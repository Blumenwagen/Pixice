import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionJournal } from "../electron/runtime/execution-journal.mjs";

const connections = [];
const directories = [];
function createJournal(file = ":memory:") {
  const db = new DatabaseSync(file);
  connections.push(db);
  return { db, journal: new ExecutionJournal({ database: { db } }) };
}
function run(journal, commandId = "request-1", threadId = "thread-1", turnId = "turn-1") {
  journal.accept({ commandId, threadId, metadata: { provider: "codex", projectId: "project-1" } });
  journal.beforeDispatch(commandId);
  return journal.started(commandId, turnId);
}
afterEach(() => {
  for (const db of connections.splice(0)) { try { db.close(); } catch {} }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable execution journal", () => {
  it("persists acceptance and exact identity across restart without another dispatch claim", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-execution-"));
    directories.push(directory);
    const file = path.join(directory, "execution.sqlite");
    const first = createJournal(file);
    run(first.journal);
    first.db.close();
    const { journal } = createJournal(file);
    expect(journal.get("request-1")).toMatchObject({ status: "uncertain", turnId: "turn-1" });
    expect(journal.accept({ commandId: "request-1", threadId: "thread-1" })).toMatchObject({ duplicate: true, turnId: "turn-1" });
    expect(journal.beforeDispatch("request-1")).toBeNull();
    const onRunning = vi.fn();
    await journal.reconcile({ readThread: async () => ({ thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress" }] } }), onRunning });
    expect(onRunning).toHaveBeenCalledWith(expect.objectContaining({ status: "running", turnId: "turn-1" }), expect.objectContaining({ id: "turn-1" }));
    expect(journal.events("request-1").map((event) => event.type)).toEqual(["accepted", "dispatching", "provider-started", "process-loss", "recovery-running"]);
  });

  it("rolls back both receipt state and lifecycle event if the transition cannot persist", () => {
    const { db, journal } = createJournal();
    journal.accept({ commandId: "request-1", threadId: "thread-1" });
    db.exec("CREATE TRIGGER reject_dispatch BEFORE UPDATE ON execution_commands WHEN NEW.status='dispatching' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
    expect(() => journal.beforeDispatch("request-1")).toThrow("simulated storage failure");
    expect(journal.get("request-1")).toMatchObject({ status: "accepted", revision: 1 });
    expect(journal.events("request-1")).toHaveLength(1);
  });

  it("rejects cross-thread command reuse and claims one dispatch per thread", () => {
    const { journal } = createJournal();
    journal.accept({ commandId: "a", threadId: "thread-1" });
    expect(() => journal.accept({ commandId: "a", threadId: "thread-2" })).toThrow("already accepted");
    journal.accept({ commandId: "b", threadId: "thread-1" });
    expect(journal.beforeDispatch("a")).toMatchObject({ status: "dispatching" });
    expect(journal.beforeDispatch("a")).toBeNull();
    expect(journal.beforeDispatch("b")).toBeNull();
    journal.started("a", "turn-a");
    journal.observeCompleted("thread-1", { id: "turn-a", status: "completed" });
    expect(journal.beforeDispatch("b")).toMatchObject({ status: "dispatching" });
  });

  it("never lets an older completion settle a newer execution", () => {
    const { journal } = createJournal();
    run(journal, "old", "thread-1", "turn-old");
    journal.observeCompleted("thread-1", { id: "turn-old", status: "completed" });
    run(journal, "new", "thread-1", "turn-new");
    journal.observeCompleted("thread-1", { id: "turn-old", status: "failed" });
    expect(journal.getActive("thread-1")).toMatchObject({ commandId: "new", status: "running", turnId: "turn-new" });
    expect(journal.get("old").status).toBe("completed");
  });

  it("does not bind stale uncorrelated starts and buffers terminal before the RPC identity arrives", () => {
    const { journal } = createJournal();
    journal.accept({ commandId: "new", threadId: "thread-1" });
    journal.beforeDispatch("new");
    expect(journal.observeStarted("thread-1", "old-provider-turn")).toBeNull();
    journal.observeCompleted("thread-1", { id: "turn-new", status: "completed" });
    expect(journal.get("new").turnId).toBeNull();
    expect(journal.started("new", "turn-new")).toMatchObject({ status: "completed", turnId: "turn-new" });
    expect(journal.getActive("thread-1")).toBeNull();
  });

  it("holds a lost start response after process loss rather than guessing the latest turn", async () => {
    const { db, journal: first } = createJournal();
    first.accept({ commandId: "lost", threadId: "thread-1" });
    first.beforeDispatch("lost");
    const journal = new ExecutionJournal({ database: { db } });
    const readThread = vi.fn(async () => ({ thread: { id: "thread-1", turns: [{ id: "old", status: "completed" }] } }));
    const onUncertain = vi.fn();
    await journal.reconcile({ readThread, onUncertain });
    expect(readThread).not.toHaveBeenCalled();
    expect(onUncertain).toHaveBeenCalledWith(expect.objectContaining({ commandId: "lost", status: "uncertain", turnId: null }));
    expect(journal.observeStarted("thread-1", "unproven-turn")).toBeNull();
    expect(journal.beforeDispatch("lost")).toBeNull();
  });

  it("does not let a ready-time recovery pass classify a live in-flight dispatch as process loss", async () => {
    const { journal } = createJournal();
    journal.accept({ commandId: "live", threadId: "thread-1" });
    journal.beforeDispatch("live");
    const onUncertain = vi.fn();
    const results = await journal.reconcile({ readThread: vi.fn(), onUncertain });
    expect(results).toEqual([{ commandId: "live", skipped: true }]);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(journal.get("live").status).toBe("dispatching");
    expect(journal.started("live", "turn-live").status).toBe("running");
  });

  it("reconciles only the recorded turn even if a newer turn has completed", async () => {
    const { journal } = createJournal();
    run(journal);
    const onTerminal = vi.fn();
    await journal.reconcile({ readThread: async () => ({ thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress" }, { id: "newer", status: "completed" }] } }), onTerminal });
    expect(journal.get("request-1").status).toBe("running");
    expect(onTerminal).not.toHaveBeenCalled();
    await journal.reconcile({ readThread: async () => ({ thread: { id: "thread-1", turns: [{ id: "turn-1", status: "interrupted" }] } }), onTerminal });
    expect(journal.get("request-1").status).toBe("interrupted");
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("preserves uncertainty and its thread reservation on provider read failure or missing identity", async () => {
    const { journal } = createJournal();
    run(journal);
    await journal.reconcile({ readThread: async () => { throw new Error("Provider unavailable"); } });
    expect(journal.getActive("thread-1")).toMatchObject({ status: "uncertain", turnId: "turn-1", error: "Provider unavailable" });
    await journal.reconcile({ readThread: async () => ({ thread: { id: "thread-1", turns: [{ id: "newer", status: "completed" }] } }) });
    expect(journal.get("request-1").status).toBe("uncertain");
  });

  it("fences a delayed recovery read after a live event terminalizes the turn", async () => {
    const { journal } = createJournal();
    run(journal);
    let resolveRead;
    const onRunning = vi.fn();
    const pending = journal.reconcile({ readThread: () => new Promise((resolve) => { resolveRead = resolve; }), onRunning });
    journal.observeCompleted("thread-1", { id: "turn-1", status: "completed" });
    resolveRead({ thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress" }] } });
    await pending;
    expect(journal.get("request-1").status).toBe("completed");
    expect(onRunning).not.toHaveBeenCalled();
  });

  it("caps candidate count and provider recovery concurrency", async () => {
    const { journal } = createJournal();
    for (let index = 0; index < 130; index++) run(journal, `request-${index}`, `thread-${index}`, `turn-${index}`);
    let active = 0;
    let maximum = 0;
    let reads = 0;
    const results = await journal.reconcile({ limit: 500, concurrency: 500, readThread: async (threadId) => {
      active++; reads++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { thread: { id: threadId, turns: [{ id: `turn-${threadId.slice(7)}`, status: "completed" }] } };
    } });
    expect(results).toHaveLength(128);
    expect(reads).toBe(128);
    expect(maximum).toBe(4);
    expect(journal.listRecoverable()).toHaveLength(2);
  });

  it("keeps steering acceptance separate from execution identity and terminal observations", () => {
    const { db, journal } = createJournal();
    run(journal);
    journal.accept({ commandId: "delivery-1", threadId: "thread-1", kind: "turn-steer", turnId: "turn-1", metadata: { deliveryId: "result-1" } });
    expect(journal.beforeDispatch("delivery-1")).toMatchObject({ status: "dispatching" });
    expect(journal.acknowledge("delivery-1", { turnId: "turn-1" })).toMatchObject({ status: "completed" });
    expect(journal.getActive("thread-1").commandId).toBe("request-1");
    journal.accept({ commandId: "delivery-lost", threadId: "thread-1", kind: "turn-steer", turnId: "turn-1" });
    journal.beforeDispatch("delivery-lost");
    const reopened = new ExecutionJournal({ database: { db } });
    reopened.observeCompleted("thread-1", { id: "turn-1", status: "completed" });
    expect(reopened.get("delivery-lost").status).toBe("uncertain");
    expect(reopened.listRecoverable()).toEqual([]);
    expect(reopened.listRecoverable(128, { includeDeliveries: true })).toEqual([expect.objectContaining({ commandId: "delivery-lost", status: "uncertain" })]);
  });

  it("permits explicit retry after a definitive rejection while preserving one stable delivery receipt", () => {
    const { journal } = createJournal();
    journal.accept({ commandId: "delivery", threadId: "thread-1", kind: "turn-steer", turnId: "turn-1", metadata: { deliveryId: "delivery" } });
    journal.beforeDispatch("delivery");
    journal.failed("delivery", "Provider rejected before accepting the message", { uncertain: false });
    expect(journal.retryRejected("delivery")).toMatchObject({ status: "accepted", turnId: "turn-1", dispatchedAt: null });
    expect(journal.retryRejected("delivery")).toBeNull();
    expect(journal.beforeDispatch("delivery")).toMatchObject({ status: "dispatching" });
    journal.acknowledge("delivery", { turnId: "turn-1" });
    expect(journal.accept({ commandId: "delivery", threadId: "thread-1", kind: "turn-steer", turnId: "turn-1" })).toMatchObject({ duplicate: true, status: "completed" });
    expect(journal.retryRejected("delivery")).toBeNull();
    expect(journal.events("delivery").filter((event) => event.type === "provider-delivery-accepted")).toHaveLength(1);
  });

  it("never redrives uncertain dispatches or provider-terminal failures", () => {
    const { journal } = createJournal();
    journal.accept({ commandId: "lost", threadId: "thread-1" });
    journal.beforeDispatch("lost");
    journal.failed("lost", "Response lost", { uncertain: true });
    expect(journal.retryRejected("lost")).toBeNull();
    run(journal, "executed", "thread-2", "turn-2");
    journal.observeCompleted("thread-2", { id: "turn-2", status: "failed" });
    expect(journal.retryRejected("executed")).toBeNull();
    run(journal, "started", "thread-3", "turn-3");
    journal.failed("started", "Execution failed", { uncertain: false });
    expect(journal.retryRejected("started")).toBeNull();
  });
});
