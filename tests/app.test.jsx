import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const api = {
    emit(event) { eventListener?.(event); },
    app: { bootstrap: vi.fn().mockResolvedValue({ projects: [project], models: [{ id: "gpt", model: "gpt-5.6", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], runtime: { state: "ready", connected: true } }) },
    runtime: { status: vi.fn().mockResolvedValue({ state: "ready", connected: true }) },
    projects: { list: vi.fn().mockResolvedValue([project]), open: vi.fn().mockResolvedValue(project) },
    threads: {
      list: vi.fn().mockResolvedValue({ data: [threadValue], nextCursor: null }),
      read: vi.fn().mockResolvedValue({ thread: threadValue }),
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
  it("loads real task data and moves between review and extensions", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));
    expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(window.loom.extensions.list).toHaveBeenCalled();
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
    await waitFor(() => expect(taskProgress).toHaveTextContent("1 of 1 complete"));

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

  it("sends the selected permission mode with new tasks and turns", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    await user.click(screen.getByRole("button", { name: "Permissions: Workspace access" }));
    await user.click(screen.getByRole("option", { name: /Read only/ }));
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Message Codex" }), "Inspect without edits");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.loom.threads.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "read-only" })));
    expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "read-only" }));
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
});
