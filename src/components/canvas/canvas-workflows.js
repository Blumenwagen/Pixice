import { createCanvasItem } from "./canvas-store.js";
import { WORKFLOW_NODE_WIDTH, workflowNodeHeight } from "../workflows/workflow-utils.js";

export function placeCanvasWorkflow(workflow, position, metadata = {}, id = crypto.randomUUID()) {
  const label = createCanvasItem("workflow", position, { title: workflow.name, ...metadata, workflow: { ...workflow, graph: undefined }, flattened: true });
  label.id = id;
  label.style = { width: 560, height: 54 };
  const nodes = (workflow.graph?.nodes ?? []).map(node => ({
    id: `${id}:${node.id}`, type: "canvasWorkflowNode", position: { x: position.x + node.position.x, y: position.y + 100 + node.position.y },
    dragHandle: ".pixice-workflow-node-handle", style: { width: WORKFLOW_NODE_WIDTH + 30, height: workflowNodeHeight(node) + 20 },
    data: { kind: "workflowNode", ownerId: id, title: node.name, node }
  }));
  const edges = (workflow.graph?.edges ?? []).map(edge => ({ id: `${id}:${edge.id}`, source: `${id}:${edge.source}`, target: `${id}:${edge.target}`, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort, type: "smoothstep", data: { kind: "workflow", ownerId: id, nativeId: edge.id }, style: { stroke: "#a38aab", strokeWidth: 1.5 } }));
  return { label, nodes, edges };
}

export function canvasWorkflowGraph(document, ownerId) {
  const label = document.nodes.find(node => node.id === ownerId);
  const nodes = document.nodes.filter(node => node.data.ownerId === ownerId && node.data.kind === "workflowNode");
  const ids = new Map(nodes.map(node => [node.id, node.data.node.id]));
  return { nodes: nodes.map(node => ({ ...node.data.node, position: { x: node.position.x - label.position.x, y: node.position.y - label.position.y - 100 } })),
    edges: document.edges.filter(edge => edge.data?.kind === "workflow" && edge.data.ownerId === ownerId && ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ id: edge.data.nativeId ?? edge.id, source: ids.get(edge.source), target: ids.get(edge.target), sourcePort: edge.sourceHandle, targetPort: edge.targetHandle })),
    viewport: { x: 0, y: 0, zoom: 1 } };
}

export function flattenCanvasWorkflows(document) {
  const flattened = document.nodes.filter(node => node.data.kind !== "workflow" || node.data.flattened).map(node => node.data.kind === "agent" ? { ...node, style: { width: Math.max(520, node.style?.width ?? 520) } } : node);
  const edges = [...document.edges];
  let changed = document.nodes.some(node => node.data.kind === "agent" && node.style?.height);
  for (const node of document.nodes) {
    if (node.data.kind !== "workflow" || node.data.flattened) continue;
    const workflow = node.data.workflow ?? { id: node.data.workflowId, name: node.data.title, graph: { nodes: [], edges: [] } };
    const placed = placeCanvasWorkflow(workflow, node.position, node.data, node.id);
    placed.label.data.flattened = true;
    flattened.push(placed.label, ...placed.nodes); edges.push(...placed.edges); changed = true;
  }
  return changed ? { ...document, nodes: flattened, edges } : document;
}
