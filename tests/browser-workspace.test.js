import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace, normalizeBrowserUrl } from "../electron/browser/browser-workspace.mjs";

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = "";
    this.closed = false;
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn()
    };
  }

  isDestroyed() { return this.closed; }
  getURL() { return this.url; }
  getTitle() { return this.url ? new URL(this.url).hostname : ""; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  async loadURL(url) { this.url = url; this.emit("did-navigate"); }
  close() { this.closed = true; }
  reload() {}
  stop() {}
  async executeJavaScript() { return {}; }
  async capturePage() { return { toDataURL: () => "data:image/png;base64,test" }; }
}

class FakeWebContentsView {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    FakeWebContentsView.instances.push(this);
  }

  setBackgroundColor() {}
  setBounds(bounds) { this.bounds = bounds; }
}

function createHarness() {
  FakeWebContentsView.instances = [];
  const attached = new Set();
  const window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view) => attached.add(view),
      removeChildView: (view) => attached.delete(view)
    }
  };
  const emit = vi.fn();
  return { workspace: new BrowserWorkspace({ window, WebContentsView: FakeWebContentsView, emit }), attached, emit };
}

describe("BrowserWorkspace", () => {
  it("loads the trusted internal home page without rewriting it as HTTPS", async () => {
    const { workspace } = createHarness();

    const snapshot = workspace.createTab("thread-home");
    await Promise.resolve();

    expect(snapshot.tabs[0].url).toBe("");
    expect(FakeWebContentsView.instances[0].webContents.url).toMatch(/^data:text\/html;charset=utf-8,/);
    expect(normalizeBrowserUrl("data:text/html,untrusted")).toBe("https://data:text/html,untrusted");
  });

  it("opens a fresh thread-scoped workspace through the Pixice browser tool route", async () => {
    const { workspace, emit } = createHarness();

    const response = await workspace.handleToolCall({
      threadId: "thread-tool",
      namespace: "loom_browser",
      tool: "navigate",
      arguments: { url: "https://example.com" }
    });
    const state = JSON.parse(response.contentItems[0].text);

    expect(response.success).toBe(true);
    expect(state.workspaceId).toBe("thread-tool");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("https://example.com");
    expect(emit).toHaveBeenCalledWith("BrowserOpenRequested", {
      threadId: "thread-tool",
      workspaceId: "thread-tool",
      source: "codex"
    });
  });

  it("ignores a stale home-page failure after a successful navigation", async () => {
    const { workspace } = createHarness();

    workspace.createTab("thread-race");
    await Promise.resolve();
    const contents = FakeWebContentsView.instances[0].webContents;
    const staleHomeUrl = contents.url;

    await workspace.navigate({ workspaceId: "thread-race", url: "https://example.com" });
    contents.emit("did-fail-load", {}, -300, "ERR_INVALID_URL", staleHomeUrl, true);

    expect(workspace.snapshot("thread-race").tabs[0]).toMatchObject({
      url: "https://example.com",
      error: null
    });
  });

  it("isolates tabs, visible views, and persistent sessions by thread", async () => {
    const { workspace, attached } = createHarness();

    workspace.createTab("thread-1", "https://example.com");
    workspace.createTab("thread-1", "https://example.org");
    workspace.createTab("thread-2", "https://openai.com");
    await Promise.resolve();

    expect(workspace.snapshot("thread-1").tabs).toHaveLength(2);
    expect(workspace.snapshot("thread-2").tabs).toHaveLength(1);
    expect(FakeWebContentsView.instances[0].options.webPreferences.partition)
      .toBe(FakeWebContentsView.instances[1].options.webPreferences.partition);
    expect(FakeWebContentsView.instances[0].options.webPreferences.partition)
      .not.toBe(FakeWebContentsView.instances[2].options.webPreferences.partition);

    workspace.setViewport({ workspaceId: "thread-1", visible: true, bounds: { x: 1, y: 2, width: 900, height: 600 } });
    expect(attached.has(FakeWebContentsView.instances[1])).toBe(true);
    workspace.setViewport({ workspaceId: "thread-2", visible: true, bounds: { x: 3, y: 4, width: 800, height: 500 } });
    expect(attached.has(FakeWebContentsView.instances[1])).toBe(false);
    expect(attached.has(FakeWebContentsView.instances[2])).toBe(true);
  });

  it("adopts a draft workspace without merging it into another thread", async () => {
    const { workspace } = createHarness();
    workspace.createTab("draft:project-1", "https://example.com");
    await Promise.resolve();

    const adopted = workspace.adoptWorkspace("draft:project-1", "thread-new");

    expect(adopted.workspaceId).toBe("thread-new");
    expect(adopted.tabs).toHaveLength(1);
    expect(workspace.snapshot("draft:project-1").tabs).toHaveLength(0);
    expect(workspace.snapshot("thread-new").tabs[0].url).toBe("https://example.com");
  });

  it("closes every renderer owned by a discarded preview workspace", async () => {
    const { workspace, attached } = createHarness();
    workspace.createTab("thread-old", "https://example.com");
    workspace.createTab("thread-old", "https://example.org");
    await Promise.resolve();
    workspace.setViewport({ workspaceId: "thread-old", visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });

    workspace.destroyWorkspace("thread-old");

    expect(workspace.snapshot("thread-old").tabs).toHaveLength(0);
    expect(FakeWebContentsView.instances.every((view) => view.webContents.closed)).toBe(true);
    expect(attached.size).toBe(0);
  });
});
