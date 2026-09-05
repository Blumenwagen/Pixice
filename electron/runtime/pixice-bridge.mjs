import { z } from "zod";
import { buildCodexUserInput } from "./user-input.mjs";
import { bridgeEligibleModels, recommendBridgeModel } from "./model-capabilities.mjs";
import { installWorkflowRuntimeHost } from "../workflows/workflow-runtime-host.mjs";
import { pixiceWorkflowTools } from "../workflows/pixice-workflows.mjs";
import { pixiceWorkflowToolShapes } from "../workflows/workflow-tool-shapes.mjs";

export const PIXICE_BRIDGE_NAMESPACE = "pixice_bridge";
const WORKFLOW_TOOL_NAMES = new Set(pixiceWorkflowTools.map((tool) => tool.name));
export const PIXICE_BRIDGE_MCP_TOOLS = new Set([
  "mcp__pixice_bridge__list_models",
  "mcp__pixice_bridge__spawn_thread",
  "mcp__pixice_bridge__send_update",
  ...[...WORKFLOW_TOOL_NAMES].map((name) => `mcp__pixice_bridge__${name}`)
]);

const listModelsShape = {
  task: z.string().trim().max(2_000).optional()
};

const spawnThreadShape = {
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(160),
  effort: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(32).optional(),
  permissionMode: z.enum(["read-only", "workspace-write", "auto-approve", "full-access"]).optional()
};

const sendUpdateShape = {
  message: z.string().trim().min(1).max(10_000)
};

export const pixiceBridgeToolShapes = {
  list_models: listModelsShape,
  spawn_thread: spawnThreadShape,
  send_update: sendUpdateShape,
  ...pixiceWorkflowToolShapes
};

const listModelsInputSchema = {
  type: "object",
  properties: {
    task: { type: "string", maxLength: 2000, description: "Optional task summary used to frame the model choice." }
  },
  additionalProperties: false
};

const spawnThreadInputSchema = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 100000, description: "The complete task for the new Pixice thread." },
    model: { type: "string", minLength: 1, maxLength: 160, description: "Qualified model id returned by list_models." },
    effort: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 32, description: "A reasoning effort supported by the selected model." },
    permissionMode: {
      type: "string",
      enum: ["read-only", "workspace-write", "auto-approve", "full-access"],
      description: "Permission scope for the new thread. Defaults to the parent thread's permission mode."
    }
  },
  required: ["prompt", "model"],
  additionalProperties: false
};

const sendUpdateInputSchema = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 10000, description: "A concise progress update for the parent thread." }
  },
  required: ["message"],
  additionalProperties: false
};

const bridgeTools = [
  {
    type: "function",
    name: "list_models",
    description: "List only currently connected models available to the Pixice bridge, Pixice's internal 1-5 capability ratings, and a policy-based recommendation for the supplied task. GPT is intentionally limited to 5.6 Luna, Terra, and Sol; every connected Claude model reported by Claude Code is eligible.",
    inputSchema: listModelsInputSchema
  },
  {
    type: "function",
    name: "spawn_thread",
    description: "Create a child Pixice thread, run the prompt with the selected model and reasoning effort, wait for completion, and return its final answer. The thread remains visible and reusable in Pixice.",
    inputSchema: spawnThreadInputSchema
  },
  {
    type: "function",
    name: "send_update",
    description: "Send a meaningful progress update from a spawned Pixice bridge thread to its parent. This is only valid inside a bridge-created child thread.",
    inputSchema: sendUpdateInputSchema
  }
];

export const pixiceBridgeDynamicTools = [{
  type: "namespace",
  name: PIXICE_BRIDGE_NAMESPACE,
  description: "Coordinate Pixice-native agents and visual workflows. Spawn deliberately selected GPT or Claude threads, inspect or edit project workflows, and run Pixice Agent nodes either quietly in the background or as normal foreground tasks. Call list_models before spawning a bridge thread so model choice and availability are evidence-based.",
  tools: [...bridgeTools, ...pixiceWorkflowTools]
}];

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
  };
}

function finalAnswer(turn) {
  return [...(turn?.items ?? [])]
    .reverse()
    .find((item) => item.type === "agentMessage" && item.text?.trim())
    ?.text?.trim() ?? "";
}

function completionStatus(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "errored";
  return status === "cancelled" ? "interrupted" : status;
}

