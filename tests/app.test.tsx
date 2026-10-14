// @vitest-environment jsdom

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_CHANGED_CHANNEL } from "../contract";

const project = { id: "project-a", name: "Project A", isPersonal: false, href: "/projects/project-a", settingsHref: "/projects/project-a/settings" };
const message = {
  messageId: 1,
  projectId: "project-a",
  senderThreadId: "thread-sender",
  senderTitle: "Build worker",
  severity: "urgent" as const,
  text: "**Decision needed**\n\n- keep this\n\n![tracking](https://example.test/beacon.png)",
  createdAtMs: 1,
  readAtMs: null,
  archivedAtMs: null,
  replyText: null,
  replyAcceptedAtMs: null,
  replyDelivery: null,
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function loadApp() {
  const { loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
  return loadPluginApp(() => import("../app"));
}

function handlers(overrides: Record<string, unknown> = {}) {
  return {
    messageFileContext: vi.fn(async () => null),
    operatorMessages: vi.fn(async () => ({ messages: [message] })),
    unreadOperatorMessageCount: vi.fn(async () => ({ count: 1 })),
    markOperatorMessageRead: vi.fn(async (input: { projectId: string; messageId: number }) => ({ ...message, ...input, readAtMs: 2 })),
    archiveOperatorMessage: vi.fn(async () => ({ ...message, archivedAtMs: 3 })),
    replyToOperatorMessage: vi.fn(async ({ text }: { text: string }) => ({ ...message, readAtMs: 4, replyText: text, replyAcceptedAtMs: 4, replyDelivery: "queued" as const })),
    ...overrides,
  };
}

describe("Operator Inbox panel", () => {
  it("renders safe Markdown and navigates to the recorded sender thread", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers() as never,
    });

    expect((await rendered.findByText("Decision needed")).tagName).toBe("STRONG");
    expect(rendered.container.querySelector("img")).toBeNull();
    fireEvent.click(rendered.getByRole("link", { name: "Open sender thread Build worker" }));
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-sender" });
  });

  it("keeps sender navigation when the stored title is unavailable", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, senderTitle: null }] }) }) as never,
    });

    fireEvent.click(await rendered.findByRole("link", { name: "Open sender thread Sender thread" }));
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread-sender" });
    expect(rendered.queryByText("thread-sender")).toBeNull();
  });

  it("refreshes messages without showing a layout-shifting loading row", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    let finishRefresh!: (value: { messages: (typeof message)[] }) => void;
    const operatorMessages = vi.fn()
      .mockResolvedValueOnce({ messages: [message] })
      .mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages }) as never,
    });

    expect(await rendered.findByText("Decision needed")).toBeTruthy();
    fireEvent.click(rendered.getByRole("button", { name: "Refresh inbox" }));
    await waitFor(() => expect(operatorMessages).toHaveBeenCalledTimes(2));
    expect(rendered.queryByText("Loading messages…")).toBeNull();
    expect(rendered.getByText("Decision needed")).toBeTruthy();
    finishRefresh({ messages: [message] });
    await waitFor(() => expect((rendered.getByRole("button", { name: "Refresh inbox" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("records reply acceptance without claiming provider delivery or consumption", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rpc = handlers();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: rpc as never,
    });

    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.change(editor, { target: { value: "Proceed Tuesday" } });
    expect(window.sessionStorage.getItem("operator-inbox.drafts")).toContain("Proceed Tuesday");
    fireEvent.click(rendered.getByRole("button", { name: "Send reply" }));
    expect(await rendered.findByText("Reply accepted by BB (queued). Provider consumption is not observed.")).toBeTruthy();
    expect(rpc.replyToOperatorMessage).toHaveBeenCalledWith({ projectId: "project-a", messageId: 1, text: "Proceed Tuesday" });
    expect(window.sessionStorage.getItem("operator-inbox.drafts")).toBe("{}");
    expect(rendered.queryByText(/reply delivered/i)).toBeNull();
  });

  it("sends trimmed multiline replies with Enter and ignores repeated submits while pending", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    let finish!: (value: unknown) => void;
    const reply = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ replyToOperatorMessage: reply }) as never,
    });
    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.change(editor, { target: { value: "  First line\nSecond line  " } });
    expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(false);
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(rendered.getByRole("button", { name: "Sending reply" }));
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ projectId: "project-a", messageId: 1, text: "First line\nSecond line" });
    await act(async () => finish({ ...message, replyText: "First line\nSecond line", replyAcceptedAtMs: 4, readAtMs: 4, replyDelivery: "queued" }));
    expect(await rendered.findByRole("region", { name: "Reply accepted by BB" })).toBeTruthy();
    expect(window.sessionStorage.getItem("operator-inbox.drafts")).toBe("{}");
  });

  it("allows Shift+Enter and IME confirmation, and does not send empty or held Enter", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const rpc = handlers();
    const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] }, rpc: rpc as never,
    });
    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.change(editor, { target: { value: " " } });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.change(editor, { target: { value: "Draft" } });
    expect(fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 })).toBe(true);
    fireEvent.keyDown(editor, { key: "Enter", repeat: true });
    expect(rpc.replyToOperatorMessage).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("Draft");
  });

  it("keeps a failed Enter reply draft and allows retry with the send button", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const reply = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ...message, replyText: "Retry me", replyAcceptedAtMs: 4, readAtMs: 4, replyDelivery: "queued" });
    const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ replyToOperatorMessage: reply }) as never,
    });
    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.change(editor, { target: { value: "Retry me" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await rendered.findByRole("alert");
    await waitFor(() => expect((rendered.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(false));
    expect((editor as HTMLTextAreaElement).value).toBe("Retry me");
    expect(window.sessionStorage.getItem("operator-inbox.drafts")).toContain("Retry me");
    fireEvent.click(rendered.getByRole("button", { name: "Send reply" }));
    await rendered.findByRole("region", { name: "Reply accepted by BB" });
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("does not send with Enter while a message mutation is pending", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    let finish!: (value: unknown) => void;
    const rpc = handlers({ markOperatorMessageRead: () => new Promise((resolve) => { finish = resolve; }) });
    const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] }, rpc: rpc as never,
    });
    const editor = await rendered.findByLabelText("Reply text");
    fireEvent.change(editor, { target: { value: "Wait" } });
    fireEvent.click(rendered.getByRole("button", { name: "Mark message read" }));
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(rpc.replyToOperatorMessage).not.toHaveBeenCalled();
    await act(async () => finish({ ...message, readAtMs: 2 }));
  });

  it("marks read, archives, and fails closed on a foreign-project row", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    const rpc = handlers();
    const rendered = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: rpc as never,
    });

    await rendered.findByRole("button", { name: "Mark message read" });
    expect(rpc.markOperatorMessageRead).not.toHaveBeenCalled();
    fireEvent.focus(rendered.getByRole("button", { name: "Mark message read" }));
    expect(await rendered.findByRole("tooltip", { name: "Mark as read" })).toBeTruthy();
    fireEvent.focus(rendered.getByRole("button", { name: "Archive message" }));
    expect(await rendered.findByRole("tooltip", { name: "Archive" })).toBeTruthy();
    fireEvent.click(rendered.getByRole("button", { name: "Mark message read" }));
    await waitFor(() => expect(rendered.queryByRole("button", { name: "Mark message read" })).toBeNull());
    expect(rpc.markOperatorMessageRead).toHaveBeenCalledWith({ projectId: "project-a", messageId: 1 });
    fireEvent.click(rendered.getByRole("button", { name: "Archive message" }));
    expect(await rendered.findByText("Archived. Turn on Show archived to include it again.")).toBeTruthy();

    const contaminated = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, projectId: "project-b" }] }) }) as never,
    });
    expect(await contaminated.findByText(/returned a message from another project/)).toBeTruthy();
    expect(contaminated.queryByText("Decision needed")).toBeNull();
  });

  it("opens a project-locked thread panel and restores its session draft", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    expect(app.threadPanelActions.map(({ id }) => id)).toContain("inbox");
    window.sessionStorage.setItem("operator-inbox.drafts", JSON.stringify({ "project-a:1": "Keep this draft" }));
    const operatorMessages = vi.fn(async () => ({ messages: [message] }));
    const rendered = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-current", params: null }, {
      sidebarThreads: { status: "ready", projects: [project], threads: [{ id: "thread-current", projectId: "project-a" } as never] },
      rpc: handlers({ operatorMessages }) as never,
    });

    expect(await rendered.findByText("Project A")).toBeTruthy();
    expect(rendered.queryByRole("combobox")).toBeNull();
    expect((rendered.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(operatorMessages).toHaveBeenCalledWith({ projectIds: ["project-a"] });
  });

  it("updates the navigation icon from realtime and reconnect without polling", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    expect(app.navPanels[0]!.icon).toBe("operator-inbox/inbox");
    expect(app.icons[0]!.name).toBe("operator-inbox/inbox");
    let count = 1;
    const countRpc = vi.fn(async () => ({ count }));
    const controller = renderSlot(app.appOverlays[0]!, {}, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ unreadOperatorMessageCount: countRpc }) as never,
    });
    const icon = renderSlot(app.icons[0]!, { className: "test-icon-size" });
    await icon.findByText("1");
    expect(icon.container.querySelector(".test-icon-size")).toBeTruthy();
    count = 2;
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-b" });
    expect(countRpc).toHaveBeenCalledTimes(1);
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    await icon.findByText("2");
    expect(countRpc).toHaveBeenCalledTimes(2);
    await controller.behavior.setRealtimeConnectionState("reconnecting");
    count = 3;
    await controller.behavior.setRealtimeConnectionState("connected");
    await icon.findByText("3");
  });

  it("does not replace a newer count with a stale RPC response", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    let finish!: (value: { count: number }) => void;
    const countRpc = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ count: 1 });
    const controller = renderSlot(app.appOverlays[0]!, {}, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ unreadOperatorMessageCount: countRpc }) as never,
    });
    const icon = renderSlot(app.icons[0]!, {});
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    await icon.findByText("1");
    await act(async () => finish({ count: 2 }));
    expect(icon.container.textContent).toBe("1");
  });

  it("keeps the navigation icon at zero and caps only the visible badge at 99+", async () => {
    const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadApp();
    let count = 0;
    const countRpc = vi.fn(async () => ({ count }));
    const controller = renderSlot(app.appOverlays[0]!, {}, {
      sidebarThreads: { status: "ready", projects: [project], threads: [] },
      rpc: handlers({ unreadOperatorMessageCount: countRpc }) as never,
    });
    const icon = renderSlot(app.icons[0]!, {});
    await waitFor(() => expect(countRpc).toHaveBeenCalledTimes(1));
    expect(icon.container.querySelector("svg")).toBeTruthy();
    expect(icon.container.textContent).toBe("");
    count = 120;
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    const badge = await icon.findByText("99+");
    expect(badge.style).toMatchObject({ position: "absolute", display: "flex", alignItems: "center", justifyContent: "center", minWidth: "14px", height: "14px", lineHeight: "1", paddingBottom: "2px" });
    expect((icon.container.firstElementChild as HTMLElement).style.position).toBe("relative");
    expect(icon.container.firstElementChild?.getAttribute("title")).toBe("120 unread operator messages");
    count = 0;
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    await waitFor(() => expect(icon.container.textContent).toBe(""));
    count = 1;
    await controller.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
    await icon.findByText("1");
    controller.lifecycle.unmount();
    await waitFor(() => expect(icon.container.textContent).toBe(""));
  });
});

