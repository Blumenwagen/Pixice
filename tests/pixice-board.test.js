import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { PixiceBoard, pixiceBoardDynamicTools } from "../electron/runtime/pixice-board.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function resultValue(result) {
  return JSON.parse(result.contentItems[0].text);
}

describe("Pixice board agent capability", () => {
  it("lets an active agent inspect, add, edit, order, attach, and remove board tasks", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-board-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = new Date().toISOString();
    database.upsertProject({ id: "project-1", canonicalPath: "/workspace", displayName: "Workspace", createdAt: now, updatedAt: now });
    const onChange = vi.fn();
    const board = new PixiceBoard({
      database,
      threadContext: (threadId) => threadId.startsWith("thread-") ? { projectId: "project-1", cwd: "/workspace" } : null,
      onChange
    });

    const created = resultValue(await board.handleToolCall({
      threadId: "thread-agent",
      tool: "create_task",
      arguments: { title: "Write migration", description: "Cover existing records", column: "ready", attachCurrentThread: true }
    })).task;
    expect(created).toMatchObject({ title: "Write migration", column: "ready", threadId: "thread-agent", createdByThreadId: "thread-agent" });

    const updated = resultValue(await board.handleToolCall({
      threadId: "thread-agent",
      tool: "update_task",
      arguments: { taskId: created.id, title: "Write safe migration" }
    })).task;
    expect(updated.title).toBe("Write safe migration");

    const moved = resultValue(await board.handleToolCall({
      threadId: "thread-agent",
      tool: "move_task",
      arguments: { taskId: created.id, column: "active" }
    })).task;
    expect(moved.column).toBe("active");

    const listed = resultValue(await board.handleToolCall({ threadId: "thread-agent", tool: "list_tasks", arguments: {} }));
    expect(listed.tasks).toHaveLength(1);

    const attached = resultValue(await board.handleToolCall({
      threadId: "thread-agent",
      tool: "attach_thread",
      arguments: { taskId: created.id, threadId: "thread-review" }
    })).task;
    expect(attached.threadId).toBe("thread-review");

    const deleted = resultValue(await board.handleToolCall({
      threadId: "thread-agent",
      tool: "delete_task",
      arguments: { taskId: created.id }
    }));
    expect(deleted.deleted).toBe(true);
    expect(database.listBoardTasks("project-1")).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(5);
    database.db.close();
  });

  it("advertises a dedicated Board namespace to Codex", () => {
    expect(pixiceBoardDynamicTools[0]).toMatchObject({
      type: "namespace",
      name: "pixice_board"
    });
    expect(pixiceBoardDynamicTools[0].tools.map((tool) => tool.name)).toEqual([
      "list_tasks", "read_task", "create_task", "update_task", "move_task", "delete_task", "attach_thread",
      "propose_plan", "apply_plan", "bind_workflow"
    ]);
  });

  it("keeps protected deadlines and Workflow execution under user control", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-board-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = new Date().toISOString();
    database.upsertProject({ id: "project-1", canonicalPath: "/workspace", displayName: "Workspace", createdAt: now, updatedAt: now });
    database.createBoardTask({
      id: "task-1", projectId: "project-1", title: "Release",
      schedule: { hardDeadline: "2026-08-31T16:00:00.000Z", timezone: "UTC", lockedFields: ["hardDeadline"] }
    });
    const resolveWorkflow = vi.fn(async () => ({ id: "workflow-1" }));
    const board = new PixiceBoard({ database, threadContext: () => ({ projectId: "project-1", cwd: "/workspace" }), resolveWorkflow });

    const deadlineChange = resultValue(await board.handleToolCall({
      threadId: "thread-agent", tool: "update_task",
      arguments: { taskId: "task-1", schedule: { hardDeadline: "2026-09-01T16:00:00.000Z" } }
    }));
    expect(deadlineChange.error).toMatch(/protected/i);

    const enabledBinding = resultValue(await board.handleToolCall({
      threadId: "thread-agent", tool: "bind_workflow",
      arguments: { taskId: "task-1", workflowId: "workflow-1", triggerType: "entered-ready", enabled: true }
    }));
    expect(enabledBinding.error).toMatch(/user must enable/i);

    const prepared = resultValue(await board.handleToolCall({
      threadId: "thread-agent", tool: "bind_workflow",
      arguments: { taskId: "task-1", workflowId: "workflow-1", triggerType: "entered-ready" }
    }));
    expect(prepared.binding.enabled).toBe(false);
    expect(resolveWorkflow).toHaveBeenCalledWith("project-1", "workflow-1");
    database.db.close();
  });
});
