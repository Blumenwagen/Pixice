import { EventEmitter } from "node:events";
import { annotateBridgeModel } from "../runtime/model-capabilities.mjs";

const THREAD_METHOD_PREFIXES = ["thread/", "turn/"];

function isThreadMethod(method) {
  return THREAD_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function modelId(model) {
  return typeof model === "string" ? model : model?.id ?? model?.model;
}

function tagProvider(value, provider) {
  return value && typeof value === "object" ? { ...value, provider } : value;
}

function authenticationState(result) {
  const requiresAuth = result?.requiresAuth ?? true;
  const authenticated = result?.authenticated ?? (Boolean(result?.account) || !requiresAuth);
  return { requiresAuth, authenticated };
}

function persistedThread(database, binding) {
  const snapshot = database.getProviderThreadSnapshot?.(binding.threadId);
  if (!snapshot) return null;
  const link = database.getThreadLink?.(binding.threadId);
  return tagProvider({
    ...snapshot,
    id: binding.threadId,
    providerThreadId: snapshot.providerThreadId ?? binding.providerThreadId,
    cwd: snapshot.cwd || binding.cwd,
    name: database.getThreadName?.(binding.threadId) ?? snapshot.name ?? null,
    preview: snapshot.preview ?? "",
    source: snapshot.source ?? "appServer",
    createdAt: snapshot.createdAt ?? binding.createdAt,
    updatedAt: snapshot.updatedAt ?? binding.updatedAt,
    parentThreadId: link?.parentThreadId ?? snapshot.parentThreadId ?? null,
    status: snapshot.status ?? { type: "notLoaded" },
    ...(link ? { bridge: link } : {}),
    persisted: true
  }, binding.provider);
}

/**
 * ProviderService equivalent for Pixice. It deliberately keeps a compatibility
 * request(method, params) surface so the renderer and IPC handlers can migrate
 * incrementally instead of forking into provider-specific code paths.
 */
export class ProviderRegistry extends EventEmitter {
  constructor({ database }) {
    super();
    this.database = database;
    this.providers = new Map();
    this.requestOwners = new Map();
    this.modelProviders = new Map();
    this.statuses = new Map();
  }

  get connected() {
    return [...this.providers.values()].some((provider) => provider.connected);
  }

  register(provider) {
    if (!provider?.id) throw new Error("A provider id is required");
    if (this.providers.has(provider.id)) throw new Error(`Provider ${provider.id} is already registered`);
    this.providers.set(provider.id, provider);
    provider.on("status", (status) => this.#handleStatus(provider, status));
    provider.on("event", (event) => this.emit("event", {
      ...event,
      payload: { ...(event?.payload ?? {}), provider: provider.id }
    }));
    provider.on("server-request", (request) => {
      this.requestOwners.set(this.#requestKey(request.id), provider.id);
      this.emit("server-request", { ...request, provider: provider.id });
    });
    provider.on("recoverable-error", (error) => this.emit("recoverable-error", { ...error, provider: provider.id }));
    provider.on("diagnostic", (message) => this.emit("diagnostic", `[${provider.id}] ${message}`));
    provider.on("binding", (binding) => this.#saveBinding(provider.id, binding));
    return provider;
  }

  async start() {
    const results = await Promise.allSettled([...this.providers.values()].map((provider) => provider.start()));
    return results.some((result) => result.status === "fulfilled" && result.value !== false);
  }

  async stop() {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.stop()));
  }

  refreshDeveloperInstructions() {
    for (const provider of this.providers.values()) provider.refreshDeveloperInstructions?.();
  }

  async listProviders() {
    return Promise.all([...this.providers.values()].map(async (provider) => {
      let account = null;
      let requiresAuth = true;
      let authenticated = false;
      let accountError = null;
      try {
        const result = provider.account ? await provider.account() : null;
        account = result?.account ?? null;
        ({ requiresAuth, authenticated } = authenticationState(result));
      } catch (error) {
        accountError = error.message;
      }
      const sessionCount = this.database.listThreadProviderBindings
        ? this.database.listThreadProviderBindings({ provider: provider.id }).length
        : 0;
      return {
        id: provider.id,
        connected: provider.connected,
        status: this.statuses.get(provider.id) ?? { state: provider.connected ? "ready" : "unavailable" },
        account,
        authenticated,
        requiresAuth,
        accountError,
        sessionCount,
        loginAvailable: typeof provider.login === "function"
      };
    }));
  }

  loginProvider(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable`);
    if (typeof provider.login !== "function") throw new Error(`${providerId} does not support sign in`);
    return provider.login();
  }

  async request(method, params = {}) {
    if (method === "model/list") return this.#listModels(params);
    if (method === "thread/list" && !params.provider) return this.#listThreads(params);

    const provider = this.#providerForRequest(method, params);
    const prepared = this.#prepareParams(provider.id, params);
    const response = await provider.request(method, prepared);
    return this.#rememberResponse(provider.id, method, prepared, response);
  }

  respond(id, result) {
    const key = this.#requestKey(id);
    const providerId = this.requestOwners.get(key);
    const provider = providerId ? this.providers.get(providerId) : this.providers.get("codex");
    if (!provider) throw new Error("The provider for this request is unavailable");
    this.requestOwners.delete(key);
    return provider.respond(id, result);
  }

  providerForThread(threadId) {
    return this.database.getThreadProviderBinding(threadId)?.provider ?? "codex";
  }

  #providerForRequest(method, params) {
    let providerId = params.provider;
    if (!providerId && params.threadId) providerId = this.providerForThread(params.threadId);
    if (!providerId && method === "thread/start") providerId = this.#providerForModel(params.model);
    if (!providerId && isThreadMethod(method)) providerId = "codex";
    if (!providerId) providerId = "codex";
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable`);
    return provider;
  }

  #providerForModel(model) {
    const id = modelId(model);
    if (!id) return "codex";
    if (id.includes(":")) {
      const prefix = id.slice(0, id.indexOf(":"));
      if (this.providers.has(prefix)) return prefix;
    }
    return this.modelProviders.get(id) ?? "codex";
  }

  #prepareParams(providerId, params) {
    const prepared = { ...params };
    delete prepared.provider;
    if (typeof prepared.model === "string" && prepared.model.startsWith(`${providerId}:`)) {
      prepared.model = prepared.model.slice(providerId.length + 1);
    }
    return prepared;
  }

  async #listModels(params) {
    const settled = await Promise.allSettled([...this.providers.values()].map(async (provider) => {
      if (!provider.connected) return [];
      if (provider.account) {
        const account = await provider.account();
        if (!authenticationState(account).authenticated) return [];
      }
      const response = await provider.request("model/list", params);
      return (response?.data ?? []).map((model) => {
        const rawId = modelId(model);
        if (rawId) this.modelProviders.set(rawId, provider.id);
        return annotateBridgeModel({
          ...model,
          id: rawId ? `${provider.id}:${rawId}` : rawId,
          model: rawId,
          provider: provider.id
        });
      });
    }));
    const data = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    return { data, nextCursor: null };
  }

  async #listThreads(params) {
    const settled = await Promise.allSettled([...this.providers.values()].map(async (provider) => {
      if (params.provider && params.provider !== provider.id) return { providerId: provider.id, queried: false, data: [] };
      if (!provider.connected) return { providerId: provider.id, queried: false, data: [] };
      const response = await provider.request("thread/list", params);
      const data = (response?.data ?? []).map((thread) => {
        this.#saveBinding(provider.id, { threadId: thread.id, providerThreadId: thread.providerThreadId, cwd: thread.cwd });
        const link = this.database.getThreadLink?.(thread.id);
        const tagged = tagProvider(link ? { ...thread, parentThreadId: link.parentThreadId, bridge: link } : thread, provider.id);
        this.#saveThreadSummary(provider.id, tagged);
        return tagged;
      });
      return { providerId: provider.id, queried: true, data };
    }));
    const live = settled.flatMap((result) => result.status === "fulfilled" ? result.value.data : []);
    const queriedProviders = new Set(settled.flatMap((result) => result.status === "fulfilled" && result.value.queried ? [result.value.providerId] : []));
    const byId = new Map(live.map((thread) => [thread.id, thread]));
    const bindings = this.database.listThreadProviderBindings({ provider: params.provider, cwd: params.cwd });
    for (const binding of bindings) {
      if (queriedProviders.has(binding.provider)) continue;
      if (byId.has(binding.threadId)) continue;
      const cached = persistedThread(this.database, binding);
      if (!cached) continue;
      if (params.ancestorThreadId && cached.parentThreadId !== params.ancestorThreadId) continue;
      byId.set(cached.id, cached);
    }
    return {
      data: [...byId.values()]
        .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))),
      nextCursor: null
    };
  }

  #rememberResponse(providerId, method, params, response) {
    if (response?.thread?.id) {
      this.#saveBinding(providerId, {
        threadId: response.thread.id,
        providerThreadId: response.thread.providerThreadId,
        cwd: response.thread.cwd ?? params.cwd
      });
      const thread = tagProvider(response.thread, providerId);
      this.#saveThreadSummary(providerId, thread);
      return { ...response, thread };
    }
    if (method === "thread/archive" && params.threadId) this.database.deleteThreadProviderBinding(params.threadId);
    return response;
  }

  #saveBinding(provider, binding) {
    if (!binding?.threadId) return;
    this.database.saveThreadProviderBinding({
      threadId: binding.threadId,
      provider,
      providerThreadId: binding.providerThreadId ?? null,
      resumeCursor: binding.resumeCursor ?? null,
      cwd: binding.cwd ?? this.database.getThreadProviderBinding(binding.threadId)?.cwd ?? ""
    });
  }

  #saveThreadSummary(provider, thread) {
    if (provider !== "codex" || !thread?.id || !this.database.saveProviderThreadSnapshot) return;
    this.database.saveProviderThreadSnapshot(thread.id, {
      id: thread.id,
      providerThreadId: thread.providerThreadId ?? null,
      cwd: thread.cwd ?? "",
      name: thread.name ?? null,
      preview: thread.preview ?? "",
      source: thread.source ?? "appServer",
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      status: thread.status ?? { type: "notLoaded" }
    });
  }

  #handleStatus(provider, status) {
    this.statuses.set(provider.id, status);
    const states = [...this.statuses.values()].map((entry) => entry.state);
    const state = states.includes("ready")
      ? "ready"
      : states.some((entry) => entry === "connecting" || entry === "reconnecting")
        ? "connecting"
        : states.includes("error")
          ? "error"
          : states.includes("unavailable")
            ? "unavailable"
            : "stopped";
    this.emit("status", {
      state,
      provider: provider.id,
      message: state === status.state ? status.message : undefined,
      providers: Object.fromEntries(this.statuses)
    });
  }

  #requestKey(id) {
    return `${typeof id}:${id}`;
  }
}