const fileContext = {
  hostId: "host-sender", environmentId: "env-sender", threadId: "thread-sender",
  workspacePath: "/Users/pixexid/Projects/nuvyr-landscaping-concept-2026-09-05",
  storageRootPath: "/Users/pixexid/.bb/thread-storage/thread-sender",
};
const png = `${fileContext.workspacePath}/showcase/demos/002-landscaping-hardscaping/evidence/qa-final/home-1440-900-true.png`;
const report = "/Users/pixexid/.bb/thread-storage/thr_tikuhzrqy8/REPORT.md";

async function renderBody(text: string, context: unknown = fileContext, openUrl = () => true) {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  return renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    openUrl, openFilePreview: () => true,
    rpc: handlers({ operatorMessages: async () => ({ messages: [{ ...message, text }] }), messageFileContext: async () => context }) as never,
  });
}

it("routes the exact five-link matrix through native URL and file intents without browser file hrefs", async () => {
  const rendered = await renderBody(`[Preview](http://localhost:4422/) · [PNG](<${png}>) · [Report](${report}) · [GitHub](https://github.com/pixexid/nuvyr/pull/66) · [AGENTS](${fileContext.workspacePath}/AGENTS.md) · [Storage](${fileContext.storageRootPath}/REPORT.md)`);
  await rendered.findByRole("button", { name: "PNG" });
  for (const [name, url] of [["Preview", "http://localhost:4422/"], ["GitHub", "https://github.com/pixexid/nuvyr/pull/66"]]) {
    const link = rendered.getByRole("link", { name });
    expect(fireEvent.click(link)).toBe(false);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  }
  for (const [name, target] of [
    ["PNG", { kind: "workspace", environmentId: "env-sender", path: png.slice(fileContext.workspacePath.length + 1) }],
    ["Report", { kind: "host", hostId: "host-sender", path: report }],
    ["AGENTS", { kind: "workspace", environmentId: "env-sender", path: "AGENTS.md" }],
    ["Storage", { kind: "thread-storage", threadId: "thread-sender", path: "REPORT.md" }],
  ] as const) {
    const button = rendered.getByRole("button", { name });
    expect(button.hasAttribute("href")).toBe(false);
    fireEvent.click(button);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "experimental_openFilePreview", options: { target, location: null } });
    const count = rendered.inspection.navigateCalls.length;
    fireEvent.contextMenu(button); fireEvent.dragStart(button); fireEvent(button, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(rendered.inspection.navigateCalls).toHaveLength(count);
    fireEvent.click(button, { ctrlKey: true });
    expect(rendered.inspection.navigateCalls.at(-1)).toEqual({ method: "experimental_openFilePreview", options: { target, location: null } });
  }
  expect(rendered.getByTestId("message-body").querySelectorAll("a")).toHaveLength(2);
  expect(rendered.getByLabelText("Reply text")).toBeTruthy();
});

