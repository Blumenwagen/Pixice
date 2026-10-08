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
    if (method === "thread/read") {
      return { thread: this.threadReads?.[params.threadId] ?? this.threads?.find((thread) => thread.id === params.threadId) };
    }
    if (method === "thread/start") return { thread: { id: `${this.id}-thread`, cwd: params.cwd, ephemeral: params.ephemeral === true, turns: [] } };
    if (method === "thread/fork") return { thread: { id: `${this.id}-fork`, cwd: "/workspace", parentThreadId: null, turns: [] } };
    if (method === "turn/start") return { turn: { id: `${this.id}-turn` } };
    return {};
  }
  respond(id, result) { this.response = { id, result }; }
  async account() { return { account: { type: this.id === "codex" ? "chatgpt" : "claude", email: "dev@example.com" }, authenticated: true, requiresAuth: true }; }
  async login() { return { type: this.id, authUrl: `https://example.com/${this.id}` }; }
}

describe("ProviderRegistry", () => {
  it("retains provider response ownership until native confirmation, including failed and repeated writes", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    claude.respond = vi.fn().mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue({ written: true, resolved: false });
    codex.respond = vi.fn();
    claude.emit("server-request", { id: "owned", method: "approval", params: {} });
    await expect(registry.respond("owned", { decision: "accept" })).rejects.toThrow("Response lost");
    await registry.respond("owned", { decision: "accept" });
    await registry.respond("owned", { decision: "accept" });
    expect(claude.respond).toHaveBeenCalledTimes(3);
    expect(codex.respond).not.toHaveBeenCalled();
    expect(registry.requestOwners.get("claude\0string:owned")).toBe("claude");
    codex.emit("event", { payload: { method: "serverRequest/resolved", requestId: "owned" } });
    expect(registry.requestOwners.get("claude\0string:owned")).toBe("claude");
    claude.emit("event", { payload: { method: "serverRequest/resolved", requestId: "owned" } });
    expect(registry.requestOwners.has("claude\0string:owned")).toBe(false);
  });

  it("a delayed resolved SDK receipt cannot release a replacement callback with a reused id", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const claude = registry.register(new FakeProvider("claude", []));
    let resolve;
    claude.respond = vi.fn(() => new Promise(yes => { resolve = yes; }));
    claude.emit("server-request", { id: "reused", method: "approval", params: {} });
    const original = registry.respond("reused", {});
    claude.emit("server-request", { id: "reused", method: "approval", params: {} });
    resolve({ resolved: true });
    await original;
    expect(registry.requestOwners.get("claude\0string:reused")).toBe("claude");
  });

  it("never defaults a lost callback to Codex and rejects a mismatched provider or native generation", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    codex.respond = vi.fn();
    claude.respond = vi.fn(() => ({ written: true, resolved: false }));
    expect(() => registry.respond("lost", {})).toThrow("no longer available");
    let request;
    registry.on("server-request", value => { request = value; });
    claude.emit("server-request", { id: "owned", method: "approval", params: {} });
    expect(() => registry.respond("owned", {}, { provider: "codex" })).toThrow("no longer available");
    expect(() => registry.respond("owned", {}, { provider: "claude", generation: request.providerRequestGeneration + 1 })).toThrow("no longer available");
    registry.respond("owned", {}, { provider: "claude", generation: request.providerRequestGeneration });
    expect(claude.respond).toHaveBeenCalledOnce();
    expect(codex.respond).not.toHaveBeenCalled();
  });

  it("routes simultaneous same typed ids separately and resolving one leaves the other owned", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    codex.respond = vi.fn(() => ({ written: true, resolved: false }));
    claude.respond = vi.fn(() => ({ written: true, resolved: false }));
    const requests = [];
    registry.on("server-request", value => requests.push(value));
    codex.emit("server-request", { id: 7, method: "approval", params: { threadId: "codex-thread" } });
    claude.emit("server-request", { id: 7, method: "question", params: { threadId: "claude-thread" } });
    expect(() => registry.respond(7, {})).toThrow("ambiguous");
    registry.respond(7, { decision: "accept" }, { provider: "codex", generation: requests[0].providerRequestGeneration });
    registry.respond(7, { answer: "yes" }, { provider: "claude", generation: requests[1].providerRequestGeneration });
    expect(codex.respond).toHaveBeenCalledWith(7, { decision: "accept" });
    expect(claude.respond).toHaveBeenCalledWith(7, { answer: "yes" });
    const events = [];
    registry.on("event", value => events.push(value));
    codex.emit("event", { payload: { method: "serverRequest/resolved", requestId: 7 } });
    expect(events[0].payload).toMatchObject({ provider: "codex", providerRequestGeneration: requests[0].providerRequestGeneration });
    expect(registry.requestOwners.has("codex\0number:7")).toBe(false);
    expect(registry.requestOwners.get("claude\0number:7")).toBe("claude");
    registry.respond(7, {}, { provider: "claude", generation: requests[1].providerRequestGeneration });
    expect(claude.respond).toHaveBeenCalledTimes(2);
  });

  it("known old native resolution generation cannot release a replacement callback", () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const claude = registry.register(new FakeProvider("claude", []));
    const requests = [], events = [];
    registry.on("server-request", value => requests.push(value));
    registry.on("event", value => events.push(value));
    claude.emit("server-request", { id: "reused", method: "question", params: {} });
    claude.emit("server-request", { id: "reused", method: "question", params: {} });
    claude.emit("event", { payload: { method: "serverRequest/resolved", requestId: "reused", providerRequestGeneration: requests[0].providerRequestGeneration } });
    expect(registry.requestOwners.get("claude\0string:reused")).toBe("claude");
    expect(events[0].payload.providerRequestGeneration).toBe(requests[0].providerRequestGeneration);
    claude.emit("event", { payload: { method: "serverRequest/resolved", requestId: "reused", providerRequestGeneration: requests[1].providerRequestGeneration } });
    expect(registry.requestOwners.has("claude\0string:reused")).toBe(false);
  });

  it("a resolved event for another recorded turn cannot remove the current native owner", () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    codex.emit("server-request", { id: 1, method: "approval", params: { threadId: "thread", turnId: "new-turn" } });
    codex.emit("event", { payload: { method: "serverRequest/resolved", requestId: 1, threadId: "thread", turnId: "old-turn" } });
    expect(registry.requestOwners.get("codex\0number:1")).toBe("codex");
  });

  it("invalidates restarted provider callbacks while preserving another provider's same id", () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));
    codex.emit("server-request", { id: 1, method: "approval", params: {} });
    claude.emit("server-request", { id: 1, method: "approval", params: {} });
    codex.emit("status", { state: "connecting" });
    expect(() => registry.respond(1, {}, { provider: "codex" })).toThrow("no longer available");
    expect(() => registry.respond(1, {}, { provider: "claude" })).not.toThrow();
  });
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

  it("discovers Astra and routes qualified model IDs and reasoning effort to Codex", async () => {
    const registry = new ProviderRegistry({ database: new MemoryDatabase() });
    const codex = registry.register(new FakeProvider("codex", ["gpt-6-astra"]));
    const models = await registry.request("model/list");
    expect(models.data[0]).toMatchObject({
      id: "codex:gpt-6-astra", model: "gpt-6-astra", bridge: { eligible: true }
    });
    const started = await registry.request("thread/start", { cwd: "/workspace", model: "codex:gpt-6-astra" });
    await registry.request("turn/start", { threadId: started.thread.id, model: "codex:gpt-6-astra", effort: "ultra", serviceTier: "priority" });
    expect(codex.calls.at(-1)).toMatchObject({
      method: "turn/start", params: { model: "gpt-6-astra", effort: "ultra", serviceTier: "priority" }
    });
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

  it("routes a fork to the source provider and persists fork ancestry separately", async () => {
    const database = new MemoryDatabase();
    database.saveThreadProviderBinding({ threadId: "source-thread", provider: "claude", providerThreadId: "session-1", cwd: "/workspace" });
    const registry = new ProviderRegistry({ database });
    const codex = registry.register(new FakeProvider("codex", []));
    const claude = registry.register(new FakeProvider("claude", []));

    const response = await registry.request("thread/fork", {
      threadId: "source-thread",
      lastTurnId: "turn-1",
      lastItemId: "answer-1"
    });

    expect(response.thread).toMatchObject({ id: "claude-fork", provider: "claude", parentThreadId: null, forkedFromId: "source-thread" });
    expect(claude.calls.at(-1)).toMatchObject({ method: "thread/fork", params: { threadId: "source-thread", lastTurnId: "turn-1", lastItemId: "answer-1" } });
    expect(codex.calls).toEqual([]);
    expect(database.getThreadProviderBinding("claude-fork")).toMatchObject({ provider: "claude", forkedFromId: "source-thread" });
  });

  it("projects durable Codex fork ancestry onto live list and read responses after restart", async () => {
    const database = new MemoryDatabase();
    database.saveThreadProviderBinding({ threadId: "source-thread", provider: "codex", providerThreadId: "native-source", cwd: "/workspace" });
    const initialRegistry = new ProviderRegistry({ database });
    initialRegistry.register(new FakeProvider("codex", []));

    const forked = await initialRegistry.request("thread/fork", {
      threadId: "source-thread",
      lastTurnId: "turn-1",
      lastItemId: "answer-1"
    });
    expect(forked.thread).toMatchObject({ id: "codex-fork", forkedFromId: "source-thread" });

    const restartedRegistry = new ProviderRegistry({ database });
    const restartedCodex = restartedRegistry.register(new FakeProvider("codex", []));
    const liveFork = {
      id: "codex-fork",
      providerThreadId: "native-fork",
      cwd: "/workspace",
      name: "Source task (fork)",
      status: { type: "idle" }
    };
    restartedCodex.threads = [liveFork];
    restartedCodex.threadReads = { "codex-fork": liveFork };

    await expect(restartedRegistry.request("thread/list", { cwd: "/workspace" })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "codex-fork", forkedFromId: "source-thread", provider: "codex" })]
    });
    await expect(restartedRegistry.request("thread/read", { threadId: "codex-fork" })).resolves.toMatchObject({
      thread: expect.objectContaining({ id: "codex-fork", forkedFromId: "source-thread", provider: "codex" })
    });

    restartedCodex.connected = false;
    await expect(restartedRegistry.request("thread/list", { cwd: "/workspace" })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "codex-fork", forkedFromId: "source-thread", persisted: true })]
    });
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
