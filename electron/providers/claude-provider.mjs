import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PIXICE_BROWSER_MCP_TOOLS,
  PIXICE_BROWSER_NAMESPACE,
  browserDynamicTools,
  browserToolShapes
} from "../browser/browser-workspace.mjs";
import { buildClaudeUserMessage } from "../runtime/user-input.mjs";
import {
  PIXICE_PREVIEW_MCP_TOOLS,
  PIXICE_PREVIEW_NAMESPACE,
  previewContextDynamicTools,
  previewContextToolShapes,
  stripPreviewContextHint
} from "../runtime/preview-context.mjs";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { normalizePixiceQuestions, pixiceQuestionToolShape } from "../runtime/question-tool.mjs";
import { PIXICE_BRIDGE_MCP_TOOLS, pixiceBridgeDynamicTools, pixiceBridgeToolShapes } from "../runtime/pixice-bridge.mjs";
import { PIXICE_BOARD_MCP_TOOLS, pixiceBoardToolShapes, pixiceBoardTools } from "../runtime/pixice-board.mjs";
import {
  PIXICE_INSTRUMENTS_MCP_TOOLS,
  instrumentToolShapes,
  instrumentTools
} from "../instruments/instrument-service.mjs";

const FALLBACK_MODELS = [
  { value: "default", displayName: "Claude (recommended)", description: "Use Claude Code's recommended model." }
];
export const CLAUDE_STREAM_CHECKPOINT_MS = 250;

function normalizeClaudeModels(discovered = []) {
  const models = new Map();
  for (const model of discovered) {
    const value = model.value ?? model.id ?? model.model;
    if (!value) continue;
    models.set(value, { ...model, value });
  }
  return [...models.values()];
}

function serializeClaudeModels(models) {
  return models.map((model) => ({
    id: model.value,
    model: model.value,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.value === "default",
    defaultReasoningEffort: model.supportsEffort ? "high" : null,
    supportedReasoningEfforts: (model.supportedEffortLevels ?? []).map((effort) => ({ reasoningEffort: effort, description: effort }))
  }));
}

export function claudeAccountIsAuthenticated(account) {
  if (!account || typeof account !== "object") return false;
  if (account.apiProvider && account.apiProvider !== "firstParty") return true;
  if (account.email || account.organization || account.subscriptionType) return true;
  if (account.apiKeySource && account.apiKeySource !== "none") return true;
  return Boolean(account.tokenSource && account.tokenSource !== "none");
}

export function claudeExternallyManagedAuth(account, environment = process.env) {
  if (
    environment.ANTHROPIC_API_KEY
    || environment.ANTHROPIC_AUTH_TOKEN
    || environment.CLAUDE_CODE_OAUTH_TOKEN
    || environment.CLAUDE_CODE_USE_BEDROCK
    || environment.CLAUDE_CODE_USE_VERTEX
    || environment.CLAUDE_CODE_USE_FOUNDRY
  ) return true;
  if (account?.apiProvider && account.apiProvider !== "firstParty") return true;
  const apiKeySource = String(account?.apiKeySource ?? "none").toLowerCase();
  if (["anthropic_api_key", "apikeyhelper", "user", "project", "org", "temporary"].includes(apiKeySource)) return true;
  const tokenSource = String(account?.tokenSource ?? "none").toLowerCase();
  return tokenSource !== "none" && !tokenSource.includes("oauth") && !tokenSource.includes("claude.ai");
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
const PIXICE_QUESTION_MCP_TOOL = "mcp__pixice__request_user_input";

export class AsyncPromptQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) throw new Error("This Claude prompt queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

export function claudePermissionSettings(mode) {
  if (mode === "full-access") {
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, sandbox: undefined };
  }
  if (mode === "auto-approve") {
    return { permissionMode: "auto", allowDangerouslySkipPermissions: false, sandbox: { enabled: true } };
  }
  if (mode === "workspace-write") {
    return { permissionMode: "acceptEdits", allowDangerouslySkipPermissions: false, sandbox: { enabled: true } };
  }
  return {
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    sandbox: { enabled: true },
    tools: [
      ...READ_TOOLS,
      "AskUserQuestion",
      PIXICE_QUESTION_MCP_TOOL,
      ...PIXICE_BRIDGE_MCP_TOOLS,
      ...PIXICE_BOARD_MCP_TOOLS,
      ...PIXICE_INSTRUMENTS_MCP_TOOLS,
      ...PIXICE_BROWSER_MCP_TOOLS,
      ...PIXICE_PREVIEW_MCP_TOOLS
    ]
  };
}

