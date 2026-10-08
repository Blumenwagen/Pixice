// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestResponseDelivery } from "../electron/runtime/request-response-delivery.mjs";

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(respond = vi.fn(async () => ({ written: true, resolved: false })), timeoutMs = 20) {
  const db = new DatabaseSync(":memory:");
  cleanups.push(() => db.close());
  const onResolved = vi.fn(), onState = vi.fn();
  const delivery = new RequestResponseDelivery({ database: { db }, respond, onResolved, onState, timeoutMs });
  cleanups.push(() => delivery.dispose());
  const register = (id = 1, overrides = {}) => {
    const request = { id, provider: "codex", params: { threadId: "thread", turnId: "turn" }, ...overrides };
    const pending = { request, generation: delivery.nextGeneration() };
    delivery.register(pending);
    return pending;
  };
  return { delivery, db, respond, register, onResolved, onState };
}

describe("native runtime request response receipts (T3 V2 reference)", () => {
  it("a completed transport write never resolves the provider callback", async () => {
    const { delivery, register, respond, onResolved } = harness();
    const pending = register();
    const response = delivery.send(pending, { decision: "accept" });
    let settled = false;
    response.then(() => { settled = true; });
    await tick();
    expect(respond).toHaveBeenCalledOnce();
    expect(delivery.state(pending.generation).state).toBe("responding");
    expect(settled).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
    expect(delivery.confirm(1, { provider: "codex", threadId: "thread", turnId: "turn", generation: pending.generation })).toBe(true);
    await expect(response).resolves.toMatchObject({ resolved: true, requestGeneration: pending.generation });
  });

  it("coalesces identical in-flight retries and blocks altered answers", async () => {
    const { delivery, register, respond } = harness();
    const pending = register();
    const original = delivery.send(pending, { answers: { choice: "A" } });
    const retry = delivery.send(pending, { answers: { choice: "A" } });
    expect(retry).toBe(original);
    await expect(delivery.send(pending, { answers: { choice: "B" } })).rejects.toThrow("cannot be changed");
    await tick();
    expect(respond).toHaveBeenCalledOnce();
    delivery.confirm(1, { provider: "codex" });
    await original;
  });

  it("times out as uncertain, keeps the callback, and accepts a late native confirmation", async () => {
    const { delivery, register, onResolved } = harness(undefined, 1);
    const pending = register();
    await expect(delivery.send(pending, { decision: "accept" })).rejects.toMatchObject({ uncertain: true });
    expect(delivery.state(pending.generation).state).toBe("uncertain");
    expect(delivery.pending.size).toBe(1);
    expect(onResolved).not.toHaveBeenCalled();
    await expect(delivery.send(pending, { decision: "decline" })).rejects.toThrow("cannot be changed");
    expect(delivery.confirm(1, { provider: "codex" })).toBe(true);
    expect(delivery.state(pending.generation).state).toBe("resolved");
    expect(onResolved).toHaveBeenCalledWith(pending);
  });

  it("a late SDK acknowledgement cannot resolve a replacement generation", async () => {
    let ack;
    const { delivery, register } = harness(vi.fn(() => new Promise(resolve => { ack = resolve; })));
    const first = register();
    const response = delivery.send(first, { decision: "accept" });
    const rejected = expect(response).rejects.toThrow("replaced");
    await tick();
    const replacement = register();
    await rejected;
    ack({ resolved: true });
    await tick();
    expect(delivery.state(first.generation).state).toBe("unavailable");
    expect(delivery.state(replacement.generation).state).toBe("pending");
    expect(delivery.confirm(1, { generation: first.generation, provider: "codex" })).toBe(false);
    expect(delivery.confirm(1, { generation: replacement.generation, provider: "codex" })).toBe(true);
  });

  it("keeps same native ids isolated by provider and checks exact thread and turn", () => {
    const { delivery, register } = harness();
    const codex = register(1);
    const claude = register(1, { provider: "claude" });
    expect(delivery.pending.size).toBe(2);
    expect(delivery.confirm(1)).toBe(false);
    expect(delivery.confirm(1, { provider: "codex", threadId: "other" })).toBe(false);
    expect(delivery.confirm(1, { provider: "codex", turnId: "other" })).toBe(false);
    delivery.confirm(1, { provider: "claude" });
    expect(delivery.state(claude.generation).state).toBe("resolved");
    expect(delivery.state(codex.generation).state).toBe("pending");
  });

  it("an exact terminal turn closes the callback without claiming its submitted answer was accepted", async () => {
    const { delivery, register, onResolved } = harness();
    const pending = register();
    const response = delivery.send(pending, { answers: { secret: "private answer" } });
    const rejected = expect(response).rejects.toMatchObject({ requestClosed: true, uncertain: true });
    await tick();
    delivery.terminal("thread", "other-turn");
    expect(delivery.state(pending.generation).state).toBe("responding");
    delivery.terminal("thread", "turn");
    await rejected;
    expect(delivery.state(pending.generation).state).toBe("unavailable");
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ responseState: "unavailable" }));
    expect(delivery.confirm(1, { provider: "codex" })).toBe(false);
  });

  it("provider failure stays visible and does not persist answers or secrets", async () => {
    const { delivery, register, db } = harness(vi.fn(async () => { throw new Error("Closed transport"); }));
    const pending = register();
    await expect(delivery.send(pending, { private: "do-not-store-secret" })).rejects.toMatchObject({ uncertain: true });
    expect(delivery.state(pending.generation).state).toBe("uncertain");
    expect(JSON.stringify(db.prepare("SELECT * FROM runtime_request_deliveries").all())).not.toContain("do-not-store-secret");
    delivery.unavailable("claude");
    expect(delivery.state(pending.generation).state).toBe("uncertain");
    delivery.unavailable("codex");
    expect(delivery.state(pending.generation).state).toBe("unavailable");
  });

  it("restart invalidates process-bound callbacks and preserves increasing generations", () => {
    const { delivery, db, register } = harness();
    const pending = register();
    const restarted = new RequestResponseDelivery({ database: { db }, respond: vi.fn() });
    cleanups.push(() => restarted.dispose());
    expect(restarted.state(pending.generation).state).toBe("unavailable");
    expect(restarted.nextGeneration()).toBeGreaterThan(pending.generation);
    expect(restarted.confirm(1, { provider: "codex" })).toBe(false);
  });

  it("reopens a disk SQLite receipt as unavailable without replaying a lost native callback", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-request-receipts-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "state.sqlite");
    const firstDb = new DatabaseSync(filename);
    const first = new RequestResponseDelivery({ database: { db: firstDb }, respond: vi.fn() });
    const generation = first.nextGeneration();
    first.register({ generation, request: { id: 42, provider: "codex", params: { threadId: "thread", turnId: "turn" } } });
    // Simulate process memory disappearing while SQLite retains the callback receipt.
    first.pending.clear();
    firstDb.close();
    const secondDb = new DatabaseSync(filename);
    cleanups.push(() => secondDb.close());
    const respond = vi.fn();
    const second = new RequestResponseDelivery({ database: { db: secondDb }, respond });
    cleanups.push(() => second.dispose());
    expect(second.state(generation)).toMatchObject({ state: "unavailable", thread_id: "thread", turn_id: "turn", provider: "codex" });
    expect(second.nextGeneration()).toBeGreaterThan(generation);
    expect(respond).not.toHaveBeenCalled();
  });

  it("forwards native provider ownership independently from the durable UI generation", async () => {
    const { delivery, register, respond } = harness(vi.fn(async () => ({ resolved: true })));
    const pending = register(42, { provider: "claude", providerRequestGeneration: 200 });
    await delivery.send(pending, { decision: "accept" });
    expect(respond).toHaveBeenCalledWith(42, { decision: "accept" }, { provider: "claude", requestGeneration: pending.generation, generation: 200 });
  });

  it("known stale native resolution cannot acknowledge a reused callback", () => {
    const { delivery, register } = harness();
    const pending = register(42, { providerRequestGeneration: 200 });
    expect(delivery.confirm(42, { provider: "codex", providerRequestGeneration: 199 })).toBe(false);
    expect(delivery.state(pending.generation).state).toBe("pending");
    expect(delivery.confirm(42, { provider: "codex", providerRequestGeneration: 200 })).toBe(true);
    expect(delivery.state(pending.generation).state).toBe("resolved");
  });
});
