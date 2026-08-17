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
      create: vi.fn().mockResolvedValue({ thread: { ...thread, id: "thread-new", name: null, preview: "", turns: [] } }),
      archive: vi.fn().mockResolvedValue({})
    },
    turns: {
      start: vi.fn().mockResolvedValue({ turn: { id: "turn-new", status: "inProgress", items: [] } }),
      steer: vi.fn().mockResolvedValue({}),
      interrupt: vi.fn().mockResolvedValue({})
    },
    approvals: { resolve: vi.fn().mockResolvedValue({ ok: true }) },
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
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByText("cookies").tagName).toBe("STRONG");
    expect(screen.getByText("pnpm test").tagName).toBe("CODE");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Runtime")).toHaveAttribute("title", "src/runtime.js");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("heading", { name: "Aurora" })).toBeInTheDocument();
    expect(screen.getByText("auth.js")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Extensions" }));
    expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(window.loom.extensions.list).toHaveBeenCalled();
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
    expect(screen.getByText("Everything passes.")).toBeInTheDocument();

    fireEvent.click(settledToggle);
    expect(settledToggle).toHaveAttribute("aria-expanded", "true");
    expect(disclosure).toHaveAttribute("aria-hidden", "false");
  });

  it("creates a real thread before sending the first new-task message", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("I traced the current flow.");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "Implement the refresh flow");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(window.loom.threads.create).toHaveBeenCalledWith({ projectId: "project-1", model: "gpt-5.6" }));
    expect(window.loom.turns.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      threadId: "thread-new",
      text: "Implement the refresh flow"
    }));
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
