import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import {
  createSdkMcpServer,
  deleteSession as deleteClaudeSession,
  forkSession as forkClaudeSession,
  getSessionMessages as getClaudeSessionMessages,
  tool
} from "@anthropic-ai/claude-agent-sdk";
import { normalizePixiceQuestions, pixiceQuestionToolShape } from "../runtime/question-tool.mjs";
import { PIXICE_BRIDGE_MCP_TOOLS, pixiceBridgeDynamicTools, pixiceBridgeToolShapes } from "../runtime/pixice-bridge.mjs";
import { PIXICE_BOARD_MCP_TOOLS, pixiceBoardToolShapes, pixiceBoardTools } from "../runtime/pixice-board.mjs";
import {
  PIXICE_INSTRUMENTS_MCP_TOOLS,
  instrumentToolShapes,
  instrumentTools
} from "../instruments/instrument-service.mjs";
import {
  PIXICE_IOS_MCP_TOOLS,
  PIXICE_IOS_NAMESPACE,
  iosDynamicTools
} from "../ios/ios-tools.mjs";
import { z } from "zod";

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
      ...PIXICE_PREVIEW_MCP_TOOLS,
      ...PIXICE_IOS_MCP_TOOLS
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
    const filePath = block.input?.file_path ?? block.input?.notebook_path;
    return {
      ...common,
      type: "fileChange",
      path: filePath,
      changes: filePath ? [{ path: filePath }] : [],
      arguments: block.input
    };
  }
  if (block.name === "Agent" || block.name === "Task") {
    return { ...common, type: "collabAgentToolCall", tool: "spawnAgent", prompt: block.input?.prompt, senderThreadId: null, receiverThreadIds: [], agentsStates: {} };
  }
  if (block.name.startsWith("mcp__")) {
    const [, server, ...tool] = block.name.split("__");
    return { ...common, type: [PIXICE_BROWSER_NAMESPACE, PIXICE_PREVIEW_NAMESPACE, PIXICE_IOS_NAMESPACE].includes(server) ? "dynamicToolCall" : "mcpToolCall", server, tool: tool.join("__"), arguments: block.input };
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

function zodTypeFromJsonSchema(schema = {}) {
  let shape;
  if (Array.isArray(schema.enum) && schema.enum.length) shape = z.enum(schema.enum);
  else if (schema.type === "string") shape = z.string();
  else if (schema.type === "integer") shape = z.number().int();
  else if (schema.type === "number") shape = z.number();
  else if (schema.type === "boolean") shape = z.boolean();
  else shape = z.unknown();

  if (schema.type === "string") {
    if (schema.minLength !== undefined) shape = shape.min(schema.minLength);
    if (schema.maxLength !== undefined) shape = shape.max(schema.maxLength);
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum !== undefined) shape = shape.min(schema.minimum);
    if (schema.maximum !== undefined) shape = shape.max(schema.maximum);
  }
  if (schema.description) shape = shape.describe(schema.description);
  if (schema.default !== undefined) shape = shape.default(schema.default);
  return shape;
}

function zodShapeFromDynamicTool(definition) {
  const required = new Set(definition.inputSchema?.required ?? []);
  return Object.fromEntries(Object.entries(definition.inputSchema?.properties ?? {}).map(([name, schema]) => {
    const shape = zodTypeFromJsonSchema(schema);
    return [name, required.has(name) || schema.default !== undefined ? shape : shape.optional()];
  }));
}

function appendItem(turn, item) {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = { ...turn.items[index], ...item };
  return turn.items[index === -1 ? turn.items.length - 1 : index];
}

function contentText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block?.type === "text" ? block.text ?? "" : "").join("");
}

function toolResultBlocks(message) {
  const content = message.message?.content;
  return (Array.isArray(content) ? content : []).filter((block) => block?.type === "tool_result");
}

function usageDelta(current = {}, previous = {}) {
  const value = (camel, snake) => Number(current[camel] ?? current[snake] ?? 0);
  const before = (camel, snake) => Number(previous[camel] ?? previous[snake] ?? 0);
  return {
    inputTokens: Math.max(0, value("inputTokens", "input_tokens") - before("inputTokens", "input_tokens")),
    cachedInputTokens: Math.max(0, value("cacheReadInputTokens", "cache_read_input_tokens") - before("cacheReadInputTokens", "cache_read_input_tokens")),
    cacheWriteInputTokens: Math.max(0, value("cacheCreationInputTokens", "cache_creation_input_tokens") - before("cacheCreationInputTokens", "cache_creation_input_tokens")),
    outputTokens: Math.max(0, value("outputTokens", "output_tokens") - before("outputTokens", "output_tokens")),
    reasoningOutputTokens: 0
  };
}

function taskStatus(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "errored";
  if (status === "stopped" || status === "killed") return "interrupted";
  return "running";
}

const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "collabAgentToolCall", "mcpToolCall", "dynamicToolCall", "contextCompaction"]);

