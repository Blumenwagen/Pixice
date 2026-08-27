import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../electron/providers/provider-registry.mjs";

class MemoryDatabase {
  constructor() {
    this.bindings = new Map();
    this.snapshots = new Map();
  }
  getThreadProviderBinding(threadId) { return this.bindings.get(threadId) ?? null; }
  saveThreadProviderBinding(binding) {
    const previous = this.bindings.get(binding.threadId) ?? {};
    const saved = { createdAt: previous.createdAt ?? "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-21T10:00:00.000Z", ...previous, ...binding };
    this.bindings.set(binding.threadId, saved);
    return saved;
  }
  deleteThreadProviderBinding(threadId) {
    this.bindings.delete(threadId);
    this.snapshots.delete(threadId);
  }
  listThreadProviderBindings({ provider, cwd } = {}) {
    return [...this.bindings.values()].filter((binding) => (!provider || binding.provider === provider) && (!cwd || binding.cwd === cwd));
  }
  saveProviderThreadSnapshot(threadId, snapshot) { this.snapshots.set(threadId, structuredClone(snapshot)); }
  getProviderThreadSnapshot(threadId) { return structuredClone(this.snapshots.get(threadId) ?? null); }
  getThreadName() { return null; }
  getThreadLink() { return null; }
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
  refreshDeveloperInstructions() { this.instructionRefreshes = (this.instructionRefreshes ?? 0) + 1; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: this.models.map((model) => ({ model, displayName: model })) };
    if (method === "thread/list") return { data: this.threads ?? [] };
    if (method === "thread/start") return { thread: { id: `${this.id}-thread`, cwd: params.cwd, ephemeral: params.ephemeral === true, turns: [] } };
    if (method === "turn/start") return { turn: { id: `${this.id}-turn` } };
    return {};
  }
  respond(id, result) { this.response = { id, result }; }
  async account() { return { account: { type: this.id === "codex" ? "chatgpt" : "claude", email: "dev@example.com" }, authenticated: true, requiresAuth: true }; }
  async login() { return { type: this.id, authUrl: `https://example.com/${this.id}` }; }
}