it.each([null, { ...fileContext, threadId: "foreign" }, { ...fileContext, hostId: "" }, { ...fileContext, workspacePath: "/a/../b" }])("keeps invalid or unresolved context inert: %j", async (context) => {
  const rendered = await renderBody(`[PNG](${png})`, context);
  await rendered.findByText("PNG");
  await act(async () => { await Promise.resolve(); });
  expect(rendered.getByTestId("message-body").querySelector("a,button")).toBeNull();
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it("blocks image/reference/HTML media and unsafe or malformed destinations with the real parser", async () => {
  const unsafe = ["/a/../secret", "/a/%2e%2e/secret", "/a/%252e%252e/secret", "/a/%2F/secret", "//evil.test/file", "/a/%5csecret", "/a/%00secret", "/a/%ED%A0%80", "relative.png", "file:///etc/passwd", "javascript:alert%281%29", "data:text/html,hello", "/a/./b", "/a/%"];
  const rendered = await renderBody('**Strong**\n\n- item\n\n```html\n<img src="sample">\n```\n\n![beacon](https://evil.test/beacon)\n\n![ref][b]\n\n[b]: https://evil.test/ref\n\n<img src="https://evil.test/raw"><video src="https://evil.test/video"></video>\n\n<a href="javascript:alert(1)" target="_top" rel="opener">raw</a>\n\n' + unsafe.map((path, i) => `[Unsafe ${i}](<${path}>)`).join(' · '));
  const body = await rendered.findByTestId("message-body");
  await act(async () => { await Promise.resolve(); });
  expect(body.querySelector("img,video,audio,iframe,source,object,embed,a,button")).toBeNull();
  expect(body.querySelector("strong")).not.toBeNull();
  expect(body.querySelector("li")).not.toBeNull();
  expect(body.querySelector("pre code")).not.toBeNull();
  expect(rendered.inspection.navigateCalls).toEqual([]);
});

it("does not lend late sender context to another message or a reply", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  let finish: (value: typeof fileContext) => void = () => {};
  const late = new Promise<typeof fileContext>((resolve) => { finish = resolve; });
  const second = { ...message, messageId: 2, senderThreadId: "thread-other", text: `[Second](${png})`, replyText: `[Reply](${png})`, replyAcceptedAtMs: 2 };
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [message, second] }), messageFileContext: async ({ messageId }: { messageId: number }) => messageId === 1 ? late : null }) as never,
  });
  await rendered.findByTestId("message-body");
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  await rendered.findByText("Second");
  await act(async () => { finish(fileContext); await late; });
  for (const body of rendered.getAllByTestId("message-body")) expect(body.querySelector("a,button")).toBeNull();
});

