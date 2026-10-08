// @vitest-environment node
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeJobStore } from "../electron/persistence/bridge-job-store.mjs";
import { PixiceBridge } from "../electron/runtime/pixice-bridge.mjs";
import { BridgeParentContinuation } from "../electron/runtime/bridge-parent-continuation.mjs";

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function disk() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-bridge-recovery-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return () => {
    const db = new DatabaseSync(path.join(directory, "state.sqlite"));
    cleanups.push(() => { try { db.close(); } catch {} });
    return { db, saveThreadLink: vi.fn(), getThreadLink: vi.fn() };
  };
}
function harness(database, response = null) {
  const runtime = new EventEmitter();
  runtime.request = vi.fn(async (method, params) => {
    if (response) return response(method, params);
    if (method === "model/list") return { data: [{ id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", provider: "codex" }] };
    if (method === "thread/start") return { thread: { id: "child" } };
    if (method === "turn/start") return { turn: { id: "child-turn", status: "inProgress" } };
    return { thread: { id: params.threadId, turns: [] } };
  });
  const store = new BridgeJobStore(database);
  const onCompletion = vi.fn();
  const bridge = new PixiceBridge({ database, runtime, jobStore: store, onCompletion, dynamicTools: () => [],
    threadContext: () => ({ projectId: "project", cwd: "/workspace", permissionSettings: () => ({}) }) });
  return { bridge, store, runtime, onCompletion };
}
const params = { threadId: "parent", turnId: "parent-turn", callId: "call", tool: "spawn_thread",
  arguments: { prompt: "Review this change", model: "codex:gpt-5.6-luna", clientRequestId: "stable-review", mode: "async" } };
const result = (value) => JSON.parse(value.contentItems[0].text);
const terminal = { id: "child-turn", status: "completed", items: [{ type: "agentMessage", text: "Verified original result." }] };

describe("durable bridge recovery (T3 V2 reference semantics)", () => {
  it("persists ownership before thread creation and paid work, and deduplicates retries", async () => {
    const { bridge, store, runtime } = harness(disk()());
    const original = runtime.request;
    runtime.request = vi.fn(async (method, input) => {
      if (method === "thread/start") expect(store.jobs()[0]).toMatchObject({ status: "thread_dispatching", parentTurnId: "parent-turn" });
      if (method === "turn/start") expect(store.jobs()[0]).toMatchObject({ status: "turn_dispatching", childThreadId: "child" });
      return original(method, input);
    });
    const first = result(await bridge.handleToolCall(params));
    const retried = result(await bridge.handleToolCall({ ...params, callId: "new-transport-call" }));
    expect(retried.jobId).toBe(first.jobId);
    expect(runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    const conflict = await bridge.handleToolCall({ ...params, arguments: { ...params.arguments, prompt: "Different task" } });
    expect(conflict.success).toBe(false);
  });

  it("prefers a stable tool call id despite a changed native transport request id", async () => {
    const { bridge, runtime } = harness(disk()());
    const firstParams = { ...params, requestId: "transport-1", callId: "stable-native-call",
      provider: "codex", arguments: { ...params.arguments, clientRequestId: undefined } };
    const first = result(await bridge.handleToolCall(firstParams));
    const retry = result(await bridge.handleToolCall({ ...firstParams, requestId: "transport-2" }));
    expect(retry.jobId).toBe(first.jobId);
    expect(runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("partitions reused native request ids and native call ids by provider and parent turn", async () => {
    const { bridge, runtime } = harness(disk()());
    const native = { ...params, callId: undefined, requestId: "codex\0number:7", provider: "codex",
      arguments: { ...params.arguments, clientRequestId: undefined } };
    const first = result(await bridge.handleToolCall(native));
    const nextTurn = result(await bridge.handleToolCall({ ...native, turnId: "different-parent-turn" }));
    expect(nextTurn.jobId).not.toBe(first.jobId);
    const otherProvider = result(await bridge.handleToolCall({ ...native, provider: "claude" }));
    expect(otherProvider.jobId).not.toBe(first.jobId);
    const call = { ...native, callId: "native-call" };
    const callFirst = result(await bridge.handleToolCall(call));
    const callNext = result(await bridge.handleToolCall({ ...call, turnId: "different-parent-turn" }));
    expect(callNext.jobId).not.toBe(callFirst.jobId);
    expect(runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(5);
  });

  it("explicit client task identities remain idempotent across parent turns", async () => {
    const { bridge, runtime } = harness(disk()());
    const first = result(await bridge.handleToolCall(params));
    const retry = result(await bridge.handleToolCall({ ...params, turnId: "later-parent-turn", callId: "later-tool-call", requestId: "later-transport" }));
    expect(retry.jobId).toBe(first.jobId);
    expect(runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("reopens SQLite and recovers the stored child turn, never a later follow-up", async () => {
    const open = disk();
    const first = harness(open());
    const job = result(await first.bridge.handleToolCall(params));
    first.runtime.removeAllListeners();
    first.store.db.close();
    const restarted = harness(open(), async (method, input) => ({ thread: { id: input.threadId,
      turns: [terminal, { id: "unrelated-follow-up", status: "completed", items: [{ type: "agentMessage", text: "Wrong result." }] }] } }));
    await restarted.bridge.recover();
    expect(restarted.store.get(job.jobId).result.answer).toBe("Verified original result.");
    expect(restarted.onCompletion).toHaveBeenCalledWith(expect.objectContaining({ parentThreadId: "parent", parentTurnId: "parent-turn", answer: "Verified original result.", deliveryId: expect.any(String) }));
    expect(restarted.runtime.request.mock.calls.every(([method]) => method === "thread/read")).toBe(true);
  });

  it("holds an ambiguous paid submission instead of creating another turn on retry or restart", async () => {
    const open = disk();
    const first = harness(open());
    const original = first.runtime.request;
    first.runtime.request = vi.fn(async (method, input) => {
      if (method === "turn/start") throw new Error("Connection closed after acceptance");
      return original(method, input);
    });
    const job = result(await first.bridge.handleToolCall(params));
    expect(job).toMatchObject({ status: "uncertain", uncertain: true, threadId: "child" });
    await first.bridge.handleToolCall(params);
    expect(first.runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    first.store.db.close();
    const restarted = harness(open());
    await restarted.bridge.recover();
    expect(restarted.store.get(job.jobId).status).toBe("uncertain");
    expect(restarted.runtime.request).not.toHaveBeenCalled();
  });

  it("captures a positive started event even when the turn response is lost", async () => {
    const { bridge, store, runtime } = harness(disk()());
    const original = runtime.request;
    runtime.request = vi.fn(async (method, input) => {
      if (method !== "turn/start") return original(method, input);
      runtime.emit("event", { payload: { method: "turn/started", threadId: "child", turn: { id: "child-turn" } } });
      throw new Error("Lost response");
    });
    const job = result(await bridge.handleToolCall(params));
    expect(store.get(job.jobId).childTurnId).toBe("child-turn");
    runtime.emit("event", { payload: { method: "turn/completed", threadId: "child", turn: terminal } });
    await tick();
    expect(store.get(job.jobId).result.answer).toBe("Verified original result.");
  });

  it("does not acknowledge a running status response whose result arrives later", async () => {
    const { bridge, store, runtime } = harness(disk()());
    const job = result(await bridge.handleToolCall(params));
    const statusParams = { threadId: "parent", callId: "status-call", tool: "task_status", arguments: { jobId: job.jobId } };
    await bridge.handleToolCall(statusParams);
    runtime.emit("event", { payload: { method: "turn/completed", threadId: "child", turn: terminal } });
    await tick();
    expect(bridge.acknowledgeToolResult(statusParams)).toBe(false);
    expect(store.deliveries()[0].state).toBe("pending");
    await bridge.handleToolCall(statusParams);
    expect(bridge.acknowledgeToolResult(statusParams)).toBe(true);
    expect(store.deliveries()[0].state).toBe("acknowledged");
  });

  it("wait timeout releases its waiter without stopping work and rejects another parent's read", async () => {
    const { bridge, store, runtime } = harness(disk()());
    const job = result(await bridge.handleToolCall(params));
    const waited = result(await bridge.handleToolCall({ threadId: "parent", callId: "bounded-wait", tool: "task_wait", arguments: { jobId: job.jobId, timeoutMs: 1 } }));
    expect(waited).toMatchObject({ waitTimedOut: true, status: "running" });
    expect(bridge.pending.size).toBe(0);
    expect(store.get(job.jobId).status).toBe("running");
    const stranger = await bridge.handleToolCall({ threadId: "other-parent", tool: "task_status", arguments: { jobId: job.jobId } });
    expect(stranger.success).toBe(false);
    expect(runtime.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("keeps same-turn mailbox pending, then acknowledges a positively resolved blocking result", async () => {
    const { bridge, store, runtime } = harness(disk()());
    const waiting = bridge.handleToolCall({ ...params, arguments: { ...params.arguments, mode: "wait" } });
    await tick();
    runtime.emit("event", { payload: { method: "turn/completed", threadId: "child", turn: terminal } });
    const job = result(await waiting);
    const startTurn = vi.fn();
    const continuation = new BridgeParentContinuation({ jobStore: store, activeTurnId: () => "parent-turn", startTurn, steerTurn: vi.fn() });
    const completion = { ...job, childThreadId: "child", parentThreadId: "parent", parentTurnId: "parent-turn", blocking: true };
    expect(await continuation.notify(completion)).toMatchObject({ action: "awaiting-tool-resolution" });
    expect(store.getDelivery(job.deliveryId).state).toBe("pending");
    expect(bridge.acknowledgeToolResult(params)).toBe(true);
    expect(await continuation.notify(completion)).toMatchObject({ action: "acknowledged" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("does not replay uncertain completion dispatch after restart, and finds an accepted stable marker", async () => {
    const open = disk();
    const first = harness(open());
    const job = result(await first.bridge.handleToolCall(params));
    first.runtime.emit("event", { payload: { method: "turn/completed", threadId: "child", turn: terminal } });
    await tick();
    const completion = { ...result(await first.bridge.handleToolCall(params)), childThreadId: "child", parentThreadId: "parent", parentTurnId: "parent-turn", blocking: false };
    const startTurn = vi.fn(async () => { throw new Error("Provider accepted but response lost"); });
    const continuation = new BridgeParentContinuation({ jobStore: first.store, activeTurnId: () => null, startTurn, steerTurn: vi.fn() });
    expect(await continuation.notify(completion)).toMatchObject({ action: "failed" });
    expect(first.store.getDelivery(completion.deliveryId).state).toBe("uncertain");
    expect(await continuation.notify(completion)).toMatchObject({ action: "uncertain" });
    expect(startTurn).toHaveBeenCalledTimes(1);
    first.store.db.close();
    const restarted = harness(open(), async (method, input) => ({ thread: { id: input.threadId, turns: [{ id: "accepted-parent-turn",
      items: [{ type: "userMessage", content: [{ type: "text", text: `[Pixice delivery: ${completion.deliveryId}]` }] }] }] } }));
    await restarted.bridge.recover();
    expect(restarted.store.getDelivery(completion.deliveryId)).toMatchObject({ state: "delivered", targetTurnId: "accepted-parent-turn" });
    expect(restarted.onCompletion).not.toHaveBeenCalled();
  });

  it("keeps detached Focus completion owned by Focus across SQLite reopen", async () => {
    const open = disk();
    const first = harness(open());
    const child = await first.bridge.startDetached({ ...params, requestId: "focus-work" }, { prompt: "Check Focus", model: "codex:gpt-5.6-luna" });
    first.runtime.emit("event", { payload: { method: "turn/completed", threadId: "child", turn: terminal } });
    await tick();
    expect(first.store.get(child.jobId).result).toBeTruthy();
    expect(first.store.deliveries()).toEqual([]);
    expect(first.onCompletion).not.toHaveBeenCalled();
    first.store.db.close();
    const restarted = harness(open());
    await restarted.bridge.recover();
    expect(restarted.onCompletion).not.toHaveBeenCalled();
  });

  it("bounds recovery to 128 candidates and four reads while rotating across a larger durable backlog", async () => {
    const { bridge, store, runtime } = harness(disk()());
    for (let index = 0; index < 260; index++) {
      const { job } = store.accept({ parentThreadId: "parent", parentTurnId: "parent-turn", requestId: `seed:${index}`, identity: { index }, deliveryOwner: "bridge" });
      store.patch(job.id, { status: "running", childThreadId: `child-${index}`, childTurnId: `turn-${index}` });
    }
    let activeReads = 0, maximumReads = 0;
    const seen = new Set();
    runtime.request = vi.fn(async (method, input) => {
      expect(method).toBe("thread/read");
      activeReads++; maximumReads = Math.max(maximumReads, activeReads);
      await tick();
      activeReads--;
      seen.add(input.threadId);
      return { thread: { id: input.threadId, turns: [{ id: input.threadId.replace("child-", "turn-"), status: "inProgress" }] } };
    });
    await bridge.recover();
    expect(runtime.request).toHaveBeenCalledTimes(128);
    expect(maximumReads).toBeLessThanOrEqual(4);
    expect(seen.size).toBe(128);
    runtime.request.mockClear();
    await bridge.recover();
    expect(runtime.request).toHaveBeenCalledTimes(128);
    expect(seen.size).toBe(256);
    runtime.request.mockClear();
    await bridge.recover();
    expect(runtime.request).toHaveBeenCalledTimes(4);
    expect(seen.size).toBe(260);
  });

  it("drains at most 128 durable completions per pass without starving later pending deliveries", async () => {
    const { bridge, store, onCompletion } = harness(disk()());
    for (let index = 0; index < 260; index++) {
      const { job } = store.accept({ parentThreadId: "parent", requestId: `result:${index}`, identity: { index }, deliveryOwner: "bridge" });
      store.complete(job.id, { status: "completed", answer: `Result ${index}` });
    }
    await bridge.drainCompletions();
    expect(onCompletion).toHaveBeenCalledTimes(128);
    await bridge.drainCompletions();
    expect(onCompletion).toHaveBeenCalledTimes(256);
    await bridge.drainCompletions();
    expect(onCompletion).toHaveBeenCalledTimes(260);
    expect(new Set(onCompletion.mock.calls.map(([completion]) => completion.jobId)).size).toBe(260);
  });
});
