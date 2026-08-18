import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../electron/providers/provider-registry.mjs";

class MemoryDatabase {
  constructor() { this.bindings = new Map(); }
  getThreadProviderBinding(threadId) { return this.bindings.get(threadId) ?? null; }
  saveThreadProviderBinding(binding) {
    const previous = this.bindings.get(binding.threadId) ?? {};
    const saved = { ...previous, ...binding };
    this.bindings.set(binding.threadId, saved);
    return saved;
  }
  deleteThreadProviderBinding(threadId) { this.bindings.delete(threadId); }
}

class FakeProvider extends EventEmitter {
  constructor(id, models) {
    super();
    this.id = id;
    this.models = models;
    this.connected = true;
    this.calls = [];
  }
  async start() { return true; }
  async stop() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: this.models.map((model) => ({ model, displayName: model })) };
    if (method === "thread/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: `${this.id}-thread`, cwd: params.cwd, turns: [] } };
    if (method === "turn/start") return { turn: { id: `${this.id}-turn` } };
    return {};
  }
  respond(id, result) { this.response = { id, result }; }
}

describe("ProviderRegistry", () => {
  it("qualifies models and routes a new thread and its turns to one provider", async () => {
    const database = new MemoryDatabase();
    const registry = new ProviderRegistry({ database });
    const codex = registry.register(new FakeProvider("codex", ["gpt-5.6"]));
    const claude = registry.register(new FakeProvider("claude", ["sonnet"]));

    const models = await registry.request("model/list");
    expect(models.data).toEqual([
      expect.objectContaining({ id: "codex:gpt-5.6", model: "gpt-5.6", provider: "codex" }),
      expect.objectContaining({ id: "claude:sonnet", model: "sonnet", provider: "claude" })
    ]);

    const started = await registry.request("thread/start", { cwd: "/workspace", model: "sonnet" });
    expect(started.thread.provider).toBe("claude");
    expect(database.getThreadProviderBinding("claude-thread").provider).toBe("claude");

    await registry.request("turn/start", { threadId: "claude-thread", model: "sonnet" });
    expect(claude.calls.at(-1)).toMatchObject({ method: "turn/start", params: { threadId: "claude-thread", model: "sonnet" } });
    expect(codex.calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("routes provider server-request responses back to their owner", () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    void codex;
    claude.emit("server-request", { id: "claude-request:1", method: "item/tool/requestApproval", params: {} });
    registry.respond("claude-request:1", { decision: "accept" });
    expect(claude.response).toEqual({ id: "claude-request:1", result: { decision: "accept" } });
  });
});
