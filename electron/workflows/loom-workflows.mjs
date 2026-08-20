import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildCodexUserInput } from "../runtime/user-input.mjs";
import {
  WORKFLOW_NODE_TYPES,
  workflowNodeIsAttachment,
  workflowNodeIsTrigger
} from "./workflow-node-catalog.mjs";
import { WORKFLOW_NODE_GUIDE } from "./workflow-node-guide.mjs";
import {
  executeBuiltInWorkflowNode,
  normalizeWorkflowNodeResult,
  workflowNodeResult
} from "./workflow-node-executors.mjs";
import {
  createDefaultWorkflow,
  normalizeWorkflowDocument,
  validateWorkflowGraph,
  workflowExecutionLayers,
  workflowInputsForNode,
  workflowNodePrompt,
  workflowTriggerNodes
} from "./workflow-model.mjs";
import {
  resolveWorkflowSkillAttachment,
  workflowSkillDeveloperInstructions,
  workflowSkillPublicMetadata
} from "./workflow-skill-node.mjs";

export const LOOM_WORKFLOW_NAMESPACE = "loom_workflows";
const WORKFLOW_TOOL_NAMES = [
  "list_workflows",
  "describe_nodes",
  "inspect_workflow",
  "create_workflow",
  "save_workflow",
  "delete_workflow",
  "run_workflow",
  "open_workflow"
];
export const LOOM_WORKFLOW_MCP_TOOLS = new Set(WORKFLOW_TOOL_NAMES.map((name) => `mcp__loom_workflows__${name}`));

const identifier = z.string().trim().min(1).max(160);
const graphShape = {
  nodes: z.array(z.object({
    id: identifier,
    type: z.enum(WORKFLOW_NODE_TYPES),
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

const emptySchema = z.object({}).strict();
const workflowIdSchema = z.object({ workflowId: identifier }).strict();
const createSchema = z.object({
  name: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).default(""),
  enabled: z.boolean().default(false)
}).strict();
const saveSchema = z.object({
  workflowId: identifier,
  name: z.string().trim().min(1).max(240).optional(),
  description: z.string().max(10_000).optional(),
  enabled: z.boolean().optional(),
  ...graphShape,
  expectedUpdatedAt: z.string().datetime().optional()
}).strict();
const runSchema = z.object({
  workflowId: identifier,
  input: z.unknown().optional(),
  triggerNodeId: identifier.optional()
}).strict();

const nodeJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 160 },
    type: { type: "string", enum: WORKFLOW_NODE_TYPES },
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
      description: "Node-specific settings. Call describe_nodes before constructing unfamiliar node types.",
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
    description: "List the current project's workflows, enabled state, trigger configuration, and latest run summaries.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "describe_nodes",
    description: "List every Loom workflow node type, its ports, purpose, and configuration fields. Use this before creating or substantially editing a workflow.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "inspect_workflow",
    description: "Read a complete workflow graph and open its canvas in Loom.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"], additionalProperties: false
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
        description: { type: "string", maxLength: 10000 },
        enabled: { type: "boolean", description: "Enable automatic Schedule and Webhook triggers. Defaults to false." }
      },
      required: ["name"], additionalProperties: false
    }
  },
  {
    type: "function",
    name: "save_workflow",
    description: "Replace a workflow graph after inspecting it. Preserve unrelated nodes and use expectedUpdatedAt to avoid overwriting newer edits.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, maxLength: 160 },
        name: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: "string", maxLength: 10000 },
        enabled: { type: "boolean" },
        nodes: { type: "array", maxItems: 200, items: nodeJsonSchema },
        edges: { type: "array", maxItems: 600, items: edgeJsonSchema },
        viewport: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, zoom: { type: "number", minimum: 0.2, maximum: 3 } },
          additionalProperties: false
        },
        expectedUpdatedAt: { type: "string", description: "The updatedAt value returned by inspect_workflow." }
      },
      required: ["workflowId", "nodes", "edges"], additionalProperties: false
    }
  },
  {
    type: "function",
    name: "delete_workflow",
    description: "Permanently delete a workflow and its run history.",
    inputSchema: {
      type: "object", properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"], additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_workflow",
    description: "Run a workflow now and wait for it to finish. This can test automatic-trigger workflows without enabling them.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, maxLength: 160 },
        input: { description: "JSON-compatible value supplied to the selected trigger." },
        triggerNodeId: { type: "string", description: "Optional trigger to test. Manual triggers are preferred when omitted." }
      },
      required: ["workflowId"], additionalProperties: false
    }
  },
  {
    type: "function",
    name: "open_workflow",
    description: "Open a workflow in Loom's preview without changing or running it.",
    inputSchema: {
      type: "object", properties: { workflowId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["workflowId"], additionalProperties: false
    }
  }
];