export class PixiceBridge {
  constructor({ runtime, database, threadContext, dynamicTools, onThreadCreated, onActivity, onCompletion }) {
    this.runtime = runtime;
    this.database = database;
    this.threadContext = threadContext;
    this.dynamicTools = dynamicTools;
    this.onThreadCreated = onThreadCreated;
    this.onActivity = onActivity;
    this.onCompletion = onCompletion;
    this.pending = new Map();
    this.workflowIntegration = null;
    this.workflowError = null;
    this.workflowReady = installWorkflowRuntimeHost({
      runtime,
      database,
      threadContext,
      dynamicTools,
      onThreadCreated,
      onAgentActivity: onActivity
    }).then((integration) => {
      this.workflowIntegration = integration;
      return integration;
    }).catch((error) => {
      this.workflowError = error;
      return null;
    });
    this.runtime.on("event", (event) => this.#onRuntimeEvent(event));
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Pixice bridge tools require a thread-scoped call");
      if (WORKFLOW_TOOL_NAMES.has(params.tool)) {
        const integration = this.workflowIntegration ?? await this.workflowReady;
        if (!integration) throw this.workflowError ?? new Error("Pixice workflows are unavailable in this runtime");
        return integration.workflows.handleToolCall(params);
      }
      const input = params.arguments ?? {};
      if (params.tool === "list_models") return textResult(await this.#listModels(listModelsShape, input));
      if (params.tool === "spawn_thread") return textResult(await this.#spawnThread(params, z.object(spawnThreadShape).parse(input)));
      if (params.tool === "send_update") return textResult(this.#sendUpdate(params, z.object(sendUpdateShape).parse(input)));
      throw new Error(`Unknown Pixice bridge tool: ${params.tool}`);
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }

  async #listModels(shape, input) {
    z.object(shape).parse(input);
    const response = await this.runtime.request("model/list", { limit: 100 });
    const eligible = bridgeEligibleModels(response.data ?? []);
    const recommendation = recommendBridgeModel(eligible, input.task);
    const models = eligible.map((model) => ({
      id: model.id,
      model: model.model,
      provider: model.provider,
      availability: "connected",
      displayName: model.displayName ?? model.model,
      description: model.description,
      supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
      profile: model.bridge
    }));
    return {
      models,
      connectedFamilies: [...new Set(models.map((model) => model.provider === "codex" ? "gpt" : model.provider))],
      recommendation,
      guidance: {
        defaultPolicy: "Normally prefer a GPT model because GPT 5.6 is more cost-effective.",
        claudeExceptions: [
          "The user specifically asks for Claude.",
          "Claude is the only connected model family.",
          "The task is primarily about UI design or taste."
        ],
        routineAndHighVolume: "Prefer GPT 5.6 Luna.",
        balancedImplementation: "Prefer GPT 5.6 Terra.",
        deepTechnicalWork: "Prefer GPT 5.6 Sol.",
        uiAndProductTaste: "Prefer Claude Sonnet or Opus when one is connected; GPT remains capable if Claude is unavailable.",
        crossFamilyDirection: "A Claude bridge thread may direct or review a GPT bridge thread, and vice versa.",
        note: "Only models from connected providers are returned. Ratings are Pixice routing heuristics on a 1-5 scale, not vendor benchmarks."
      }
    };
  }

  async #spawnThread(params, input) {
    const context = this.threadContext(params.threadId);
    if (!context?.projectId || !context.cwd) throw new Error("The parent thread is not attached to an open Pixice project");
    const catalog = (await this.#listModels(listModelsShape, {})).models;
    const matches = catalog.filter((model) => model.id === input.model || model.model === input.model);
    if (matches.length !== 1) {
      throw new Error(matches.length ? "Use the qualified model id returned by list_models" : `Model ${input.model} is not eligible or unavailable`);
    }
    const selected = matches[0];
    const effortValues = (selected.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort ?? entry.effort ?? entry);
    if (input.effort && effortValues.length && !effortValues.includes(input.effort)) {
      throw new Error(`${input.effort} is not supported by ${selected.displayName}`);
    }
    const permissionMode = input.permissionMode ?? context.permissionMode ?? "workspace-write";
    const permissions = context.permissionSettings(permissionMode);
    const runtimeWorkspaceRoots = context.runtimeWorkspaceRoots?.length ? context.runtimeWorkspaceRoots : [context.cwd];
    const started = await this.runtime.request("thread/start", {
      cwd: context.cwd,
      runtimeWorkspaceRoots,
      parentThreadId: params.threadId,
      model: selected.id,
      permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: context.developerInstructions,
      dynamicTools: this.dynamicTools(),
      threadSource: "pixiceBridge"
    });
    const child = { ...started.thread, parentThreadId: params.threadId, bridgeModel: selected.id };
    this.database.saveThreadLink({
      childThreadId: child.id,
      parentThreadId: params.threadId,
      model: selected.id,
      effort: input.effort ?? null
    });
    this.onThreadCreated?.({ context, thread: child, prompt: input.prompt, model: selected, permissionMode });
    this.#publishAgentState({
      parentThreadId: params.threadId,
      childThreadId: child.id,
      prompt: input.prompt,
      model: selected.id,
      effort: input.effort,
      status: "running",
      message: `Running on ${selected.displayName}`
    });

    const completion = new Promise((resolve) => this.pending.set(child.id, {
      resolve,
      parentThreadId: params.threadId,
      parentTurnId: params.turnId ?? null,
      model: selected.id,
      effort: input.effort ?? null,
      prompt: input.prompt
    }));
    try {
      const turn = await this.runtime.request("turn/start", {
        threadId: child.id,
        input: buildCodexUserInput(input.prompt, []),
        cwd: context.cwd,
        runtimeWorkspaceRoots,
        model: selected.id,
        effort: input.effort || null,
        permissionMode,
        approvalPolicy: permissions.approvalPolicy,
        approvalsReviewer: permissions.approvalsReviewer,
        sandboxPolicy: permissions.sandboxPolicy
      });
      const record = this.pending.get(child.id);
      if (record) record.turnId = turn.turn.id;
    } catch (error) {
      this.pending.delete(child.id);
      this.#publishAgentState({
        parentThreadId: params.threadId,
        childThreadId: child.id,
        prompt: input.prompt,
        model: selected.id,
        status: "errored",
        message: error.message
      });
      throw error;
    }
    return completion;
  }

  #sendUpdate(params, input) {
    const link = this.database.getThreadLink(params.threadId);
    if (!link || link.kind !== "pixiceBridge") throw new Error("This thread was not created by the Pixice bridge");
    this.#publishAgentState({
      parentThreadId: link.parentThreadId,
      childThreadId: params.threadId,
      model: link.model,
      effort: link.effort,
      status: "running",
      message: input.message
    });
    return { delivered: true, parentThreadId: link.parentThreadId };
  }

  async #onRuntimeEvent(event) {
    const payload = event?.payload ?? {};
    if (payload.method !== "turn/completed" || !payload.threadId) return;
    const pending = this.pending.get(payload.threadId);
    if (!pending || (pending.turnId && pending.turnId !== payload.turn?.id)) return;
    this.pending.delete(payload.threadId);
    let turn = payload.turn;
    if (!finalAnswer(turn)) {
      try {
        const response = await this.runtime.request("thread/read", { threadId: payload.threadId, includeTurns: true });
        turn = response.thread?.turns?.at(-1) ?? turn;
      } catch {
        // The completion event still carries enough status information to settle the bridge.
      }
    }
    const status = turn?.status ?? "completed";
    const answer = finalAnswer(turn);
    const message = answer || turn?.error?.message || `Bridge thread ${status}`;
    this.#publishAgentState({
      parentThreadId: pending.parentThreadId,
      childThreadId: payload.threadId,
      prompt: pending.prompt,
      model: pending.model,
      effort: pending.effort,
      status: completionStatus(status),
      message
    });
    const result = {
      threadId: payload.threadId,
      status,
      model: pending.model,
      effort: pending.effort,
      answer,
      error: turn?.error?.message ?? null
    };
    pending.resolve(result);
    const completionTimer = setTimeout(() => {
      void Promise.resolve(this.onCompletion?.({
        parentThreadId: pending.parentThreadId,
        parentTurnId: pending.parentTurnId,
        childThreadId: payload.threadId,
        ...result
      })).catch(() => {});
    }, 0);
    completionTimer.unref?.();
  }

  #publishAgentState({ parentThreadId, childThreadId, prompt, model, effort, status, message }) {
    this.onActivity?.({
      method: "pixice/bridge/updated",
      threadId: parentThreadId,
      item: {
        id: `pixice-bridge:${childThreadId}`,
        type: "collabAgentToolCall",
        tool: status === "running" && prompt ? "spawnAgent" : "pixiceBridge",
        bridge: true,
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        prompt,
        model,
        effort,
        agentsStates: { [childThreadId]: { status, message } }
      }
    });
  }
}
