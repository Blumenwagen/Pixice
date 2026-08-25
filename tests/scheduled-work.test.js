import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { buildTaskPlan } from "../electron/runtime/task-scheduler.mjs";
import { WorkflowTriggerHost } from "../electron/workflows/workflow-trigger-host.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function databaseFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-scheduled-work-"));
  temporaryDirectories.push(directory);
  const database = new PixiceDatabase(directory);
  const now = new Date().toISOString();
  database.upsertProject({ id: "project-1", canonicalPath: "/workspace", displayName: "Workspace", createdAt: now, updatedAt: now });
  return database;
}

function schedule(day, { deadline = null, lockedFields = [], autoSchedule = true } = {}) {
  return {
    plannedStart: `2026-08-${day}T08:00:00.000Z`,
    plannedEnd: `2026-08-${day}T16:00:00.000Z`,
    hardDeadline: deadline,
    allDay: false,
    timezone: "Europe/Zurich",
    constraintType: "flexible",
    lockedFields,
    autoSchedule,
    explanation: "Test schedule"
  };
}

describe("scheduled Board work", () => {
  it("persists schedules, dependencies, bindings, activity provenance, and independent revisions", () => {
    const database = databaseFixture();
    database.createBoardTask({ id: "model", projectId: "project-1", title: "Temporal model", column: "done", schedule: schedule("03") });
    const renderer = database.createBoardTask({
      id: "renderer", projectId: "project-1", title: "Calendar renderer", column: "active",
      kind: "task", priority: "high", estimateMinutes: 960, owner: "UI agent", schedule: schedule("17", { deadline: "2026-08-28T16:00:00.000Z", lockedFields: ["hardDeadline"] }),
      dependencies: [{ dependsOnTaskId: "model", type: "finish-to-start", lagMinutes: 60 }], actorKind: "agent", actorId: "thread-agent"
    });
    const binding = database.upsertBoardTaskWorkflowBinding({ id: "binding-1", taskId: renderer.id, workflowId: "workflow-1", triggerType: "entered-ready", enabled: false, missedTriggerPolicy: "ask" });

    expect(database.getBoardTask("renderer")).toMatchObject({
      priority: "high", estimateMinutes: 960, owner: "UI agent", revision: 1,
      schedule: { revision: 1, hardDeadline: "2026-08-28T16:00:00.000Z", lockedFields: ["hardDeadline"] },
      dependencies: [{ dependsOnTaskId: "model", lagMinutes: 60 }],
      workflowBindings: [{ id: binding.id, enabled: false }]
    });
    expect(database.listBoardTaskActivity("renderer")).toEqual(expect.arrayContaining([expect.objectContaining({ actorKind: "agent", actorId: "thread-agent" })]));

    const modelRevision = database.getBoardTask("model").revision;
    database.moveBoardTask("renderer", "ready");
    expect(database.getBoardTask("renderer").revision).toBe(2);
    expect(database.getBoardTask("model").revision).toBe(modelRevision);

    database.db.close();
    const reopened = new PixiceDatabase(temporaryDirectories[0]);
    expect(reopened.getBoardTask("renderer")).toMatchObject({ column: "ready", schedule: { timezone: "Europe/Zurich" } });
    reopened.db.close();
  });

  it("rejects stale revisions and dependency cycles", () => {
    const database = databaseFixture();
    database.createBoardTask({ id: "a", projectId: "project-1", title: "A", schedule: schedule("03", { deadline: "2026-08-04T16:00:00.000Z" }) });
    database.createBoardTask({ id: "b", projectId: "project-1", title: "B", dependencies: [{ dependsOnTaskId: "a" }] });
    expect(() => database.updateBoardTask("a", { expectedRevision: 99, title: "Stale" })).toThrow(/changed after/i);
    expect(() => database.updateBoardTask("a", { dependencies: [{ dependsOnTaskId: "b" }] })).toThrow(/cycle/i);
    database.updateBoardTask("a", { schedule: { hardDeadline: null } });
    expect(database.getBoardTask("a").schedule.hardDeadline).toBeNull();
    database.db.close();
  });

  it("keeps Workflow bindings scoped to their original work item", () => {
    const database = databaseFixture();
    database.createBoardTask({ id: "a", projectId: "project-1", title: "A" });
    database.createBoardTask({ id: "b", projectId: "project-1", title: "B" });
    database.upsertBoardTaskWorkflowBinding({ id: "binding-1", taskId: "a", workflowId: "workflow-1", triggerType: "entered-ready" });
    expect(() => database.upsertBoardTaskWorkflowBinding({ id: "binding-1", taskId: "b", workflowId: "workflow-1", triggerType: "entered-ready" })).toThrow(/another work item/i);
    expect(database.getBoardTask("a").workflowBindings).toHaveLength(1);
    expect(database.getBoardTask("b").workflowBindings).toHaveLength(0);
    database.db.close();
  });

  it("applies a reviewed plan atomically", () => {
    const database = databaseFixture();
    const plan = buildTaskPlan({
      title: "August delivery", outcome: "Ship scheduled work", startAt: "2026-08-03T08:00:00.000Z", deadline: "2026-08-14T16:00:00.000Z", timezone: "Europe/Zurich",
      items: [
        { id: "model", title: "Temporal model", estimateMinutes: 480 },
        { id: "calendar", title: "Calendar renderer", estimateMinutes: 960, dependsOn: ["model"] }
      ]
    }, []);
    const proposal = database.createBoardPlanProposal({ id: "proposal-1", projectId: "project-1", title: plan.title, proposal: plan });
    expect(database.listBoardTasks("project-1")).toEqual([]);
    const result = database.applyBoardPlanProposal(proposal.id, { actorKind: "agent", actorId: "thread-agent" });
    expect(result.proposal.status).toBe("applied");
    expect(result.tasks).toHaveLength(2);
    expect(database.getBoardTask("calendar").dependencies[0].dependsOnTaskId).toBe("model");
    database.db.close();
  });
});

