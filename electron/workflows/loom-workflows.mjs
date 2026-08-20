import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildCodexUserInput } from "../runtime/user-input.mjs";
import {
  createDefaultWorkflow,
  normalizeWorkflowDocument,
  validateWorkflowGraph,
  workflowExecutionLayers,
  workflowInputsForNode,
  workflowNodePrompt
} from "./workflow-model.mjs";

export const LOOM_WORKFLOW_NAMESPACE = "loom_workflows";
export const LOOM_WORKFLOW_MCP_TOOLS = new Set([
  "mcp__loom_workflows__list_workflows",
  "mcp__loom_workflows__inspect_workflow",
  "mcp__loom_workflows__create_workflow",
  "mcp__loom_workflows__save_workflow",
  "mcp__loom_workflows__delete_workflow",
  "mcp__loom_workflows__run_workflow",
  "mcp__loom_workflows__open_workflow"
]);

const identifier = z.string().trim().min(1).max(160);
const graphShape = {
  nodes: z.array(z.object({
    id: identifier,
    type: z.enum(["manualTrigger", "loomAgent", "output"]),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).default(""),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    config: z.record(z.unknown()).default({})
  }).strict()).max(200),
  edges: z.array(z.object({
    id: identifier,
    source: identifier,
    target: identifier,
    sourcePort: z.string().trim().min(1).max(80).default("output"),
    targetPort: z.string().trim().min(1).max(80).default("input")
  }).strict()).max(600),
  viewport: z.object({
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    zoom: z.number().finite().min(0.2).max(3).default(1)
  }).strict().optional()
};

const listSchema = z.object({}).strict();
const workflowIdSchema = z.object({ workflowId: identifier }).strict();
const createSchema = z.object({
  name: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).default("")
}).strict();
const saveSchema = z.object({
  workflowId: identifier,
  name: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(10_000).optional(),
  ...graphShape,
  expectedUpdatedAt: z.string().datetime().optional()
}).strict();
const runSchema = z.object({
  workflowId: identifier,
  input: z.unknown().optional()
}).strict();

const nodeJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 160 },
    type: { type: "string", enum: ["manualTrigger", "loomAgent", "output"] },
    name: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string", maxLength: 2000 },
    position: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false
    },
    config: {
      type: "object",
      description: "Node-specific settings. Loom Agent nodes accept prompt, model, effort, permissionMode, and executionMode (background or foreground).",
      additionalProperties: true
    }
  },
  required: ["id", "type", "name", "position"],
  additionalProperties: false
};

const edgeJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 160 },
    source: { type: "string", minLength: 1, maxLength: 160 },
    target: { type: "string", minLength: 1, maxLength: 160 },
    sourcePort: { type: "string", minLength: 1, maxLength: 80 },
    targetPort: { type: "string", minLength: 1, maxLength: 80 }
  },
  required: ["id", "source", "target"],
  additionalProperties: false
};

export const loomWorkflowTools = [
  {
    type: "function",
    name: "list_workflows",
    description: "List the current project's workflows and their latest run summaries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "inspect_workflow",
    description: "Read a complete workflow graph. This also opens the workflow canvas in Loom.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "create_workflow",
    description: "Create a workflow prefilled with Manual Trigger → Loom Agent → Output and open it in Loom.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: "string", maxLength: 10000 }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "save_workflow",
    description: "Replace a workflow graph after inspecting it. Preserve unrelated nodes and use expectedUpdatedAt to avoid overwriting newer edits. Opens the updated canvas in Loom.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, maxLength: 160 },
        name: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: "string", maxLength: 10000 },
        nodes: { type: "array", maxItems: 200, items: nodeJsonSchema },
        edges: { type: "array", maxItems: 600, items: edgeJsonSchema },
        viewport: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, zoom: { type: "number", minimum: 0.2, maximum: 3 } },
          additionalProperties: false
        },
        expectedUpdatedAt: { type: "string", description: "The updatedAt value returned by inspect_workflow." }
      },
      required: ["workflowId", "nodes", "edges"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "delete_workflow",
    description: "Permanently delete a workflow and its run history.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_workflow",
    description: "Run a workflow now, wait for it to finish, and return every node result. Each Loom Agent node may run quietly in the background or promote itself to a normal foreground Loom thread according to its executionMode setting.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, maxLength: 160 },
        input: { description: "JSON-compatible value supplied to Manual Trigger nodes." }
      },
      required: ["workflowId"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "open_workflow",
    description: "Open a workflow in Loom's preview without changing or running it.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"],
      additionalProperties: false
    }
  }
];

