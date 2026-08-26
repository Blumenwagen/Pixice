import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildTaskPlan, taskPlanInputSchema } from "./task-scheduler.mjs";

export const PIXICE_BOARD_NAMESPACE = "pixice_board";
export const PIXICE_BOARD_MCP_TOOLS = new Set([
  "mcp__pixice_board__list_tasks",
  "mcp__pixice_board__read_task",
  "mcp__pixice_board__create_task",
  "mcp__pixice_board__update_task",
  "mcp__pixice_board__move_task",
  "mcp__pixice_board__delete_task",
  "mcp__pixice_board__attach_thread",
  "mcp__pixice_board__propose_plan",
  "mcp__pixice_board__apply_plan",
  "mcp__pixice_board__bind_workflow"
]);

const column = z.enum(["backlog", "ready", "active", "done"]);
const taskId = z.string().trim().min(1).max(160);
const title = z.string().trim().min(1).max(240);
const description = z.string().trim().max(10_000);
const taskKind = z.enum(["task", "milestone", "event"]);
const priority = z.enum(["low", "normal", "high", "urgent"]);
const schedule = z.object({
  plannedStart: z.string().datetime().nullable().optional(),
  plannedEnd: z.string().datetime().nullable().optional(),
  hardDeadline: z.string().datetime().nullable().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  constraintType: z.enum(["flexible", "as-soon-as-possible", "fixed-start", "fixed-window"]).optional(),
  lockedFields: z.array(z.enum(["plannedStart", "plannedEnd", "hardDeadline"])).max(3).optional(),
  autoSchedule: z.boolean().optional(),
  explanation: z.string().max(2_000).optional()
}).strict();
const dependency = z.object({
  dependsOnTaskId: taskId,
  type: z.literal("finish-to-start").default("finish-to-start"),
  lagMinutes: z.number().int().min(0).max(525_600).default(0)
}).strict();

export const pixiceBoardToolShapes = {
  list_tasks: { column: column.optional() },
  read_task: { taskId },
  create_task: {
    title,
    description: description.optional(),
    column: column.default("backlog"),
    attachCurrentThread: z.boolean().default(false),
    kind: taskKind.default("task"),
    priority: priority.default("normal"),
    estimateMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
    owner: z.string().trim().max(160).optional(),
    schedule: schedule.optional(),
    dependencies: z.array(dependency).max(100).optional()
  },
  update_task: {
    taskId,
    title: title.optional(),
    description: description.optional(),
    kind: taskKind.optional(),
    priority: priority.optional(),
    estimateMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
    owner: z.string().trim().max(160).optional(),
    schedule: schedule.nullable().optional(),
    dependencies: z.array(dependency).max(100).optional(),
    expectedRevision: z.number().int().positive().optional(),
    expectedScheduleRevision: z.number().int().nonnegative().optional()
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
  },
  propose_plan: taskPlanInputSchema.shape,
  apply_plan: { proposalId: taskId },
  bind_workflow: {
    taskId,
    workflowId: taskId,
    triggerNodeId: taskId.optional(),
    triggerType: z.enum(["planned-start-reached", "deadline-approaching", "entered-ready", "dependencies-completed", "became-overdue", "schedule-changed"]),
    enabled: z.boolean().default(false),
    missedTriggerPolicy: z.enum(["skip", "ask", "notify", "run"]).default("ask")
  }
};

const schemas = Object.fromEntries(Object.entries(pixiceBoardToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]));
schemas.update_task = schemas.update_task.refine(
  (input) => Object.keys(input).some((key) => !["taskId", "expectedRevision", "expectedScheduleRevision"].includes(key)),
  "A task change is required"
);