function normalizeStoredClaudeThread(thread) {
  let changed = false;
  const turns = (thread.turns ?? []).map((turn) => {
    const terminal = turn.status && turn.status !== "inProgress";
    const items = (turn.items ?? []).flatMap((original) => {
      let item = original;
      if (item.type === "reasoning") {
        const text = [item.text, item.content, ...(item.summary ?? []).map((part) => part?.text)].filter((value) => typeof value === "string").join("").trim();
        if (!text) {
          changed = true;
          return [];
        }
      }
      if (item.type === "agentMessage" && !String(item.text ?? "").trim()) {
        changed = true;
        return [];
      }
      if (item.type === "fileChange" && !Array.isArray(item.changes)) {
        const legacy = item.changes && typeof item.changes === "object" ? item.changes : {};
        const filePath = legacy.path ?? legacy.filePath ?? legacy.file_path ?? legacy.notebook_path ?? item.path ?? item.filePath;
        item = { ...item, changes: filePath ? [{ ...legacy, path: filePath }] : [] };
        changed = true;
      }
      if (terminal && TOOL_ITEM_TYPES.has(item.type) && (!item.status || item.status === "inProgress")) {
        const completed = turn.status === "completed";
        item = {
          ...item,
          status: completed ? "completed" : "failed",
          completedAt: item.completedAt ?? turn.completedAt,
          ...(!completed && !item.failure ? { failure: { message: turn.error?.message ?? `Claude turn ${turn.status}` } } : {})
        };
        changed = true;
      }
      return [item];
    });
    return items === turn.items ? turn : { ...turn, items };
  });
  return { thread: changed ? { ...thread, turns } : thread, changed };
}

function claudeForkPoint(thread, lastTurnId, lastItemId) {
  const turnIndex = (thread.turns ?? []).findIndex((turn) => turn.id === lastTurnId);
  if (turnIndex === -1) throw new Error("Claude fork turn was not found");
  const turn = thread.turns[turnIndex];
  if (turn.status !== "completed") throw new Error("Claude can only fork from a completed answer");
  const agentItems = (turn.items ?? []).filter((item) => item.type === "agentMessage" && String(item.text ?? "").trim());
  const finalItem = [...agentItems].reverse().find((item) => item.phase === "final_answer") ?? agentItems.at(-1);
  if (!finalItem) throw new Error("Claude fork turn has no assistant answer");
  if (lastItemId && finalItem.id !== lastItemId) throw new Error("Claude can only fork from the final answer in a turn");
  if (!finalItem.sourceUuid) throw new Error("This Claude answer predates native fork metadata and cannot be forked safely");
  return { turnIndex, finalItem };
}

function sessionMessageSignature(message) {
  return JSON.stringify([message?.type, message?.parent_tool_use_id ?? null, message?.message ?? null]);
}

function claudeForkUuidMap(sourceMessages, forkedMessages, cutoffUuid) {
  const cutoffIndex = sourceMessages.findIndex((message) => message.uuid === cutoffUuid);
  if (cutoffIndex === -1) {
    if (forkedMessages.length > sourceMessages.length) {
      throw new Error("Claude returned a fork whose transcript does not match the selected history");
    }
    const sourcePrefix = sourceMessages.slice(0, forkedMessages.length);
    const mapping = new Map();
    for (let index = 0; index < forkedMessages.length; index += 1) {
      if (sessionMessageSignature(sourcePrefix[index]) !== sessionMessageSignature(forkedMessages[index])) {
        throw new Error("Claude returned a fork whose transcript does not match the selected history");
      }
      mapping.set(sourcePrefix[index].uuid, forkedMessages[index].uuid);
    }
    return mapping;
  }
  const sourcePrefix = sourceMessages.slice(0, cutoffIndex + 1);
  const mapping = new Map();
  let forkedIndex = 0;
  for (const sourceMessage of sourcePrefix) {
    const signature = sessionMessageSignature(sourceMessage);
    while (forkedIndex < forkedMessages.length && sessionMessageSignature(forkedMessages[forkedIndex]) !== signature) {
      forkedIndex += 1;
    }
    const forkedMessage = forkedMessages[forkedIndex];
    if (!forkedMessage) throw new Error("Claude returned a fork whose transcript does not match the selected history");
    mapping.set(sourceMessage.uuid, forkedMessage.uuid);
    forkedIndex += 1;
  }
  return mapping;
}

function cloneClaudeForkTurns(turns, uuidMap) {
  const copied = structuredClone(turns);
  for (const turn of copied) {
    for (const item of turn.items ?? []) {
      if (!item.sourceUuid) continue;
      const remapped = uuidMap.get(item.sourceUuid);
      if (remapped) item.sourceUuid = remapped;
      else delete item.sourceUuid;
    }
  }
  return copied;
}

