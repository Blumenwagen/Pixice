import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  WORKFLOW_AGENT_EXECUTION_MODES,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_PERMISSION_MODES,
  defaultWorkflowNodeConfig,
  normalizeWorkflowNodeConfig,
  workflowNodeInputPorts,
  workflowNodeIsAttachment,
  workflowNodeIsTrigger,
  workflowNodeOutputPorts
} from "./workflow-node-catalog.mjs";

export {
  WORKFLOW_AGENT_EXECUTION_MODES,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_PERMISSION_MODES
} from "./workflow-node-catalog.mjs";

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
  enabled: z.boolean().default(false),
  graph: workflowGraphSchema,
  createdByThreadId: identifier.nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const workflowRunInputSchema = z.object({
  value: z.unknown().optional()
}).passthrough().default({});

function validateSkillEdge(edge, source, target) {
  const isSkillConnection = source.type === "useSkill" || edge.sourcePort === "skill" || edge.targetPort === "skill";
  if (!isSkillConnection) return;
  if (source.type !== "useSkill" || edge.sourcePort !== "skill" || target.type !== "loomAgent" || edge.targetPort !== "skill") {
    throw new Error(`Workflow edge ${edge.id} must connect Use Skill · Skill directly to Pixice Agent · Skill`);
  }
}

export function validateWorkflowGraph(graph) {
  const parsed = workflowGraphSchema.parse(graph);
  const normalized = {
    ...parsed,
    nodes: parsed.nodes.map((node) => ({ ...node, config: normalizeWorkflowNodeConfig(node) }))
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
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source) throw new Error(`Workflow edge ${edge.id} references a missing source node`);
    if (!target) throw new Error(`Workflow edge ${edge.id} references a missing target node`);
    if (edge.source === edge.target) throw new Error(`Workflow edge ${edge.id} cannot connect a node to itself`);
    if (!workflowNodeOutputPorts(source).includes(edge.sourcePort)) {
      throw new Error(`Workflow edge ${edge.id} references missing output port ${edge.sourcePort} on ${source.name}`);
    }
    if (!workflowNodeInputPorts(target).includes(edge.targetPort)) {
      throw new Error(`Workflow edge ${edge.id} references missing input port ${edge.targetPort} on ${target.name}`);
    }
    validateSkillEdge(edge, source, target);
    const pair = `${edge.source}:${edge.sourcePort}->${edge.target}:${edge.targetPort}`;
    if (edgePairs.has(pair)) throw new Error("Workflow contains a duplicate connection");
    edgePairs.add(pair);
  }

  return normalized;
}

export function workflowExecutionLayers(workflow) {
  const graph = validateWorkflowGraph(workflow.graph ?? workflow);
  if (!graph.nodes.length) throw new Error("Workflow has no nodes to run");
  if (!graph.nodes.some(workflowNodeIsTrigger)) throw new Error("Workflow needs at least one trigger node");

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

export function workflowTriggerNodes(workflow) {
  return (workflow.graph ?? workflow).nodes.filter(workflowNodeIsTrigger);
}

export function workflowAttachmentNodes(workflow) {
  return (workflow.graph ?? workflow).nodes.filter(workflowNodeIsAttachment);
}

function inputFromEdge(edge, outputs) {
  if (!outputs.has(edge.source)) return [];
  const sourceResult = outputs.get(edge.source);
  if (sourceResult?.ports) {
    if (!Object.prototype.hasOwnProperty.call(sourceResult.ports, edge.sourcePort)) return [];
    return [{
      edgeId: edge.id,
      sourceNodeId: edge.source,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      value: sourceResult.ports[edge.sourcePort]
    }];
  }
  if (edge.sourcePort !== "output") return [];
  return [{
    edgeId: edge.id,
    sourceNodeId: edge.source,
    sourcePort: edge.sourcePort,
    targetPort: edge.targetPort,
    value: sourceResult
  }];
}

export function workflowInputsForNode(workflow, nodeId, outputs) {
  const graph = workflow.graph ?? workflow;
  const edges = graph.edges.filter((edge) => edge.target === nodeId);
  const dataEdges = edges.filter((edge) => edge.targetPort !== "skill");
  const skillEdges = edges.filter((edge) => edge.targetPort === "skill");
  const dataInputs = dataEdges.flatMap((edge) => inputFromEdge(edge, outputs));

  // Skill attachments describe how an Agent should work; they must never activate
  // an otherwise disconnected or inactive Agent branch by themselves.
  if (skillEdges.length && (dataEdges.length === 0 || dataInputs.length === 0)) return dataInputs;
  return [...dataInputs, ...skillEdges.flatMap((edge) => inputFromEdge(edge, outputs))];
}

export function createDefaultWorkflow({
  id = randomUUID(),
  projectId,
  name = "Untitled workflow",
  description = "",
  enabled = false,
  createdByThreadId = null,
  now = new Date().toISOString()
}) {
  const triggerId = randomUUID();
  const agentId = randomUUID();
  const outputId = randomUUID();
  return workflowDocumentSchema.parse({
    id,
    projectId,
    name,
    description,
    enabled,
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
          config: defaultWorkflowNodeConfig("manualTrigger")
        },
        {
          id: agentId,
          type: "loomAgent",
          name: "Pixice Agent",
          description: "Run a Pixice-native coding agent with the upstream context.",
          position: { x: 410, y: 180 },
          config: defaultWorkflowNodeConfig("loomAgent")
        },
        {
          id: outputId,
          type: "output",
          name: "Workflow output",
          description: "Expose the final value returned by this workflow.",
          position: { x: 740, y: 180 },
          config: defaultWorkflowNodeConfig("output")
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
    enabled: input.enabled ?? current?.enabled ?? false,
    graph,
    createdByThreadId: input.createdByThreadId ?? current?.createdByThreadId ?? null,
    createdAt: current?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

export function workflowNodePrompt(node, inputs, runInput) {
  const configured = String(node.config?.prompt ?? "").trim() || "Complete the workflow task using the incoming context.";
  const context = inputs.length
    ? inputs.map((entry) => ({ sourceNodeId: entry.sourceNodeId, sourcePort: entry.sourcePort, value: entry.value }))
    : [{ sourceNodeId: "workflow-input", value: runInput }];
  return `${configured}\n\nWorkflow context:\n${JSON.stringify(context, null, 2)}`;
}