const toolSchemas = {
  list_tasks: {
    type: "object",
    properties: { column: { type: "string", enum: ["backlog", "ready", "active", "done"] } },
    additionalProperties: false
  },
  read_task: {
    type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["taskId"], additionalProperties: false
  },
  create_task: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 240 },
      description: { type: "string", maxLength: 10000 },
      column: { type: "string", enum: ["backlog", "ready", "active", "done"], description: "Defaults to backlog." },
      attachCurrentThread: { type: "boolean", description: "Link this active Pixice thread to the new task. Defaults to false." }
      ,kind: { type: "string", enum: ["task", "milestone", "event"] }
      ,priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
      ,estimateMinutes: { type: ["integer", "null"], minimum: 0, maximum: 525600 }
      ,owner: { type: "string", maxLength: 160 }
      ,schedule: { type: "object", additionalProperties: true }
      ,dependencies: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 100 }
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
      ,kind: { type: "string", enum: ["task", "milestone", "event"] }
      ,priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
      ,estimateMinutes: { type: ["integer", "null"], minimum: 0, maximum: 525600 }
      ,owner: { type: "string", maxLength: 160 }
      ,schedule: { type: ["object", "null"], additionalProperties: true }
      ,dependencies: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 100 }
      ,expectedRevision: { type: "integer", minimum: 1 }
      ,expectedScheduleRevision: { type: "integer", minimum: 0 }
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
  },
  propose_plan: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 240 }, outcome: { type: "string", maxLength: 10000 },
      startAt: { type: "string", format: "date-time" }, deadline: { type: "string", format: "date-time" },
      timezone: { type: "string", minLength: 1, maxLength: 120 }, workdayMinutes: { type: "integer", minimum: 15, maximum: 1440 },
      items: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: true } }
    },
    required: ["title", "items"], additionalProperties: false
  },
  apply_plan: { type: "object", properties: { proposalId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["proposalId"], additionalProperties: false },
  bind_workflow: {
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1, maxLength: 160 }, workflowId: { type: "string", minLength: 1, maxLength: 160 },
      triggerNodeId: { type: "string", minLength: 1, maxLength: 160 },
      triggerType: { type: "string", enum: ["planned-start-reached", "deadline-approaching", "entered-ready", "dependencies-completed", "became-overdue", "schedule-changed"] },
      missedTriggerPolicy: { type: "string", enum: ["skip", "ask", "notify", "run"] }
    },
    required: ["taskId", "workflowId", "triggerType"], additionalProperties: false
  }
};

const descriptions = {
  list_tasks: "Inspect the current project's work items in Board order.",
  read_task: "Read one work item with its schedule, dependencies, Workflow bindings, revisions, and recent activity.",
  create_task: "Add a work item to the current project's Board without starting a new thread.",
  update_task: "Edit a work item's details, schedule, or dependencies. Protected deadlines require the user to change them in Preview.",
  move_task: "Move or reorder a Board work item.",
  delete_task: "Delete a Board work item. This does not delete its linked thread.",
  attach_thread: "Attach a Pixice thread to an existing Board work item. Defaults to the active thread.",
  propose_plan: "Create a deterministic, reviewable schedule proposal and open it in Preview without applying it.",
  apply_plan: "Apply a previously reviewed plan proposal atomically. Stale proposals fail without partial writes.",
  bind_workflow: "Create a disabled task-to-Workflow event binding for user review in Preview. Agents cannot enable execution."
};

export const pixiceBoardTools = Object.keys(toolSchemas).map((name) => ({
  type: "function",
  name,
  description: descriptions[name],
  inputSchema: toolSchemas[name]
}));

export const pixiceBoardDynamicTools = [{
  type: "namespace",
  name: PIXICE_BOARD_NAMESPACE,
  description: "Inspect and manage the current Pixice project's scheduled Board work. Dated work items also appear in Timeline and may link to a running thread.",
  tools: pixiceBoardTools
}];

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  };
}