describe("agent schedule proposals", () => {
  it("orders dependencies deterministically and reports deadline conflicts", () => {
    const input = {
      title: "Release plan", startAt: "2026-08-03T08:00:00.000Z", deadline: "2026-08-03T16:00:00.000Z", timezone: "UTC",
      items: [
        { id: "model", title: "Model", estimateMinutes: 480, confidence: "high" },
        { id: "renderer", title: "Renderer", estimateMinutes: 480, dependsOn: ["model"], confidence: "medium" }
      ]
    };
    const first = buildTaskPlan(input, []);
    const second = buildTaskPlan(input, []);
    expect(second).toEqual(first);
    expect(first.items[1].schedule.plannedStart).toBe(first.items[0].schedule.plannedEnd);
    expect(first.conflicts).toEqual([expect.objectContaining({ taskId: "renderer", type: "deadline" })]);
  });

  it("reports a fixed start that overlaps a dependency", () => {
    const plan = buildTaskPlan({
      title: "Fixed release plan", startAt: "2026-08-03T08:00:00.000Z", timezone: "UTC",
      items: [
        { id: "model", title: "Model", estimateMinutes: 480 },
        { id: "renderer", title: "Renderer", estimateMinutes: 480, dependsOn: ["model"], fixedStart: "2026-08-03T10:00:00.000Z" }
      ]
    }, []);
    expect(plan.conflicts).toEqual([expect.objectContaining({ taskId: "renderer", type: "dependency" })]);
  });
});

