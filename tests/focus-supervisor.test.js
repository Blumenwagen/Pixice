import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusSupervisor } from "../electron/runtime/focus-supervisor.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { FocusStore } from "../electron/persistence/focus-store.mjs";

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class MemoryStore {
  constructor(policy = {}) {
    this.policy = { coordinatorModel: null, workerModel: "codex:gpt-worker", reviewModel: "codex:gpt-review", maxWorkers: 2, permissionMode: "workspace-write", executionHost: "current", ...policy };
    this.work = new Map();
    this.events = [];
    this.decisions = [];
    this.seen = 0;
    this.nextId = 1;
  }
  getPolicy() { return { ...this.policy }; }
  listWork(projectId, { query, limit = 40 } = {}) {
    return [...this.work.values()].filter((work) => work.projectId === projectId)
      .filter((work) => !query || `${work.title} ${work.prompt}`.includes(query)).slice(0, limit).map((work) => ({ ...work }));
  }
  getWork(projectId, id) { const work = this.work.get(id); return work?.projectId === projectId ? { ...work } : null; }
  getWorkByThread(threadId) { const work = [...this.work.values()].find((item) => item.threadId === threadId); return work ? { ...work } : null; }
  createWork(projectId, input) {
    const id = input.id ?? `work-${this.nextId++}`;
    const work = { id, projectId, threadId: null, turnId: null, answer: "", error: null, verification: null, artifacts: [],
      revision: 1, decisionRevision: 0, acknowledgedDecisionRevision: 0, completionReported: false, ...input };
    this.work.set(id, work);
    return { ...work };
  }
  updateWork(projectId, id, patch) {
    const current = this.getWork(projectId, id);
    if (!current) throw new Error("missing work");
    const next = { ...current, ...patch, revision: current.revision + 1 };
    this.work.set(id, next);
    return { ...next };
  }
  listRecoverableWork(projectId) {
    return [...this.work.values()].filter((work) => (!projectId || work.projectId === projectId) && (!["done", "failed", "cancelled"].includes(work.status) || !work.completionReported)).map((work) => ({ ...work }));
  }
  appendEvent(projectId, event) {
    const value = { id: `event-${this.events.length + 1}`, sequence: this.events.length + 1, projectId, deliveredAt: null, ...event };
    this.events.push(value);
    return { ...value };
  }
  listEvents(projectId, { after = 0, limit = 50 } = {}) { return this.events.filter((event) => event.projectId === projectId && event.sequence > after).slice(0, limit).map((event) => ({ ...event })); }
  pendingEvents(projectId, limit = 20) { return this.events.filter((event) => event.projectId === projectId && !event.deliveredAt).slice(0, limit).map((event) => ({ ...event })); }
  markEventsDelivered(projectId, ids) { for (const event of this.events) if (event.projectId === projectId && ids.includes(event.id)) event.deliveredAt = new Date().toISOString(); }
  latestSequence(projectId) { return this.events.filter((event) => event.projectId === projectId).at(-1)?.sequence ?? 0; }
  getSeen() { return this.seen; }
  markSeen(_projectId, sequence) { this.seen = Math.max(this.seen, sequence); }
  recordDecision(projectId, input) {
    const decision = { id: `decision-${this.decisions.length + 1}`, projectId, revision: this.decisions.length + 1, ...input };
    this.decisions.push(decision);
    return { ...decision };
  }
  listDecisions(projectId, { limit = 20 } = {}) { return this.decisions.filter((decision) => decision.projectId === projectId).slice(-limit).reverse().map((decision) => ({ ...decision })); }
  latestDecisionRevision(projectId) { return this.decisions.filter((decision) => decision.projectId === projectId).at(-1)?.revision ?? 0; }
}

