import { randomUUID } from "node:crypto";
import { z } from "zod";

export const WORKFLOW_NODE_TYPES = ["manualTrigger", "loomAgent", "output"];
export const WORKFLOW_PERMISSION_MODES = ["read-only", "workspace-write", "auto-approve", "full-access"];
export const WORKFLOW_AGENT_EXECUTION_MODES = ["background", "foreground"];

const identifier = z.string().trim().min(1).max(160);
const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const workflowNodeSchema = z.object({
  id: identifier,
  type: z.enum(WORKFLOW_NODE_TYPES),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  position: pointSchema,
  config: z.record(z.unknown()).default({})
}).strict();

export const workflowEdgeSchema = z.object({
  id: identifier,
  source: identifier,
  target: identifier,
  sourcePort: z.string().trim().min(1).max(80).default("output"),
  targetPort: z.string().trim().min(1).max(80).default("input")
}).strict();

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).max(200).default([]),
  edges: z.array(workflowEdgeSchema).max(600).default([]),
  viewport: z.object({
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    zoom: z.number().finite().min(0.2).max(3).default(1)
  }).strict().default({ x: 0, y: 0, zoom: 1 })
}).strict();

export const workflowDocumentSchema = z.object({
  id: identifier,
  projectId: identifier,
  name: z.string().trim().min(1).max(240),
  description: z.string().max(10_000).default(""),
  graph: workflowGraphSchema,
  createdByThreadId: identifier.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const workflowRunInputSchema = z.object({
  value: z.unknown().optional()
}).passthrough().default({});

function normalizeAgentConfig(node) {
  if (node.type !== "loomAgent") return node;
  const executionMode = node.config?.executionMode ?? "background";
  if (!WORKFLOW_AGENT_EXECUTION_MODES.includes(executionMode)) {
    throw new Error(`Loom Agent node ${node.id} has an invalid execution mode`);
  }
  const permissionMode = node.config?.permissionMode ?? "workspace-write";
  if (!WORKFLOW_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`Loom Agent node ${node.id} has an invalid permission mode`);
  }
  return {
    ...node,
    config: {
      ...(node.config ?? {}),
      executionMode,
      permissionMode
    }
  };
}

export function validateWorkflowGraph(graph) {
  const parsed = workflowGraphSchema.parse(graph);
  const normalized = {
    ...parsed,
    nodes: parsed.nodes.map(normalizeAgentConfig)
  };
  const nodesById = new Map();
  for (const node of normalized.nodes) {
    if (nodesById.has(node.id)) throw new Error(`Workflow contains duplicate node id: ${node.id}`);
    nodesById.set(node.id, node);
  }

  const edgeIds = new Set();
  const edgePairs = new Set();
  for (const edge of normalized.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Workflow contains duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodesById.has(edge.source)) throw new Error(`Workflow edge ${edge.id} references a missing source node`);
    if (!nodesById.has(edge.target)) throw new Error(`Workflow edge ${edge.id} references a missing target node`);
    if (edge.source === edge.target) throw new Error(`Workflow edge ${edge.id} cannot connect a node to itself`);
    const pair = `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`;
    if (edgePairs.has(pair)) throw new Error("Workflow contains a duplicate connection");
    edgePairs.add(pair);
  }

  return normalized;
}

export function workflowExecutionLayers(workflow) {
  const graph = validateWorkflowGraph(workflow.graph ?? workflow);
  if (!graph.nodes.length) throw new Error("Workflow has no nodes to run");
  if (!graph.nodes.some((node) => node.type === "manualTrigger")) {
    throw new Error("Workflow needs at least one Manual Trigger node");
  }

  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  let ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const layers = [];
  let visited = 0;
  while (ready.length) {
    const layer = ready;
    ready = [];
    layers.push(layer);
    visited += layer.length;
    for (const nodeId of layer) {
      for (const targetId of outgoing.get(nodeId) ?? []) {
        const nextDegree = (indegree.get(targetId) ?? 0) - 1;
        indegree.set(targetId, nextDegree);
        if (nextDegree === 0) ready.push(targetId);
      }
    }
  }

  if (visited !== graph.nodes.length) throw new Error("Workflow contains a cycle and cannot run");
  return layers;
}

export function workflowInputsForNode(workflow, nodeId, outputs) {
  const graph = workflow.graph ?? workflow;
  return graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => ({
      edgeId: edge.id,
      sourceNodeId: edge.source,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      value: outputs.get(edge.source)
    }));
}

export function createDefaultWorkflow({ id = randomUUID(), projectId, name = "Untitled workflow", description = "", createdByThreadId = null, now = new Date().toISOString() }) {
  const triggerId = randomUUID();
  const agentId = randomUUID();
  const outputId = randomUUID();
  return workflowDocumentSchema.parse({
    id,
    projectId,
    name,
    description,
    createdByThreadId,
    createdAt: now,
    updatedAt: now,
    graph: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: triggerId,
          type: "manualTrigger",
          name: "Manual trigger",
          description: "Start with input supplied by the user or calling agent.",
          position: { x: 80, y: 180 },
          config: {}
        },
        {
          id: agentId,
          type: "loomAgent",
          name: "Loom Agent",
          description: "Run a Loom-native coding agent with the upstream context.",
          position: { x: 410, y: 180 },
          config: {
            prompt: "Complete the workflow task using the incoming context.",
            model: null,
            effort: null,
            permissionMode: "workspace-write",
            executionMode: "background"
          }
        },
        {
          id: outputId,
          type: "output",
          name: "Workflow output",
          description: "Expose the final value returned by this workflow.",
          position: { x: 740, y: 180 },
          config: {}
        }
      ],
      edges: [
        { id: randomUUID(), source: triggerId, target: agentId, sourcePort: "output", targetPort: "input" },
        { id: randomUUID(), source: agentId, target: outputId, sourcePort: "output", targetPort: "input" }
      ]
    }
  });
}

export function normalizeWorkflowDocument(input, current = null) {
  const now = new Date().toISOString();
  const graph = validateWorkflowGraph(input.graph ?? current?.graph ?? { nodes: [], edges: [] });
  return workflowDocumentSchema.parse({
    id: input.id ?? current?.id,
    projectId: input.projectId ?? current?.projectId,
    name: input.name ?? current?.name,
    description: input.description ?? current?.description ?? "",
    graph,
    createdByThreadId: input.createdByThreadId ?? current?.createdByThreadId ?? null,
    createdAt: current?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

export function workflowNodePrompt(node, inputs, runInput) {
  const configured = String(node.config?.prompt ?? "").trim() || "Complete the workflow task using the incoming context.";
  const context = inputs.length
    ? inputs.map((entry) => ({ sourceNodeId: entry.sourceNodeId, value: entry.value }))
    : [{ sourceNodeId: "workflow-input", value: runInput }];
  return `${configured}\n\nWorkflow context:\n${JSON.stringify(context, null, 2)}`;
}