export const loomWorkflowDynamicTools = [{
  type: "namespace",
  name: LOOM_WORKFLOW_NAMESPACE,
  description: "Build and run Loom-native visual automations with local triggers, APIs, encrypted credentials, deterministic data operations, SQLite, subworkflows, loops, notifications, attached Skills, board actions, and Loom Agents.",
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

function timeoutResult(promise, timeoutMs) {
  let timer;
  const marker = Symbol("timeout");
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(marker), timeoutMs); })
  ]).then((value) => ({ timedOut: value === marker, value: value === marker ? null : value }));
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
    onAgentActivity,
    fetchImpl = globalThis.fetch,
    credentialResolver = null,
    notify = null
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
    this.fetchImpl = fetchImpl;
    this.credentialResolver = credentialResolver;
    this.notify = notify;
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

  create({ projectId, name, description = "", enabled = false, createdByThreadId = null, graph = null }) {
    const initial = createDefaultWorkflow({ projectId, name, description, enabled, createdByThreadId });
    const workflow = this.store.createWorkflow(graph ? normalizeWorkflowDocument({ ...initial, graph }) : initial);
    this.#changed("created", workflow);
    return workflow;
  }

  save({ projectId, workflowId, name, description, enabled, graph, expectedUpdatedAt }) {
    const current = this.#workflow(projectId, workflowId);
    const workflow = this.store.saveWorkflow({
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      graph: validateWorkflowGraph(graph)
    }, { expectedUpdatedAt });
    this.#changed("updated", workflow);
    return workflow;
  }

  delete(projectId, workflowId) {
    const workflow = this.#workflow(projectId, workflowId);
    if (this.isWorkflowActive(workflow.id)) throw new Error("Stop the active workflow run before deleting it");
    const deleted = this.store.deleteWorkflow(workflow.id);
    this.#changed("deleted", deleted);
    return deleted;
  }

  isWorkflowActive(workflowId) {
    return [...this.activeRuns.values()].some((entry) => entry.workflowId === workflowId);
  }

  startRun({
    projectId,
    workflowId,
    input = {},
    sourceThreadId = null,
    triggerNodeId = null,
    parentRunId = null,
    parentNodeId = null,
    callStack = []
  }) {
    const workflow = this.#workflow(projectId, workflowId);
    if (callStack.includes(workflow.id)) throw new Error(`Subworkflow cycle detected at “${workflow.name}”`);
    if (callStack.length >= 8) throw new Error("Subworkflow nesting is limited to eight workflows");
    const triggers = workflowTriggerNodes(workflow);
    if (!triggers.length) throw new Error("Workflow has no trigger node");
    if (triggerNodeId && !triggers.some((node) => node.id === triggerNodeId)) throw new Error("Workflow trigger was not found");
    const preferred = triggers.filter((node) => node.type === "manualTrigger");
    const selectedTriggers = triggerNodeId
      ? [triggerNodeId]
      : (preferred.length ? preferred : [triggers[0]]).map((node) => typeof node === "string" ? node : node.id);
    const createdAt = new Date().toISOString();
    const nextCallStack = [...callStack, workflow.id];
    const run = this.store.createRun({
      id: randomUUID(),
      workflowId: workflow.id,
      projectId,
      status: "queued",
      input,
      nodeRuns: {},
      sourceThreadId,
      triggerNodeId: selectedTriggers[0] ?? null,
      parentRunId,
      parentNodeId,
      callStack: nextCallStack,
      createdAt
    });
    const state = {
      runId: run.id,
      workflowId: workflow.id,
      cancelled: false,
      threads: new Set(),
      childRuns: new Set(),
      activeTriggerIds: new Set(selectedTriggers),
      callStack: nextCallStack,
      skillAttachments: new Map()
    };
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
    await Promise.allSettled([
      ...[...state.threads].map((threadId) => {
        const pending = this.pendingAgents.get(threadId);
        return pending?.turnId
          ? this.runtime.request("turn/interrupt", { threadId, turnId: pending.turnId })
          : Promise.resolve();
      }),
      ...[...state.childRuns].map((childRunId) => this.cancelRun(projectId, childRunId))
    ]);
    return this.store.getRun(runId);
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Loom workflow tools require an active thread");
      const context = this.threadContext(params.threadId);
      if (!context?.projectId) throw new Error("The active thread is not attached to an open Loom project");
      const input = params.arguments ?? {};

      if (params.tool === "list_workflows") {
        emptySchema.parse(input);
        return textResult({ projectId: context.projectId, workflows: this.list(context.projectId) });
      }
      if (params.tool === "describe_nodes") {
        emptySchema.parse(input);
        return textResult({
          expressionSyntax: "Use {{input.path}}, {{run.path}}, {{nodes.nodeId.path}}, {{now}}, and ?? fallbacks. Loop templates additionally expose item, index, batch, batchIndex, and items.",
          nodes: WORKFLOW_NODE_GUIDE
        });
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
          enabled: value.enabled,
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
          triggerNodeId: value.triggerNodeId ?? null,
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
    const nodeStatuses = new Map();
    const nodesById = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    const incomingByNode = new Map(workflow.graph.nodes.map((node) => [node.id, []]));
    const outgoingByNode = new Map(workflow.graph.nodes.map((node) => [node.id, []]));
    for (const edge of workflow.graph.edges) {
      incomingByNode.get(edge.target)?.push(edge);
      outgoingByNode.get(edge.source)?.push(edge);
    }
    const project = this.projectContext(workflow.projectId, run.sourceThreadId);

    try {
      const layers = workflowExecutionLayers(workflow);
      for (const layer of layers) {
        this.#assertActive(state);
        await Promise.all(layer.map(async (nodeId) => {
          const node = nodesById.get(nodeId);
          const incomingEdges = incomingByNode.get(node.id) ?? [];
          const outgoingEdges = outgoingByNode.get(node.id) ?? [];
          const inputs = workflowInputsForNode(workflow, nodeId, outputs);
          const shouldRun = workflowNodeIsTrigger(node)
            ? state.activeTriggerIds.has(node.id)
            : workflowNodeIsAttachment(node)
              ? outgoingEdges.length > 0
              : incomingEdges.length > 0 && inputs.length > 0;

          if (!shouldRun) {
            outputs.set(node.id, workflowNodeResult(null, {}));
            nodeStatuses.set(node.id, "skipped");
            this.#updateNodeRun(run.id, node.id, {
              status: "skipped",
              input: [],
              output: null,
              activePorts: [],
              skipReason: workflowNodeIsTrigger(node)
                ? "Trigger was not selected"
                : workflowNodeIsAttachment(node)
                  ? "Attachment is not connected to an agent"
                  : "No active incoming branch",
              completedAt: new Date().toISOString()
            });
            return;
          }

          this.#updateNodeRun(run.id, node.id, {
            status: "running",
            startedAt: new Date().toISOString(),
            input: workflowNodeIsTrigger(node) ? run.input : workflowNodeIsAttachment(node) ? [] : inputs.map((entry) => entry.value),
            ...(node.type === "loomAgent" ? { executionMode: node.config?.executionMode ?? "background" } : {})
          });
          try {
            const result = normalizeWorkflowNodeResult(await this.#executeNode({
              workflow,
              node,
              inputs,
              run: this.store.getRun(run.id),
              state,
              outputs,
              project
            }));
            outputs.set(node.id, result);
            nodeStatuses.set(node.id, "completed");
            this.#updateNodeRun(run.id, node.id, {
              status: "completed",
              output: result.output,
              activePorts: Object.keys(result.ports ?? {}),
              completedAt: new Date().toISOString()
            });
          } catch (error) {
            nodeStatuses.set(node.id, error instanceof WorkflowCancelledError ? "cancelled" : "failed");
            this.#updateNodeRun(run.id, node.id, {
              status: error instanceof WorkflowCancelledError ? "cancelled" : "failed",
              error: error.message,
              completedAt: new Date().toISOString()
            });
            throw error;
          }
        }));
      }

      const outputNodes = workflow.graph.nodes.filter((node) => node.type === "output" && nodeStatuses.get(node.id) === "completed");
      const sinkNodes = workflow.graph.nodes.filter((node) => (
        nodeStatuses.get(node.id) === "completed"
        && !workflowNodeIsAttachment(node)
        && !workflow.graph.edges.some((edge) => edge.source === node.id)
      ));
      const resultNodes = outputNodes.length ? outputNodes : sinkNodes;
      const result = resultNodes.length === 0
        ? null
        : resultNodes.length === 1
          ? outputs.get(resultNodes[0].id)?.output
          : Object.fromEntries(resultNodes.map((node) => [node.id, outputs.get(node.id)?.output]));
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

  async #executeNode({ workflow, node, inputs, run, state, outputs, project }) {
    this.#assertActive(state);
    if (workflowNodeIsTrigger(node)) return workflowNodeResult(run.input);
    if (workflowNodeIsAttachment(node)) {
      const metadata = {
        source: node.config?.source ?? "installed",
        reference: node.config?.skillRef || node.config?.path || null,
        name: node.config?.skillName || node.name,
        path: node.config?.path || null
      };
      return workflowNodeResult(metadata, {
        skill: { kind: "workflowSkillReference", nodeId: node.id }
      });
    }
    if (node.type === "output") {
      const value = inputs.length === 0
        ? null
        : inputs.length === 1
          ? inputs[0].value
          : Object.fromEntries(inputs.map((entry) => [entry.sourceNodeId, entry.value]));
      return workflowNodeResult(value, {});
    }
    if (node.type === "loomAgent") return workflowNodeResult(await this.#runAgentNode({ workflow, node, inputs, run, state }));
    const builtIn = await executeBuiltInWorkflowNode({
      node,
      inputs,
      run,
      workflow,
      nodeOutputs: outputs,
      projectRoot: project?.cwd,
      database: this.database,
      assertActive: () => this.#assertActive(state),
      fetchImpl: this.fetchImpl,
      credentialResolver: this.credentialResolver,
      notify: this.notify,
      executeWorkflow: (request) => this.#executeNestedWorkflow({
        parentWorkflow: workflow,
        parentRun: run,
        parentNode: node,
        state,
        ...request
      })
    });
    if (builtIn !== null) return builtIn;
    throw new Error(`Unsupported workflow node type: ${node.type}`);
  }

  async #executeNestedWorkflow({ parentWorkflow, parentRun, parentNode, state, workflowId, input, timeoutMs, returnMode }) {
    this.#assertActive(state);
    const target = this.#workflow(parentWorkflow.projectId, workflowId);
    const child = this.startRun({
      projectId: target.projectId,
      workflowId: target.id,
      input,
      sourceThreadId: parentRun.sourceThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentNode.id,
      callStack: state.callStack
    });
    state.childRuns.add(child.id);
    try {
      const waited = await timeoutResult(this.waitForRun(child.id), timeoutMs);
      if (waited.timedOut) {
        await this.cancelRun(target.projectId, child.id).catch(() => null);
        throw new Error(`Subworkflow “${target.name}” timed out after ${timeoutMs}ms`);
      }
      const completed = waited.value;
      this.#assertActive(state);
      if (completed.status !== "completed") {
        throw new Error(completed.error || `Subworkflow “${target.name}” ${completed.status}`);
      }
      return returnMode === "run" ? completed : completed.output;
    } finally {
      state.childRuns.delete(child.id);
    }
  }

  async #resolveAgentSkills({ workflow, inputs, state, projectRoot }) {
    const attachments = [];
    const seen = new Set();
    for (const input of inputs.filter((entry) => entry.targetPort === "skill")) {
      if (seen.has(input.sourceNodeId)) continue;
      seen.add(input.sourceNodeId);
      const skillNode = workflow.graph.nodes.find((candidate) => candidate.id === input.sourceNodeId);
      if (!skillNode || skillNode.type !== "useSkill") {
        throw new Error("A Loom Agent Skill port received an invalid attachment node");
      }
      let pending = state.skillAttachments.get(skillNode.id);
      if (!pending) {
        pending = resolveWorkflowSkillAttachment({
          node: skillNode,
          runtime: this.runtime,
          projectRoot
        });
        state.skillAttachments.set(skillNode.id, pending);
      }
      attachments.push(await pending);
    }
    return attachments;
  }

  async #runAgentNode({ workflow, node, inputs, run, state }) {
    if (!this.runtime.connected) throw new Error("No connected agent runtime is available");
    const context = this.projectContext(workflow.projectId, run.sourceThreadId);
    if (!context?.cwd) throw new Error("Workflow project is no longer available");
    const dataInputs = inputs.filter((entry) => entry.targetPort !== "skill");
    const skillAttachments = await this.#resolveAgentSkills({
      workflow,
      inputs,
      state,
      projectRoot: context.cwd
    });
    const skillInstructions = workflowSkillDeveloperInstructions(skillAttachments);
    const developerInstructions = [context.developerInstructions, skillInstructions].filter(Boolean).join("\n\n");
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
    const prompt = workflowNodePrompt(node, dataInputs, run.input);
    const agentContext = { ...context, developerInstructions };
    const threadRequest = {
      cwd: context.cwd,
      runtimeWorkspaceRoots: [context.cwd],
      model: modelId,
      permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions,
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

    this.onThreadCreated?.({ context: agentContext, thread, prompt, model: selected, workflow, run, node, executionMode });
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
      message: `Running ${node.name} on ${selected.displayName ?? selected.model}${skillAttachments.length ? ` with ${skillAttachments.length} attached Skill${skillAttachments.length === 1 ? "" : "s"}` : ""}`
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
        executionMode,
        attachedSkills: skillAttachments.map(workflowSkillPublicMetadata)
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
