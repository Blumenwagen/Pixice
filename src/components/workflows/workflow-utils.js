export const WORKFLOW_NODE_WIDTH = 210;
export const WORKFLOW_NODE_HEIGHT = 118;

const commonInput = [{ id: "input", label: "Input" }];
const agentInputs = [{ id: "input", label: "Input" }, { id: "skill", label: "Skill" }];
const commonOutput = [{ id: "output", label: "Output" }];

export const WORKFLOW_NODE_META = {
  manualTrigger: {
    label: "Manual Trigger",
    action: "Start workflow",
    category: "Triggers",
    icon: "lightning",
    tone: "violet",
    defaultName: "Manual trigger",
    defaultDescription: "Start with input supplied by the user or calling agent.",
    defaultConfig: {},
    inputPorts: [],
    outputPorts: commonOutput
  },
  scheduleTrigger: {
    label: "Schedule Trigger",
    action: "Run on time",
    category: "Triggers",
    icon: "gauge",
    tone: "violet",
    defaultName: "Schedule",
    defaultDescription: "Run automatically on an interval or cron schedule while Pixice is open.",
    defaultConfig: {
      mode: "interval",
      every: 15,
      unit: "minutes",
      cron: "0 * * * *",
      runOnStartup: false,
      overlapPolicy: "skip"
    },
    inputPorts: [],
    outputPorts: [{ id: "output", label: "Schedule" }]
  },
  webhookTrigger: {
    label: "Local Webhook",
    action: "Receive request",
    category: "Triggers",
    icon: "plugs",
    tone: "violet",
    defaultName: "Local webhook",
    defaultDescription: "Receive a loopback-only HTTP request on 127.0.0.1.",
    defaultConfig: {
      method: "POST",
      port: 5679,
      path: "/hook",
      responseMode: "immediate",
      timeoutMs: 30000,
      authCredentialId: null,
      maxBytes: 1000000
    },
    inputPorts: [],
    outputPorts: [{ id: "output", label: "Request" }]
  },
  useSkill: {
    label: "Use Skill",
    action: "Attach instructions",
    category: "Pixice",
    icon: "skill",
    tone: "orange",
    defaultName: "Use Skill",
    defaultDescription: "Attach an installed Skill or project Markdown instructions directly to a Pixice Agent.",
    defaultConfig: {
      source: "installed",
      skillRef: "",
      skillName: "",
      path: "",
      maxBytes: 500000
    },
    inputPorts: [],
    outputPorts: [{ id: "skill", label: "Skill" }]
  },
  loomAgent: {
    label: "Pixice Agent",
    action: "Run agent",
    category: "Pixice",
    icon: "brain",
    tone: "orange",
    defaultName: "Pixice Agent",
    defaultDescription: "Run a Pixice-native coding agent with upstream workflow context and attached Skills.",
    defaultConfig: {
      prompt: "Complete the workflow task using the incoming context.",
      model: null,
      effort: null,
      permissionMode: "workspace-write",
      executionMode: "background"
    },
    inputPorts: agentInputs,
    outputPorts: [{ id: "output", label: "Answer" }]
  },
  httpRequest: {
    label: "HTTP Request",
    action: "Call API",
    category: "Actions",
    icon: "globe",
    tone: "blue",
    defaultName: "HTTP Request",
    defaultDescription: "Call an HTTP or HTTPS API with upstream workflow data.",
    defaultConfig: {
      method: "GET",
      url: "https://example.com/api",
      headers: "{}",
      query: "{}",
      bodyMode: "json",
      body: "{}",
      responseType: "auto",
      failOnHttpError: true,
      timeoutMs: 30000,
      maxBytes: 5000000,
      credentialId: null
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Response" }]
  },
  file: {
    label: "Project File",
    action: "Read or write",
    category: "Actions",
    icon: "file",
    tone: "blue",
    defaultName: "Project file",
    defaultDescription: "Read, inspect, list, or explicitly write a project-scoped file.",
    defaultConfig: {
      operation: "readText",
      path: "README.md",
      content: "{{input}}",
      createDirectories: true,
      recursive: false,
      allowWrite: false,
      maxBytes: 5000000
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Result" }]
  },
  git: {
    label: "Git",
    action: "Inspect repository",
    category: "Actions",
    icon: "git",
    tone: "green",
    defaultName: "Git status",
    defaultDescription: "Inspect Git status, diffs, changed files, history, or a commit.",
    defaultConfig: { operation: "status", target: "HEAD", pathspec: "", staged: false, maxEntries: 20 },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Git data" }]
  },
  database: {
    label: "SQLite",
    action: "Query database",
    category: "Actions",
    icon: "database",
    tone: "green",
    defaultName: "SQLite query",
    defaultDescription: "Query or explicitly mutate a project-scoped SQLite database.",
    defaultConfig: {
      operation: "query",
      databasePath: "data.sqlite",
      sql: "SELECT 1 AS value",
      parameters: "[]",
      allowWrite: false,
      maxRows: 1000
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Rows" }]
  },
  executeWorkflow: {
    label: "Execute Workflow",
    action: "Run subworkflow",
    category: "Actions",
    icon: "workflow",
    tone: "green",
    defaultName: "Execute workflow",
    defaultDescription: "Run another Pixice workflow and wait for its result.",
    defaultConfig: {
      workflowId: "",
      input: "{{input}}",
      returnMode: "output",
      continueOnError: false,
      timeoutMs: 300000
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Result" }]
  },
  notification: {
    label: "Desktop Notification",
    action: "Notify user",
    category: "Actions",
    icon: "bell",
    tone: "blue",
    defaultName: "Desktop notification",
    defaultDescription: "Show a native notification from deterministic workflow data.",
    defaultConfig: {
      title: "Pixice workflow",
      body: "{{input.message ?? input}}",
      urgency: "normal",
      silent: false
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Notification" }]
  },
  transform: {
    label: "Transform",
    action: "Map data",
    category: "Data",
    icon: "sparkle",
    tone: "pink",
    defaultName: "Transform data",
    defaultDescription: "Create typed JSON or text from workflow expressions.",
    defaultConfig: {
      mode: "json",
      template: "{\n  \"value\": \"{{input}}\"\n}",
      mergeInput: false
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Value" }]
  },
  aggregate: {
    label: "Aggregate",
    action: "Collect data",
    category: "Data",
    icon: "stack",
    tone: "pink",
    defaultName: "Aggregate data",
    defaultDescription: "Collect, count, calculate, group, deduplicate, or merge array values.",
    defaultConfig: { source: "{{input}}", operation: "collect", field: "", groupBy: "" },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Aggregate" }]
  },
  condition: {
    label: "Condition",
    action: "If / else",
    category: "Flow",
    icon: "branch",
    tone: "yellow",
    defaultName: "Condition",
    defaultDescription: "Route data through the true or false branch.",
    defaultConfig: { left: "{{input}}", operator: "isTrue", right: "" },
    inputPorts: commonInput,
    outputPorts: [{ id: "true", label: "True" }, { id: "false", label: "False" }]
  },
  switch: {
    label: "Switch",
    action: "Route cases",
    category: "Flow",
    icon: "tree",
    tone: "yellow",
    defaultName: "Switch",
    defaultDescription: "Route data to the first matching named case.",
    defaultConfig: {
      value: "{{input}}",
      rules: [{ id: "case-1", label: "Case 1", operator: "equals", compare: "value" }]
    },
    inputPorts: commonInput
  },
  merge: {
    label: "Merge",
    action: "Join branches",
    category: "Flow",
    icon: "stack",
    tone: "green",
    defaultName: "Merge branches",
    defaultDescription: "Join active values from parallel or conditional branches.",
    defaultConfig: { mode: "array" },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Merged" }]
  },
  delay: {
    label: "Delay",
    action: "Wait",
    category: "Flow",
    icon: "gauge",
    tone: "neutral",
    defaultName: "Delay",
    defaultDescription: "Wait for a configured duration before continuing.",
    defaultConfig: { amount: 1, unit: "seconds" },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Continue" }]
  },
  loop: {
    label: "Loop / Batch",
    action: "Process items",
    category: "Flow",
    icon: "refresh",
    tone: "yellow",
    defaultName: "Loop items",
    defaultDescription: "Run another workflow for every item or batch with bounded concurrency.",
    defaultConfig: {
      workflowId: "",
      source: "{{input}}",
      mode: "items",
      batchSize: 10,
      concurrency: 1,
      input: "{{item}}",
      continueOnError: false,
      timeoutMs: 300000
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Results" }]
  },
  board: {
    label: "Pixice Board",
    action: "Manage task",
    category: "Pixice",
    icon: "list",
    tone: "orange",
    defaultName: "Pixice Board",
    defaultDescription: "List, create, update, move, or delete a durable Pixice task.",
    defaultConfig: {
      operation: "list",
      taskId: "",
      title: "{{input.title ?? input}}",
      description: "{{input.description ?? ''}}",
      column: "backlog",
      beforeTaskId: "",
      attachSourceThread: false
    },
    inputPorts: commonInput,
    outputPorts: [{ id: "output", label: "Task data" }]
  },
  output: {
    label: "Output",
    action: "Return value",
    category: "Flow",
    icon: "code",
    tone: "blue",
    defaultName: "Workflow output",
    defaultDescription: "Expose the final value returned by this workflow.",
    defaultConfig: {},
    inputPorts: commonInput,
    outputPorts: []
  }
};

export const WORKFLOW_NODE_CATEGORIES = ["Triggers", "Actions", "Data", "Flow", "Pixice"];

export function workflowId(prefix = "workflow") {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function cloneWorkflow(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

export function workflowInputPorts(node) {
  return WORKFLOW_NODE_META[node.type]?.inputPorts ?? [];
}

export function workflowOutputPorts(node) {
  if (node.type === "switch") {
    const rules = Array.isArray(node.config?.rules) ? node.config.rules : [];
    return [
      ...rules.slice(0, 8).map((rule, index) => ({
        id: String(rule.id || `case-${index + 1}`),
        label: String(rule.label || `Case ${index + 1}`)
      })),
      { id: "default", label: "Default" }
    ];
  }
  return WORKFLOW_NODE_META[node.type]?.outputPorts ?? [];
}

export function workflowCanConnect(sourceNode, sourcePort, targetNode, targetPort) {
  const isSkillConnection = sourceNode?.type === "useSkill" || sourcePort === "skill" || targetPort === "skill";
  if (isSkillConnection) {
    return sourceNode?.type === "useSkill"
      && sourcePort === "skill"
      && targetNode?.type === "loomAgent"
      && targetPort === "skill";
  }
  return Boolean(sourceNode && targetNode);
}

export function workflowNodeHeight(node) {
  const ports = Math.max(workflowInputPorts(node).length, workflowOutputPorts(node).length);
  return Math.max(WORKFLOW_NODE_HEIGHT, 54 + ports * 26);
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
    config: cloneWorkflow(meta.defaultConfig)
  };
}

export function createWorkflowEdge(source, target, sourcePort = "output", targetPort = "input") {
  return {
    id: workflowId("edge"),
    source,
    target,
    sourcePort,
    targetPort
  };
}

export function nodePort(node, side, portId = side === "output" ? "output" : "input") {
  const ports = side === "output" ? workflowOutputPorts(node) : workflowInputPorts(node);
  const index = Math.max(0, ports.findIndex((port) => port.id === portId));
  const height = workflowNodeHeight(node);
  const y = ports.length <= 1
    ? height / 2
    : 22 + index * ((height - 44) / Math.max(1, ports.length - 1));
  return {
    x: node.position.x + (side === "output" ? WORKFLOW_NODE_WIDTH : 0),
    y: node.position.y + y
  };
}

export function workflowEdgePath(sourceNode, targetNode, sourcePort = "output", targetPort = "input") {
  const source = nodePort(sourceNode, "output", sourcePort);
  const target = nodePort(targetNode, "input", targetPort);
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
  const right = Math.max(...graph.nodes.map((node) => node.position.x + WORKFLOW_NODE_WIDTH));
  const bottom = Math.max(...graph.nodes.map((node) => node.position.y + workflowNodeHeight(node)));
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
  if (status === "skipped") return "Skipped";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Idle";
}
