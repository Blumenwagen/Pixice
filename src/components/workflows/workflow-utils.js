export const WORKFLOW_NODE_WIDTH = 286;
export const WORKFLOW_NODE_HEIGHT = 112;

export const WORKFLOW_NODE_META = {
  manualTrigger: {
    label: "Trigger",
    action: "Start workflow",
    tone: "violet",
    defaultName: "Manual trigger",
    defaultDescription: "Start with input supplied by the user or calling agent.",
    hasInput: false,
    hasOutput: true
  },
  loomAgent: {
    label: "Loom Agent",
    action: "Run agent",
    tone: "orange",
    defaultName: "Loom Agent",
    defaultDescription: "Run a Loom-native coding agent with upstream workflow context.",
    hasInput: true,
    hasOutput: true
  },
  output: {
    label: "Output",
    action: "Return value",
    tone: "blue",
    defaultName: "Workflow output",
    defaultDescription: "Expose the final value returned by this workflow.",
    hasInput: true,
    hasOutput: false
  }
};

export function workflowId(prefix = "workflow") {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function cloneWorkflow(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

export function createWorkflowNode(type, position) {
  const meta = WORKFLOW_NODE_META[type];
  if (!meta) throw new Error(`Unknown workflow node type: ${type}`);
  return {
    id: workflowId("node"),
    type,
    name: meta.defaultName,
    description: meta.defaultDescription,
    position,
    config: type === "loomAgent"
      ? {
          prompt: "Complete the workflow task using the incoming context.",
          model: null,
          effort: null,
          permissionMode: "workspace-write",
          executionMode: "background"
        }
      : {}
  };
}

export function createWorkflowEdge(source, target) {
  return {
    id: workflowId("edge"),
    source,
    target,
    sourcePort: "output",
    targetPort: "input"
  };
}

export function nodePort(node, side) {
  return {
    x: node.position.x + (side === "output" ? WORKFLOW_NODE_WIDTH : 0),
    y: node.position.y + WORKFLOW_NODE_HEIGHT / 2
  };
}

export function workflowEdgePath(sourceNode, targetNode) {
  const source = nodePort(sourceNode, "output");
  const target = nodePort(targetNode, "input");
  const horizontal = Math.abs(target.x - source.x);
  const bend = Math.max(72, Math.min(220, horizontal * 0.52));
  if (target.x >= source.x) {
    return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${target.x - bend} ${target.y}, ${target.x} ${target.y}`;
  }
  const loop = Math.max(82, Math.abs(target.y - source.y) * 0.45);
  return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${source.x + bend} ${source.y + loop}, ${source.x} ${source.y + loop} S ${target.x - bend} ${target.y - loop}, ${target.x} ${target.y}`;
}

export function graphBounds(graph) {
  if (!graph?.nodes?.length) return { x: 0, y: 0, width: 800, height: 500 };
  const xs = graph.nodes.map((node) => node.position.x);
  const ys = graph.nodes.map((node) => node.position.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs) + WORKFLOW_NODE_WIDTH;
  const bottom = Math.max(...ys) + WORKFLOW_NODE_HEIGHT;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fitWorkflowViewport(graph, width, height, padding = 84) {
  const bounds = graphBounds(graph);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const zoom = Math.max(0.35, Math.min(1.2, Math.min(availableWidth / bounds.width, availableHeight / bounds.height)));
  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom
  };
}

export function nextNodePosition(graph, viewport, canvasSize) {
  const center = {
    x: (canvasSize.width / 2 - viewport.x) / viewport.zoom,
    y: (canvasSize.height / 2 - viewport.y) / viewport.zoom
  };
  const offset = (graph.nodes.length % 5) * 28;
  return {
    x: Math.round(center.x - WORKFLOW_NODE_WIDTH / 2 + offset),
    y: Math.round(center.y - WORKFLOW_NODE_HEIGHT / 2 + offset)
  };
}

export function parseWorkflowInput(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Workflow input must be valid JSON: ${error.message}`);
  }
}

export function stringifyWorkflowValue(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function workflowStatusLabel(status) {
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "cancelling") return "Stopping";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Idle";
}
