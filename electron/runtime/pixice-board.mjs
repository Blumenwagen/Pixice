import { randomUUID } from "node:crypto";
import { z } from "zod";

export const PIXICE_BOARD_NAMESPACE = "pixice_board";
export const PIXICE_BOARD_MCP_TOOLS = new Set([
  "mcp__pixice_board__list_tasks",
  "mcp__pixice_board__create_task",
  "mcp__pixice_board__update_task",
  "mcp__pixice_board__move_task",
  "mcp__pixice_board__delete_task",
  "mcp__pixice_board__attach_thread"
]);

const column = z.enum(["backlog", "ready", "active", "done"]);
const taskId = z.string().trim().min(1).max(160);
const title = z.string().trim().min(1).max(240);
const description = z.string().trim().max(10_000);

export const pixiceBoardToolShapes = {
  list_tasks: { column: column.optional() },
  create_task: {
    title,
    description: description.optional(),
    column: column.default("backlog"),
    attachCurrentThread: z.boolean().default(false)
  },
  update_task: {
    taskId,
    title: title.optional(),
    description: description.optional()
  },
  move_task: {
    taskId,
    column,
    beforeTaskId: taskId.optional()
  },
  delete_task: { taskId },
  attach_thread: {
    taskId,
    threadId: taskId.optional()
  }
};

const schemas = Object.fromEntries(Object.entries(pixiceBoardToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]));
schemas.update_task = schemas.update_task.refine(
  (input) => input.title !== undefined || input.description !== undefined,
  "A task change is required"
);

const toolSchemas = {
  list_tasks: {
    type: "object",
    properties: { column: { type: "string", enum: ["backlog", "ready", "active", "done"] } },
    additionalProperties: false
  },
  create_task: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 240 },
      description: { type: "string", maxLength: 10000 },
      column: { type: "string", enum: ["backlog", "ready", "active", "done"], description: "Defaults to backlog." },
      attachCurrentThread: { type: "boolean", description: "Link this active Pixice thread to the new task. Defaults to false." }
    },
    required: ["title"],
    additionalProperties: false
  },
  update_task: {
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1, maxLength: 160 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      description: { type: "string", maxLength: 10000 }
    },
    required: ["taskId"],
    additionalProperties: false
  },
  move_task: {
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1, maxLength: 160 },
      column: { type: "string", enum: ["backlog", "ready", "active", "done"] },
      beforeTaskId: { type: "string", minLength: 1, maxLength: 160, description: "Place the task before this task. Omit to place it last." }
    },
    required: ["taskId", "column"],
    additionalProperties: false
  },
  delete_task: {
    type: "object",
    properties: { taskId: { type: "string", minLength: 1, maxLength: 160 } },
    required: ["taskId"],
    additionalProperties: false
  },
  attach_thread: {
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1, maxLength: 160 },
      threadId: { type: "string", minLength: 1, maxLength: 160, description: "Defaults to the active Pixice thread." }
    },
    required: ["taskId"],
    additionalProperties: false
  }
};

const descriptions = {
  list_tasks: "Inspect the current project's kanban tasks in board order.",
  create_task: "Add a task to the current project's kanban without starting a new thread.",
  update_task: "Edit a kanban task's title or description.",
  move_task: "Move or reorder a kanban task.",
  delete_task: "Delete a kanban task. This does not delete its linked thread.",
  attach_thread: "Attach a Pixice thread to an existing kanban task. Defaults to the active thread."
};

export const pixiceBoardDynamicTools = [{
  type: "namespace",
  name: PIXICE_BOARD_NAMESPACE,
  description: "Inspect and manage the current Pixice project's kanban board. Tasks exist independently from threads, and may optionally link to a running thread.",
  tools: Object.keys(toolSchemas).map((name) => ({
    type: "function",
    name,
    description: descriptions[name],
    inputSchema: toolSchemas[name]
  }))
}];

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  };
}

export class PixiceBoard {
  constructor({ database, threadContext, onChange }) {
    this.database = database;
    this.threadContext = threadContext;
    this.onChange = onChange;
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Pixice board tools require an active thread");
      const context = this.threadContext(params.threadId);
      if (!context?.projectId) throw new Error("The active thread is not attached to an open Pixice project");
      const schema = schemas[params.tool];
      if (!schema) throw new Error(`Unknown Pixice board tool: ${params.tool}`);
      const input = schema.parse(params.arguments ?? {});
      if (params.tool === "list_tasks") {
        const tasks = this.database.listBoardTasks(context.projectId)
          .filter((task) => !input.column || task.column === input.column);
        return textResult({ projectId: context.projectId, tasks });
      }
      if (params.tool === "create_task") {
        const task = this.database.createBoardTask({
          id: randomUUID(),
          projectId: context.projectId,
          title: input.title,
          description: input.description ?? "",
          column: input.column,
          threadId: input.attachCurrentThread ? params.threadId : null,
          createdByThreadId: params.threadId
        });
        this.#changed("created", task);
        return textResult({ task });
      }
      const task = this.#task(context.projectId, input.taskId);
      if (params.tool === "update_task") {
        const updated = this.database.updateBoardTask(task.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {})
        });
        this.#changed("updated", updated);
        return textResult({ task: updated });
      }
      if (params.tool === "move_task") {
        if (input.beforeTaskId) {
          const beforeTask = this.#task(context.projectId, input.beforeTaskId);
          if (beforeTask.column !== input.column) throw new Error("The target task is not in the destination column");
        }
        const moved = this.database.moveBoardTask(task.id, input.column, input.beforeTaskId ?? null);
        this.#changed("moved", moved);
        return textResult({ task: moved });
      }
      if (params.tool === "delete_task") {
        const deleted = this.database.deleteBoardTask(task.id);
        this.#changed("deleted", deleted);
        return textResult({ deleted: true, task: deleted });
      }
      if (params.tool === "attach_thread") {
        const linkedThreadId = input.threadId ?? params.threadId;
        const linkedContext = this.threadContext(linkedThreadId);
        if (!linkedContext || linkedContext.projectId !== context.projectId) throw new Error("The thread is outside this board's project");
        const updated = this.database.updateBoardTask(task.id, { threadId: linkedThreadId });
        this.#changed("updated", updated);
        return textResult({ task: updated });
      }
      throw new Error(`Unknown Pixice board tool: ${params.tool}`);
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }

  #task(projectId, taskIdValue) {
    const task = this.database.getBoardTask(taskIdValue);
    if (!task || task.projectId !== projectId) throw new Error("Kanban task not found in this project");
    return task;
  }

  #changed(action, task) {
    this.onChange?.({ action, projectId: task.projectId, task });
  }
}