function fixture(options = {}) {
  const store = options.store ?? new MemoryStore(options.policy);
  const runtime = new EventEmitter();
  runtime.request = vi.fn(options.readThread ?? (async () => { throw new Error("offline"); }));
  let thread = 0;
  const startWorker = options.startWorker ?? vi.fn(async () => ({ threadId: `thread-${++thread}`, turnId: `turn-${thread}` }));
  const continueWorker = options.continueWorker ?? vi.fn(async ({ threadId }) => ({ turnId: `${threadId}-continued` }));
  const interruptWorker = options.interruptWorker ?? vi.fn(async () => {});
  const deliver = options.deliver ?? vi.fn(async ({ events }) => ({ accepted: true, eventIds: events.map((event) => event.id) }));
  const onChange = vi.fn();
  const supervisor = new FocusSupervisor({ store, runtime,
    contextForProject: async () => ({ coordinatorThreadId: "coordinator-1", cwd: "/project" }),
    startWorker, continueWorker, interruptWorker, deliver, onChange });
  return { supervisor, store, runtime, startWorker, continueWorker, interruptWorker, deliver, onChange };
}

describe("FocusSupervisor", () => {
  it("durably returns dispatch before a worker starts and applies policy defaults and ceilings", async () => {
    const gate = deferred();
    const startWorker = vi.fn(() => gate.promise);
    const { supervisor, store } = fixture({ startWorker });
    const work = await supervisor.dispatch("project-1", { title: "Read it", prompt: "Inspect the code", access: "read", permissionMode: "full-access" });

    expect(work).toMatchObject({ status: "queued", model: "codex:gpt-worker", permissionMode: "read-only", resources: [] });
    await tick();
    expect(store.getWork("project-1", work.id).status).toBe("starting");
    gate.resolve({ threadId: "worker-thread", turnId: "worker-turn" });
    await tick();
    expect(store.getWork("project-1", work.id)).toMatchObject({ status: "running", threadId: "worker-thread", turnId: "worker-turn" });
    supervisor.dispose();
  });

  it("enforces max workers atomically and serializes overlapping writes while reads can run together", async () => {
    const gates = [];
    const startWorker = vi.fn(() => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    });
    const { supervisor, store } = fixture({ startWorker, policy: { maxWorkers: 3 } });
    const [a, b, c, d] = await Promise.all([
      supervisor.dispatch("project-1", { title: "A", prompt: "A", access: "write", resources: ["src/a"] }),
      supervisor.dispatch("project-1", { title: "B", prompt: "B", access: "write", resources: ["src/a"] }),
      supervisor.dispatch("project-1", { title: "C", prompt: "C", access: "read", resources: ["src/b"] }),
      supervisor.dispatch("project-1", { title: "D", prompt: "D", access: "read", resources: ["src/b"] })
    ]);
    await tick();

    expect(startWorker).toHaveBeenCalledTimes(3);
    expect(store.getWork("project-1", a.id).status).toBe("starting");
    expect(store.getWork("project-1", b.id).status).toBe("queued");
    expect(store.getWork("project-1", c.id).status).toBe("starting");
    expect(store.getWork("project-1", d.id).status).toBe("starting");
    gates.forEach((gate, index) => gate.resolve({ threadId: `thread-${index}`, turnId: `turn-${index}` }));
    await tick();
    supervisor.dispose();
  });

  it("treats parent and child resource paths as overlapping", async () => {
    const gate = deferred();
    const startWorker = vi.fn(() => gate.promise);
    const { supervisor, store } = fixture({ startWorker, policy: { maxWorkers: 2 } });
    const parent = await supervisor.dispatch("project-1", { title: "Parent", prompt: "parent", access: "write", resources: ["src/features"] });
    const child = await supervisor.dispatch("project-1", { title: "Child", prompt: "child", access: "read", resources: ["src\\features/focus"] });
    await tick();
    expect(store.getWork("project-1", parent.id).status).toBe("starting");
    expect(store.getWork("project-1", child.id).status).toBe("queued");
    gate.resolve({ threadId: "thread-parent", turnId: "turn-parent" });
    await tick();
    supervisor.dispose();
  });

  it("counts every durable active worker even beyond the bounded UI list", async () => {
    const store = new MemoryStore({ maxWorkers: 1 });
    store.createWork("project-1", { id: "old-active", title: "Old", prompt: "old", status: "running", access: "write", resources: ["old"], threadId: "old-thread", turnId: "old-turn" });
    for (let index = 0; index < 205; index += 1) {
      store.createWork("project-1", { title: `Done ${index}`, prompt: "done", status: "done", completionReported: true, access: "read", resources: [] });
    }
    const { supervisor, startWorker } = fixture({ store });
    const queued = await supervisor.dispatch("project-1", { title: "New", prompt: "new", access: "read" });
    await tick();
    expect(store.getWork("project-1", queued.id).status).toBe("queued");
    expect(startWorker).not.toHaveBeenCalled();
    supervisor.dispose();
  });

  it("keeps dependency-blocked work visible and starts it only after reviewed completion", async () => {
    const { supervisor, store, runtime, startWorker } = fixture({ policy: { maxWorkers: 2 } });
    const first = await supervisor.dispatch("project-1", { title: "First", prompt: "first", access: "write", resources: ["a"] });
    const second = await supervisor.dispatch("project-1", { title: "Second", prompt: "second", dependsOn: [first.id], access: "write", resources: ["b"] });
    await tick();
    expect(store.getWork("project-1", second.id)).toMatchObject({ status: "blocked", error: "Waiting for dependencies to complete." });
    const running = store.getWork("project-1", first.id);
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "ready" }] } });
    await tick();
    expect(store.getWork("project-1", first.id).status).toBe("review");
    supervisor.resolve("project-1", first.id, { summary: "done", verification: { status: "passed", evidence: "tests passed" } });
    await tick();
    expect(startWorker).toHaveBeenCalledTimes(2);
    supervisor.dispose();
  });

  it("routes follow-ups through the same worker identity", async () => {
    const { supervisor, store, continueWorker } = fixture();
    const created = await supervisor.dispatch("project-1", { title: "Implement", prompt: "initial" });
    await tick();
    const running = store.getWork("project-1", created.id);
    await supervisor.followUp("project-1", created.id, { prompt: "Include the edge case" });
    await tick();
    expect(continueWorker).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", threadId: running.threadId }));
    expect(store.getWork("project-1", created.id)).toMatchObject({ status: "running", prompt: "Include the edge case" });
    supervisor.dispose();
  });

  it("requires coordinator review, justified verification, and current direction acknowledgement", async () => {
    const { supervisor, store, runtime } = fixture();
    const created = await supervisor.dispatch("project-1", { title: "Build", prompt: "build it" });
    await tick();
    let running = store.getWork("project-1", created.id);
    await supervisor.decide("project-1", { text: "Use the safer API", workIds: [created.id], sourceThreadId: "coordinator-1" });
    running = store.getWork("project-1", created.id);
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "Implemented" }] } });
    await tick();
    expect(store.getWork("project-1", created.id)).toMatchObject({ status: "review", answer: "Implemented", decisionRevision: 1, acknowledgedDecisionRevision: 0 });
    expect(() => supervisor.resolve("project-1", created.id, { summary: "ship", verification: { status: "passed", evidence: "test passed" } })).toThrow(/stale/);
    supervisor.acknowledge("project-1", created.id, { revision: 1 });
    expect(() => supervisor.resolve("project-1", created.id, { summary: "ship", verification: { status: "failed", evidence: "failed" } })).toThrow(/requires passed/);
    expect(supervisor.resolve("project-1", created.id, { summary: "ship", verification: { status: "passed", evidence: "pnpm test passed" }, artifacts: ["diff"] })).toMatchObject({ status: "done", answer: "ship", artifacts: ["diff"] });
    supervisor.dispose();
  });

  it("invalidates queued, paused, and review results while reporting only successful live direction delivery", async () => {
    const store = new MemoryStore();
    const runningA = store.createWork("project-1", { title: "A", prompt: "a", status: "running", access: "write", resources: ["a"], threadId: "thread-a", turnId: "turn-a" });
    const runningB = store.createWork("project-1", { title: "B", prompt: "b", status: "running", access: "write", resources: ["b"], threadId: "thread-b", turnId: "turn-b" });
    const queued = store.createWork("project-1", { title: "Queued", prompt: "q", status: "queued", access: "read", resources: [] });
    const paused = store.createWork("project-1", { title: "Paused", prompt: "p", status: "paused", access: "read", resources: [], threadId: "thread-p", turnId: "turn-p" });
    const review = store.createWork("project-1", { title: "Review", prompt: "r", status: "review", access: "read", resources: [], threadId: "thread-r", turnId: "turn-r" });
    const continueWorker = vi.fn(async ({ threadId }) => {
      if (threadId === "thread-b") throw new Error("delivery failed");
      return { turnId: `${threadId}-steered` };
    });
    const { supervisor } = fixture({ store, continueWorker });
    const decision = await supervisor.decide("project-1", { text: "Apply the new contract", workIds: [], sourceThreadId: "coordinator-1" });
    expect(decision.deliveredWorkIds).toEqual([runningA.id]);
    expect(decision.affectedWorkIds).toEqual(expect.arrayContaining([runningA.id, runningB.id, queued.id, paused.id, review.id]));
    for (const work of [runningA, runningB, queued, paused, review]) {
      expect(store.getWork("project-1", work.id).decisionRevision).toBe(1);
    }
    expect(store.events).toEqual(expect.arrayContaining([expect.objectContaining({ workId: runningB.id, kind: "direction-delivery-failed" })]));
    supervisor.dispose();
  });

  it("does not resurrect paused or cancelled work from late runtime events", async () => {
    const { supervisor, store, runtime } = fixture();
    const paused = await supervisor.dispatch("project-1", { title: "Pause", prompt: "pause" });
    await tick();
    const running = store.getWork("project-1", paused.id);
    await supervisor.control("project-1", paused.id, { action: "pause" });
    runtime.emit("event", { method: "turn/started", threadId: running.threadId, turn: { id: "late-turn" } });
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "late" }] } });
    await tick();
    expect(store.getWork("project-1", paused.id).status).toBe("paused");

    const cancelled = await supervisor.dispatch("project-1", { title: "Cancel", prompt: "cancel", resources: ["other"] });
    await tick();
    const active = store.getWork("project-1", cancelled.id);
    await supervisor.control("project-1", cancelled.id, { action: "cancel" });
    runtime.emit("event", { method: "turn/completed", threadId: active.threadId, turn: { id: active.turnId, status: "completed", items: [{ type: "agentMessage", text: "late" }] } });
    await tick();
    expect(store.getWork("project-1", cancelled.id).status).toBe("cancelled");
    supervisor.dispose();
  });

  it("recovers running work by reading its thread and never restarts an ambiguous starting dispatch", async () => {
    const store = new MemoryStore();
    store.createWork("project-1", { id: "running", coordinatorThreadId: "coordinator-1", title: "Running", prompt: "run", model: "m", effort: null, permissionMode: "workspace-write", access: "write", resources: ["a"], dependsOn: [], status: "running", threadId: "thread-r", turnId: "turn-r" });
    store.createWork("project-1", { id: "ambiguous", coordinatorThreadId: "coordinator-1", title: "Starting", prompt: "start", model: "m", effort: null, permissionMode: "workspace-write", access: "write", resources: ["b"], dependsOn: [], status: "starting" });
    const { supervisor, startWorker } = fixture({ store, readThread: async () => ({ thread: { turns: [{ id: "turn-r", status: "completed", items: [{ type: "agentMessage", text: "Recovered answer" }] }] } }) });
    await supervisor.recover("project-1");
    expect(store.getWork("project-1", "running")).toMatchObject({ status: "review", answer: "Recovered answer" });
    expect(store.getWork("project-1", "ambiguous")).toMatchObject({ status: "needs-attention" });
    expect(startWorker).not.toHaveBeenCalled();
    supervisor.dispose();
  });

  it("does not let a stale recovery read overwrite a newer completion", async () => {
    const read = deferred();
    const store = new MemoryStore();
    store.createWork("project-1", { id: "stale", coordinatorThreadId: "coordinator-1", title: "Stale", prompt: "stale", model: "m", effort: null, permissionMode: "workspace-write", access: "write", resources: ["a"], dependsOn: [], status: "running", threadId: "thread-stale", turnId: "turn-stale" });
    const { supervisor, runtime } = fixture({ store, readThread: () => read.promise });
    const recovering = supervisor.recover("project-1");
    await tick();
    runtime.emit("event", { method: "turn/completed", threadId: "thread-stale", turn: { id: "turn-stale", status: "completed", items: [{ type: "agentMessage", text: "new result" }] } });
    await tick();
    read.resolve({ thread: { turns: [{ id: "turn-stale", status: "inProgress" }] } });
    await recovering;
    expect(store.getWork("project-1", "stale")).toMatchObject({ status: "review", answer: "new result" });
    supervisor.dispose();
  });

  it("coalesces recovery and skips a dispatch that is still starting in this process", async () => {
    const start = deferred();
    const readThread = vi.fn();
    const { supervisor, store } = fixture({ startWorker: () => start.promise, readThread });
    const created = await supervisor.dispatch("project-1", { title: "Starting", prompt: "starting" });
    await tick();
    const [first, second] = await Promise.all([supervisor.recover("project-1"), supervisor.recover("project-1")]);
    expect(first).toEqual(second);
    expect(readThread).not.toHaveBeenCalled();
    expect(store.getWork("project-1", created.id).status).toBe("starting");
    start.resolve({ threadId: "thread-start", turnId: "turn-start" });
    await tick();
    expect(store.getWork("project-1", created.id).status).toBe("running");
    supervisor.dispose();
  });

  it("retries provider-unavailable recovery on the next ready pass", async () => {
    const store = new MemoryStore();
    store.createWork("project-1", { id: "retry", coordinatorThreadId: "coordinator-1", title: "Retry", prompt: "retry", model: "m", effort: null, permissionMode: "workspace-write", access: "write", resources: ["a"], dependsOn: [], status: "running", threadId: "thread-retry", turnId: "turn-retry" });
    const readThread = vi.fn()
      .mockRejectedValueOnce(new Error("Codex runtime is not connected"))
      .mockResolvedValueOnce({ thread: { turns: [{ id: "turn-retry", status: "completed", items: [{ type: "agentMessage", text: "recovered" }] }] } });
    const { supervisor } = fixture({ store, readThread });
    await supervisor.recover("project-1");
    expect(store.getWork("project-1", "retry")).toMatchObject({ status: "needs-attention", error: expect.stringMatching(/^Worker recovery deferred/) });
    await supervisor.recover("project-1");
    expect(store.getWork("project-1", "retry")).toMatchObject({ status: "review", answer: "recovered" });
    expect(readThread).toHaveBeenCalledTimes(2);
    supervisor.dispose();
  });

  it("reserves disconnected worker capacity until provider recovery confirms its outcome", async () => {
    const store = new MemoryStore({ maxWorkers: 1 });
    store.createWork("project-1", { id: "disconnected", coordinatorThreadId: "coordinator-1", title: "Disconnected", prompt: "work", model: "m", effort: null, permissionMode: "workspace-write", access: "write", resources: ["a"], dependsOn: [], status: "running", threadId: "claude-thread", turnId: "claude-turn" });
    const { supervisor, runtime, startWorker } = fixture({ store });
    runtime.providerForThread = vi.fn(() => "claude");
    expect(supervisor.providerUnavailable("claude")).toEqual([expect.objectContaining({ id: "disconnected", status: "needs-attention" })]);
    const queued = await supervisor.dispatch("project-1", { title: "Queued", prompt: "queued", access: "read" });
    await tick();
    expect(store.getWork("project-1", queued.id).status).toBe("queued");
    expect(startWorker).not.toHaveBeenCalled();
    supervisor.dispose();
  });

  it("batches bounded completion delivery, marks accepted events, and retries only when flushed", async () => {
    const first = deferred();
    const deliver = vi.fn().mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ accepted: true });
    const { supervisor, store, runtime } = fixture({ deliver });
    const created = await supervisor.dispatch("project-1", { title: "Deliver", prompt: "deliver" });
    await tick();
    const running = store.getWork("project-1", created.id);
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "Answer" }] } });
    await tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].events.length).toBeLessThanOrEqual(25);
    first.reject(new Error("coordinator unavailable"));
    await tick();
    await tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    await supervisor.flush("project-1");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.pendingEvents("project-1")).toHaveLength(0);
    expect(store.getWork("project-1", created.id).completionReported).toBe(true);
    supervisor.dispose();
  });

  it("contains rejected runtime listener work and removes listeners on dispose", async () => {
    const { supervisor, runtime, store } = fixture();
    const created = await supervisor.dispatch("project-1", { title: "Contain", prompt: "contain" });
    await tick();
    const running = store.getWork("project-1", created.id);
    store.updateWork = () => { throw new Error("persistence failure"); };
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed" } });
    await tick();
    expect(runtime.listenerCount("event")).toBe(1);
    supervisor.dispose();
    expect(runtime.listenerCount("event")).toBe(0);
  });

  it("does not overwrite a synchronous worker completion after start resolves", async () => {
    const store = new MemoryStore();
    const runtime = new EventEmitter();
    runtime.request = vi.fn();
    const startWorker = vi.fn(async ({ projectId, workId }) => {
      store.updateWork(projectId, workId, { threadId: "sync-thread", turnId: "sync-turn" });
      runtime.emit("event", { method: "turn/started", threadId: "sync-thread", turn: { id: "sync-turn" } });
      runtime.emit("event", { method: "turn/completed", threadId: "sync-thread", turn: { id: "sync-turn", status: "completed", items: [{ type: "agentMessage", text: "sync answer" }] } });
      return { threadId: "sync-thread", turnId: "sync-turn" };
    });
    const supervisor = new FocusSupervisor({ store, runtime, contextForProject: async () => ({ coordinatorThreadId: "coordinator-1" }), startWorker,
      continueWorker: vi.fn(), interruptWorker: vi.fn(), deliver: vi.fn(async () => ({ accepted: true })), onChange: vi.fn() });
    const created = await supervisor.dispatch("project-1", { title: "Sync", prompt: "sync" });
    await tick();
    expect(store.getWork("project-1", created.id)).toMatchObject({ status: "review", answer: "sync answer" });
    supervisor.dispose();
  });

  it("hydrates sparse completion answers once without overwriting a concurrent pause", async () => {
    const reads = [];
    const readThread = vi.fn(() => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    });
    const { supervisor, store, runtime } = fixture({ readThread });
    const created = await supervisor.dispatch("project-1", { title: "Sparse", prompt: "sparse" });
    await tick();
    const running = store.getWork("project-1", created.id);
    const sparse = { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed" } };
    runtime.emit("event", sparse);
    runtime.emit("event", sparse);
    await tick();
    expect(readThread).toHaveBeenCalledTimes(2);
    reads.forEach((read) => read.resolve({
      thread: { turns: [{ id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "hydrated answer" }] }] }
    }));
    await tick();
    expect(store.getWork("project-1", created.id)).toMatchObject({ status: "review", answer: "hydrated answer" });
    expect(store.events.filter((event) => event.kind === "review-ready")).toHaveLength(1);

    const next = await supervisor.followUp("project-1", created.id, { prompt: "again" });
    await tick();
    const active = store.getWork("project-1", next.id);
    runtime.emit("event", { method: "turn/completed", threadId: active.threadId, turn: { id: active.turnId, status: "completed" } });
    await tick();
    const lastRead = reads.at(-1);
    await supervisor.control("project-1", active.id, { action: "pause" });
    lastRead.resolve({
      thread: { turns: [{ id: active.turnId, status: "completed", items: [{ type: "agentMessage", text: "too late" }] }] }
    });
    await tick();
    expect(store.getWork("project-1", active.id).status).toBe("paused");
    supervisor.dispose();
  });

  it("runs against the real durable FocusStore contract", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-focus-supervisor-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    database.createProject({ id: "project-1", canonicalPath: "/workspace/project", displayName: "Project", folders: ["/workspace/project"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const store = new FocusStore(database);
    const { supervisor, runtime } = fixture({ store });
    const created = await supervisor.dispatch("project-1", { title: "Persist", prompt: "persist", access: "write" });
    await tick();
    const running = store.getWork("project-1", created.id);
    expect(running.status).toBe("running");
    runtime.emit("event", { method: "turn/completed", threadId: running.threadId, turn: { id: running.turnId, status: "completed", items: [{ type: "agentMessage", text: "durable" }] } });
    await tick();
    expect(store.getWork("project-1", created.id)).toMatchObject({ status: "review", answer: "durable" });
    supervisor.dispose();
    database.db.close();
  });
});