export class PixiceBoard {
  constructor({ database, threadContext, resolveWorkflow, onChange, onOpen }) {
    this.database = database;
    this.threadContext = threadContext;
    this.resolveWorkflow = resolveWorkflow;
    this.onChange = onChange;
    this.onOpen = onOpen;
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
      if (params.tool === "read_task") {
        const task = this.#task(context.projectId, input.taskId);
        this.#opened({ task, threadId: params.threadId, reason: "open" });
        return textResult({ task, activity: this.database.listBoardTaskActivity(task.id) });
      }
      if (params.tool === "create_task") {
        const task = this.database.createBoardTask({
          id: randomUUID(),
          projectId: context.projectId,
          title: input.title,
          description: input.description ?? "",
          column: input.column,
          kind: input.kind,
          priority: input.priority,
          estimateMinutes: input.estimateMinutes ?? null,
          owner: input.owner ?? "",
          schedule: input.schedule ?? null,
          dependencies: input.dependencies ?? [],
          threadId: input.attachCurrentThread ? params.threadId : null,
          createdByThreadId: params.threadId,
          actorKind: "agent",
          actorId: params.threadId
        });
        this.#changed("created", task);
        this.#opened({ task, threadId: params.threadId, reason: "edit" });
        return textResult({ task });
      }
      if (params.tool === "propose_plan") {
        const existing = this.database.listBoardTasks(context.projectId);
        const proposal = buildTaskPlan(input, existing);
        const baseRevisions = Object.fromEntries(proposal.items.filter((item) => existing.some((task) => task.id === item.id)).map((item) => [item.id, existing.find((task) => task.id === item.id).revision]));
        const saved = this.database.createBoardPlanProposal({ id: randomUUID(), projectId: context.projectId, threadId: params.threadId, title: input.title, proposal, baseRevisions });
        this.onOpen?.({ projectId: context.projectId, proposalId: saved.id, threadId: params.threadId, workspaceId: params.threadId, reason: "plan", actorKind: "agent", actorId: params.threadId });
        return textResult({ proposal: saved });
      }
      if (params.tool === "apply_plan") {
        const proposal = this.database.getBoardPlanProposal(input.proposalId);
        if (!proposal || proposal.projectId !== context.projectId) throw new Error("Plan proposal not found in this project");
        const applied = this.database.applyBoardPlanProposal(proposal.id, { actorKind: "agent", actorId: params.threadId });
        this.onChange?.({ action: "plan-applied", projectId: context.projectId, proposalId: proposal.id });
        this.onOpen?.({ projectId: context.projectId, proposalId: proposal.id, threadId: params.threadId, workspaceId: params.threadId, reason: "plan", actorKind: "agent", actorId: params.threadId });
        return textResult(applied);
      }
      const task = this.#task(context.projectId, input.taskId);
      if (params.tool === "update_task") {
        const protectedDeadline = task.schedule?.lockedFields?.includes("hardDeadline");
        const proposedDeadline = input.schedule?.hardDeadline ?? null;
        if (input.schedule !== undefined && protectedDeadline && proposedDeadline !== (task.schedule?.hardDeadline ?? null)) {
          throw new Error("This deadline is protected. Open the work item in Preview so the user can confirm the change.");
        }
        const updated = this.database.updateBoardTask(task.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.estimateMinutes !== undefined ? { estimateMinutes: input.estimateMinutes } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
          ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
          expectedRevision: input.expectedRevision,
          expectedScheduleRevision: input.expectedScheduleRevision,
          actorKind: "agent",
          actorId: params.threadId
        });
        this.#changed("updated", updated);
        this.#opened({ task: updated, threadId: params.threadId, reason: "edit" });
        return textResult({ task: updated });
      }
      if (params.tool === "move_task") {
        if (input.beforeTaskId) {
          const beforeTask = this.#task(context.projectId, input.beforeTaskId);
          if (beforeTask.column !== input.column) throw new Error("The target task is not in the destination column");
        }
        const moved = this.database.moveBoardTask(task.id, input.column, input.beforeTaskId ?? null);
        this.#changed("moved", moved);
        this.#opened({ task: moved, threadId: params.threadId, reason: "edit" });
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
        this.#opened({ task: updated, threadId: params.threadId, reason: "edit" });
        return textResult({ task: updated });
      }
      if (params.tool === "bind_workflow") {
        if (input.enabled) throw new Error("Agents can create Workflow bindings, but the user must enable execution in task Preview.");
        await this.resolveWorkflow?.(context.projectId, input.workflowId);
        const binding = this.database.upsertBoardTaskWorkflowBinding({
          id: randomUUID(), taskId: task.id, workflowId: input.workflowId, triggerNodeId: input.triggerNodeId ?? null,
          triggerType: input.triggerType, enabled: false, missedTriggerPolicy: input.missedTriggerPolicy,
          createdByThreadId: params.threadId
        });
        const updated = this.database.getBoardTask(task.id);
        this.#changed("binding-updated", updated);
        this.#opened({ task: updated, threadId: params.threadId, reason: "edit" });
        return textResult({ task: updated, binding });
      }
      throw new Error(`Unknown Pixice board tool: ${params.tool}`);
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }

  #task(projectId, taskIdValue) {
    const task = this.database.getBoardTask(taskIdValue);
    if (!task || task.projectId !== projectId) throw new Error("Work item not found in this project");
    return task;
  }

  #changed(action, task) {
    this.onChange?.({ action, projectId: task.projectId, task });
  }

  #opened({ task = null, threadId, ...payload }) {
    this.onOpen?.({ ...payload, projectId: task?.projectId ?? payload.projectId, taskId: task?.id ?? payload.taskId, threadId, workspaceId: threadId });
  }
}
