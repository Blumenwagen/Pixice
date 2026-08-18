import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { constants, accessSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildClaudeUserMessage } from "../runtime/user-input.mjs";

const FALLBACK_MODELS = [
  { value: "default", displayName: "Claude (recommended)", description: "Use Claude Code's recommended model." },
  { value: "sonnet", displayName: "Claude Sonnet", description: "Fast, capable coding model." },
  { value: "opus", displayName: "Claude Opus", description: "Most capable Claude coding model." },
  { value: "haiku", displayName: "Claude Haiku", description: "Fastest Claude model." }
];

function mergeClaudeModels(discovered = []) {
  const models = new Map(FALLBACK_MODELS.map((model) => [model.value, model]));
  for (const model of discovered) {
    const value = model.value ?? model.id ?? model.model;
    if (!value) continue;
    models.set(value, { ...models.get(value), ...model, value });
  }
  return [...models.values()];
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

export function resolveClaudeCodeExecutable({
  explicitPath = process.env.LOOM_CLAUDE_PATH,
  pathValue = process.env.PATH,
  homeDirectory = homedir(),
  platform = process.platform
} = {}) {
  const filename = platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    explicitPath,
    ...(pathValue ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, filename)),
    ...(platform === "darwin" ? ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] : []),
    path.join(homeDirectory, ".local", "bin", filename),
    path.join(homeDirectory, ".claude", "local", filename)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue through the same executable locations used by CLI-first providers.
    }
  }
  return null;
}

export function resolvePackagedClaudeCodeExecutable({
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  architecture = process.arch
} = {}) {
  if (!resourcesPath) return null;
  const suffix = platform === "win32" ? "win32" : platform;
  const packageName = `claude-agent-sdk-${suffix}-${architecture}`;
  const filename = platform === "win32" ? "claude.exe" : "claude";
  const candidate = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    packageName,
    filename
  );
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

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
    tools: [...READ_TOOLS, "AskUserQuestion"]
  };
}

