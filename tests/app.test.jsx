import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";

const project = {
  id: "project-1",
  displayName: "Aurora",
  canonicalPath: "/work/aurora",
  repository: { kind: "git", root: "/work/aurora", baseCommit: "abc", dirtyPaths: ["src/auth.js"] }
};

const thread = {
  id: "thread-1",
  name: "Refactor authentication",
  preview: "Refactor authentication",
  cwd: "/work/aurora",
  parentThreadId: null,
  status: { type: "idle" },
  updatedAt: Math.floor(Date.now() / 1000),
  turns: [{
    id: "turn-1",
    status: "completed",
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Refactor authentication" }] },
      { id: "agent-1", type: "agentMessage", text: "I traced the current flow.\n\n## Summary\n\n- Sessions use **cookies**\n- Tests run with `pnpm test`\n\n| Area | State |\n| --- | --- |\n| [Runtime](src/runtime.js) | Ready |", phase: "final_answer" }
    ]
  }]
};

function createApi(threadValue = thread) {
  let eventListener = null;
  const threadValues = Array.isArray(threadValue) ? threadValue : [threadValue];
  let boardTasks = [];
  const browserState = {
    native: false,
    activeTabId: "browser-1",
    tabs: [{ id: "browser-1", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }]
  };
  const scopedBrowserState = (payload = {}) => ({ ...browserState, workspaceId: payload.workspaceId });
  const api = {
    emit(event) { eventListener?.(event); },
    app: {
      bootstrap: vi.fn().mockResolvedValue({ projects: [project], models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], runtime: { state: "ready", connected: true }, settings: {} }),
      saveSettings: vi.fn().mockResolvedValue({})
    },
    runtime: { status: vi.fn().mockResolvedValue({ state: "ready", connected: true }) },
    providers: {
      list: vi.fn().mockResolvedValue([
        { id: "codex", connected: true, status: { state: "ready", message: "Codex app server" }, account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresAuth: true, sessionCount: 3, loginAvailable: true },
        { id: "claude", connected: true, status: { state: "ready", message: "Claude Agent SDK" }, account: null, requiresAuth: true, sessionCount: 0, loginAvailable: true }
      ]),
      login: vi.fn().mockResolvedValue({ provider: "claude", opened: true })
    },
    usage: {
      summary: vi.fn().mockResolvedValue({
        rangeDays: 30,
        recordingStartedAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-19T10:00:00.000Z",
        pricingVerifiedAt: "2026-08-19",
        stats: {
          todayCostUsd: 1.24,
          currentWeekCostUsd: 8.75,
          currentMonthCostUsd: 31.5,
          projectedMonthCostUsd: 51.39,
          dailyAverageCostUsd: 1.66,
          weeklyAverageCostUsd: 11.61,
          monthlyAverageCostUsd: 50.52,
          allTimeCostUsd: 96.42,
          allTimeTokens: 2_400_000
        },
        selected: {
          inputTokens: 800_000,
          cachedInputTokens: 1_200_000,
          cacheWriteInputTokens: 40_000,
          outputTokens: 360_000,
          reasoningOutputTokens: 180_000,
          totalTokens: 2_400_000,
          costUsd: 31.5,
          events: 24,
          unpricedEvents: 0,
          unpricedTokens: 0
        },
        daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-08-${String(index + 1).padStart(2, "0")}`, costUsd: index / 10, totalTokens: index * 1_000 })),
        heatmapDaily: Array.from({ length: 365 }, (_, index) => {
          const date = new Date(2025, 7, 20);
          date.setDate(date.getDate() + index);
          return { date: date.toISOString().slice(0, 10), costUsd: index % 9 === 0 ? index / 100 : 0, totalTokens: index * 750, events: index % 9 === 0 ? 1 : 0 };
        }),
        models: [
          { provider: "codex", model: "gpt-5.6-sol", costUsd: 23.5, totalTokens: 1_600_000 },
          { provider: "claude", model: "claude-sonnet-5", costUsd: 8, totalTokens: 800_000 }
        ],
        pricing: [
          { provider: "codex", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", rates: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 }, fastRates: { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 60 } },
          { provider: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5", rates: { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 }, fastRates: null }
        ]
      })
    },
    updates: {
      status: vi.fn().mockResolvedValue({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Loom builds." }),
      check: vi.fn().mockResolvedValue({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Loom builds." }),
      download: vi.fn(),
      install: vi.fn()
    },
    browser: {
      state: vi.fn(async (payload) => scopedBrowserState(payload)),
      create: vi.fn(async (payload) => scopedBrowserState(payload)),
      close: vi.fn(async (payload) => scopedBrowserState(payload)),
      activate: vi.fn(async (payload) => scopedBrowserState(payload)),
      navigate: vi.fn(async (payload) => scopedBrowserState(payload)),
      history: vi.fn(async (payload) => scopedBrowserState(payload)),
      setViewport: vi.fn(async (payload) => scopedBrowserState(payload)),
      adopt: vi.fn(async ({ toWorkspaceId }) => scopedBrowserState({ workspaceId: toWorkspaceId }))
    },
    files: {
      read: vi.fn(async ({ path }) => ({
        path: path.startsWith("/") ? path.replace(/:\d+$/, "") : `/work/aurora/${path.replace(/:\d+$/, "")}`,
        relativePath: path.replace(/:\d+$/, ""),
        name: path.replace(/:\d+$/, "").split("/").at(-1),
        extension: `.${path.replace(/:\d+$/, "").split(".").at(-1)}`,
        kind: path.endsWith(".md") ? "markdown" : "text",
        content: "export const ready = true;\n",
        editable: true,
        size: 27,
        mtimeMs: 1
      })),
      write: vi.fn(async ({ path, content }) => ({
        path,
        relativePath: path.replace("/work/aurora/", ""),
        name: path.split("/").at(-1),
        extension: `.${path.split(".").at(-1)}`,
        kind: path.endsWith(".md") ? "markdown" : "text",
        content,
        editable: true,
        size: content.length,
        mtimeMs: 2
      }))
    },
    projects: { list: vi.fn().mockResolvedValue([project]), open: vi.fn().mockResolvedValue(project) },
    board: {
      list: vi.fn(async () => ({ data: boardTasks })),
      create: vi.fn(async (payload) => {
        const task = { id: `task-${boardTasks.length + 1}`, ...payload, description: payload.description ?? "", position: (boardTasks.length + 1) * 1024, threadId: null, createdAt: "2026-08-19T12:00:00.000Z", updatedAt: "2026-08-19T12:00:00.000Z" };
        boardTasks = [...boardTasks, task];
        return task;
      }),
      update: vi.fn(async (payload) => {
        boardTasks = boardTasks.map((task) => task.id === payload.taskId ? { ...task, ...payload, id: task.id } : task);
        return boardTasks.find((task) => task.id === payload.taskId);
      }),
      move: vi.fn(async (payload) => {
        boardTasks = boardTasks.map((task) => task.id === payload.taskId ? { ...task, column: payload.column, updatedAt: "2026-08-19T12:00:00.000Z" } : task);
        return boardTasks.find((task) => task.id === payload.taskId);
      }),
      delete: vi.fn(async ({ taskId }) => {
        const task = boardTasks.find((candidate) => candidate.id === taskId);
        boardTasks = boardTasks.filter((candidate) => candidate.id !== taskId);
        return task;
      }),
      attach: vi.fn(async ({ taskId, threadId }) => {
        boardTasks = boardTasks.map((task) => task.id === taskId ? { ...task, threadId } : task);
        return boardTasks.find((task) => task.id === taskId);
      })
    },
    threads: {
      list: vi.fn().mockResolvedValue({ data: threadValues, nextCursor: null }),
      read: vi.fn(async ({ threadId }) => ({ thread: threadValues.find((candidate) => candidate.id === threadId) ?? threadValues[0] })),
      children: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
      create: vi.fn().mockResolvedValue({ thread: { ...thread, id: "thread-new", name: null, preview: "", turns: [] } }),
      archive: vi.fn().mockResolvedValue({})
    },
    turns: {
      start: vi.fn().mockResolvedValue({ turn: { id: "turn-new", status: "inProgress", items: [] } }),
      steer: vi.fn().mockResolvedValue({}),
      interrupt: vi.fn().mockResolvedValue({})
    },
    approvals: { resolve: vi.fn().mockResolvedValue({ ok: true }) },
    requests: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    questions: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    elicitations: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    review: { read: vi.fn().mockResolvedValue({ repository: project.repository, diff: "diff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-old\n+new" }) },
    models: { list: vi.fn().mockResolvedValue([]) },
    extensions: { list: vi.fn().mockResolvedValue({ skills: [], apps: [], mcp: [], errors: [] }) },
    external: { openEditor: vi.fn(), openTerminal: vi.fn(), reveal: vi.fn() },
    events: { subscribe: vi.fn((listener) => { eventListener = listener; return () => { eventListener = null; }; }) }
  };
  return api;
}

beforeEach(() => {
  window.loom = createApi();
  localStorage.clear();
});

describe("Loom app shell", () => {
  it("creates, orders, and starts durable board tasks without making a thread first", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(await screen.findByRole("heading", { name: "Plan work before it runs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Aurora task board" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Plan release notes" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Backlog" })).getByRole("button", { name: "Add task" }));

    const card = await screen.findByRole("button", { name: "Plan release notes" });
    expect(window.loom.board.create).toHaveBeenCalledWith({
      projectId: "project-1",
      title: "Plan release notes",
      description: "",
      column: "backlog"
    });
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    expect(window.loom.board.move).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "ArrowRight" });

    await waitFor(() => expect(window.loom.board.move).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      column: "ready"
    }));

    const ready = screen.getByRole("region", { name: "Ready" });
    fireEvent.click(await within(ready).findByRole("button", { name: "Start Plan release notes" }));
    await waitFor(() => expect(window.loom.board.attach).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      threadId: "thread-new"
    }));
    expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-new",
      text: "Plan release notes"
    }));
  });

  it("shows a bridge-created Loom thread in the sidebar like a regular task", async () => {
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Cross-model UI review",
      parentThreadId: thread.id,
      bridge: { kind: "loomBridge", parentThreadId: thread.id, model: "claude:claude-sonnet-4-6" }
    };
    const subagentThread = {
      ...thread,
      id: "subagent-thread",
      name: "Internal test audit",
      parentThreadId: thread.id
    };
    window.loom = createApi([thread, bridgeThread, subagentThread]);

    render(<App />);

    const bridgeTask = await screen.findByRole("button", { name: "Cross-model UI review" });
    expect(screen.queryByRole("button", { name: "Internal test audit" })).not.toBeInTheDocument();

    fireEvent.click(bridgeTask);
    await waitFor(() => expect(window.loom.threads.read).toHaveBeenCalledWith({
      projectId: project.id,
      threadId: bridgeThread.id
    }));
    expect(bridgeTask).toHaveAttribute("aria-current", "page");
  });

  it("adds a newly spawned bridge thread to the sidebar immediately", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.loom.emit({
      type: "AgentUpdated",
      payload: {
        method: "loom/bridge/updated",
        projectId: project.id,
        threadId: thread.id,
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          bridge: true,
          senderThreadId: thread.id,
          receiverThreadIds: ["bridge-thread"],
          prompt: "Review the interface hierarchy",
          model: "claude:claude-sonnet-4-6",
          agentsStates: { "bridge-thread": { status: "running", message: "Reviewing" } }
        }
      }
    }));

    expect(await screen.findByRole("button", { name: "Review the interface hierarchy" })).toBeInTheDocument();
  });

  it("labels prompts and answers relayed through a Loom bridge thread", async () => {
    const bridgeThread = {
      ...thread,
      id: "bridge-thread",
      name: "Cross-model UI review",
      bridge: { kind: "loomBridge", parentThreadId: "main-thread", model: "claude:claude-sonnet-4-6" },
      turns: [{
        id: "bridge-turn",
        status: "completed",
        items: [
          { id: "bridge-prompt", type: "userMessage", content: [{ type: "text", text: "Review the interface hierarchy" }] },
          { id: "bridge-answer", type: "agentMessage", text: "Increase the spacing between sections.", phase: "final_answer" }
        ]
      }]
    };
    window.loom = createApi(bridgeThread);

    const { container } = render(<App />);

    const opened = await screen.findByText("Task opened by another Loom agent");
    const sent = await screen.findByText("Sent answer to main agent");
    expect(opened).toHaveClass("bridge-prompt-status");
    expect(sent).toHaveClass("bridge-answer-status");
    expect(container.querySelector(".bridge-prompt-status + .user-message")).toHaveTextContent("Review the interface hierarchy");
    expect(sent.closest(".assistant-message")).toHaveTextContent("Increase the spacing between sections.");
  });

  it("uses a subtle fade-through when entering and leaving settings", async () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const originalGetAnimations = HTMLElement.prototype.getAnimations;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const animations = [];
    HTMLElement.prototype.animate = vi.fn(function animate(keyframes, options) {
      if (this.classList.contains("loom-app")) animations.push({ keyframes, options });
      return { finished: Promise.resolve(), cancel: vi.fn() };
    });
    HTMLElement.prototype.getAnimations = vi.fn(() => []);
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);

    try {
      render(<App />);
      await screen.findByText("I traced the current flow.");

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
      expect(await screen.findByRole("complementary", { name: "Primary navigation" })).toBeInTheDocument();

      expect(document.querySelector(".view-curtain")).not.toBeInTheDocument();
      await waitFor(() => expect(animations.map(({ options }) => options.duration)).toEqual([90, 180, 90, 180]));
      expect(animations.flatMap(({ keyframes }) => keyframes).every((frame) => frame.transform.startsWith("scale("))).toBe(true);
    } finally {
      if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
      else delete HTMLElement.prototype.animate;
      if (originalGetAnimations) HTMLElement.prototype.getAnimations = originalGetAnimations;
      else delete HTMLElement.prototype.getAnimations;
      if (originalRequestAnimationFrame) window.requestAnimationFrame = originalRequestAnimationFrame;
      else delete window.requestAnimationFrame;
    }
  });

  it("recovers if a settings transition animation never finishes", async () => {
    const originalAnimate = HTMLElement.prototype.animate;
    const originalGetAnimations = HTMLElement.prototype.getAnimations;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const stuckAnimation = { finished: new Promise(() => {}), cancel: vi.fn() };
    let animationCount = 0;
    HTMLElement.prototype.animate = vi.fn(function animate() {
      if (!this.classList.contains("loom-app")) return { finished: Promise.resolve(), cancel: vi.fn() };
      animationCount += 1;
      return animationCount === 1 ? stuckAnimation : { finished: Promise.resolve(), cancel: vi.fn() };
    });
    HTMLElement.prototype.getAnimations = vi.fn(() => [stuckAnimation]);
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);

    try {
      const { container } = render(<App />);
      await screen.findByText("I traced the current flow.");

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(await screen.findByRole("heading", { name: "General" }, { timeout: 1000 })).toBeInTheDocument();
      await waitFor(() => expect(container.querySelector(".loom-app")).toHaveAttribute("data-view-transitioning", "false"));
      expect(stuckAnimation.cancel).toHaveBeenCalled();
    } finally {
      if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
      else delete HTMLElement.prototype.animate;
      if (originalGetAnimations) HTMLElement.prototype.getAnimations = originalGetAnimations;
      else delete HTMLElement.prototype.getAnimations;
      if (originalRequestAnimationFrame) window.requestAnimationFrame = originalRequestAnimationFrame;
      else delete window.requestAnimationFrame;
    }
  });

  it("renders Codex image generation in progress and swaps in the completed image", async () => {
    const imageThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-image",
        status: "inProgress",
        items: [
          { id: "user-image", type: "userMessage", content: [{ type: "text", text: "Make a lake image" }] },
          { id: "tool-image", type: "dynamicToolCall", tool: "image_gen__imagegen", status: "completed", arguments: { prompt: "a calm mountain lake at dawn", size: "1536x1024" } },
          { id: "generated-image", type: "imageGeneration", status: "inProgress", result: "", revisedPrompt: null, savedPath: null, failure: null }
        ]
      }]
    };
    window.loom = createApi(imageThread);

    render(<App />);
    expect(await screen.findByRole("img", { name: "Generating image" })).toBeInTheDocument();
    expect(screen.getByText("“a calm mountain lake at dawn”")).toBeInTheDocument();
    expect(screen.getByText("1536 × 1024")).toBeInTheDocument();

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-image",
        item: {
          id: "generated-image",
          type: "imageGeneration",
          status: "completed",
          result: "data:image/png;base64,AA==",
          revisedPrompt: "a glassy lake beneath a pink dawn sky",
          savedPath: "/tmp/lake.png",
          failure: null
        }
      }
    }));

    const result = await screen.findByRole("img", { name: "a glassy lake beneath a pink dawn sky" });
    expect(result).toHaveAttribute("src", "data:image/png;base64,AA==");
    expect(screen.getByText("Generated image")).toBeInTheDocument();
  });

  it("loads real task data and moves between review and settings", async () => {
    render(<App />);
    expect(document.querySelector(".window-drag-region")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("I traced the current flow.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect((await screen.findByText("cookies")).tagName).toBe("STRONG");
    expect((await screen.findByText("pnpm test")).tagName).toBe("CODE");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(await screen.findByText("Runtime")).toHaveAttribute("title", "src/runtime.js");
    expect(document.querySelector(".assistant-message [aria-hidden='true']")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("heading", { name: "Aurora" })).toBeInTheDocument();
    expect(screen.getByText("auth.js")).toBeInTheDocument();
    expect(screen.getByText("old").closest(".file-diff-row")).toHaveClass("del");
    expect(screen.getByText("new").closest(".file-diff-row")).toHaveClass("add");
    expect(document.querySelector(".file-diff-stat")).toHaveTextContent("+1−1");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Settings navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to task" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Capabilities/ }));
    expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(window.loom.extensions.list).toHaveBeenCalled();
  });

  it("wires settings controls to real app preferences", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Default permissions" }), { target: { value: "read-only" } });
    expect(localStorage.getItem("loom.permissionMode")).toBe("read-only");

    fireEvent.click(screen.getByRole("button", { name: /^Appearance/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show shortcut hints" }));
    expect(document.querySelector(".loom-app")).toHaveAttribute("data-show-shortcuts", "false");
    fireEvent.change(screen.getByRole("combobox", { name: "Interface density" }), { target: { value: "comfortable" } });
    expect(document.querySelector(".loom-app")).toHaveAttribute("data-density", "comfortable");

    const saved = JSON.parse(localStorage.getItem("loom.preferences"));
    expect(saved).toMatchObject({ showShortcutHints: false, density: "comfortable" });
  });

  it("persists agent behavior packs for every Loom agent", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
      runtime: { state: "ready", connected: true },
      settings: { agentBehaviors: { structuredPlanning: true, parallelDelegation: false, verification: true } },
      agentBehaviors: [
        { id: "structuredPlanning", label: "Structured planning", description: "Plan multi-step work.", defaultEnabled: true },
        { id: "parallelDelegation", label: "Parallel delegation", description: "Use focused helper agents.", defaultEnabled: false },
        { id: "verification", label: "Verification before handoff", description: "Run proportionate checks.", defaultEnabled: true }
      ]
    });
    window.loom = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Agent Behavior/ }));
    expect(await screen.findByRole("heading", { name: "Agent Behavior" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Parallel delegation" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Parallel delegation" }));
    expect(api.app.saveSettings).toHaveBeenCalledWith({
      agentBehaviors: { structuredPlanning: true, parallelDelegation: true, verification: true }
    });
  });

  it("shows provider accounts, previous sessions, and opens sign in", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Providers/ }));

    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "OpenAI Codex" })).toBeInTheDocument();
    expect(screen.getByText("dev@example.com · plus")).toBeInTheDocument();
    expect(screen.getByText("3 previous sessions")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Anthropic Claude" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(window.loom.providers.login).toHaveBeenCalledWith({ provider: "claude" });
    expect(screen.getByRole("button", { name: "Check sign-in" })).toBeInTheDocument();
  });

  it("shows measured token usage, cost averages, charts, and the current rate card", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Usage/ }));

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeInTheDocument();
    await waitFor(() => expect(window.loom.usage.summary).toHaveBeenCalledWith({ days: 30 }));
    expect(screen.getByLabelText("$31.50", { selector: ".usage-hero-heading .number-ticker" })).toBeInTheDocument();
    expect(screen.getByLabelText("$96.42", { selector: ".usage-hero-lifetime .number-ticker" })).toBeInTheDocument();
    expect(screen.getByText("Weekly average")).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Daily API-equivalent spend heat map over the last 365 days" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Daily API-equivalent spend over 30 days" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "API-equivalent cost by model" })).toBeInTheDocument();
    expect(screen.getByText("GPT-5.6 Sol", { selector: ".usage-rate-row strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
    expect(screen.getByText("Claude Sonnet 5", { selector: ".usage-rate-row strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(window.loom.usage.summary).toHaveBeenLastCalledWith({ days: 7 }));
  });

  it("checks GitHub releases from the Updates settings page", async () => {
    const api = createApi();
    api.updates.status.mockResolvedValue({ supported: true, state: "idle", currentVersion: "0.1.0", availableVersion: null, percent: 0, message: "Ready to check GitHub releases." });
    api.updates.check.mockResolvedValue({ supported: true, state: "not-available", currentVersion: "0.1.0", availableVersion: null, percent: 0, message: "Loom is up to date." });
    window.loom = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Updates/ }));
    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByText("Loom 0.1.0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(api.updates.check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Loom is up to date.")).toBeInTheDocument();
  });

  it("restores persistent model, reasoning, and permission defaults after an app update", async () => {
    const models = [{
      id: "gpt",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }, {
      id: "gpt-54",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }];
    const firstApi = createApi();
    firstApi.app.bootstrap.mockResolvedValue({
      projects: [project], models, runtime: { state: "ready", connected: true },
      settings: { defaultModel: "gpt-5.6", defaultEffort: "medium", defaultPermissionMode: "workspace-write" }
    });
    window.loom = firstApi;

    const firstLaunch = render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const modelSelect = await screen.findByRole("combobox", { name: "Default model" });
    const effortSelect = await screen.findByRole("combobox", { name: "Default reasoning effort" });
    const permissionSelect = await screen.findByRole("combobox", { name: "Default permissions" });
    fireEvent.change(modelSelect, { target: { value: "gpt-5.4" } });
    expect(effortSelect).toHaveValue("medium");
    fireEvent.change(effortSelect, { target: { value: "high" } });
    fireEvent.change(permissionSelect, { target: { value: "full-access" } });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultModel: "gpt-5.4", defaultEffort: "medium" });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultEffort: "high" });
    expect(firstApi.app.saveSettings).toHaveBeenCalledWith({ defaultPermissionMode: "full-access" });
    firstLaunch.unmount();
    localStorage.clear();

    const restartedApi = createApi();
    restartedApi.app.bootstrap.mockResolvedValue({
      projects: [project], models, runtime: { state: "ready", connected: true },
      settings: { defaultModel: "gpt-5.4", defaultEffort: "high", defaultPermissionMode: "full-access" }
    });
    window.loom = restartedApi;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });

    expect(await screen.findByRole("combobox", { name: "Default model" })).toHaveValue("gpt-5.4");
    expect(await screen.findByRole("combobox", { name: "Default reasoning effort" })).toHaveValue("high");
    expect(await screen.findByRole("combobox", { name: "Default permissions" })).toHaveValue("full-access");
  });

  it("keeps composer reasoning changes scoped to their thread", async () => {
    const user = userEvent.setup();
    const secondThread = { ...thread, id: "thread-2", name: "Prepare release notes", preview: "Prepare release notes" };
    const models = [{
      id: "gpt",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }];
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    api.threads.list.mockResolvedValue({ data: [thread, secondThread], nextCursor: null });
    api.threads.read.mockImplementation(async ({ threadId }) => ({ thread: threadId === secondThread.id ? secondThread : thread }));
    window.loom = api;

    const firstLaunch = render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Reasoning: Medium" }));
    await user.click(screen.getByRole("option", { name: /High/ }));
    expect(JSON.parse(localStorage.getItem("loom.threadConfiguration.thread-1"))).toMatchObject({ effort: "high" });

    await user.click(screen.getByRole("button", { name: "Prepare release notes" }));
    expect(await screen.findByRole("button", { name: "Reasoning: Medium" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refactor authentication" }));
    expect(await screen.findByRole("button", { name: "Reasoning: High" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByRole("combobox", { name: "Default reasoning effort" })).toHaveValue("medium");

    firstLaunch.unmount();
    const restartedApi = createApi();
    restartedApi.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    restartedApi.threads.list.mockResolvedValue({ data: [thread, secondThread], nextCursor: null });
    restartedApi.threads.read.mockImplementation(async ({ threadId }) => ({ thread: threadId === secondThread.id ? secondThread : thread }));
    window.loom = restartedApi;
    render(<App />);

    expect(await screen.findByRole("button", { name: "Reasoning: High" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare release notes" }));
    expect(await screen.findByRole("button", { name: "Reasoning: Medium" })).toBeInTheDocument();
  });

  it("filters the model picker by Codex and Claude provider", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [
        { model: "gpt-5.6", displayName: "GPT-5.6", provider: "codex", isDefault: true },
        { model: "sonnet", displayName: "Claude Sonnet", provider: "claude" },
        { model: "opus", displayName: "Claude Opus", provider: "claude" }
      ],
      runtime: { state: "ready", connected: true }
    });
    window.loom = api;
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Model: GPT-5.6" }));
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /GPT-5.6/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Claude Opus/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByRole("option", { name: /Claude Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT-5.6/ })).not.toBeInTheDocument();
  });

  it("adds provider marks to model rows without changing generic Markdown tables", async () => {
    const modelTableThread = {
      ...thread,
      turns: [{
        id: "turn-model-table",
        status: "completed",
        items: [{
          id: "agent-model-table",
          type: "agentMessage",
          phase: "final_answer",
          text: "| Model | Context | $/1M in |\n| --- | --- | --- |\n| gpt-4o | 128k | $5.00 |\n| claude-3.5 | 200k | $3.00 |\n| llama-3.1 | 128k | $0.90 |\n\n| Area | State |\n| --- | --- |\n| Runtime | Ready |"
        }]
      }]
    };
    window.loom = createApi(modelTableThread);

    const { container } = render(<App />);
    expect(await screen.findByText("gpt-4o")).toBeInTheDocument();
    expect(container.querySelectorAll(".message-table-wrap [data-model-brand]")).toHaveLength(3);
    expect(container.querySelector('.message-table-wrap [data-model-brand="openai"]')).toHaveAttribute("title", "OpenAI");
    expect(container.querySelector('.message-table-wrap [data-model-brand="anthropic"]')).toHaveAttribute("title", "Anthropic");
    expect(container.querySelector('.message-table-wrap [data-model-brand="meta"]')).toHaveAttribute("title", "Meta");
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("resolves a live approval request", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    act(() => window.loom.emit({
      type: "AttentionRequired",
      payload: { id: 17, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "pnpm test" } },
      at: new Date().toISOString()
    }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(window.loom.approvals.resolve).toHaveBeenCalledWith({ requestId: 17, decision: "accept" }));
  });

  it("applies generated task names everywhere as soon as the runtime publishes them", async () => {
    const { container } = render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: { method: "thread/name/updated", threadId: "thread-1", name: "Authentication session repair" }
    }));

    await waitFor(() => expect(container.querySelector(".task-title")).toHaveTextContent("Authentication session repair"));
    expect(container.querySelector(".toolbar-title strong")).toHaveTextContent("Authentication session repair");
  });

  it("repairs an untitled sidebar entry from the named active-thread snapshot", async () => {
    const untitled = { ...thread, name: null, preview: "" };
    const api = createApi(untitled);
    api.threads.read.mockResolvedValue({ thread: { ...untitled, name: "Authentication session repair" } });
    window.loom = api;

    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".task-title")).toHaveTextContent("Authentication session repair"));
    expect(container.querySelector(".toolbar-title strong")).toHaveTextContent("Authentication session repair");
  });

  it("answers structured user-input requests", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    act(() => window.loom.emit({
      type: "AttentionRequired",
      payload: {
        id: "question-17",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          questions: [{ id: "strategy", header: "Strategy", question: "Which strategy?", options: [{ label: "Safe", description: "Use the conservative path" }] }]
        }
      },
      at: new Date().toISOString()
    }));

    await user.click(await screen.findByRole("radio", { name: /Safe/ }));
    await waitFor(() => expect(window.loom.questions.respond).toHaveBeenCalledWith({
      requestId: "question-17",
      action: "answer",
      answers: { strategy: "Safe" }
    }));
  });

  it("wires unrestricted permission modes and MCP elicitation forms", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const permissions = await screen.findByRole("combobox", { name: "Default permissions" });
    expect(within(permissions).getByRole("option", { name: "Auto-review" })).toBeInTheDocument();
    fireEvent.change(permissions, { target: { value: "full-access" } });
    expect(localStorage.getItem("loom.permissionMode")).toBe("full-access");
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));

    act(() => window.loom.emit({
      type: "AttentionRequired",
      payload: {
        id: "elicitation-17",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          serverName: "Browser",
          mode: "form",
          message: "Choose how Loom should continue",
          requestedSchema: {
            type: "object",
            properties: { destination: { type: "string", title: "Destination" } },
            required: ["destination"]
          }
        }
      }
    }));

    await user.type(await screen.findByRole("textbox", { name: "Destination" }), "Preview");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(window.loom.elicitations.respond).toHaveBeenCalledWith({
      requestId: "elicitation-17",
      action: "accept",
      content: { destination: "Preview" }
    }));
  });

  it("keeps work traces open while running and collapses them after the final answer", async () => {
    const liveItems = [
      { id: "user-live", type: "userMessage", content: [{ type: "text", text: "Check the task" }] },
      { id: "reasoning-live", type: "reasoning", summary: ["Checking the current flow"] },
      { id: "command-live", type: "commandExecution", command: "pnpm test", status: "inProgress" }
    ];
    const liveThread = {
      ...thread,
      status: { type: "active" },
      turns: [{ id: "turn-live", status: "inProgress", items: liveItems }]
    };
    window.loom = createApi(liveThread);

    render(<App />);
    const runningToggle = await screen.findByRole("button", { name: "Running command" });
    expect(document.querySelector(".task-row.active [data-reasoning-orb]")).toBeInTheDocument();
    expect(runningToggle).toHaveAttribute("aria-expanded", "true");
    expect(runningToggle.querySelector('[data-reasoning-orb] > [aria-hidden="true"]')).toBeInTheDocument();

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Inspect the project", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toBeInTheDocument());
    const workingTrace = runningToggle.closest(".working-trace");
    const taskProgress = document.querySelector(".conversation-column .task-progress");
    expect(taskProgress).toHaveTextContent("Inspect the project");
    expect(workingTrace.compareDocumentPosition(taskProgress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(taskProgress.querySelector(".progress-step.inProgress .spin-icon")).toBeInTheDocument();
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "0%" });
    const collapseProgress = screen.getByRole("button", { name: "Collapse task progress" });
    fireEvent.click(collapseProgress);
    expect(taskProgress).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand task progress" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand task progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Open task map" }));
    expect(screen.getByRole("complementary", { name: "Task inspector" })).toHaveClass("open");
    expect(screen.getByRole("button", { name: "Hide task map" })).toBeInTheDocument();

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [
          { step: "One", status: "completed" },
          { step: "Two", status: "completed" },
          { step: "Three", status: "completed" },
          { step: "Four", status: "in_progress" },
          { step: "Five", status: "in_progress" },
          { step: "Six", status: "pending" }
        ]
      }
    }));
    await waitFor(() => expect(taskProgress).toHaveTextContent("3 / 6"));
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "50%" });

    act(() => window.loom.emit({
      type: "AgentUpdated",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-live",
        item: {
          id: "collab-live",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["agent-live"],
          prompt: "Audit runtime safety",
          agentsStates: { "agent-live": { status: "running", message: "Inspecting Electron" } }
        }
      }
    }));

    expect(await screen.findByText("Delegated agent")).toBeInTheDocument();
    expect(screen.getByText("Working · Inspecting Electron")).toBeInTheDocument();

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Inspect the project", status: "completed" }]
      }
    }));
    await waitFor(() => expect(taskProgress).toHaveTextContent("1 / 1"));
    expect(taskProgress.querySelector(".progress-track > span")).toHaveStyle({ width: "100%" });

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/completed",
        threadId: "thread-1",
        turn: {
          id: "turn-live",
          status: "completed",
          items: [
            liveItems[0],
            liveItems[1],
            { ...liveItems[2], status: "completed", aggregatedOutput: "13 tests passed" },
            { id: "final-live", type: "agentMessage", text: "Everything passes.", phase: "final_answer" }
          ]
        }
      }
    }));

    const settledToggle = await screen.findByRole("button", { name: "Ran 1 action" });
    await waitFor(() => expect(settledToggle).toHaveAttribute("aria-expanded", "false"));
    const disclosure = document.getElementById(settledToggle.getAttribute("aria-controls"));
    expect(disclosure).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("Everything passes.")).toBeInTheDocument();

    fireEvent.click(settledToggle);
    expect(settledToggle).toHaveAttribute("aria-expanded", "true");
    expect(disclosure).toHaveAttribute("aria-hidden", "false");
  });

  it("pauses stale plan activity while a task is inactive and resumes it with the next turn", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Measure transport overhead", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toBeInTheDocument());
    const taskProgress = document.querySelector(".conversation-column .task-progress");
    expect(taskProgress).toHaveAttribute("data-active", "false");
    expect(taskProgress).toHaveTextContent("Task is inactive");
    expect(taskProgress.querySelector(".progress-step.inProgress.inactive")).toBeInTheDocument();
    expect(taskProgress.querySelector(".progress-step .spin-icon")).not.toBeInTheDocument();

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: { method: "turn/started", threadId: "thread-1", turn: { id: "turn-resumed", status: "inProgress", items: [] } }
    }));
    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "turn/plan/updated",
        threadId: "thread-1",
        plan: [{ step: "Measure transport overhead", status: "in_progress" }]
      }
    }));

    await waitFor(() => expect(document.querySelector(".conversation-column .task-progress")).toHaveAttribute("data-active", "true"));
    const resumedTaskProgress = document.querySelector(".conversation-column .task-progress");
    expect(resumedTaskProgress.querySelector(".progress-step.inProgress .spin-icon")).toBeInTheDocument();
  });

  it("preserves the reading position when live reasoning arrives after scrolling up", async () => {
    const readingThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-reading",
        status: "inProgress",
        items: [{ id: "user-reading", type: "userMessage", content: [{ type: "text", text: "Review the project" }] }]
      }]
    };
    window.loom = createApi(readingThread);

    render(<App />);
    await screen.findByText("Review the project");
    await waitFor(() => expect(document.querySelector(".conversation-column")).not.toBeNull());
    const scroller = document.querySelector(".conversation-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);

    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/completed",
        threadId: "thread-1",
        turnId: "turn-reading",
        item: { id: "reasoning-reading", type: "reasoning", summary: ["Tracing another execution path"] }
      }
    }));

    expect(await screen.findByText("Tracing another execution path")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(180);

    scroller.scrollTop = 790;
    fireEvent.scroll(scroller);
    act(() => window.loom.emit({
      type: "RuntimeEvent",
      payload: {
        method: "item/agentMessage/delta",
        threadId: "thread-1",
        turnId: "turn-reading",
        itemId: "commentary-reading",
        delta: "Still working"
      }
    }));

    await screen.findByText("Still working");
    await waitFor(() => expect(scroller.scrollTop).toBe(1400));
  });

  it("jumps to a selected prompt from the thread preview rail", async () => {
    const longThread = {
      ...thread,
      turns: [1, 2, 3].map((number) => ({
        id: `turn-${number}`,
        status: "completed",
        items: [
          { id: `user-${number}`, type: "userMessage", content: [{ type: "text", text: `Prompt ${number}` }] },
          { id: `agent-${number}`, type: "agentMessage", text: `Response ${number}`, phase: "final_answer" },
        ],
      })),
    };
    window.loom = createApi(longThread);

    render(<App />);
    await screen.findByText("Response 3");
    const scroller = document.querySelector(".conversation-scroll");
    const target = document.getElementById("prompt-user-2");
    scroller.scrollTo = vi.fn();
    scroller.getBoundingClientRect = () => ({ top: 58 });
    target.getBoundingClientRect = () => ({ top: 500 });

    fireEvent.click(screen.getByRole("button", { name: "Jump to prompt 2: Prompt 2" }));

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 414, behavior: "smooth" });

    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Prompts in this thread" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Close preview workspace" })[0]);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Prompts in this thread" })).toBeInTheDocument());
  });

  it("shows the morphing reasoning orb while waiting for the first activity event", async () => {
    const waitingThread = {
      ...thread,
      status: { type: "active" },
      turns: [{
        id: "turn-waiting",
        status: "inProgress",
        items: [{ id: "user-waiting", type: "userMessage", content: [{ type: "text", text: "Start the work" }] }]
      }]
    };
    window.loom = createApi(waitingThread);

    render(<App />);
    const thinkingToggle = await screen.findByRole("button", { name: "Thinking" });
    expect(thinkingToggle.querySelector("[data-reasoning-orb]")).toBeInTheDocument();
    expect(thinkingToggle.querySelector('[data-reasoning-orb] > [aria-hidden="true"]')).toBeInTheDocument();
  });

  it("creates a real thread before sending the first new-task message", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "Implement the refresh flow");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.loom.threads.create).toHaveBeenCalledWith({ projectId: "project-1", model: "gpt-5.6", permissionMode: "workspace-write" }));
    expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-new",
      text: "Implement the refresh flow",
      permissionMode: "workspace-write"
    }));
    expect(window.loom.threads.read).not.toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-new"
    });
  });

  it("opens a new task from the sidebar shortcut", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("heading", { name: "What should Codex work on?" })).toBeInTheDocument();
  });

  it("discovers and autocompletes Codex commands from the slash menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Message Codex" });

    await user.type(composer, "/");
    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getByRole("option", { name: /\/model/ })).toHaveAttribute("aria-selected", "true");
    expect(within(commands).getByRole("option", { name: /\/permissions/ })).toBeInTheDocument();
    expect(within(commands).getByRole("option", { name: /\/compact/ })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(composer).toHaveValue("/fast ");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    expect(window.loom.turns.start).not.toHaveBeenCalled();
  });

  it("filters slash commands and keeps unknown commands sendable", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Message Codex" });

    await user.type(composer, "/compact");
    const commands = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(commands).getAllByRole("option")).toHaveLength(1);
    expect(within(commands).getByRole("option", { name: /\/compact/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, "/not-a-loom-command{Enter}");
    await waitFor(() => expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({ text: "/not-a-loom-command" })));
  });

  it("does not submit a new task twice when send is clicked repeatedly", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Only once");
    const send = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(send);
    fireEvent.click(send);

    await waitFor(() => expect(window.loom.turns.start).toHaveBeenCalledTimes(1));
    expect(window.loom.threads.create).toHaveBeenCalledTimes(1);
  });

  it("pastes image attachments and sends an image-only prompt", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" });

    fireEvent.paste(composer, { clipboardData: { files: [image], items: [{ kind: "file", type: image.type, getAsFile: () => image }] } });

    expect(await screen.findByRole("img", { name: "clipboard.png" })).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      images: [expect.stringMatching(/^data:image\/png;base64,/)]
    })));
  });

  it("accepts dropped images anywhere in Loom and lets the user remove them", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const image = new File([new Uint8Array([82, 73, 70, 70])], "dropped.webp", { type: "image/webp" });
    const transfer = { files: [image], items: [{ kind: "file", type: image.type }] };

    fireEvent.dragEnter(window, { dataTransfer: transfer });
    expect(screen.getByText("Drop images to attach")).toBeInTheDocument();
    fireEvent.drop(window, { dataTransfer: transfer });

    expect(await screen.findByRole("img", { name: "dropped.webp" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove dropped.webp" }));
    expect(screen.queryByRole("img", { name: "dropped.webp" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("uses accessible model, reasoning, and permission pickers", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Permissions: Workspace access" }));
    expect(screen.getByRole("listbox", { name: "Permissions" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Read only/ }));
    expect(screen.getByRole("button", { name: "Permissions: Read only" })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Model: GPT-5.6" }));
    expect(screen.getByRole("listbox", { name: "Model" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Reasoning: High" }));
    expect(screen.getByRole("listbox", { name: "Reasoning" })).toBeInTheDocument();
  });

  it("enables fast mode for supported Codex models and sends the priority service tier", async () => {
    const user = userEvent.setup();
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{
        id: "codex:gpt-5.6",
        model: "gpt-5.6",
        displayName: "GPT-5.6",
        provider: "codex",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Faster inference with increased usage." }]
      }],
      runtime: { state: "ready", connected: true }
    });
    api.turns.start.mockResolvedValue({ turn: { id: "turn-fast", status: "completed", items: [] } });
    window.loom = api;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    const fastToggle = screen.getByRole("button", { name: "Fast mode" });
    expect(fastToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(fastToggle);
    expect(fastToggle).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Ship this quickly");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.threads.create).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "priority" })));
    expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "priority" }));

    await waitFor(() => expect(fastToggle).toBeEnabled());
    await user.click(fastToggle);
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Return to standard speed");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(api.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ serviceTier: null })));
  });

  it("does not show fast mode for Claude models", async () => {
    const api = createApi();
    api.app.bootstrap.mockResolvedValue({
      projects: [project],
      models: [{
        id: "claude:claude-sonnet-4-6",
        model: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "claude",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Ignored for non-Codex providers." }]
      }],
      runtime: { state: "ready", connected: true }
    });
    window.loom = api;

    render(<App />);
    await screen.findByText("I traced the current flow.");

    expect(screen.queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
  });

  it("keeps composer permission changes scoped to their thread", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Permissions: Workspace access" }));
    await user.click(screen.getByRole("option", { name: /Read only/ }));
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Inspect this thread without edits");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(window.loom.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "read-only" })));

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByRole("button", { name: "Permissions: Workspace access" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Start with the default access");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.loom.threads.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "workspace-write" })));
    expect(window.loom.turns.start).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "workspace-write" }));
  });

  it("shows events emitted immediately by a newly created thread", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const startedTurn = { id: "turn-new-live", status: "inProgress", items: [] };
    liveApi.turns.start = vi.fn(async ({ threadId }) => {
      liveApi.emit({
        type: "RuntimeEvent",
        payload: { method: "turn/started", threadId, turn: startedTurn }
      });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/agentMessage/delta",
          threadId,
          turnId: startedTurn.id,
          itemId: "message-live",
          delta: "Live without switching tasks"
        }
      });
      return { turn: startedTurn };
    });
    window.loom = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "Start immediately");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Live without switching tasks")).toBeInTheDocument();
    expect(liveApi.threads.read).not.toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-new"
    });
  });

  it("keeps follow-up prompts and answers visible without reopening the task", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const followUpTurn = { id: "turn-follow-up", status: "inProgress", items: [] };
    const refreshedThread = {
      ...thread,
      turns: [
        ...thread.turns,
        {
          id: followUpTurn.id,
          status: "completed",
          items: [
            { id: "user-follow-up", type: "userMessage", content: [{ type: "text", text: "What about retries?" }] },
            { id: "answer-follow-up", type: "agentMessage", text: "Retries are covered too.", phase: "final_answer" }
          ]
        }
      ]
    };
    liveApi.turns.start = vi.fn().mockResolvedValue({ turn: followUpTurn });
    liveApi.threads.read
      .mockResolvedValueOnce({ thread })
      .mockResolvedValue({ thread: refreshedThread });
    window.loom = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "What about retries?");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("What about retries?")).toBeInTheDocument();
    expect(await screen.findByText("Retries are covered too.", {}, { timeout: 2500 })).toBeInTheDocument();
    expect(liveApi.threads.read).toHaveBeenCalledWith({ projectId: "project-1", threadId: "thread-1" });
  });

  it("reconciles live and persisted turn aliases without duplicate messages or reasoning", async () => {
    const user = userEvent.setup();
    const liveApi = createApi();
    const liveTurn = { id: "turn-live-alias", status: "inProgress", items: [] };
    const prompt = "Give me a rundown";
    const commentary = "I’ll inspect the project first.";
    const persistedThread = {
      ...thread,
      turns: [
        ...thread.turns,
        {
          id: "turn-persisted-alias",
          status: "completed",
          items: [
            { id: "persisted-user", type: "userMessage", content: [{ type: "text", text: prompt }] },
            { id: "persisted-commentary", type: "agentMessage", text: commentary, phase: "commentary" },
            { id: "persisted-answer", type: "agentMessage", text: "Here is the rundown.", phase: "final_answer" }
          ]
        }
      ]
    };
    liveApi.turns.start = vi.fn(async ({ threadId }) => {
      liveApi.emit({ type: "RuntimeEvent", payload: { method: "turn/started", threadId, turn: liveTurn } });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/completed",
          threadId,
          turnId: liveTurn.id,
          item: { id: "live-user", type: "userMessage", content: [{ type: "text", text: prompt }] }
        }
      });
      liveApi.emit({
        type: "RuntimeEvent",
        payload: {
          method: "item/completed",
          threadId,
          turnId: liveTurn.id,
          item: { id: "live-commentary", type: "agentMessage", text: commentary, phase: "commentary" }
        }
      });
      return { turn: liveTurn };
    });
    liveApi.threads.read
      .mockResolvedValueOnce({ thread })
      .mockResolvedValue({ thread: persistedThread });
    window.loom = liveApi;

    render(<App />);
    await screen.findByText("I traced the current flow.");
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, prompt);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Here is the rundown.", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getAllByText(prompt)).toHaveLength(1);
    expect(screen.getAllByText(commentary)).toHaveLength(1);
  });

  it("deletes a conversation from the task list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByText("I traced the current flow.");

    fireEvent.click(screen.getByRole("button", { name: "Delete Refactor authentication" }));

    await waitFor(() => expect(window.loom.threads.archive).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-1"
    }));
    expect(screen.queryByRole("button", { name: "Delete Refactor authentication" })).not.toBeInTheDocument();
  });

  it("resizes the sidebar with pointer and keyboard controls", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    const app = separator.closest(".loom-app");

    fireEvent.pointerDown(separator, { clientX: 296 });
    fireEvent.pointerMove(window, { clientX: 352 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(app).toHaveStyle({ "--sidebar-width": "320px" }));
    expect(localStorage.getItem("loom.sidebarWidth")).toBe("320");

    fireEvent.keyDown(separator, { key: "End" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "360"));
    expect(localStorage.getItem("loom.sidebarWidth")).toBe("360");
  });

  it("changes sidebar expansion only from the explicit toggle", async () => {
    localStorage.setItem("loom.sidebarPinned", "false");
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });

    expect(sidebar).toHaveAttribute("data-expanded", "false");
    fireEvent.mouseEnter(sidebar);
    fireEvent.mouseLeave(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Expand navigation labels" }));
    await waitFor(() => expect(sidebar).toHaveAttribute("data-expanded", "true"));
    fireEvent.mouseLeave(sidebar);
    expect(sidebar).toHaveAttribute("data-expanded", "true");
  });

  it("opens a tabbed preview workspace and temporarily collapses the sidebar", async () => {
    render(<App />);
    await screen.findByText("I traced the current flow.");
    const sidebar = screen.getByRole("complementary", { name: "Primary navigation" });

    expect(sidebar).toHaveAttribute("data-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Open preview workspace" }));

    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(document.querySelector(".task-workspace")).toHaveClass("preview-mode");
    expect(document.querySelector(".loom-app")).toHaveAttribute("data-preview-open", "true");
    expect(sidebar).toHaveAttribute("data-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.loom.browser.create).toHaveBeenCalledWith({ workspaceId: "thread-1" });

    fireEvent.click(screen.getAllByRole("button", { name: "Close preview workspace" })[0]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Preview workspace" })).not.toBeInTheDocument());
    expect(sidebar).toHaveAttribute("data-expanded", "true");
  });

  it("keeps preview and editor state isolated per thread", async () => {
    const secondThread = {
      ...thread,
      id: "thread-2",
      name: "Second task",
      preview: "Second task",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [{ id: "agent-2", type: "agentMessage", text: "Second task response.", phase: "final_answer" }]
      }]
    };
    window.loom = createApi([thread, secondThread]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open src/runtime.js" }));
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Second task" }));
    await screen.findByText("Second task response.");
    expect(screen.queryByRole("region", { name: "Preview workspace" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open preview workspace" }));
    expect(await screen.findByRole("region", { name: "Preview workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "runtime.js" })).not.toBeInTheDocument();
    expect(window.loom.browser.state).toHaveBeenCalledWith({ workspaceId: "thread-2" });

    await user.click(screen.getByRole("button", { name: "Refactor authentication" }));
    await screen.findByText("I traced the current flow.");
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toBeInTheDocument();
  });

  it("opens response file links in a tab and edits the file in place", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");

    await user.click(screen.getByRole("button", { name: "Open src/runtime.js" }));
    expect(await screen.findByRole("tab", { name: "runtime.js" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("export const ready = true;")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit runtime.js" });
    fireEvent.change(editor, { target: { value: "export const ready = false;\n" } });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(window.loom.files.write).toHaveBeenCalledWith({
      projectId: "project-1",
      path: "/work/aurora/src/runtime.js",
      content: "export const ready = false;\n",
      expectedMtimeMs: 1
    }));
  });

  it("replaces the active composer with a sequential question flow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    expect(screen.getByRole("textbox", { name: "Message Codex" })).toBeInTheDocument();

    act(() => window.loom.emit({
      type: "AttentionRequired",
      payload: {
        id: "question-1",
        method: "loom/requestUserInput",
        projectId: project.id,
        params: {
          threadId: thread.id,
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "How should Loom proceed?",
              options: [
                { label: "Build it", description: "Implement the complete flow.", recommended: true },
                { label: "Plan only", description: "Stop after the implementation plan.", recommended: false }
              ]
            },
            {
              id: "scope",
              header: "Scope",
              question: "Where should it be available?",
              options: [
                { label: "Every model", description: "Expose it across all providers.", recommended: true },
                { label: "Codex only", description: "Limit the first release.", recommended: false }
              ]
            }
          ]
        }
      }
    }));

    expect(await screen.findByText("How should Loom proceed?")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message Codex" })).not.toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Build it/ }));
    expect(await screen.findByText("Where should it be available?", {}, { timeout: 1000 })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Every model/ }));

    await waitFor(() => expect(window.loom.questions.respond).toHaveBeenCalledWith({
      requestId: "question-1",
      action: "answer",
      answers: { approach: "Build it", scope: "Every model" }
    }));
    expect(await screen.findByRole("textbox", { name: "Message Codex" })).toBeInTheDocument();
  });
});