it("retains only a safe new-tab fallback when native URL opening declines", async () => {
  const rendered = await renderBody("[Preview](http://localhost:4422/)", fileContext, () => false);
  await rendered.findByRole("link", { name: "Preview" });
  await act(async () => { await Promise.resolve(); });
  const link = rendered.getByRole("link", { name: "Preview" });
  let preventedByPlugin = true;
  rendered.container.addEventListener("click", (event) => {
    preventedByPlugin = event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  fireEvent.click(link);
  expect(preventedByPlugin).toBe(false);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(rendered.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "http://localhost:4422/" });
});

it("expands one card at a time, preserves drafts, and keeps all cards collapsed across refresh", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const second = { ...message, messageId: 2, text: "Second message body" };
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: [message, second] }) }) as never,
  });
  const firstToggle = await rendered.findByRole("button", { name: /^Collapse message #1/ });
  expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(firstToggle.getAttribute("aria-controls")!)?.contains(rendered.getByTestId("message-body"))).toBe(true);
  fireEvent.change(rendered.getByLabelText("Reply text"), { target: { value: "Keep this draft" } });
  fireEvent.click(firstToggle);
  expect(rendered.queryByTestId("message-body")).toBeNull();
  expect(rendered.queryByLabelText("Reply text")).toBeNull();
  fireEvent.click(rendered.getByRole("button", { name: "Refresh inbox" }));
  await waitFor(() => expect(rendered.queryByText("Loading messages…")).toBeNull());
  expect(rendered.queryByTestId("message-body")).toBeNull();
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect(rendered.getByTestId("message-body").textContent).toBe(second.text);
  expect((rendered.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #1/ }));
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect((rendered.getByLabelText("Reply text") as HTMLTextAreaElement).value).toBe("Keep this draft");
});

it("keeps the message expanded when opening a native file panel", async () => {
  const rendered = await renderBody(`[PNG](${png})`);
  fireEvent.click(await rendered.findByRole("button", { name: "PNG" }));
  expect(rendered.getByRole("button", { name: /^Collapse message #1/ }).getAttribute("aria-expanded")).toBe("true");
  expect(rendered.getAllByTestId("message-body")).toHaveLength(1);
  expect(rendered.inspection.navigateCalls.at(-1)).toEqual({ method: "experimental_openFilePreview", options: {
    target: { kind: "workspace", environmentId: "env-sender", path: png.slice(fileContext.workspacePath.length + 1) }, location: null,
  } });
});

it("clears unread feedback only after saving and keeps order and selection through realtime refresh", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  let rows: Array<Omit<typeof message, "readAtMs"> & { readAtMs: number | null }> = [{ ...message }, { ...message, messageId: 2, text: "Second" }];
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const read = vi.fn(async ({ messageId }: { messageId: number }) => {
    if (messageId === 1) await pending;
    rows = rows.map((row) => row.messageId === messageId ? { ...row, readAtMs: 3 } : row);
    return rows.find((row) => row.messageId === messageId)!;
  });
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ operatorMessages: async () => ({ messages: rows }), markOperatorMessageRead: read }) as never,
  });
  await rendered.findByRole("button", { name: /^Collapse message #1/ });
  expect(rendered.getAllByLabelText("Unread", { exact: true })).toHaveLength(2);
  expect(rendered.getByText("2 unread")).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(rendered.getByRole("button", { name: "Mark message read" }));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await pending; });
  await waitFor(() => expect(rendered.getAllByLabelText("Unread", { exact: true })).toHaveLength(1));
  expect(rendered.getByText("1 unread")).toBeTruthy();
  await rendered.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
  const toggles = () => rendered.getAllByRole("button", { name: /^(Expand|Collapse) message/ }).map((button) => button.getAttribute("aria-label")!.match(/#\d+/)![0]);
  expect(toggles()).toEqual(["#1", "#2"]);
  expect(rendered.getByRole("button", { name: /^Collapse message #1/ })).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  rows = [{ ...message, messageId: 3, text: "New arrival" }, ...rows];
  await rendered.behavior.emitRealtime(INBOX_CHANGED_CHANNEL, { projectId: "project-a" });
  expect(rendered.getByRole("button", { name: /^Collapse message #1/ })).toBeTruthy();
  expect(rendered.getByRole("button", { name: /^Expand message #3/ })).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  expect(rendered.getAllByLabelText("Unread", { exact: true })).toHaveLength(2);
  expect(rendered.getByText("2 unread")).toBeTruthy();
  expect(toggles()).toEqual(["#3", "#1", "#2"]);
});

it("keeps a failed read unread and allows a manual retry without an automatic retry loop", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const read = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ...message, readAtMs: 9 });
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] },
    rpc: handlers({ markOperatorMessageRead: read }) as never,
  });
  fireEvent.click(await rendered.findByRole("button", { name: "Mark message read" }));
  await rendered.findByText(/Could not mark message read:.*Offline/);
  expect(read).toHaveBeenCalledTimes(1);
  expect(rendered.getByLabelText("Unread", { exact: true })).toBeTruthy();
  fireEvent.click(rendered.getByRole("button", { name: "Mark message read" }));
  await waitFor(() => expect(rendered.queryByLabelText("Unread", { exact: true })).toBeNull());
  expect(read).toHaveBeenCalledTimes(2);
  expect(rendered.queryByRole("alert")).toBeNull();
});

it("archives only from the expanded message actions without marking it read", async () => {
  const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const second = { ...message, messageId: 2, text: "Collapsed message" };
  const archive = vi.fn(async () => ({ ...second, archivedAtMs: 3 }));
  const rpc = handlers({ operatorMessages: async () => ({ messages: [message, second] }), archiveOperatorMessage: archive });
  const rendered = renderSlot((await loadApp()).navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [project], threads: [] }, rpc: rpc as never,
  });
  await rendered.findByRole("button", { name: /^Expand message #2/ });
  expect(rendered.getAllByRole("button", { name: "Archive message" })).toHaveLength(1);
  fireEvent.click(rendered.getByRole("button", { name: /^Expand message #2/ }));
  fireEvent.click(rendered.getByRole("button", { name: "Archive message" }));
  await waitFor(() => expect(rendered.queryByRole("button", { name: /^Expand message #2/ })).toBeNull());
  expect(archive).toHaveBeenCalledWith({ projectId: "project-a", messageId: 2 });
  expect(rendered.getByRole("button", { name: /^Collapse message #1/ })).toBeTruthy();
  expect(rpc.markOperatorMessageRead).not.toHaveBeenCalled();
});
