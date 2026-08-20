import { WORKFLOW_CONDITION_OPERATORS } from "./workflow-values.mjs";

export const WORKFLOW_NODE_TYPES = [
  "manualTrigger",
  "loomAgent",
  "output",
  "httpRequest",
  "transform",
  "condition",
  "switch",
  "merge",
  "delay",
  "file",
  "git",
  "board"
];

export const WORKFLOW_TRIGGER_NODE_TYPES = ["manualTrigger"];
export const WORKFLOW_PERMISSION_MODES = ["read-only", "workspace-write", "auto-approve", "full-access"];
export const WORKFLOW_AGENT_EXECUTION_MODES = ["background", "foreground"];

const DEFAULT_CONFIGS = {
  manualTrigger: {},
  loomAgent: {
    prompt: "Complete the workflow task using the incoming context.",
    model: null,
    effort: null,
    permissionMode: "workspace-write",
    executionMode: "background"
  },
  output: {},
  httpRequest: {
    method: "GET",
    url: "https://example.com/api",
    headers: "{}",
    query: "{}",
    bodyMode: "json",
    body: "{}",
    responseType: "auto",
    failOnHttpError: true,
    timeoutMs: 30_000,
    maxBytes: 5_000_000
  },
  transform: {
    mode: "json",
    template: "{\n  \"value\": \"{{input}}\"\n}",
    mergeInput: false
  },
  condition: {
    left: "{{input}}",
    operator: "isTrue",
    right: ""
  },
  switch: {
    value: "{{input}}",
    rules: [
      { id: "case-1", label: "Case 1", operator: "equals", compare: "value" }
    ]
  },
  merge: {
    mode: "array"
  },
  delay: {
    amount: 1,
    unit: "seconds"
  },
  file: {
    operation: "readText",
    path: "README.md",
    content: "{{input}}",
    createDirectories: true,
    recursive: false,
    allowWrite: false,
    maxBytes: 5_000_000
  },
  git: {
    operation: "status",
    target: "HEAD",
    pathspec: "",
    staged: false,
    maxEntries: 20
  },
  board: {
    operation: "list",
    taskId: "",
    title: "{{input.title ?? input}}",
    description: "{{input.description ?? ''}}",
    column: "backlog",
    beforeTaskId: "",
    attachSourceThread: false
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function enumValue(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function strictEnumValue(value, values, fallback, label, node) {
  if (value === undefined || value === null || value === "") return fallback;
  if (values.includes(value)) return value;
  throw new Error(`${node.name || node.id} has an invalid ${label}: ${value}`);
}

function switchRules(value, node) {
  if (!Array.isArray(value)) return clone(DEFAULT_CONFIGS.switch.rules);
  const seen = new Set();
  return value.slice(0, 8).map((rule, index) => {
    const rawId = stringValue(rule?.id, `case-${index + 1}`).trim().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || `case-${index + 1}`;
    let id = rawId;
    let suffix = 2;
    while (seen.has(id) || id === "default" || id === "output") {
      id = `${rawId}-${suffix}`.slice(0, 80);
      suffix += 1;
    }
    seen.add(id);
    return {
      id,
      label: stringValue(rule?.label, `Case ${index + 1}`).trim().slice(0, 120) || `Case ${index + 1}`,
      operator: strictEnumValue(rule?.operator, WORKFLOW_CONDITION_OPERATORS, "equals", "switch operator", node),
      compare: stringValue(rule?.compare, "")
    };
  });
}

export function defaultWorkflowNodeConfig(type) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIGS, type)) throw new Error(`Unknown workflow node type: ${type}`);
  return clone(DEFAULT_CONFIGS[type]);
}