describe("ProviderRegistry", () => {
  it("refreshes developer instructions across provider adapters", () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));

    registry.refreshDeveloperInstructions();

    expect(codex.instructionRefreshes).toBe(1);
    expect(claude.instructionRefreshes).toBe(1);
  });

  it("starts healthy providers when another provider is missing or broken", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    codex.start = vi.fn().mockRejectedValue(new Error("Codex is missing"));
    claude.start = vi.fn().mockResolvedValue(true);

    await expect(registry.start()).resolves.toBe(true);
    expect(codex.start).toHaveBeenCalledOnce();
    expect(claude.start).toHaveBeenCalledOnce();
  });

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

  it("does not persist ephemeral helper threads", async () => {
    const database = new MemoryDatabase();
    const registry = new ProviderRegistry({ database });
    const codex = registry.register(new FakeProvider("codex", ["gpt-5.6-luna"]));
    const claude = registry.register(new FakeProvider("claude", ["haiku"]));

    const response = await registry.request("thread/start", {
      cwd: "/workspace",
      model: "claude:haiku",
      ephemeral: true
    });

    expect(response.thread).toMatchObject({ id: "claude-thread", ephemeral: true, provider: "claude" });
    expect(database.getThreadProviderBinding("claude-thread")).toBeNull();

    await registry.request("turn/start", { threadId: "claude-thread", model: "claude:haiku" });
    expect(claude.calls.at(-1)).toMatchObject({ method: "turn/start", params: { threadId: "claude-thread", model: "haiku" } });
    expect(codex.calls.some((call) => call.method === "turn/start")).toBe(false);

    await registry.request("thread/archive", { threadId: "claude-thread" });
    expect(database.getThreadProviderBinding("claude-thread")).toBeNull();
  });

  it("reports provider accounts and starts sign in with the selected provider", async () => {
    const database = new MemoryDatabase();
    database.saveThreadProviderBinding({ threadId: "prior-thread", provider: "claude", cwd: "/workspace" });
    const registry = new ProviderRegistry({ database });
    registry.register(new FakeProvider("codex", ["gpt-5.6"]));
    registry.register(new FakeProvider("claude", ["sonnet"]));

    await expect(registry.listProviders()).resolves.toEqual([
      expect.objectContaining({ id: "codex", account: { type: "chatgpt", email: "dev@example.com" }, sessionCount: 0 }),
      expect.objectContaining({ id: "claude", account: { type: "claude", email: "dev@example.com" }, authenticated: true, sessionCount: 1, loginAvailable: true })
    ]);
    await expect(registry.loginProvider("claude")).resolves.toEqual({ type: "claude", authUrl: "https://example.com/claude" });
  });

  it("honors the app-server requiresOpenaiAuth account field", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    codex.account = async () => ({ account: null, requiresOpenaiAuth: false });

    await expect(registry.listProviders()).resolves.toEqual([
      expect.objectContaining({ id: "codex", requiresAuth: false, authenticated: true })
    ]);
  });

  it("exposes lifecycle state and keeps provider operations isolated", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", ["gpt-5.6"]));
    const claude = registry.register(new FakeProvider("claude", ["sonnet"]));
    codex.lifecycle = () => ({
      installed: true,
      installState: { state: "idle" },
      executablePath: "/tools/codex",
      version: "codex-cli 1.2.3",
      compatible: true,
      health: { state: "healthy" },
      updateState: { state: "available", availableVersion: "1.2.4" },
      actions: { install: false, locate: true, repair: true, checkUpdate: true, update: true, login: true, logout: true }
    });
    codex.repair = vi.fn().mockResolvedValue({ installed: true, version: "codex-cli 1.2.4" });
    codex.checkForUpdate = vi.fn().mockResolvedValue({ updateState: { state: "available", availableVersion: "1.2.4" } });
    codex.update = vi.fn().mockResolvedValue({ updateState: { state: "succeeded" }, version: "1.2.4" });
    claude.repair = vi.fn();

    await expect(registry.listProviders()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex",
        installed: true,
        executablePath: "/tools/codex",
        version: "codex-cli 1.2.3",
        compatible: true,
        repairAvailable: true,
        checkUpdateAvailable: true,
        updateAvailable: true
      })
    ]));
    await expect(registry.repairProvider("codex")).resolves.toMatchObject({ version: "codex-cli 1.2.4" });
    expect(codex.repair).toHaveBeenCalledOnce();
    expect(claude.repair).not.toHaveBeenCalled();
  });

  it("checks and updates providers independently", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    codex.checkForUpdate = vi.fn().mockResolvedValue({ updateState: { state: "available", availableVersion: "0.151.0" } });
    claude.checkForUpdate = vi.fn().mockRejectedValue(new Error("Claude channel unavailable"));
    codex.update = vi.fn().mockResolvedValue({ updateState: { state: "succeeded" }, version: "0.151.0" });
    claude.update = vi.fn();

    await expect(registry.checkProviderUpdates()).resolves.toEqual([
      expect.objectContaining({ provider: "codex", updateState: { state: "available", availableVersion: "0.151.0" } }),
      expect.objectContaining({ provider: "claude", updateState: { state: "error", message: "Claude channel unavailable" } })
    ]);
    await expect(registry.updateProvider("codex")).resolves.toMatchObject({ version: "0.151.0" });
    expect(codex.update).toHaveBeenCalledOnce();
    expect(claude.update).not.toHaveBeenCalled();
  });

  it("never advertises models from a disconnected provider", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    registry.register(new FakeProvider("codex", ["gpt-5.6-terra"]));
    const claude = registry.register(new FakeProvider("claude", ["claude-sonnet-4-6"]));
    claude.connected = false;

    const models = await registry.request("model/list");
    expect(models.data.map((model) => model.provider)).toEqual(["codex"]);
    expect(claude.calls.some((call) => call.method === "model/list")).toBe(false);
  });

  it("returns persisted thread summaries while a provider reconnects after an update", async () => {
    const database = new MemoryDatabase();
    const registry = new ProviderRegistry({ database });
    const codex = registry.register(new FakeProvider("codex", ["gpt-5.6-terra"]));
    codex.threads = [{
      id: "codex-thread",
      cwd: "/workspace",
      name: "Persistent task",
      preview: "Persistent task",
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
      status: { type: "idle" }
    }];

    const live = await registry.request("thread/list", { cwd: "/workspace" });
    expect(live.data).toEqual([expect.objectContaining({ id: "codex-thread", provider: "codex" })]);

    codex.connected = false;
    const restored = await registry.request("thread/list", { cwd: "/workspace" });

    expect(restored.data).toEqual([expect.objectContaining({
      id: "codex-thread",
      name: "Persistent task",
      provider: "codex",
      persisted: true
    })]);

    codex.connected = true;
    codex.threads = [];
    const reconciled = await registry.request("thread/list", { cwd: "/workspace" });
    expect(reconciled.data).toEqual([]);
  });

  it("does not advertise models from an unauthenticated provider", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    registry.register(new FakeProvider("codex", ["gpt-5.6-terra"]));
    const claude = registry.register(new FakeProvider("claude", ["claude-sonnet-4-6"]));
    claude.account = async () => ({ account: null, authenticated: false, requiresAuth: true });

    const models = await registry.request("model/list");

    expect(models.data.map((model) => model.provider)).toEqual(["codex"]);
    expect(claude.calls.some((call) => call.method === "model/list")).toBe(false);
  });
});
