import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import {
  findTaskMatch,
  ProactiveStewardship,
  workPatternFromTurn
} from "../electron/runtime/proactive-stewardship.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-stewardship-"));
  temporaryDirectories.push(directory);
  const database = new PixiceDatabase(directory);
  const now = new Date().toISOString();
  database.upsertProject({ id: "project-1", canonicalPath: "/workspace", displayName: "Workspace", createdAt: now, updatedAt: now });
  return database;
}

function completedTurn(id = "turn-1") {
  return {
    id,
    status: "completed",
    items: [
      { id: `${id}:prompt`, type: "userMessage", content: [{ type: "text", text: "Run the desktop release check" }] },
      { id: `${id}:status`, type: "commandExecution", command: "git status --short", status: "completed" },
      { id: `${id}:test`, type: "commandExecution", command: "pnpm test", status: "completed" },
      { id: `${id}:internal`, type: "dynamicToolCall", tool: "pixice_board__move_task", status: "completed" },
      { id: `${id}:answer`, type: "agentMessage", text: "Done", phase: "final_answer" }
    ]
  };
}

describe("proactive task stewardship", () => {
  it("only attaches a unique high-confidence board match and moves it to active", () => {
    const tasks = [
      { id: "release", title: "Run desktop release check", column: "ready", threadId: null },
      { id: "docs", title: "Update documentation", column: "backlog", threadId: null }
    ];
    expect(findTaskMatch(tasks, { prompt: "Please run the desktop release check" })?.task.id).toBe("release");
    expect(findTaskMatch(tasks, { prompt: "Please work on the project" })).toBeNull();
    expect(findTaskMatch([{ id: "broad", title: "Release", column: "ready", threadId: null }], { prompt: "Review the release notes" })).toBeNull();

    const database = setup();
    database.createBoardTask({ id: "release", projectId: "project-1", title: "Run desktop release check", column: "ready" });
    const onBoardChange = vi.fn();
    const service = new ProactiveStewardship({ database, onBoardChange });
    const task = service.startTurn({ projectId: "project-1", threadId: "thread-1", turnId: "turn-start", prompt: "Please run the desktop release check" });

    expect(task).toMatchObject({ id: "release", threadId: "thread-1", column: "active" });
    expect(task.latestActivity).toMatchObject({ kind: "linked", turnId: "turn-start" });
    expect(onBoardChange).toHaveBeenCalledTimes(3);
    expect(service.list("project-1", "thread-1")).toEqual([
      expect.objectContaining({ type: "task-stewarded", status: "open" })
    ]);
    database.db.close();
  });

  it("suggests closing attached work after a successful turn", async () => {
    const database = setup();
    database.createBoardTask({ id: "task-1", projectId: "project-1", title: "Release", column: "active", threadId: "thread-1" });
    const service = new ProactiveStewardship({ database });

    service.completeTurn({ projectId: "project-1", threadId: "thread-1", turn: completedTurn() });
    const suggestion = service.list("project-1", "thread-1").find((candidate) => candidate.type === "task-status");
    expect(suggestion).toMatchObject({ payload: { taskId: "task-1", targetColumn: "done" } });

    await service.resolve({ projectId: "project-1", suggestionId: suggestion.id, decision: "accept" });
    expect(database.getBoardTask("task-1").column).toBe("done");
    expect(service.list("project-1", "thread-1")).toEqual([]);
    database.db.close();
  });

  it("offers one manual workflow draft after the same successful sequence repeats", async () => {
    const database = setup();
    const createWorkflowDraft = vi.fn(async (proposal) => ({ id: "workflow-1", name: proposal.suggestedName }));
    const service = new ProactiveStewardship({ database, threshold: 3, createWorkflowDraft });

    for (let index = 1; index <= 3; index += 1) {
      service.completeTurn({ projectId: "project-1", threadId: "thread-1", turn: completedTurn(`turn-${index}`) });
    }
    const suggestions = service.list("project-1", "thread-1");
    const suggestion = suggestions.find((candidate) => candidate.type === "workflow-pattern");
    expect(suggestion).toMatchObject({
      message: "Pixice has seen this sequence 3 times.",
      payload: { count: 3, suggestedName: "Run the desktop release check" }
    });
    expect(suggestion.payload.steps.map((step) => step.action)).toEqual(["command:git:status", "command:pnpm:test"]);

    service.completeTurn({ projectId: "project-1", threadId: "thread-1", turn: completedTurn("turn-4") });
    expect(service.list("project-1", "thread-1").filter((candidate) => candidate.type === "workflow-pattern")).toHaveLength(1);

    await service.resolve({ projectId: "project-1", suggestionId: suggestion.id, decision: "accept" });
    expect(createWorkflowDraft).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", count: 3 }));
    database.db.close();
  });

  it("ignores incomplete, single-step, and internal-only traces", () => {
    expect(workPatternFromTurn({ id: "failed", status: "failed", items: completedTurn().items })).toBeNull();
    expect(workPatternFromTurn({
      id: "internal",
      status: "completed",
      items: [
        { type: "dynamicToolCall", tool: "pixice_board__list_tasks", status: "completed" },
        { type: "commandExecution", command: "pnpm test", status: "completed" }
      ]
    })).toBeNull();
  });
});