export const loomWorkflowDynamicTools = [{
  type: "namespace",
  name: LOOM_WORKFLOW_NAMESPACE,
  description: "Inspect, create, edit, open, and run Loom-native visual workflows for the current project. Workflows are directed graphs with Manual Trigger, Loom Agent, and Output nodes. Loom Agent nodes can run in the background or as normal foreground threads. Using a workflow tool opens that workflow in Loom's in-app preview so the user can watch the agent work.",
  tools: loomWorkflowTools
}];

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
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
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  return status ?? "failed";
}

class WorkflowCancelledError extends Error {
  constructor() {
    super("Workflow run was cancelled");
    this.name = "WorkflowCancelledError";
  }
}

export class LoomWorkflows {
  constructor({
    runtime,
    store,
    database,
    threadContext,
    projectContext,
    dynamicTools,
    onChange,
    onOpen,
    onRun,
    onForeground,
    onThreadCreated,
    onAgentActivity
  }) {
    this.runtime = runtime;
    this.store = store;
    this.database = database;
    this.threadContext = threadContext;
    this.projectContext = projectContext;
    this.dynamicTools = dynamicTools;
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.onRun = onRun;
    this.onForeground = onForeground;
    this.onThreadCreated = onThreadCreated;
    this.onAgentActivity = onAgentActivity;
    this.pendingAgents = new Map();
    this.activeRuns = new Map();
    this.runPromises = new Map();
    this.runtime.on("event", (event) => this.#onRuntimeEvent(event));
  }

  list(projectId) {
    return this.store.listWorkflows(projectId).map((workflow) => ({
      ...workflow,
      latestRun: this.store.listRuns(workflow.id, 1)[0] ?? null
    }));
  }

  read(projectId, workflowId) {
    const workflow = this.#workflow(projectId, workflowId);
    return { workflow, runs: this.store.listRuns(workflow.id, 20) };
  }

  create({ projectId, name, description = "", createdByThreadId = null, graph = null }) {
    const initial = createDefaultWorkflow({ projectId, name, description, createdByThreadId });
    const workflow = this.store.createWorkflow(graph ? normalizeWorkflowDocument({ ...initial, graph }) : initial);
    this.#changed("created", workflow);
    return workflow;
  }

  save({ projectId, workflowId, name, description, graph, expectedUpdatedAt }) {
    const current = this.#workflow(projectId, workflowId);
    const workflow = this.store.saveWorkflow({
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      graph: validateWorkflowGraph(graph)
    }, { expectedUpdatedAt });
    this.#changed("updated", workflow);
    return workflow;
  }

  delete(projectId, workflowId) {
    const workflow = this.#workflow(projectId, workflowId);
    const active = [...this.activeRuns.values()].some((entry) => entry.workflowId === workflow.id);
    if (active) throw new Error("Stop the active workflow run before deleting it");
    const deleted = this.store.deleteWorkflow(workflow.id);
    this.#changed("deleted", deleted);
    return deleted;
  }

  startRun({ projectId, workflowId, input = {}, sourceThreadId = null }) {
    const workflow = this.#workflow(projectId, workflowId);
    const createdAt = new Date().toISOString();
    const run = this.store.createRun({
      id: randomUUID(),
      workflowId: workflow.id,
      projectId,
      status: "queued",
      input,
      nodeRuns: {},
      sourceThreadId,
      createdAt
    });
    const state = { runId: run.id, workflowId: workflow.id, cancelled: false, threads: new Set() };
    this.activeRuns.set(run.id, state);
    const promise = this.#executeRun(workflow, run, state)
      .catch(() => this.store.getRun(run.id))
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.runPromises.delete(run.id);
      });
    this.runPromises.set(run.id, promise);
    this.#publishRun(run);
    return run;
  }

  async waitForRun(runId) {
    const promise = this.runPromises.get(runId);
    if (promise) await promise;
    const run = this.store.getRun(runId);
    if (!run) throw new Error("Workflow run not found");
    return run;
  }

  async cancelRun(projectId, runId) {
    const run = this.store.getRun(runId);
    if (!run || run.projectId !== projectId) throw new Error("Workflow run not found in this project");
    const state = this.activeRuns.get(runId);
    if (!state) return run;
    state.cancelled = true;
    const cancelling = this.store.updateRun(runId, { status: "cancelling" });
    this.#publishRun(cancelling);
    await Promise.allSettled([...state.threads].map((threadId) => {
      const pending = this.pendingAgents.get(threadId);
      return pending?.turnId
        ? this.runtime.request("turn/interrupt", { threadId, turnId: pending.turnId })
        : Promise.resolve();
    }));
    return this.store.getRun(runId);
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Loom workflow tools require an active thread");
      const context = this.threadContext(params.threadId);
      if (!context?.projectId) throw new Error("The active thread is not attached to an open Loom project");
      const input = params.arguments ?? {};

      if (params.tool === "list_workflows") {
        listSchema.parse(input);
        return textResult({ projectId: context.projectId, workflows: this.list(context.projectId) });
      }
      if (params.tool === "inspect_workflow") {
        const value = workflowIdSchema.parse(input);
        const result = this.read(context.projectId, value.workflowId);
        this.#opened(result.workflow, params.threadId, "inspect");
        return textResult(result);
      }
      if (params.tool === "create_workflow") {
        const value = createSchema.parse(input);
        const workflow = this.create({ ...value, projectId: context.projectId, createdByThreadId: params.threadId });
        this.#opened(workflow, params.threadId, "create");
        return textResult({ workflow });
      }
      if (params.tool === "save_workflow") {
        const value = saveSchema.parse(input);
        const current = this.#workflow(context.projectId, value.workflowId);
        const workflow = this.save({
          projectId: context.projectId,
          workflowId: value.workflowId,
          name: value.name,
          description: value.description,
          graph: {
            nodes: value.nodes,
            edges: value.edges,
            viewport: value.viewport ?? current.graph.viewport
          },
          expectedUpdatedAt: value.expectedUpdatedAt
        });
        this.#opened(workflow, params.threadId, "edit");
        return textResult({ workflow });
      }
      if (params.tool === "delete_workflow") {
        const value = workflowIdSchema.parse(input);
        return textResult({ deleted: true, workflow: this.delete(context.projectId, value.workflowId) });
      }
      if (params.tool === "open_workflow") {
        const value = workflowIdSchema.parse(input);
        const workflow = this.#workflow(context.projectId, value.workflowId);
        this.#opened(workflow, params.threadId, "open");
        return textResult({ opened: true, workflow });
      }
      if (params.tool === "run_workflow") {
        const value = runSchema.parse(input);
        const workflow = this.#workflow(context.projectId, value.workflowId);
        this.#opened(workflow, params.threadId, "run");
        const run = this.startRun({
          projectId: context.projectId,
          workflowId: value.workflowId,
          input: value.input ?? {},
          sourceThreadId: params.threadId
        });
        return textResult({ run: await this.waitForRun(run.id) });
      }
      throw new Error(`Unknown Loom workflow tool: ${params.tool}`);
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }

  async #executeRun(workflow, initialRun, state) {
    const startedAt = new Date().toISOString();
    let run = this.store.updateRun(initialRun.id, { status: "running", startedAt });
    this.#publishRun(run);
    const outputs = new Map();
    const nodesById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));

    try {
      const layers = workflowExecutionLayers(workflow);
      for (const layer of layers) {
        this.#assertActive(state);
        await Promise.all(layer.map(async (nodeId) => {
          const node = nodesById.get(nodeId);
          const inputs = workflowInputsForNode(workflow, nodeId, outputs);
          this.#updateNodeRun(run.id, node.id, {
            status: "running",
            startedAt: new Date().toISOString(),
            input: inputs.map((entry) => entry.value),
            ...(node.type === "loomAgent" ? { executionMode: node.config?.executionMode ?? "background" } : {})
          });
          try {
            const output = await this.#executeNode({ workflow, node, inputs, run: this.store.getRun(run.id), state });
            outputs.set(node.id, output);
            this.#updateNodeRun(run.id, node.id, {
              status: "completed",
              output,
              completedAt: new Date().toISOString()
            });
          } catch (error) {
            this.#updateNodeRun(run.id, node.id, {
              status: error instanceof WorkflowCancelledError ? "cancelled" : "failed",
              error: error.message,
              completedAt: new Date().toISOString()
            });
            throw error;
          }
        }));
      }

      const outputNodes = workflow.graph.nodes.filter((node) => node.type === "output");
      const sinkIds = outputNodes.length ? outputNodes.map((node) => node.id) : workflow.graph.nodes
        .filter((node) => !workflow.graph.edges.some((edge) => edge.source === node.id))
        .map((node) => node.id);
      const result = sinkIds.length === 1
        ? outputs.get(sinkIds[0])
        : Object.fromEntries(sinkIds.map((nodeId) => [nodeId, outputs.get(nodeId)]));
      run = this.store.updateRun(run.id, {
        status: "completed",
        output: result,
        completedAt: new Date().toISOString()
      });
      this.#publishRun(run);
      return run;
    } catch (error) {
      const cancelled = error instanceof WorkflowCancelledError || state.cancelled;
      run = this.store.updateRun(run.id, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Workflow run was cancelled" : error.message,
        completedAt: new Date().toISOString()
      });
      this.#publishRun(run);
      return run;
    }
  }

  async #executeNode({ workflow, node, inputs, run, state }) {
    this.#assertActive(state);
    if (node.type === "manualTrigger") return run.input;
    if (node.type === "output") {
      if (inputs.length === 0) return null;
      if (inputs.length === 1) return inputs[0].value;
      return Object.fromEntries(inputs.map((entry) => [entry.sourceNodeId, entry.value]));
    }
    if (node.type === "loomAgent") {
      return this.#runAgentNode({ workflow, node, inputs, run, state });
    }
    throw new Error(`Unsupported workflow node type: ${node.type}`);
  }

  async #runAgentNode({ workflow, node, inputs, run, state }) {
    if (!this.runtime.connected) throw new Error("No connected agent runtime is available");
    const context = this.projectContext(workflow.projectId, run.sourceThreadId);
    if (!context?.cwd) throw new Error("Workflow project is no longer available");
    const modelResponse = await this.runtime.request("model/list", { limit: 100 });
    const models = modelResponse.data ?? [];
    const requestedModel = String(node.config?.model ?? context.defaultModel ?? "").trim();
    const selected = models.find((model) => model.id === requestedModel || model.model === requestedModel)
      ?? models.find((model) => model.isDefault)
      ?? models[0];
    if (!selected) throw new Error("No connected model is available for the Loom Agent node");
    const modelId = selected.id ?? selected.model;
    const effort = String(node.config?.effort ?? context.defaultEffort ?? selected.defaultReasoningEffort ?? "").trim() || null;
    const permissionMode = ["read-only", "workspace-write", "auto-approve", "full-access"].includes(node.config?.permissionMode)
      ? node.config.permissionMode
      : context.defaultPermissionMode ?? "workspace-write";
    const executionMode = node.config?.executionMode === "foreground" ? "foreground" : "background";
    const permissions = context.permissionSettings(permissionMode);
    const prompt = workflowNodePrompt(node, inputs, run.input);
    const threadRequest = {
      cwd: context.cwd,
      runtimeWorkspaceRoots: [context.cwd],
      model: modelId,
      permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: context.developerInstructions,
      dynamicTools: this.dynamicTools(),
      threadSource: "loomBridge"
    };
    if (executionMode === "background" && run.sourceThreadId) threadRequest.parentThreadId = run.sourceThreadId;
    const started = await this.runtime.request("thread/start", threadRequest);
    const thread = {
      ...started.thread,
      ...(executionMode === "background" && run.sourceThreadId ? { parentThreadId: run.sourceThreadId } : {}),
      workflow: { workflowId: workflow.id, runId: run.id, nodeId: node.id, executionMode }
    };

    if (executionMode === "background") {
      this.database?.saveThreadLink({
        childThreadId: thread.id,
        parentThreadId: run.sourceThreadId ?? `workflow:${workflow.id}`,
        kind: "loomWorkflowBackground",
        model: modelId,
        effort
      });
    }

    this.onThreadCreated?.({ context, thread, prompt, model: selected, workflow, run, node, executionMode });
    this.#publishAgentState({
      executionMode,
      parentThreadId: run.sourceThreadId,
      childThreadId: thread.id,
      workflow,
      run,
      node,
      model: modelId,
      effort,
      status: "running",
      message: `Running ${node.name} on ${selected.displayName ?? selected.model}`
    });

    state.threads.add(thread.id);
    const completion = new Promise((resolve) => this.pendingAgents.set(thread.id, {
      resolve,
      runId: run.id,
      nodeId: node.id,
      parentThreadId: run.sourceThreadId,
      workflow,
      run,
      node,
      model: modelId,
      effort,
      executionMode,
      prompt
    }));
    try {
      const turn = await this.runtime.request("turn/start", {
        threadId: thread.id,
        input: buildCodexUserInput(prompt, []),
        cwd: context.cwd,
        runtimeWorkspaceRoots: [context.cwd],
        model: modelId,
        effort,
        permissionMode,
        approvalPolicy: permissions.approvalPolicy,
        approvalsReviewer: permissions.approvalsReviewer,
        sandboxPolicy: permissions.sandboxPolicy
      });
      const pending = this.pendingAgents.get(thread.id);
      if (pending) pending.turnId = turn.turn.id;
      this.#updateNodeRun(run.id, node.id, {
        threadId: thread.id,
        turnId: turn.turn.id,
        model: modelId,
        effort,
        executionMode
      });
      if (executionMode === "foreground") {
        this.onForeground?.({
          projectId: workflow.projectId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          runId: run.id,
          nodeId: node.id,
          nodeName: node.name,
          threadId: thread.id,
          turnId: turn.turn.id,
          sourceThreadId: run.sourceThreadId
        });
      }
    } catch (error) {
      this.pendingAgents.delete(thread.id);
      state.threads.delete(thread.id);
      throw error;
    }

    const result = await completion;
    state.threads.delete(thread.id);
    this.#assertActive(state);
    if (result.status !== "completed") throw new Error(result.error || `Loom Agent node ${completionStatus(result.status)}`);
    return result.answer;
  }

  async #onRuntimeEvent(event) {
    const payload = event?.payload ?? {};
    if (payload.method !== "turn/completed" || !payload.threadId) return;
    const pending = this.pendingAgents.get(payload.threadId);
    if (!pending || (pending.turnId && pending.turnId !== payload.turn?.id)) return;
    this.pendingAgents.delete(payload.threadId);
    let turn = payload.turn;
    if (!finalAnswer(turn)) {
      try {
        const response = await this.runtime.request("thread/read", { threadId: payload.threadId, includeTurns: true });
        turn = response.thread?.turns?.at(-1) ?? turn;
      } catch {
        // The completion event still settles the workflow node.
      }
    }
    const status = turn?.status ?? "completed";
    const answer = finalAnswer(turn);
    const error = turn?.error?.message ?? null;
    this.#publishAgentState({
      executionMode: pending.executionMode,
      parentThreadId: pending.parentThreadId,
      childThreadId: payload.threadId,
      workflow: pending.workflow,
      run: pending.run,
      node: pending.node,
      model: pending.model,
      effort: pending.effort,
      status: completionStatus(status),
      message: answer || error || `Workflow agent ${status}`
    });
    pending.resolve({ threadId: payload.threadId, status, answer, error });
  }

  #workflow(projectId, workflowId) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow || workflow.projectId !== projectId) throw new Error("Workflow not found in this project");
    return workflow;
  }

  #assertActive(state) {
    if (state.cancelled) throw new WorkflowCancelledError();
  }

  #updateNodeRun(runId, nodeId, patch) {
    const run = this.store.getRun(runId);
    const nodeRuns = { ...run.nodeRuns, [nodeId]: { ...(run.nodeRuns?.[nodeId] ?? {}), nodeId, ...patch } };
    const updated = this.store.updateRun(runId, { nodeRuns });
    this.#publishRun(updated);
    return updated;
  }

  #changed(action, workflow) {
    this.onChange?.({ action, projectId: workflow.projectId, workflow });
  }

  #opened(workflow, threadId, reason) {
    this.onOpen?.({
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      threadId,
      reason
    });
  }

  #publishRun(run) {
    this.onRun?.({ projectId: run.projectId, workflowId: run.workflowId, run });
  }

  #publishAgentState({ executionMode, parentThreadId, childThreadId, workflow, run, node, model, effort, status, message }) {
    if (executionMode !== "background" || !parentThreadId) return;
    this.onAgentActivity?.({
      method: "loom/workflow/agent/updated",
      threadId: parentThreadId,
      item: {
        id: `loom-workflow:${run.id}:${node.id}`,
        type: "collabAgentToolCall",
        tool: status === "running" ? "spawnAgent" : "loomWorkflow",
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        prompt: `${workflow.name} · ${node.name}`,
        model,
        effort,
        executionMode,
        agentsStates: { [childThreadId]: { status, message } }
      }
    });
  }
}