export function claudeQueryOptions({
  cwd,
  runtimeWorkspaceRoots,
  model,
  effort,
  permissionMode,
  sessionId,
  resume,
  developerInstructions,
  clientVersion,
  canUseTool,
  mcpServers,
  pathToClaudeCodeExecutable,
  environment = process.env
}) {
  const permissions = claudePermissionSettings(permissionMode);
  const executableDirectory = pathToClaudeCodeExecutable ? path.dirname(pathToClaudeCodeExecutable) : null;
  const inheritedPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const childEnvironment = { ...environment };
  delete childEnvironment.Path;
  delete childEnvironment.path;
  if (executableDirectory || inheritedPath) {
    childEnvironment.PATH = [executableDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
  }
  return {
    cwd,
    additionalDirectories: [...new Set([cwd, ...(runtimeWorkspaceRoots ?? [])])],
    model: model || undefined,
    effort: effort || undefined,
    sessionId: resume ? undefined : sessionId,
    resume: resume || undefined,
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    settingSources: ["user", "project", "local"],
    systemPrompt: developerInstructions
      ? { type: "preset", preset: "claude_code", append: developerInstructions }
      : { type: "preset", preset: "claude_code" },
    // Claude Code initializes native subagents through a separate prompt channel.
    appendSubagentSystemPrompt: developerInstructions || undefined,
    canUseTool,
    mcpServers,
    env: {
      ...childEnvironment,
      CLAUDE_AGENT_SDK_CLIENT_APP: `pixice/${clientVersion}`
    },
    pathToClaudeCodeExecutable: pathToClaudeCodeExecutable || undefined,
    ...permissions
  };
}

function now() {
  return new Date().toISOString();
}

function threadStatus(type) {
  return type === "active" ? { type: "active", activeFlags: [] } : { type };
}

function userItem(message, id = randomUUID()) {
  return {
    id,
    type: "userMessage",
    content: (message.message?.content ?? []).map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", url: `data:${part.source.media_type};base64,${part.source.data}` })
  };
}

function toolItem(block) {
  const common = { id: block.id, status: "inProgress" };
  if (block.name === "Bash") return { ...common, type: "commandExecution", command: block.input?.command ?? "", cwd: block.input?.cwd };
  if (["Write", "Edit", "NotebookEdit"].includes(block.name)) {
    return { ...common, type: "fileChange", path: block.input?.file_path ?? block.input?.notebook_path, changes: block.input };
  }
  if (block.name === "Agent" || block.name === "Task") {
    return { ...common, type: "collabAgentToolCall", tool: "spawnAgent", prompt: block.input?.prompt, senderThreadId: null, receiverThreadIds: [], agentsStates: {} };
  }
  if (block.name.startsWith("mcp__")) {
    const [, server, ...tool] = block.name.split("__");
    return { ...common, type: [PIXICE_BROWSER_NAMESPACE, PIXICE_PREVIEW_NAMESPACE].includes(server) ? "dynamicToolCall" : "mcpToolCall", server, tool: tool.join("__"), arguments: block.input };
  }
  return { ...common, type: "mcpToolCall", server: "claude", tool: block.name, arguments: block.input };
}

function claudeMcpResult(result) {
  return {
    content: (result.contentItems ?? []).map((item) => {
      if (item.type !== "inputImage") return { type: "text", text: item.text ?? "" };
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl ?? "");
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: match?.[1] ?? "image/png",
          data: match?.[2] ?? ""
        }
      };
    }),
    isError: result.success === false
  };
}

function appendItem(turn, item) {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = { ...turn.items[index], ...item };
  return turn.items[index === -1 ? turn.items.length - 1 : index];
}

export class ClaudeProvider extends EventEmitter {
  constructor({
    database,
    clientVersion,
    developerInstructionsPath,
    developerInstructions = null,
    queryFactory = null,
    pixiceBridge = null,
    pixiceBoard = null,
    pixiceInstruments = null,
    pixiceBrowser = null,
    pixicePreview = null,
    pathToClaudeCodeExecutable = null,
    requireExternalExecutable = false,
    runtimeLifecycle = null,
    environment = process.env,
    streamCheckpointMs = CLAUDE_STREAM_CHECKPOINT_MS
  }) {
    super();
    this.id = "claude";
    this.database = database;
    this.clientVersion = clientVersion;
    this.developerInstructionsPath = developerInstructionsPath;
    this.developerInstructions = developerInstructions;
    this.queryFactory = queryFactory;
    this.pixiceBridge = pixiceBridge;
    this.pixiceBoard = pixiceBoard;
    this.pixiceInstruments = pixiceInstruments;
    this.pixiceBrowser = pixiceBrowser;
    this.pixicePreview = pixicePreview;
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    this.requireExternalExecutable = requireExternalExecutable;
    this.runtimeLifecycle = runtimeLifecycle;
    this.environment = environment;
    this.streamCheckpointMs = Math.max(1, Number(streamCheckpointMs) || CLAUDE_STREAM_CHECKPOINT_MS);
    this.sessions = new Map();
    this.pendingSnapshotWrites = new Map();
    this.persistedBindingKeys = new Map();
    this.pendingRequests = new Map();
    this.models = null;
    this.started = false;
    this.authSession = null;
    this.runtimeLifecycle?.on("state", (state) => this.emit("lifecycle", state));
  }

  get connected() {
    return this.started;
  }

