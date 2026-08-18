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
  const browserState = {
    native: false,
    activeTabId: "browser-1",
    tabs: [{ id: "browser-1", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }]
  };
  const scopedBrowserState = (payload = {}) => ({ ...browserState, workspaceId: payload.workspaceId });
  const api = {
    emit(event) { eventListener?.(event); },
    app: { bootstrap: vi.fn().mockResolvedValue({ projects: [project], models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], runtime: { state: "ready", connected: true } }) },
    runtime: { status: vi.fn().mockResolvedValue({ state: "ready", connected: true }) },
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

  it("restores the default reasoning effort after an app restart", async () => {
    const models = [{
      id: "gpt",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    }];
    const firstApi = createApi();
    firstApi.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    window.loom = firstApi;

    const firstLaunch = render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const effortSelect = await screen.findByRole("combobox", { name: "Default reasoning effort" });
    expect(effortSelect).toHaveValue("medium");
    fireEvent.change(effortSelect, { target: { value: "high" } });
    expect(localStorage.getItem("loom.effort")).toBe("high");
    firstLaunch.unmount();

    const restartedApi = createApi();
    restartedApi.app.bootstrap.mockResolvedValue({ projects: [project], models, runtime: { state: "ready", connected: true } });
    window.loom = restartedApi;
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.keyDown(window, { key: ",", metaKey: true });

    expect(await screen.findByRole("combobox", { name: "Default reasoning effort" })).toHaveValue("high");
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
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(window.loom.requests.respond).toHaveBeenCalledWith({
      requestId: "question-17",
      answers: { strategy: { answers: ["Safe"] } }
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
});