describe("task event workflow triggers", () => {
  it("runs only an explicitly enabled binding and records an idempotency receipt", async () => {
    const database = databaseFixture();
    database.createBoardTask({ id: "task-1", projectId: "project-1", title: "Release checks", column: "backlog", schedule: schedule("26") });
    database.upsertBoardTaskWorkflowBinding({ id: "binding-1", taskId: "task-1", workflowId: "workflow-1", triggerNodeId: "task-ready", triggerType: "entered-ready", enabled: true, missedTriggerPolicy: "ask" });
    const workflow = {
      id: "workflow-1", projectId: "project-1", name: "Release readiness", enabled: true,
      graph: { nodes: [{ id: "task-ready", type: "taskEventTrigger", name: "When ready", description: "", position: { x: 0, y: 0 }, config: { eventType: "entered-ready", leadMinutes: 1440 } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
    };
    const startRun = vi.fn(() => ({ id: "run-1" }));
    const host = new WorkflowTriggerHost({
      store: { listAllWorkflows: () => [workflow], getWorkflow: () => workflow },
      workflows: { startRun, isWorkflowActive: () => false }, database,
      credentialStore: { resolve: () => null }, setTimer: () => ({ unref: vi.fn() }), clearTimer: vi.fn()
    });
    await host.start();
    database.moveBoardTask("task-1", "ready");
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "workflow-1", triggerNodeId: "task-ready", input: expect.objectContaining({ task: expect.objectContaining({ id: "task-1" }) }) }));
    expect(database.listBoardTaskActivity("task-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workflow-run", actorKind: "workflow", metadata: expect.objectContaining({ runId: "run-1" }) })
    ]));
    await host.handleBoardEvent({ action: "moved", previous: { column: "backlog" }, task: database.getBoardTask("task-1") });
    expect(startRun).toHaveBeenCalledTimes(1);
    await host.close();
    database.db.close();
  });

  it("asks before running a missed event and starts it only after approval", async () => {
    const database = databaseFixture();
    database.createBoardTask({
      id: "task-1",
      projectId: "project-1",
      title: "Start release",
      column: "ready",
      schedule: schedule("25")
    });
    database.upsertBoardTaskWorkflowBinding({
      id: "binding-1",
      taskId: "task-1",
      workflowId: "workflow-1",
      triggerNodeId: "task-start",
      triggerType: "planned-start-reached",
      enabled: true,
      missedTriggerPolicy: "ask"
    });
    const workflow = {
      id: "workflow-1",
      projectId: "project-1",
      name: "Release kickoff",
      enabled: true,
      graph: {
        nodes: [{
          id: "task-start",
          type: "taskEventTrigger",
          name: "When planned work starts",
          description: "",
          position: { x: 0, y: 0 },
          config: { eventType: "planned-start-reached", leadMinutes: 1_440 }
        }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    };
    const timers = [];
    const onAttention = vi.fn();
    const startRun = vi.fn(() => ({ id: "run-approved" }));
    const host = new WorkflowTriggerHost({
      store: { listAllWorkflows: () => [workflow], getWorkflow: () => workflow },
      workflows: { startRun, isWorkflowActive: () => false },
      database,
      credentialStore: { resolve: () => null },
      now: () => new Date("2026-08-26T08:00:00.000Z"),
      setTimer: (callback) => {
        timers.push(callback);
        return { unref: vi.fn() };
      },
      clearTimer: vi.fn(),
      onAttention
    });

    await host.start();
    expect(timers).toHaveLength(1);
    await timers[0]();
    await vi.waitFor(() => expect(onAttention).toHaveBeenCalledOnce());
    expect(startRun).not.toHaveBeenCalled();

    const request = onAttention.mock.calls[0][0];
    expect(request).toMatchObject({
      method: "workflow/taskEvent/requestApproval",
      params: { taskId: "task-1", workflowId: "workflow-1", allowForSession: false }
    });
    await host.resolveMissed(request.id, "accept");
    expect(startRun).toHaveBeenCalledOnce();
    expect(database.listBoardTaskActivity("task-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workflow-awaiting-approval" }),
      expect.objectContaining({ kind: "workflow-run", metadata: expect.objectContaining({ runId: "run-approved" }) })
    ]));

    await host.close();
    database.db.close();
  });
});