export function normalizeWorkflowNodeConfig(node) {
  const source = { ...defaultWorkflowNodeConfig(node.type), ...(node.config ?? {}) };
  if (node.type === "loomAgent") {
    return {
      ...source,
      prompt: stringValue(source.prompt, DEFAULT_CONFIGS.loomAgent.prompt),
      model: source.model ? String(source.model) : null,
      effort: source.effort ? String(source.effort) : null,
      permissionMode: strictEnumValue(source.permissionMode, WORKFLOW_PERMISSION_MODES, "workspace-write", "permission mode", node),
      executionMode: strictEnumValue(source.executionMode, WORKFLOW_AGENT_EXECUTION_MODES, "background", "execution mode", node)
    };
  }
  if (node.type === "httpRequest") {
    return {
      ...source,
      method: enumValue(String(source.method ?? "GET").toUpperCase(), ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "GET"),
      url: stringValue(source.url, DEFAULT_CONFIGS.httpRequest.url),
      headers: stringValue(source.headers, "{}"),
      query: stringValue(source.query, "{}"),
      bodyMode: enumValue(source.bodyMode, ["json", "text", "none"], "json"),
      body: stringValue(source.body, "{}"),
      responseType: enumValue(source.responseType, ["auto", "json", "text"], "auto"),
      failOnHttpError: source.failOnHttpError !== false,
      timeoutMs: finiteNumber(source.timeoutMs, 30_000, 100, 300_000),
      maxBytes: finiteNumber(source.maxBytes, 5_000_000, 1_024, 25_000_000)
    };
  }
  if (node.type === "transform") {
    return {
      ...source,
      mode: enumValue(source.mode, ["json", "text"], "json"),
      template: stringValue(source.template, DEFAULT_CONFIGS.transform.template),
      mergeInput: Boolean(source.mergeInput)
    };
  }
  if (node.type === "condition") {
    return {
      ...source,
      left: stringValue(source.left, "{{input}}"),
      operator: strictEnumValue(source.operator, WORKFLOW_CONDITION_OPERATORS, "isTrue", "condition operator", node),
      right: stringValue(source.right, "")
    };
  }
  if (node.type === "switch") {
    return {
      ...source,
      value: stringValue(source.value, "{{input}}"),
      rules: switchRules(source.rules, node)
    };
  }
  if (node.type === "merge") {
    return { ...source, mode: enumValue(source.mode, ["array", "object", "keyed", "concatenate", "first", "last"], "array") };
  }
  if (node.type === "delay") {
    return {
      ...source,
      amount: finiteNumber(source.amount, 1, 0, 86_400),
      unit: enumValue(source.unit, ["milliseconds", "seconds", "minutes", "hours"], "seconds")
    };
  }
  if (node.type === "file") {
    return {
      ...source,
      operation: enumValue(source.operation, ["readText", "writeText", "list", "stat", "exists"], "readText"),
      path: stringValue(source.path, "README.md"),
      content: stringValue(source.content, "{{input}}"),
      createDirectories: source.createDirectories !== false,
      recursive: Boolean(source.recursive),
      allowWrite: Boolean(source.allowWrite),
      maxBytes: finiteNumber(source.maxBytes, 5_000_000, 1_024, 25_000_000)
    };
  }
  if (node.type === "git") {
    return {
      ...source,
      operation: enumValue(source.operation, ["status", "diff", "log", "show", "changedFiles"], "status"),
      target: stringValue(source.target, "HEAD"),
      pathspec: stringValue(source.pathspec, ""),
      staged: Boolean(source.staged),
      maxEntries: finiteNumber(source.maxEntries, 20, 1, 100)
    };
  }
  if (node.type === "board") {
    return {
      ...source,
      operation: enumValue(source.operation, ["list", "create", "update", "move", "delete"], "list"),
      taskId: stringValue(source.taskId, ""),
      title: stringValue(source.title, DEFAULT_CONFIGS.board.title),
      description: stringValue(source.description, DEFAULT_CONFIGS.board.description),
      column: enumValue(source.column, ["backlog", "ready", "active", "done"], "backlog"),
      beforeTaskId: stringValue(source.beforeTaskId, ""),
      attachSourceThread: Boolean(source.attachSourceThread)
    };
  }
  return source;
}

export function workflowNodeInputPorts(node) {
  return node.type === "manualTrigger" ? [] : ["input"];
}

export function workflowNodeOutputPorts(node) {
  if (node.type === "output") return [];
  if (node.type === "condition") return ["true", "false"];
  if (node.type === "switch") return [...normalizeWorkflowNodeConfig(node).rules.map((rule) => rule.id), "default"];
  return ["output"];
}

export function workflowNodeIsTrigger(node) {
  return WORKFLOW_TRIGGER_NODE_TYPES.includes(node.type);
}