  async start() {
    try {
      let lifecycle = null;
      if (this.runtimeLifecycle) {
        lifecycle = await this.runtimeLifecycle.discover();
        this.pathToClaudeCodeExecutable = lifecycle.executablePath;
      }
      if (this.requireExternalExecutable && (!this.pathToClaudeCodeExecutable || lifecycle?.compatible === false)) {
        throw new Error(lifecycle?.health?.message ?? "Claude Code is unavailable. Install Claude Code or locate an existing executable in Settings.");
      }
      if (!this.queryFactory) this.queryFactory = (await import("@anthropic-ai/claude-agent-sdk")).query;
      this.started = true;
      this.emit("status", { state: "ready", message: "Claude runtime available" });
      return true;
    } catch (error) {
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "claude_sdk_unavailable", message: error.message });
      return false;
    }
  }

  async stop() {
    this.#closeAuthSession();
    for (const context of this.sessions.values()) {
      this.#flushPersist(context);
      context.queue?.close();
      context.abortController?.abort();
      context.query?.close?.();
    }
    this.sessions.clear();
    this.persistedBindingKeys.clear();
    for (const pending of this.pendingRequests.values()) {
      pending.resolve(pending.kind === "pixice-question"
        ? { cancelled: true, answers: {} }
        : { behavior: "deny", message: "Pixice stopped the Claude session", interrupt: true });
    }
    this.pendingRequests.clear();
    this.started = false;
    this.emit("status", { state: "stopped" });
  }

  refreshDeveloperInstructions() {
    for (const context of this.sessions.values()) {
      if (!context.usesGlobalDeveloperInstructions) continue;
      context.developerInstructions = null;
      if (context.currentTurn) context.refreshInstructionsAfterTurn = true;
      else this.#disposeQuery(context);
    }
  }

  async account() {
    if (!this.started) throw new Error("Claude provider is not available");
    let query;
    const queue = new AsyncPromptQueue();
    try {
      query = this.queryFactory({
        prompt: queue,
        options: this.#probeOptions()
      });
      const account = await Promise.race([
        query.accountInfo(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Claude account discovery timed out")), 8_000))
      ]);
      const authenticated = claudeAccountIsAuthenticated(account);
      return {
        account: authenticated ? { type: "claude", ...account } : null,
        authenticated,
        requiresAuth: true,
        externallyManagedAuth: claudeExternallyManagedAuth(account, this.environment)
      };
    } finally {
      queue.close();
      query?.close?.();
    }
  }

  async usageLimits() {
    if (!this.started) throw new Error("Claude provider is not available");
    let query;
    const queue = new AsyncPromptQueue();
    try {
      query = this.queryFactory({
        prompt: queue,
        options: this.#probeOptions()
      });
      const account = await Promise.race([
        query.accountInfo(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Claude account discovery timed out")), 8_000))
      ]);
      const authenticated = claudeAccountIsAuthenticated(account);
      if (!authenticated) return { account: null, authenticated: false, usage: null };
      const usageMethod = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof usageMethod !== "function") throw new Error("This Claude runtime does not expose live plan limits yet.");
      const usage = await Promise.race([
        usageMethod.call(query),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Claude limits discovery timed out")), 8_000))
      ]);
      return { account: { type: "claude", ...account }, authenticated: true, usage };
    } finally {
      queue.close();
      query?.close?.();
    }
  }

  async login() {
    if (!this.started) throw new Error("Claude provider is not available");
    this.#closeAuthSession();
    const queue = new AsyncPromptQueue();
    const query = this.queryFactory({ prompt: queue, options: this.#probeOptions() });
    this.authSession = { queue, query };
    try {
      const response = await query.claudeAuthenticate(true);
      const authUrl = response?.authUrl ?? response?.url;
      if (!authUrl) throw new Error("Claude did not return a sign-in URL");
      void query.claudeOAuthWaitForCompletion()
        .then(() => {
          this.models = null;
          this.emit("status", { state: "ready", message: "Claude account connected" });
        })
        .catch((error) => this.emit("diagnostic", `Claude sign in did not complete: ${error.message}`))
        .finally(() => this.#closeAuthSession(query));
      return { ...response, type: "claude", authUrl };
    } catch (error) {
      this.#closeAuthSession(query);
      throw error;
    }
  }

  async logout() {
    if (!this.started) throw new Error("Claude provider is not available");
    const account = await this.account();
    if (account.externallyManagedAuth) {
      return {
        loggedOut: false,
        externallyManagedAuth: true,
        message: "Claude credentials are managed by an environment variable or external cloud provider and must be cleared there."
      };
    }
    if (!this.runtimeLifecycle) throw new Error("Claude logout requires an external Claude Code executable");
    this.#closeAuthSession();
    await this.runtimeLifecycle.logoutCommand();
    this.models = null;
    this.emit("status", { state: "ready", message: "Claude account disconnected" });
    return { loggedOut: true, externallyManagedAuth: false };
  }

  lifecycle() {
    return this.runtimeLifecycle?.snapshot() ?? {};
  }

  externallyManagedAuth() {
    return claudeExternallyManagedAuth(null, this.environment);
  }

  install() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.install());
  }

  locate(executablePath) {
    return this.#replaceRuntime(() => this.runtimeLifecycle.locate(executablePath));
  }

  repair() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.repair());
  }

  checkForUpdate() {
    if (!this.runtimeLifecycle) throw new Error("Claude update checks are unavailable");
    return this.runtimeLifecycle.checkForUpdate();
  }

  update() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.update());
  }

  async refreshLifecycle() {
    const lifecycle = await this.runtimeLifecycle.discover();
    this.pathToClaudeCodeExecutable = lifecycle.executablePath;
    return { ...lifecycle, connected: this.connected };
  }

  async #replaceRuntime(operation) {
    if (!this.runtimeLifecycle) throw new Error("Claude runtime management is unavailable");
    const previousExecutablePath = this.pathToClaudeCodeExecutable;
    const wasConnected = this.connected;
    await this.stop();
    try {
      const lifecycle = await operation();
      this.pathToClaudeCodeExecutable = lifecycle.executablePath;
      const connected = await this.start();
      return { ...this.runtimeLifecycle.snapshot(), connected };
    } catch (error) {
      this.pathToClaudeCodeExecutable = previousExecutablePath;
      if (wasConnected && previousExecutablePath) await this.start();
      throw error;
    }
  }

  async request(method, params = {}) {
    if (!this.started) throw new Error("Claude provider is not available");
    if (method === "model/list") return this.#listModels(params);
    if (method === "thread/list") return this.#listThreads(params);
    if (method === "thread/start") return this.#startThread(params);
    if (method === "thread/read" || method === "thread/resume") return { thread: this.#context(params.threadId).thread };
    if (method === "thread/archive") return this.#archiveThread(params.threadId);
    if (method === "thread/name/set") return this.#nameThread(params.threadId, params.name);
    if (method === "turn/start") return this.#startTurn(params);
    if (method === "turn/steer") return this.#steerTurn(params);
    if (method === "turn/interrupt") return this.#interruptTurn(params);
    if (["skills/list", "app/list", "mcpServerStatus/list"].includes(method)) return { data: [] };
    throw new Error(`Claude provider does not implement ${method}`);
  }

  respond(id, result) {
    const pending = this.pendingRequests.get(String(id));
    if (!pending) throw new Error("Claude request is no longer pending");
    this.pendingRequests.delete(String(id));
    if (pending.kind === "question") {
      pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: result.answers ?? {} } });
      return;
    }
    if (pending.kind === "pixice-question") {
      pending.resolve(result.action === "cancel"
        ? { cancelled: true, answers: {} }
        : { cancelled: false, answers: result.answers ?? {} });
      return;
    }
    if (result.decision === "accept" || result.decision === "acceptForSession") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        ...(result.decision === "acceptForSession" && pending.suggestions?.length ? { updatedPermissions: pending.suggestions } : {})
      });
    } else {
      pending.resolve({ behavior: "deny", message: "The user declined this tool call", interrupt: result.decision === "cancel" });
    }
  }

  async #listModels(params) {
    if (this.models) return { data: serializeClaudeModels(this.models) };
    let models;
    let probe;
    const queue = new AsyncPromptQueue();
    try {
      const cwd = params.cwd || process.cwd();
      probe = this.queryFactory({
        prompt: queue,
        options: claudeQueryOptions({
          cwd,
          permissionMode: "read-only",
          sessionId: randomUUID(),
          developerInstructions: this.#developerInstructions(),
          clientVersion: this.clientVersion,
          canUseTool: async () => ({ behavior: "deny", message: "Model discovery cannot run tools" }),
          pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
          environment: this.environment
        })
      });
      const discovered = await Promise.race([
        probe.supportedModels(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Claude model discovery timed out")), 8_000))
      ]);
      models = normalizeClaudeModels(discovered);
      if (!models.length) throw new Error("Claude returned no supported models");
      this.models = models;
    } catch (error) {
      models = FALLBACK_MODELS;
      this.emit("diagnostic", `Claude model discovery fell back to aliases: ${error.message}`);
    } finally {
      queue.close();
      probe?.close?.();
    }
    return { data: serializeClaudeModels(models) };
  }

  #probeOptions() {
    return claudeQueryOptions({
      cwd: process.cwd(),
      permissionMode: "read-only",
      sessionId: randomUUID(),
      developerInstructions: this.#developerInstructions(),
      clientVersion: this.clientVersion,
      canUseTool: async () => ({ behavior: "deny", message: "Account discovery cannot run tools" }),
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
      environment: this.environment
    });
  }

  #closeAuthSession(expectedQuery) {
    if (!this.authSession || (expectedQuery && this.authSession.query !== expectedQuery)) return;
    this.authSession.queue.close();
    this.authSession.query.close?.();
    this.authSession = null;
  }

  #listThreads({ cwd, ancestorThreadId } = {}) {
    const data = (this.database.listProviderThreadSummaries
      ? this.database.listProviderThreadSummaries({ provider: this.id, cwd })
      : this.database.listThreadProviderBindings({ provider: this.id, cwd })
        .map((binding) => this.database.getProviderThreadSnapshot(binding.threadId))
        .filter(Boolean))
      .filter((thread) => !ancestorThreadId || thread.parentThreadId === ancestorThreadId);
    return { data, nextCursor: null };
  }

  #startThread(params) {
    const createdAt = now();
    const threadId = randomUUID();
    const providerThreadId = randomUUID();
    const thread = {
      id: threadId,
      providerThreadId,
      cwd: params.cwd,
      ephemeral: params.ephemeral === true,
      name: null,
      preview: "",
      source: "appServer",
      createdAt,
      updatedAt: createdAt,
      parentThreadId: params.parentThreadId ?? null,
      status: threadStatus("idle"),
      turns: []
    };
    const globalDeveloperInstructions = this.#developerInstructions();
    const usesGlobalDeveloperInstructions = !params.developerInstructions || params.developerInstructions === globalDeveloperInstructions;
    const context = {
      thread,
      providerThreadId,
      resumeCursor: null,
      model: params.model || null,
      effort: null,
      permissionMode: params.permissionMode || "workspace-write",
      internalNoTools: params.internalNoTools === true,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots || [params.cwd],
      developerInstructions: usesGlobalDeveloperInstructions ? null : params.developerInstructions,
      usesGlobalDeveloperInstructions,
      refreshInstructionsAfterTurn: false,
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      compactionItem: null,
      toolItems: new Map()
    };
    this.sessions.set(threadId, context);
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "thread/started", thread });
    return { thread };
  }

  #archiveThread(threadId) {
    const context = this.#context(threadId);
    this.#flushPersist(context);
    context.queue?.close();
    context.abortController?.abort();
    context.query?.close?.();
    this.sessions.delete(threadId);
    this.persistedBindingKeys.delete(threadId);
    this.#emitEvent("TaskUpdated", { method: "thread/archived", threadId });
    return { threadId };
  }

  #nameThread(threadId, name) {
    const context = this.#context(threadId);
    context.thread.name = String(name ?? "").trim() || context.thread.name;
    context.thread.updatedAt = now();
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "thread/name/updated", threadId, name: context.thread.name });
    return { thread: context.thread };
  }

  async #startTurn(params) {
    const context = this.#context(params.threadId);
    if (context.currentTurn) throw new Error("Claude already has an active turn in this thread");
    context.model = params.model || context.model;
    context.effort = params.effort || context.effort;
    context.permissionMode = params.permissionMode || context.permissionMode;
    context.runtimeWorkspaceRoots = params.runtimeWorkspaceRoots || context.runtimeWorkspaceRoots;
    const message = this.#inputMessage(params.input);
    message.session_id = context.providerThreadId;
    const turn = {
      id: randomUUID(),
      status: "inProgress",
      items: [userItem(message)],
      createdAt: now()
    };
    context.currentTurn = turn;
    context.thread.turns.push(turn);
    context.thread.preview ||= stripPreviewContextHint(message.message.content.find((part) => part.type === "text")?.text).slice(0, 180) || "Image task";
    context.thread.status = threadStatus("active");
    context.thread.updatedAt = now();
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "turn/started", threadId: context.thread.id, turn });

    await this.#ensureQuery(context);
    if (context.query?.setModel && params.model) await context.query.setModel(params.model);
    if (context.query?.setPermissionMode) await context.query.setPermissionMode(claudePermissionSettings(context.permissionMode).permissionMode);
    context.queue.push(message);
    return { turn };
  }

  #steerTurn(params) {
    const context = this.#context(params.threadId);
    if (!context.currentTurn || context.currentTurn.id !== params.expectedTurnId) throw new Error("Claude turn is no longer active");
    const message = this.#inputMessage(params.input);
    message.session_id = context.providerThreadId;
    appendItem(context.currentTurn, userItem(message));
    context.queue.push(message);
    this.#persist(context);
    return { turnId: context.currentTurn.id };
  }

  async #interruptTurn({ threadId, turnId }) {
    const context = this.#context(threadId);
    if (context.currentTurn?.id !== turnId) return { turnId };
    await context.query?.interrupt?.();
    this.#completeTurn(context, "interrupted");
    return { turnId };
  }

  async #ensureQuery(context) {
    if (context.query) return;
    context.queue = new AsyncPromptQueue();
    context.abortController = new AbortController();
    const options = claudeQueryOptions({
      cwd: context.thread.cwd,
      runtimeWorkspaceRoots: context.runtimeWorkspaceRoots,
      model: context.model,
      effort: context.effort,
      permissionMode: context.permissionMode,
      sessionId: context.providerThreadId,
      resume: context.resumeCursor,
      developerInstructions: context.developerInstructions || this.#developerInstructions(),
      clientVersion: this.clientVersion,
      canUseTool: (toolName, input, details) => this.#canUseTool(context, toolName, input, details),
      mcpServers: {
        pixice: this.#pixiceQuestionServer(context),
        ...(this.pixiceBridge ? { pixice_bridge: this.#pixiceBridgeServer(context) } : {}),
        ...(this.pixiceBoard ? { pixice_board: this.#pixiceBoardServer(context) } : {}),
        ...(this.pixiceInstruments ? { pixice_instruments: this.#pixiceInstrumentsServer(context) } : {}),
        ...(this.pixiceBrowser ? { [PIXICE_BROWSER_NAMESPACE]: this.#pixiceBrowserServer(context) } : {}),
        ...(this.pixicePreview ? { [PIXICE_PREVIEW_NAMESPACE]: this.#pixicePreviewServer(context) } : {})
      },
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
      environment: this.environment
    });
    options.abortController = context.abortController;
    const query = this.queryFactory({ prompt: context.queue, options });
    context.query = query;
    context.runner = this.#consume(context, query).catch((error) => {
      if (context.query === query) this.#handleQueryError(context, error);
    });
  }

  #disposeQuery(context) {
    context.queue?.close();
    context.abortController?.abort();
    context.query?.close?.();
    context.query = null;
    context.queue = null;
    context.runner = null;
    context.abortController = null;
  }

  async #consume(context, query) {
    for await (const message of query) this.#handleMessage(context, message);
    if (context.query !== query) return;
    if (context.currentTurn) this.#completeTurn(context, "failed", "Claude session ended before the turn completed");
    context.query = null;
    context.queue = null;
  }

  #handleMessage(context, message) {
    if (message.session_id && message.session_id !== context.providerThreadId) {
      context.providerThreadId = message.session_id;
      context.thread.providerThreadId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "init") {
      context.resumeCursor = message.session_id;
      this.#persist(context);
      return;
    }
    if (!context.currentTurn) return;
    if (message.type === "system" && message.subtype === "status") this.#handleStatus(context, message);
    else if (message.type === "stream_event") this.#handleStreamEvent(context, message);
    else if (message.type === "assistant") this.#handleAssistant(context, message);
    else if (message.type === "tool_progress") this.#handleToolProgress(context, message);
    else if (message.type === "result") this.#handleResult(context, message);
    else if (message.type === "system" && message.subtype === "permission_denied") {
      this.#emitEvent("ActivityReceived", {
        method: "item/tool/permissionDenied",
        threadId: context.thread.id,
        turnId: context.currentTurn.id,
        toolName: message.tool_name,
        message: message.message
      });
    }
  }

  #handleStatus(context, message) {
    const turn = context.currentTurn;
    if (message.status === "compacting") {
      if (context.compactionItem) return;
      const item = {
        id: `claude-compaction:${turn.id}:${message.uuid}`,
        type: "contextCompaction",
        status: "inProgress",
        startedAt: now(),
        provider: "claude"
      };
      context.compactionItem = item;
      appendItem(turn, item);
      this.#emitEvent("TaskUpdated", {
        method: "item/started",
        threadId: context.thread.id,
        turnId: turn.id,
        item
      });
      this.#persist(context);
      return;
    }
    if (!context.compactionItem) return;
    this.#finishCompaction(context, message.compact_result === "failed", message.compact_error);
  }

  #finishCompaction(context, failed = false, error = null) {
    const item = context.compactionItem;
    const turn = context.currentTurn;
    if (!item || !turn) return;
    item.status = failed ? "failed" : "completed";
    item.completedAt = now();
    if (error) item.failure = { message: error };
    this.#emitEvent("TaskUpdated", {
      method: "item/completed",
      threadId: context.thread.id,
      turnId: turn.id,
      item
    });
    context.compactionItem = null;
    this.#persist(context);
  }

  #handleStreamEvent(context, message) {
    const event = message.event;
    if (event?.type !== "content_block_delta") return;
    const turn = context.currentTurn;
    const itemId = `claude-message:${message.uuid}`;
    if (event.delta?.type === "text_delta") {
      const item = turn.items.find((candidate) => candidate.id === itemId)
        ?? appendItem(turn, { id: itemId, type: "agentMessage", text: "", phase: "commentary" });
      item.text += event.delta.text ?? "";
      this.#emitEvent("TaskUpdated", {
        method: "item/agentMessage/delta",
        threadId: context.thread.id,
        turnId: turn.id,
        itemId,
        delta: event.delta.text ?? ""
      });
    }
    if (event.delta?.type === "thinking_delta") {
      const reasoningId = `claude-reasoning:${message.uuid}`;
      const existing = turn.items.find((candidate) => candidate.id === reasoningId)
        ?? appendItem(turn, { id: reasoningId, type: "reasoning", summary: [] });
      existing.summary = [{ type: "summary_text", text: `${existing.summary?.[0]?.text ?? ""}${event.delta.thinking ?? ""}` }];
    }
    this.#persist(context, { deferred: true });
  }

  #handleAssistant(context, message) {
    const turn = context.currentTurn;
    const text = (message.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    if (text) {
      const id = `claude-message:${message.uuid}`;
      const item = appendItem(turn, { id, type: "agentMessage", text, phase: "commentary" });
      this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item });
    }
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const item = toolItem(block);
      item.senderThreadId ||= context.thread.id;
      context.toolItems.set(block.id, item);
      appendItem(turn, item);
      this.#emitEvent(item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: "item/started",
        threadId: context.thread.id,
        turnId: turn.id,
        item
      });
    }
    this.#persist(context);
  }

  #handleToolProgress(context, message) {
    const item = context.toolItems.get(message.tool_use_id);
    if (!item) return;
    item.elapsedTimeMs = message.elapsed_time_seconds ? Math.round(message.elapsed_time_seconds * 1000) : item.elapsedTimeMs;
    this.#emitEvent("ActivityReceived", {
      method: "item/tool/progress",
      threadId: context.thread.id,
      turnId: context.currentTurn.id,
      item
    });
  }

  #handleResult(context, message) {
    const turn = context.currentTurn;
    if (context.compactionItem) this.#finishCompaction(context, message.is_error, message.errors?.join("\n"));
    const modelUsage = message.modelUsage ?? message.model_usage ?? {};
    const usageEntries = Object.entries(modelUsage);
    if (usageEntries.length) {
      for (const [model, usage] of usageEntries) {
        this.#emitEvent("ActivityReceived", {
          method: "provider/usage/recorded",
          threadId: context.thread.id,
          turnId: turn.id,
          responseId: `${message.uuid}:${model}`,
          model,
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            cachedInputTokens: usage.cacheReadInputTokens ?? 0,
            cacheWriteInputTokens: usage.cacheCreationInputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            reasoningOutputTokens: 0
          },
          costUsd: usage.costUSD,
          costSource: "provider-reported"
        });
      }
    } else if (message.usage) {
      this.#emitEvent("ActivityReceived", {
        method: "provider/usage/recorded",
        threadId: context.thread.id,
        turnId: turn.id,
        responseId: message.uuid,
        model: context.model,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteInputTokens: message.usage.cache_creation_input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          reasoningOutputTokens: 0
        },
        costUsd: message.total_cost_usd,
        costSource: "provider-reported"
      });
    }
    for (const item of context.toolItems.values()) {
      item.status = message.is_error ? "failed" : "completed";
      this.#emitEvent(item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: "item/completed",
        threadId: context.thread.id,
        turnId: turn.id,
        item
      });
    }
    context.toolItems.clear();
    const agentItems = turn.items.filter((item) => item.type === "agentMessage");
    const finalItem = agentItems.at(-1);
    if (finalItem) {
      finalItem.phase = "final_answer";
      this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item: finalItem });
    } else if (message.subtype === "success" && message.result) {
      const item = { id: `claude-result:${message.uuid}`, type: "agentMessage", text: message.result, phase: "final_answer" };
      appendItem(turn, item);
      this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item });
    }
    this.#completeTurn(context, message.is_error ? "failed" : "completed", message.errors?.join("\n"));
  }

  #completeTurn(context, status, error) {
    const turn = context.currentTurn;
    if (!turn) return;
    if (context.compactionItem) this.#finishCompaction(context, status !== "completed", error);
    turn.status = status;
    turn.completedAt = now();
    if (error) turn.error = { message: error };
    context.thread.status = threadStatus("idle");
    context.thread.updatedAt = now();
    context.currentTurn = null;
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "turn/completed", threadId: context.thread.id, turn });
    if (context.refreshInstructionsAfterTurn) {
      context.refreshInstructionsAfterTurn = false;
      queueMicrotask(() => {
        if (!context.currentTurn) this.#disposeQuery(context);
      });
    }
  }

  #handleQueryError(context, error) {
    this.emit("recoverable-error", { code: "claude_query_failed", message: error.message, threadId: context.thread.id });
    if (context.currentTurn) this.#completeTurn(context, "failed", error.message);
    context.query = null;
    context.queue = null;
  }

  #canUseTool(context, toolName, input, details) {
    if (context.internalNoTools) return Promise.resolve({ behavior: "deny", message: "This internal helper cannot use tools" });
    if (
      toolName === PIXICE_QUESTION_MCP_TOOL
      || PIXICE_BRIDGE_MCP_TOOLS.has(toolName)
      || PIXICE_BOARD_MCP_TOOLS.has(toolName)
      || PIXICE_INSTRUMENTS_MCP_TOOLS.has(toolName)
      || PIXICE_BROWSER_MCP_TOOLS.has(toolName)
      || PIXICE_PREVIEW_MCP_TOOLS.has(toolName)
    ) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    if (context.permissionMode === "read-only" && READ_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const id = `claude-request:${randomUUID()}`;
    const kind = toolName === "AskUserQuestion" ? "question" : "approval";
    const request = kind === "question"
      ? {
          id,
          method: "item/tool/requestUserInput",
          params: { threadId: context.thread.id, turnId: context.currentTurn?.id, questions: input.questions ?? [] }
        }
      : {
          id,
          method: "item/tool/requestApproval",
          params: {
            threadId: context.thread.id,
            turnId: context.currentTurn?.id,
            cwd: context.thread.cwd,
            toolName,
            input,
            message: details.title || details.description || details.decisionReason || `Claude wants to use ${toolName}`
          }
        };
    return new Promise((resolve) => {
      const abort = () => {
        this.pendingRequests.delete(id);
        resolve({ behavior: "deny", message: "The Claude tool request was cancelled", interrupt: true });
      };
      if (details.signal?.aborted) return abort();
      details.signal?.addEventListener("abort", abort, { once: true });
      this.pendingRequests.set(id, { resolve, kind, input, suggestions: details.suggestions });
      this.emit("server-request", request);
    });
  }

  #pixiceQuestionServer(context) {
    return createSdkMcpServer({
      name: "pixice",
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: [tool(
        "request_user_input",
        "Ask the user one to three short multiple-choice questions in Pixice's composer and wait for their answers. Available in every mode. Put the recommended choice first and mark exactly one option per question as recommended.",
        pixiceQuestionToolShape,
        async (input) => {
          const result = await this.#requestPixiceQuestion(context, input);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
      )]
    });
  }

  #pixiceBridgeServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixiceBridge.handleToolCall({
        namespace: "pixice_bridge",
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: "pixice_bridge",
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: pixiceBridgeDynamicTools[0].tools.map((definition) => tool(
        definition.name,
        definition.description,
        pixiceBridgeToolShapes[definition.name],
        run(definition.name)
      ))
    });
  }

  #pixiceBoardServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixiceBoard.handleToolCall({
        namespace: "pixice_board",
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: "pixice_board",
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: pixiceBoardTools.map((definition) => tool(
        definition.name,
        definition.description,
        pixiceBoardToolShapes[definition.name],
        run(definition.name)
      ))
    });
  }

  #pixiceInstrumentsServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixiceInstruments.handleToolCall({
        namespace: "pixice_instruments",
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: "pixice_instruments",
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: instrumentTools.map((definition) => tool(
        definition.name,
        definition.description,
        instrumentToolShapes[definition.name],
        run(definition.name)
      ))
    });
  }

  #pixiceBrowserServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixiceBrowser.handleToolCall({
        namespace: PIXICE_BROWSER_NAMESPACE,
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input,
        source: "claude"
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: PIXICE_BROWSER_NAMESPACE,
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: browserDynamicTools[0].tools.map((definition) => tool(
        definition.name,
        definition.description,
        browserToolShapes[definition.name],
        run(definition.name)
      ))
    });
  }

  #pixicePreviewServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixicePreview.handleToolCall({
        namespace: PIXICE_PREVIEW_NAMESPACE,
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input,
        source: "claude"
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: PIXICE_PREVIEW_NAMESPACE,
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: previewContextDynamicTools[0].tools.map((definition) => tool(
        definition.name,
        definition.description,
        previewContextToolShapes[definition.name],
        run(definition.name)
      ))
    });
  }

  #requestPixiceQuestion(context, input) {
    const questions = normalizePixiceQuestions(input);
    const id = `claude-pixice-question:${randomUUID()}`;
    const request = {
      id,
      method: "pixice/requestUserInput",
      params: {
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        questions
      }
    };
    return new Promise((resolve) => {
      this.pendingRequests.set(id, { resolve, kind: "pixice-question", input });
      this.emit("server-request", request);
    });
  }

  #inputMessage(input) {
    if (Array.isArray(input)) {
      const text = input.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const images = input.filter((part) => part.type === "image").map((part) => part.url);
      return buildClaudeUserMessage(text, images);
    }
    if (input?.type === "user") return input;
    throw new Error("Claude received an invalid user message");
  }

  #context(threadId) {
    let context = this.sessions.get(threadId);
    if (context) return context;
    const binding = this.database.getThreadProviderBinding(threadId);
    const thread = this.database.getProviderThreadSnapshot(threadId);
    if (!binding || binding.provider !== this.id || !thread) throw new Error("Claude thread was not found");
    context = {
      thread,
      providerThreadId: binding.providerThreadId || randomUUID(),
      resumeCursor: binding.resumeCursor || binding.providerThreadId,
      model: null,
      effort: null,
      permissionMode: "workspace-write",
      internalNoTools: false,
      runtimeWorkspaceRoots: [thread.cwd],
      developerInstructions: null,
      usesGlobalDeveloperInstructions: true,
      refreshInstructionsAfterTurn: false,
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      compactionItem: null,
      toolItems: new Map()
    };
    this.sessions.set(threadId, context);
    return context;
  }

  #persist(context, { deferred = false } = {}) {
    if (context.thread.ephemeral) return;
    if (deferred) {
      if (this.pendingSnapshotWrites.has(context.thread.id)) return;
      const timer = setTimeout(() => {
        this.pendingSnapshotWrites.delete(context.thread.id);
        this.#writeStreamCheckpoint(context);
      }, this.streamCheckpointMs);
      timer.unref?.();
      this.pendingSnapshotWrites.set(context.thread.id, { context, timer });
      return;
    }
    this.#flushPersist(context, { force: true });
  }

  #flushPersist(context, { force = false } = {}) {
    const pending = this.pendingSnapshotWrites.get(context.thread.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSnapshotWrites.delete(context.thread.id);
    }
    if (pending || force) this.#writePersistedContext(context);
  }

  #writePersistedContext(context) {
    const binding = {
      threadId: context.thread.id,
      provider: this.id,
      providerThreadId: context.providerThreadId,
      resumeCursor: context.resumeCursor,
      cwd: context.thread.cwd
    };
    const bindingKey = JSON.stringify([binding.providerThreadId, binding.resumeCursor, binding.cwd]);
    if (this.persistedBindingKeys.get(context.thread.id) !== bindingKey) {
      this.database.saveThreadProviderBinding(binding);
      this.persistedBindingKeys.set(context.thread.id, bindingKey);
      this.emit("binding", binding);
    }
    this.database.saveProviderThreadSnapshot(context.thread.id, context.thread);
  }

  #writeStreamCheckpoint(context) {
    if (!context.currentTurn || !this.database.saveProviderActiveTurn) {
      this.#writePersistedContext(context);
      return;
    }
    this.database.saveProviderActiveTurn(context.thread.id, context.currentTurn);
  }

  #developerInstructions() {
    if (this.developerInstructions) {
      try {
        return String(this.developerInstructions()).trim();
      } catch (error) {
        this.emit("diagnostic", `Claude could not compose Pixice developer instructions: ${error.message}`);
        return "";
      }
    }
    if (!this.developerInstructionsPath) return "";
    try {
      return readFileSync(this.developerInstructionsPath, "utf8").trim();
    } catch (error) {
      this.emit("diagnostic", `Claude could not load Pixice developer instructions: ${error.message}`);
      return "";
    }
  }

  #emitEvent(type, payload) {
    this.emit("event", { type, payload });
  }
}