export function claudeQueryOptions({
  cwd,
  model,
  effort,
  permissionMode,
  sessionId,
  resume,
  developerInstructions,
  clientVersion,
  canUseTool,
  pathToClaudeCodeExecutable
}) {
  const permissions = claudePermissionSettings(permissionMode);
  return {
    cwd,
    additionalDirectories: [cwd],
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
    canUseTool,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: `loom/${clientVersion}`
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
    return { ...common, type: server === "loom_browser" ? "dynamicToolCall" : "mcpToolCall", server, tool: tool.join("__"), arguments: block.input };
  }
  return { ...common, type: "mcpToolCall", server: "claude", tool: block.name, arguments: block.input };
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
    queryFactory = null,
    pathToClaudeCodeExecutable = resolveClaudeCodeExecutable(),
    requireExternalExecutable = false
  }) {
    super();
    this.id = "claude";
    this.database = database;
    this.clientVersion = clientVersion;
    this.developerInstructionsPath = developerInstructionsPath;
    this.queryFactory = queryFactory;
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    this.requireExternalExecutable = requireExternalExecutable;
    this.sessions = new Map();
    this.pendingRequests = new Map();
    this.models = null;
    this.started = false;
  }

  get connected() {
    return this.started;
  }

  async start() {
    try {
      if (this.requireExternalExecutable && !this.pathToClaudeCodeExecutable) {
        throw new Error("Claude Code is unavailable. Install `claude`, set LOOM_CLAUDE_PATH, or reinstall Loom with its Claude runtime.");
      }
      if (!this.queryFactory) this.queryFactory = (await import("@anthropic-ai/claude-agent-sdk")).query;
      this.started = true;
      this.emit("status", { state: "ready", message: "Claude Agent SDK is available" });
      return true;
    } catch (error) {
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "claude_sdk_unavailable", message: error.message });
      return false;
    }
  }

  async stop() {
    for (const context of this.sessions.values()) {
      context.queue?.close();
      context.abortController?.abort();
      context.query?.close?.();
    }
    this.sessions.clear();
    for (const pending of this.pendingRequests.values()) pending.resolve({ behavior: "deny", message: "Loom stopped the Claude session", interrupt: true });
    this.pendingRequests.clear();
    this.started = false;
    this.emit("status", { state: "stopped" });
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
    if (this.models) return { data: this.models };
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
          pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable
        })
      });
      const discovered = await Promise.race([
        probe.supportedModels(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Claude model discovery timed out")), 8_000))
      ]);
      this.models = mergeClaudeModels(discovered);
    } catch (error) {
      this.models = FALLBACK_MODELS;
      this.emit("diagnostic", `Claude model discovery fell back to aliases: ${error.message}`);
    } finally {
      queue.close();
      probe?.close?.();
    }
    return {
      data: this.models.map((model) => ({
        id: model.value,
        model: model.value,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.value === "default",
        defaultReasoningEffort: model.supportsEffort ? "high" : null,
        supportedReasoningEfforts: (model.supportedEffortLevels ?? []).map((effort) => ({ reasoningEffort: effort, description: effort }))
      }))
    };
  }

  #listThreads({ cwd } = {}) {
    const data = this.database.listThreadProviderBindings({ provider: this.id, cwd })
      .map((binding) => this.database.getProviderThreadSnapshot(binding.threadId))
      .filter(Boolean);
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
      name: null,
      preview: "",
      source: "appServer",
      createdAt,
      updatedAt: createdAt,
      status: threadStatus("idle"),
      turns: []
    };
    const context = {
      thread,
      providerThreadId,
      resumeCursor: null,
      model: params.model || null,
      effort: null,
      permissionMode: params.permissionMode || "workspace-write",
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      toolItems: new Map()
    };
    this.sessions.set(threadId, context);
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "thread/started", thread });
    return { thread };
  }

  #archiveThread(threadId) {
    const context = this.#context(threadId);
    context.queue?.close();
    context.abortController?.abort();
    context.query?.close?.();
    this.sessions.delete(threadId);
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
    context.thread.preview ||= message.message.content.find((part) => part.type === "text")?.text?.slice(0, 180) ?? "Image task";
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
      model: context.model,
      effort: context.effort,
      permissionMode: context.permissionMode,
      sessionId: context.providerThreadId,
      resume: context.resumeCursor,
      developerInstructions: this.#developerInstructions(),
      clientVersion: this.clientVersion,
      canUseTool: (toolName, input, details) => this.#canUseTool(context, toolName, input, details),
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable
    });
    options.abortController = context.abortController;
    context.query = this.queryFactory({ prompt: context.queue, options });
    context.runner = this.#consume(context).catch((error) => this.#handleQueryError(context, error));
  }

  async #consume(context) {
    for await (const message of context.query) this.#handleMessage(context, message);
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
    if (message.type === "stream_event") this.#handleStreamEvent(context, message);
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

  #handleStreamEvent(context, message) {
    const event = message.event;
    if (event?.type !== "content_block_delta") return;
    const turn = context.currentTurn;
    const itemId = `claude-message:${message.uuid}`;
    if (event.delta?.type === "text_delta") {
      const item = appendItem(turn, { id: itemId, type: "agentMessage", text: "", phase: "commentary" });
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
      const existing = appendItem(turn, { id: reasoningId, type: "reasoning", summary: [] });
      existing.summary = [{ type: "summary_text", text: `${existing.summary?.[0]?.text ?? ""}${event.delta.thinking ?? ""}` }];
    }
    this.#persist(context);
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
    turn.status = status;
    turn.completedAt = now();
    if (error) turn.error = { message: error };
    context.thread.status = threadStatus("idle");
    context.thread.updatedAt = now();
    context.currentTurn = null;
    this.#persist(context);
    this.#emitEvent("TaskUpdated", { method: "turn/completed", threadId: context.thread.id, turn });
  }

  #handleQueryError(context, error) {
    this.emit("recoverable-error", { code: "claude_query_failed", message: error.message, threadId: context.thread.id });
    if (context.currentTurn) this.#completeTurn(context, "failed", error.message);
    context.query = null;
    context.queue = null;
  }

  #canUseTool(context, toolName, input, details) {
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
      query: null,
      queue: null,
      runner: null,
      abortController: null,
      currentTurn: null,
      toolItems: new Map()
    };
    this.sessions.set(threadId, context);
    return context;
  }

  #persist(context) {
    this.database.saveThreadProviderBinding({
      threadId: context.thread.id,
      provider: this.id,
      providerThreadId: context.providerThreadId,
      resumeCursor: context.resumeCursor,
      cwd: context.thread.cwd
    });
    this.database.saveProviderThreadSnapshot(context.thread.id, context.thread);
    this.emit("binding", {
      threadId: context.thread.id,
      providerThreadId: context.providerThreadId,
      resumeCursor: context.resumeCursor,
      cwd: context.thread.cwd
    });
  }

  #developerInstructions() {
    if (!this.developerInstructionsPath) return "";
    try {
      return readFileSync(this.developerInstructionsPath, "utf8").trim();
    } catch (error) {
      this.emit("diagnostic", `Claude could not load Loom developer instructions: ${error.message}`);
      return "";
    }
  }

  #emitEvent(type, payload) {
    this.emit("event", { type, payload });
  }
}