export class ClaudeProvider extends EventEmitter {
  constructor({
    database,
    clientVersion,
    developerInstructionsPath,
    developerInstructions = null,
    queryFactory = null,
    sessionFork = forkClaudeSession,
    sessionMessages = getClaudeSessionMessages,
    sessionDelete = deleteClaudeSession,
    pixiceBridge = null,
    pixiceBoard = null,
    pixiceInstruments = null,
    pixiceBrowser = null,
    pixicePreview = null,
    pixiceIos = null,
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
    this.sessionFork = sessionFork;
    this.sessionMessages = sessionMessages;
    this.sessionDelete = sessionDelete;
    this.pixiceBridge = pixiceBridge;
    this.pixiceBoard = pixiceBoard;
    this.pixiceInstruments = pixiceInstruments;
    this.pixiceBrowser = pixiceBrowser;
    this.pixicePreview = pixicePreview;
    this.pixiceIos = pixiceIos;
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
    this.discoveryCache = new Map();
    this.discoveryTail = Promise.resolve();
    this.discoveryGeneration = 0;
    this.discoveryAbortController = null;
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
      this.#repairStoredThreads();
      this.emit("status", { state: "ready", message: "Claude runtime available" });
      return true;
    } catch (error) {
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "claude_sdk_unavailable", message: error.message });
      return false;
    }
  }

  async stop() {
    this.started = false;
    this.#invalidateDiscovery();
    await this.discoveryTail;
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
    return this.#discover("account", async (query) => {
      const account = await query.accountInfo();
      const authenticated = claudeAccountIsAuthenticated(account);
      return {
        account: authenticated ? { type: "claude", ...account } : null,
        authenticated,
        requiresAuth: true,
        externallyManagedAuth: claudeExternallyManagedAuth(account, this.environment)
      };
    });
  }

  async usageLimits() {
    if (!this.started) throw new Error("Claude provider is not available");
    return this.#discover("limits", async (query) => {
      const account = await query.accountInfo();
      const authenticated = claudeAccountIsAuthenticated(account);
      if (!authenticated) return { account: null, authenticated: false, usage: null };
      const usageMethod = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof usageMethod !== "function") throw new Error("This Claude runtime does not expose live plan limits yet.");
      const usage = await usageMethod.call(query);
      return { account: { type: "claude", ...account }, authenticated: true, usage };
    }, { timeoutMs: 16_000 });
  }

  async login() {
    if (!this.started) throw new Error("Claude provider is not available");
    this.#closeAuthSession();
    const queue = new AsyncPromptQueue();
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-auth-"));
    const abortController = new AbortController();
    this.authSession = { queue, directory, abortController };
    let query;
    try {
      query = this.queryFactory({ prompt: queue, options: this.#probeOptions(directory, abortController) });
      this.authSession.query = query;
      const response = await query.claudeAuthenticate(true);
      const authUrl = response?.authUrl ?? response?.url;
      if (!authUrl) throw new Error("Claude did not return a sign-in URL");
      void query.claudeOAuthWaitForCompletion()
        .then(() => {
          if (!this.started || this.authSession?.query !== query) return;
          this.#invalidateDiscovery();
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
    this.#invalidateDiscovery();
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
    if (method === "thread/fork") return this.#forkThread(params);
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

  async #listModels() {
    try {
      return await this.#discover("models", async (query) => {
        const models = normalizeClaudeModels(await query.supportedModels());
        if (!models.length) throw new Error("Claude returned no supported models");
        return { data: serializeClaudeModels(models) };
      }, { ttlMs: 300_000 });
    } catch (error) {
      return { data: serializeClaudeModels(FALLBACK_MODELS) };
    }
  }

  #invalidateDiscovery() {
    this.discoveryGeneration += 1;
    this.discoveryCache.clear();
    this.models = null;
    this.discoveryAbortController?.abort(new Error("Claude discovery cancelled"));
  }

  #discover(key, operation, { ttlMs = 30_000, timeoutMs = 8_000 } = {}) {
    const cached = this.discoveryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const generation = this.discoveryGeneration;
    const entry = { expiresAt: Infinity, promise: null };
    // Share identical reads and serialize different reads: status refreshes must
    // never create an unbounded number of full Claude Code subprocesses.
    const pending = this.discoveryTail.then(async () => {
      if (!this.started || generation !== this.discoveryGeneration) throw new Error("Claude discovery cancelled");
      const abortController = new AbortController();
      this.discoveryAbortController = abortController;
      const queue = new AsyncPromptQueue();
      let query;
      let directory;
      let timer;
      let onAbort;
      let child;
      let childExited;
      try {
        directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-discovery-"));
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(abortController.signal.reason);
          abortController.signal.addEventListener("abort", onAbort, { once: true });
        });
        timer = setTimeout(() => abortController.abort(new Error(`Claude ${key} discovery timed out`)), timeoutMs);
        const options = this.#probeOptions(directory, abortController);
        options.spawnClaudeCodeProcess = ({ command, args, ...spawnOptions }) => {
          abortController.signal.throwIfAborted();
          child = spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          child.stderr.resume();
          childExited = new Promise((resolve) => {
            child.once("close", resolve);
            child.once("error", resolve);
          });
          return child;
        };
        query = this.queryFactory({ prompt: queue, options });
        return await Promise.race([Promise.resolve().then(() => operation(query)), cancelled]);
      } finally {
        clearTimeout(timer);
        abortController.signal.removeEventListener("abort", onAbort);
        queue.close();
        try { query?.close?.(); } finally {
          abortController.abort();
          // SDK close() returns before process exit. Wait for our metadata
          // child so the next queued read cannot overlap its shutdown grace.
          if (childExited) {
            const killTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 2_500);
            try { await childExited; } finally { clearTimeout(killTimer); }
          }
          if (this.discoveryAbortController === abortController) this.discoveryAbortController = null;
          if (directory) rmSync(directory, { recursive: true, force: true });
        }
      }
    });
    entry.promise = pending.then((value) => {
      entry.expiresAt = Date.now() + ttlMs;
      return value;
    }, (error) => {
      // Back off after failures too, including model fallback and signed-out
      // accounts. A new login/runtime invalidates this cooldown immediately.
      entry.expiresAt = Date.now() + 30_000;
      if (generation === this.discoveryGeneration) this.emit("diagnostic", `Claude ${key} discovery failed: ${error.message}`);
      throw error;
    });
    this.discoveryTail = entry.promise.catch(() => {});
    this.discoveryCache.set(key, entry);
    return entry.promise;
  }

  #probeOptions(cwd, abortController) {
    const { env, pathToClaudeCodeExecutable } = claudeQueryOptions({
      cwd,
      clientVersion: this.clientVersion,
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
      environment: this.environment
    });
    return {
      cwd,
      env,
      pathToClaudeCodeExecutable,
      abortController,
      tools: [],
      settingSources: [],
      plugins: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      systemPrompt: "Read account and runtime metadata only.",
      canUseTool: async () => ({ behavior: "deny", message: "Discovery cannot run tools" })
    };
  }

  #repairStoredThreads() {
    if (!this.database.listThreadProviderBindings) return;
    let repaired = 0;
    for (const binding of this.database.listThreadProviderBindings({ provider: this.id })) {
      const stored = this.database.getProviderThreadSnapshot(binding.threadId);
      if (!stored || stored.status?.type === "active") continue;
      const normalized = normalizeStoredClaudeThread(stored);
      if (!normalized.changed) continue;
      this.database.saveProviderThreadSnapshot(binding.threadId, normalized.thread);
      repaired += 1;
    }
    if (repaired) this.emit("diagnostic", `Claude repaired ${repaired} stored task${repaired === 1 ? "" : "s"}.`);
  }

  #closeAuthSession(expectedQuery) {
    if (!this.authSession || (expectedQuery && this.authSession.query !== expectedQuery)) return;
    this.authSession.queue.close();
    this.authSession.query?.close?.();
    this.authSession.abortController?.abort();
    if (this.authSession.directory) rmSync(this.authSession.directory, { recursive: true, force: true });
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
      toolItems: new Map(),
      taskItems: new Map(),
      streamResponses: new Map(),
      activeResponseByLane: new Map(),
      usageBaseline: new Map(),
      terminalError: null
    };
    this.sessions.set(threadId, context);
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "thread/started", thread });
    return { thread };
  }

  async #forkThread(params) {
    const source = this.#context(params.threadId);
    if (source.currentTurn || source.thread.status?.type === "active") {
      throw new Error("Claude cannot fork a thread while it is running");
    }
    const { turnIndex, finalItem } = claudeForkPoint(source.thread, params.lastTurnId, params.lastItemId);
    const sourceMessages = await this.sessionMessages(source.providerThreadId, {
      dir: source.thread.cwd,
      includeSystemMessages: true
    });
    const sourceName = String(source.thread.name ?? "").trim();
    const forkResult = await this.sessionFork(source.providerThreadId, {
      dir: source.thread.cwd,
      upToMessageId: finalItem.sourceUuid,
      ...(sourceName ? { title: `${sourceName} (fork)` } : {})
    });
    if (!forkResult?.sessionId) throw new Error("Claude did not return a session for the fork");

    let turns;
    try {
      const forkedMessages = await this.sessionMessages(forkResult.sessionId, {
        dir: source.thread.cwd,
        includeSystemMessages: true
      });
      const uuidMap = claudeForkUuidMap(sourceMessages, forkedMessages, finalItem.sourceUuid);
      turns = cloneClaudeForkTurns(source.thread.turns.slice(0, turnIndex + 1), uuidMap);
    } catch (error) {
      try {
        await this.sessionDelete(forkResult.sessionId, { dir: source.thread.cwd });
      } catch (cleanupError) {
        this.emit("diagnostic", `Claude could not remove an incomplete fork: ${cleanupError.message}`);
      }
      throw error;
    }

    const createdAt = now();
    const {
      bridge: _bridge,
      bridgeModel: _bridgeModel,
      bridgeThread: _bridgeThread,
      agentNickname: _agentNickname,
      agentRole: _agentRole,
      agentStatusMessage: _agentStatusMessage,
      parentThreadId: _parentThreadId,
      ...independentSourceThread
    } = structuredClone(source.thread);
    const thread = {
      ...independentSourceThread,
      id: randomUUID(),
      providerThreadId: forkResult.sessionId,
      ephemeral: false,
      name: sourceName ? `${sourceName} (fork)` : null,
      createdAt,
      updatedAt: createdAt,
      parentThreadId: null,
      forkedFromId: source.thread.id,
      status: threadStatus("idle"),
      turns
    };
    const context = {
      thread,
      providerThreadId: forkResult.sessionId,
      resumeCursor: forkResult.sessionId,
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode,
      internalNoTools: source.internalNoTools,
      runtimeWorkspaceRoots: [...source.runtimeWorkspaceRoots],
      developerInstructions: source.developerInstructions,
      usesGlobalDeveloperInstructions: source.usesGlobalDeveloperInstructions,
      refreshInstructionsAfterTurn: false,
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      compactionItem: null,
      toolItems: new Map(),
      taskItems: new Map(),
      streamResponses: new Map(),
      activeResponseByLane: new Map(),
      usageBaseline: new Map(),
      terminalError: null
    };
    this.sessions.set(thread.id, context);
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
    if (context.query && params.effort && context.effort && params.effort !== context.effort) this.#disposeQuery(context);
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
    context.compactionItem = null;
    context.toolItems.clear();
    context.streamResponses.clear();
    context.activeResponseByLane.clear();
    context.terminalError = null;
    context.thread.turns.push(turn);
    context.thread.preview ||= stripPreviewContextHint(message.message.content.find((part) => part.type === "text")?.text).slice(0, 180) || "Image task";
    context.thread.status = threadStatus("active");
    context.thread.updatedAt = now();
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "turn/started", threadId: context.thread.id, turn });

    try {
      await this.#ensureQuery(context);
      if (context.query?.setModel && params.model) await context.query.setModel(params.model);
      if (context.query?.setPermissionMode) await context.query.setPermissionMode(claudePermissionSettings(context.permissionMode).permissionMode);
      context.queue.push(message);
    } catch (error) {
      this.#completeTurn(context, "failed", error.message);
      this.#disposeQuery(context);
      throw error;
    }
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
    this.#completeTurn(context, "interrupted", "Claude was interrupted");
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
        ...(this.pixicePreview ? { [PIXICE_PREVIEW_NAMESPACE]: this.#pixicePreviewServer(context) } : {}),
        ...(this.pixiceIos ? { [PIXICE_IOS_NAMESPACE]: this.#pixiceIosServer(context) } : {})
      },
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
      environment: this.environment
    });
    options.abortController = context.abortController;
    const query = this.queryFactory({ prompt: context.queue, options });
    context.usageBaseline.clear();
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
    context.usageBaseline.clear();
    context.streamResponses.clear();
    context.activeResponseByLane.clear();
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
    if (message.type === "system" && ["task_started", "task_progress", "task_updated", "task_notification"].includes(message.subtype)) {
      this.#handleTaskEvent(context, message);
      return;
    }
    if (!context.currentTurn) return;
    if (message.type === "system" && message.subtype === "status") this.#handleStatus(context, message);
    else if (message.type === "stream_event") this.#handleStreamEvent(context, message);
    else if (message.type === "assistant") this.#handleAssistant(context, message);
    else if (message.type === "user") this.#handleToolResults(context, message);
    else if (message.type === "tool_progress") this.#handleToolProgress(context, message);
    else if (message.type === "tool_use_summary") this.#handleToolSummary(context, message);
    else if (message.type === "result") this.#handleResult(context, message);
    else if (message.type === "system" && message.subtype === "permission_denied") this.#handlePermissionDenied(context, message);
    else if (message.type === "system" && message.subtype === "api_retry") this.#handleApiRetry(context, message);
    else if (message.type === "system" && message.subtype === "model_refusal_fallback") this.#handleRefusalFallback(context, message);
    else if (message.type === "system" && message.subtype === "model_refusal_no_fallback") this.#handleRefusalFailure(context, message);
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
    const lane = message.parent_tool_use_id || "root";
    if (event?.type === "message_start") {
      const responseId = event.message?.id ?? message.uuid;
      context.activeResponseByLane.set(lane, responseId);
      if (!context.streamResponses.has(responseId)) context.streamResponses.set(responseId, { blocks: new Map(), nextIndex: 0 });
      return;
    }
    if (lane !== "root") return;
    if (!["content_block_start", "content_block_delta", "content_block_stop"].includes(event?.type)) return;
    const turn = context.currentTurn;
    const responseId = context.activeResponseByLane.get(lane) ?? message.uuid;
    const response = context.streamResponses.get(responseId) ?? { blocks: new Map(), nextIndex: 0 };
    context.streamResponses.set(responseId, response);
    const index = Number.isInteger(event.index) ? event.index : 0;
    response.nextIndex = Math.max(response.nextIndex, index + 1);
    const blockType = event.content_block?.type ?? (event.delta?.type === "thinking_delta" ? "thinking" : event.delta?.type === "text_delta" ? "text" : null);
    if (blockType) response.blocks.set(index, { ...(response.blocks.get(index) ?? {}), type: blockType });
    if (event.delta?.type === "text_delta" && event.delta.text) {
      const itemId = `claude-message:${responseId}:${index}`;
      const item = turn.items.find((candidate) => candidate.id === itemId)
        ?? appendItem(turn, { id: itemId, type: "agentMessage", text: "", phase: "commentary", sourceUuid: message.uuid });
      item.text += event.delta.text;
      this.#emitEvent("TaskUpdated", {
        method: "item/agentMessage/delta",
        threadId: context.thread.id,
        turnId: turn.id,
        itemId,
        delta: event.delta.text
      });
    }
    if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
      const reasoningId = `claude-reasoning:${responseId}:${index}`;
      const existing = turn.items.find((candidate) => candidate.id === reasoningId)
        ?? appendItem(turn, { id: reasoningId, type: "reasoning", summary: [], sourceUuid: message.uuid });
      existing.summary = [{ type: "summary_text", text: `${existing.summary?.[0]?.text ?? ""}${event.delta.thinking ?? ""}` }];
      this.#emitEvent("TaskUpdated", { method: "item/started", threadId: context.thread.id, turnId: turn.id, item: existing });
    }
    this.#persist(context, { deferred: true });
  }

  #handleAssistant(context, message) {
    this.#evictSuperseded(context, message.supersedes);
    if (message.error) context.terminalError = `Claude assistant error: ${message.error}`;
    if (message.parent_tool_use_id) {
      const record = context.toolItems.get(message.parent_tool_use_id);
      if (record) {
        record.item.latestMessage = contentText(message.message?.content) || record.item.latestMessage;
        this.#emitEvent("AgentUpdated", { method: "item/started", threadId: context.thread.id, turnId: record.turnId, item: record.item });
      }
      return;
    }
    const turn = context.currentTurn;
    const responseId = message.message?.id ?? context.activeResponseByLane.get("root") ?? message.uuid;
    const response = context.streamResponses.get(responseId) ?? { blocks: new Map(), nextIndex: 0 };
    context.streamResponses.set(responseId, response);
    for (const block of message.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        const match = [...response.blocks].find(([, meta]) => meta.type === "text" && !meta.completed);
        const index = match?.[0] ?? response.nextIndex++;
        response.blocks.set(index, { type: "text", completed: true });
        const id = `claude-message:${responseId}:${index}`;
        const item = appendItem(turn, { id, type: "agentMessage", text: block.text, phase: "commentary", sourceUuid: message.uuid });
        this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item });
        continue;
      }
      if (block.type === "thinking" && block.thinking) {
        const match = [...response.blocks].find(([, meta]) => meta.type === "thinking" && !meta.completed);
        const index = match?.[0] ?? response.nextIndex++;
        response.blocks.set(index, { type: "thinking", completed: true });
        const item = appendItem(turn, { id: `claude-reasoning:${responseId}:${index}`, type: "reasoning", summary: [{ type: "summary_text", text: block.thinking }], sourceUuid: message.uuid });
        this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const item = toolItem(block);
      item.senderThreadId ||= context.thread.id;
      item.sourceUuid = message.uuid;
      context.toolItems.set(block.id, { item, turnId: turn.id });
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
    const record = context.toolItems.get(message.tool_use_id);
    if (!record) return;
    const item = record.item;
    item.elapsedTimeMs = message.elapsed_time_seconds ? Math.round(message.elapsed_time_seconds * 1000) : item.elapsedTimeMs;
    this.#emitEvent(item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
      method: "item/tool/progress",
      threadId: context.thread.id,
      turnId: record.turnId,
      item
    });
    this.#persist(context, { deferred: true });
  }

  #handleToolResults(context, message) {
    for (const block of toolResultBlocks(message)) {
      const record = context.toolItems.get(block.tool_use_id);
      if (!record) continue;
      const item = record.item;
      const result = message.tool_use_result;
      const failed = block.is_error === true || result?.status === "failed" || result?.status === "error" || result?.interrupted === true;
      item.status = failed ? "failed" : result?.backgroundTaskId ? "inProgress" : "completed";
      item.result = result ?? contentText(block.content);
      if (item.type === "commandExecution") {
        item.aggregatedOutput = [result?.stdout, result?.stderr].filter(Boolean).join("\n") || contentText(block.content);
      } else if (item.type === "fileChange") {
        item.path = result?.filePath ?? item.path;
        item.changes = result?.structuredPatch?.length
          ? [{ path: item.path, patch: result.structuredPatch }]
          : item.path ? [{ path: item.path }] : [];
      } else if (item.type === "collabAgentToolCall" && result?.agentId) {
        item.receiverThreadIds = [...new Set([...(item.receiverThreadIds ?? []), result.agentId])];
        item.agentsStates = { ...(item.agentsStates ?? {}), [result.agentId]: { status: taskStatus(result.status), message: contentText(result.content) } };
      }
      if (result?.backgroundTaskId) context.taskItems.set(result.backgroundTaskId, record);
      if (failed) item.failure = { message: contentText(block.content) || result?.error || "Claude tool execution failed" };
      if (item.status !== "inProgress") item.completedAt = now();
      this.#emitEvent(item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: item.status === "inProgress" ? "item/started" : "item/completed",
        threadId: context.thread.id,
        turnId: record.turnId,
        item
      });
      if (item.status !== "inProgress") context.toolItems.delete(block.tool_use_id);
    }
    this.#persist(context);
  }

  #handleToolSummary(context, message) {
    for (const toolUseId of message.preceding_tool_use_ids ?? []) {
      const record = context.toolItems.get(toolUseId);
      if (!record) continue;
      record.item.summary = message.summary;
      this.#emitEvent(record.item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: "item/started",
        threadId: context.thread.id,
        turnId: record.turnId,
        item: record.item
      });
    }
    this.#persist(context, { deferred: true });
  }

  #handlePermissionDenied(context, message) {
    const record = context.toolItems.get(message.tool_use_id);
    if (record) {
      record.item.status = "failed";
      record.item.completedAt = now();
      record.item.failure = { message: message.message || message.decision_reason || "Claude tool permission was denied" };
      this.#emitEvent(record.item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: "item/completed",
        threadId: context.thread.id,
        turnId: record.turnId,
        item: record.item
      });
      context.toolItems.delete(message.tool_use_id);
      this.#persist(context);
    }
    this.#emitEvent("ActivityReceived", {
      method: "item/tool/permissionDenied",
      threadId: context.thread.id,
      turnId: context.currentTurn.id,
      toolName: message.tool_name,
      toolUseId: message.tool_use_id,
      message: message.message
    });
  }

  #handleTaskEvent(context, message) {
    let record = message.tool_use_id ? context.toolItems.get(message.tool_use_id) : null;
    if (!record && message.task_id) record = context.taskItems.get(message.task_id);
    if (!record && context.currentTurn && !message.skip_transcript) {
      const item = {
        id: message.tool_use_id ?? `claude-task:${message.task_id}`,
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        prompt: message.prompt ?? message.description,
        senderThreadId: context.thread.id,
        receiverThreadIds: [],
        agentsStates: {},
        status: "inProgress"
      };
      appendItem(context.currentTurn, item);
      record = { item, turnId: context.currentTurn.id };
      if (message.tool_use_id) context.toolItems.set(message.tool_use_id, record);
    }
    if (!record) return;
    const item = record.item;
    if (message.task_id && item.type === "collabAgentToolCall") {
      context.taskItems.set(message.task_id, record);
      item.receiverThreadIds = [...new Set([...(item.receiverThreadIds ?? []), message.task_id])];
      const status = message.subtype === "task_notification" ? taskStatus(message.status) : taskStatus(message.patch?.status);
      item.agentsStates = {
        ...(item.agentsStates ?? {}),
        [message.task_id]: {
          ...(item.agentsStates?.[message.task_id] ?? {}),
          status,
          message: message.summary ?? message.description ?? message.patch?.error ?? item.agentsStates?.[message.task_id]?.message,
          subagentType: message.subagent_type
        }
      };
    }
    if (message.task_id && item.type !== "collabAgentToolCall") item.taskId = message.task_id;
    if (message.description) item.description = message.description;
    if (message.summary) item.summary = message.summary;
    if (message.usage) item.usage = message.usage;
    if (message.subtype === "task_notification") {
      item.status = message.status === "completed" ? "completed" : "failed";
      item.completedAt = now();
      if (message.status !== "completed") item.failure = { message: message.summary || `Claude task ${message.status}` };
      context.taskItems.delete(message.task_id);
      if (message.tool_use_id) context.toolItems.delete(message.tool_use_id);
    }
    this.#emitEvent(item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
      method: message.subtype === "task_notification" ? "item/completed" : "item/started",
      threadId: context.thread.id,
      turnId: record.turnId,
      item
    });
    this.#persist(context);
  }

  #handleApiRetry(context, message) {
    const item = appendItem(context.currentTurn, {
      id: `claude-api-retry:${context.currentTurn.id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: `Claude request failed (${message.error}); retrying ${message.attempt}/${message.max_retries}.` }]
    });
    this.#emitEvent("TaskUpdated", { method: "item/started", threadId: context.thread.id, turnId: context.currentTurn.id, item });
    this.#persist(context);
  }

  #handleRefusalFallback(context, message) {
    this.#evictSuperseded(context, message.retracted_message_uuids);
    const item = appendItem(context.currentTurn, {
      id: `claude-refusal-fallback:${message.uuid}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.content || `Claude switched from ${message.original_model} to ${message.fallback_model}.` }]
    });
    this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: context.currentTurn.id, item });
    this.#persist(context);
  }

  #handleRefusalFailure(context, message) {
    context.terminalError = message.content || message.api_refusal_explanation || "Claude refused the request and no fallback model was available.";
  }

  #evictSuperseded(context, uuids = []) {
    if (!uuids?.length || !context.currentTurn) return;
    const removed = context.currentTurn.items.filter((item) => uuids.includes(item.sourceUuid));
    context.currentTurn.items = context.currentTurn.items.filter((item) => !uuids.includes(item.sourceUuid));
    for (const item of removed) {
      context.toolItems.delete(item.id);
      this.#emitEvent("TaskUpdated", { method: "item/removed", threadId: context.thread.id, turnId: context.currentTurn.id, itemId: item.id });
    }
  }

  #finishPendingTools(context, status, error) {
    for (const [toolUseId, record] of context.toolItems) {
      if ([...context.taskItems.values()].includes(record)) continue;
      record.item.status = status === "completed" ? "completed" : "failed";
      record.item.completedAt = now();
      if (status !== "completed") record.item.failure = { message: error || `Claude turn ${status}` };
      this.#emitEvent(record.item.type === "collabAgentToolCall" ? "AgentUpdated" : "TaskUpdated", {
        method: "item/completed",
        threadId: context.thread.id,
        turnId: record.turnId,
        item: record.item
      });
      context.toolItems.delete(toolUseId);
    }
  }

  #handleResult(context, message) {
    const turn = context.currentTurn;
    const error = message.errors?.join("\n") || (message.is_error ? message.result : null) || context.terminalError || null;
    if (context.compactionItem) this.#finishCompaction(context, message.is_error, error);
    const modelUsage = message.modelUsage ?? message.model_usage ?? {};
    const usageEntries = Object.entries(modelUsage);
    if (usageEntries.length) {
      for (const [model, usage] of usageEntries) {
        const previous = context.usageBaseline.get(model) ?? {};
        const delta = usageDelta(usage, previous);
        const costUsd = Math.max(0, Number(usage.costUSD ?? 0) - Number(previous.costUSD ?? 0));
        context.usageBaseline.set(model, { ...usage });
        if (!Object.values(delta).some(Boolean) && !costUsd) continue;
        this.#emitEvent("ActivityReceived", {
          method: "provider/usage/recorded",
          threadId: context.thread.id,
          turnId: turn.id,
          responseId: `${message.uuid}:${model}:delta`,
          model,
          usage: delta,
          costUsd,
          costSource: "provider-reported"
        });
      }
    } else if (message.usage) {
      const previousCost = Number(context.usageBaseline.get("__total_cost__") ?? 0);
      const totalCost = Number(message.total_cost_usd ?? 0);
      context.usageBaseline.set("__total_cost__", totalCost);
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
        costUsd: Math.max(0, totalCost - previousCost),
        costSource: "provider-reported"
      });
    }
    for (const denial of message.permission_denials ?? []) this.#handlePermissionDenied(context, { ...denial, message: `Permission denied for ${denial.tool_name}` });
    this.#finishPendingTools(context, message.is_error ? "failed" : "completed", error);
    const agentItems = turn.items.filter((item) => item.type === "agentMessage");
    const resultText = String(message.result ?? "").trim();
    const finalItem = !message.is_error && resultText
      ? [...agentItems].reverse().find((item) => item.text?.trim() === resultText)
      : !message.is_error ? agentItems.at(-1) : null;
    if (finalItem) {
      finalItem.phase = "final_answer";
      this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item: finalItem });
    } else if (resultText || error) {
      const item = {
        id: `claude-result:${message.uuid}`,
        type: "agentMessage",
        text: resultText || error,
        phase: "final_answer",
        sourceUuid: message.uuid,
        ...(message.is_error ? { error: true } : {})
      };
      appendItem(turn, item);
      this.#emitEvent("TaskUpdated", { method: "item/completed", threadId: context.thread.id, turnId: turn.id, item });
    }
    this.#completeTurn(context, message.is_error ? "failed" : "completed", error);
  }

  #completeTurn(context, status, error) {
    const turn = context.currentTurn;
    if (!turn) return;
    this.#finishPendingTools(context, status, error);
    if (context.compactionItem) this.#finishCompaction(context, status !== "completed", error);
    turn.status = status;
    turn.completedAt = now();
    if (error) turn.error = { message: error };
    context.thread.status = threadStatus("idle");
    context.thread.updatedAt = now();
    context.currentTurn = null;
    context.streamResponses.clear();
    context.activeResponseByLane.clear();
    context.terminalError = null;
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
      || PIXICE_IOS_MCP_TOOLS.has(toolName)
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

  #pixiceIosServer(context) {
    const run = (name) => async (input) => {
      const result = await this.pixiceIos.handleToolCall({
        namespace: PIXICE_IOS_NAMESPACE,
        tool: name,
        threadId: context.thread.id,
        turnId: context.currentTurn?.id,
        arguments: input,
        source: "claude"
      });
      return claudeMcpResult(result);
    };
    return createSdkMcpServer({
      name: PIXICE_IOS_NAMESPACE,
      version: this.clientVersion || "1.0.0",
      alwaysLoad: true,
      tools: iosDynamicTools[0].tools.map((definition) => tool(
        definition.name,
        definition.description,
        zodShapeFromDynamicTool(definition),
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
    const storedThread = this.database.getProviderThreadSnapshot(threadId);
    if (!binding || binding.provider !== this.id || !storedThread) throw new Error("Claude thread was not found");
    const { providerContext = {}, ...thread } = storedThread;
    context = {
      thread,
      providerThreadId: binding.providerThreadId || randomUUID(),
      resumeCursor: binding.resumeCursor || binding.providerThreadId,
      model: providerContext.model ?? null,
      effort: providerContext.effort ?? null,
      permissionMode: providerContext.permissionMode ?? "workspace-write",
      internalNoTools: providerContext.internalNoTools === true,
      runtimeWorkspaceRoots: Array.isArray(providerContext.runtimeWorkspaceRoots) ? providerContext.runtimeWorkspaceRoots : [thread.cwd],
      developerInstructions: providerContext.developerInstructions ?? null,
      usesGlobalDeveloperInstructions: providerContext.usesGlobalDeveloperInstructions !== false,
      refreshInstructionsAfterTurn: false,
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      compactionItem: null,
      toolItems: new Map(),
      taskItems: new Map(),
      streamResponses: new Map(),
      activeResponseByLane: new Map(),
      usageBaseline: new Map(),
      terminalError: null
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
      cwd: context.thread.cwd,
      forkedFromId: context.thread.forkedFromId ?? null
    };
    const bindingKey = JSON.stringify([binding.providerThreadId, binding.resumeCursor, binding.cwd, binding.forkedFromId]);
    if (this.persistedBindingKeys.get(context.thread.id) !== bindingKey) {
      this.database.saveThreadProviderBinding(binding);
      this.persistedBindingKeys.set(context.thread.id, bindingKey);
      this.emit("binding", binding);
    }
    this.database.saveProviderThreadSnapshot(context.thread.id, {
      ...context.thread,
      providerContext: {
        model: context.model,
        effort: context.effort,
        permissionMode: context.permissionMode,
        internalNoTools: context.internalNoTools,
        runtimeWorkspaceRoots: context.runtimeWorkspaceRoots,
        developerInstructions: context.developerInstructions,
        usesGlobalDeveloperInstructions: context.usesGlobalDeveloperInstructions
      }
    });
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
