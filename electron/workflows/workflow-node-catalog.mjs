import { WORKFLOW_CONDITION_OPERATORS } from "./workflow-values.mjs";

export const WORKFLOW_NODE_TYPES = [
  "manualTrigger",
  "scheduleTrigger",
  "webhookTrigger",
  "useSkill",
  "loomAgent",
  "output",
  "httpRequest",
  "transform",
  "aggregate",
  "condition",
  "switch",
  "merge",
  "delay",
  "loop",
  "file",
  "command",
  "git",
  "database",
  "executeWorkflow",
  "notification",
  "board"
];

export const WORKFLOW_TRIGGER_NODE_TYPES = ["manualTrigger", "scheduleTrigger", "webhookTrigger"];
export const WORKFLOW_ATTACHMENT_NODE_TYPES = ["useSkill"];
export const WORKFLOW_PERMISSION_MODES = ["read-only", "workspace-write", "auto-approve", "full-access"];
export const WORKFLOW_AGENT_EXECUTION_MODES = ["background", "foreground"];
export const WORKFLOW_CREDENTIAL_TYPES = ["bearer", "basic", "apiKey", "headers"];

const DEFAULT_CONFIGS = {
  manualTrigger: {},
  scheduleTrigger: {
    mode: "interval",
    every: 15,
    unit: "minutes",
    cron: "0 * * * *",
    runOnStartup: false,
    overlapPolicy: "skip"
  },
  webhookTrigger: {
    method: "POST",
    port: 5679,
    path: "/hook",
    responseMode: "immediate",
    timeoutMs: 30_000,
    authCredentialId: null,
    maxBytes: 1_000_000
  },
  useSkill: {
    source: "installed",
    skillRef: "",
    skillName: "",
    path: "",
    maxBytes: 500_000
  },
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
    maxBytes: 5_000_000,
    credentialId: null
  },
  transform: {
    mode: "json",
    template: "{\n  \"value\": \"{{input}}\"\n}",
    mergeInput: false
  },
  aggregate: {
    source: "{{input}}",
    operation: "collect",
    field: "",
    groupBy: ""
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
  loop: {
    workflowId: "",
    source: "{{input}}",
    mode: "items",
    batchSize: 10,
    concurrency: 1,
    input: "{{item}}",
    continueOnError: false,
    timeoutMs: 300_000
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
  command: {
    executable: "",
    arguments: "[]",
    workingDirectory: ".",
    environment: "{}",
    allowExecution: false,
    continueOnError: false,
    timeoutMs: 300_000,
    maxBytes: 5_000_000
  },
  git: {
    operation: "status",
    target: "HEAD",
    pathspec: "",
    staged: false,
    maxEntries: 20
  },
  database: {
    operation: "query",
    databasePath: "data.sqlite",
    sql: "SELECT 1 AS value",
    parameters: "[]",
    allowWrite: false,
    maxRows: 1_000
  },
  executeWorkflow: {
    workflowId: "",
    input: "{{input}}",
    returnMode: "output",
    continueOnError: false,
    timeoutMs: 300_000
  },
  notification: {
    title: "Pixice workflow",
    body: "{{input.message ?? input}}",
    urgency: "normal",
    silent: false
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

function integerValue(value, fallback, minimum, maximum) {
  return Math.round(finiteNumber(value, fallback, minimum, maximum));
}

function enumValue(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function strictEnumValue(value, values, fallback, label, node) {
  if (value === undefined || value === null || value === "") return fallback;
  if (values.includes(value)) return value;
  throw new Error(`${node.name || node.id} has an invalid ${label}: ${value}`);
}

function nullableIdentifier(value) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  return normalized || null;
}

function webhookPath(value) {
  let normalized = stringValue(value, "/hook").trim() || "/hook";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  normalized = normalized.split(/[?#]/, 1)[0].replace(/\/{2,}/g, "/");
  if (normalized.includes("..")) throw new Error("Webhook paths cannot contain .. segments");
  return normalized.slice(0, 240) || "/hook";
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
  if (node.type === "scheduleTrigger") {
    return {
      ...source,
      mode: enumValue(source.mode, ["interval", "cron"], "interval"),
      every: integerValue(source.every, 15, 1, 86_400),
      unit: enumValue(source.unit, ["seconds", "minutes", "hours", "days"], "minutes"),
      cron: stringValue(source.cron, "0 * * * *").trim().slice(0, 200) || "0 * * * *",
      runOnStartup: Boolean(source.runOnStartup),
      overlapPolicy: enumValue(source.overlapPolicy, ["skip", "allow"], "skip")
    };
  }
  if (node.type === "webhookTrigger") {
    return {
      ...source,
      method: enumValue(String(source.method ?? "POST").toUpperCase(), ["GET", "POST", "PUT", "PATCH", "DELETE"], "POST"),
      port: integerValue(source.port, 5_679, 1_024, 65_535),
      path: webhookPath(source.path),
      responseMode: enumValue(source.responseMode, ["immediate", "workflow"], "immediate"),
      timeoutMs: integerValue(source.timeoutMs, 30_000, 100, 300_000),
      authCredentialId: nullableIdentifier(source.authCredentialId),
      maxBytes: integerValue(source.maxBytes, 1_000_000, 1_024, 25_000_000)
    };
  }
  if (node.type === "useSkill") {
    return {
      ...source,
      source: enumValue(source.source, ["installed", "markdown"], "installed"),
      skillRef: stringValue(source.skillRef, "").trim().slice(0, 2_000),
      skillName: stringValue(source.skillName, "").trim().slice(0, 240),
      path: stringValue(source.path, "").trim().slice(0, 2_000),
      maxBytes: integerValue(source.maxBytes, 500_000, 1_024, 2_000_000)
    };
  }
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
      timeoutMs: integerValue(source.timeoutMs, 30_000, 100, 300_000),
      maxBytes: integerValue(source.maxBytes, 5_000_000, 1_024, 25_000_000),
      credentialId: nullableIdentifier(source.credentialId)
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
  if (node.type === "aggregate") {
    return {
      ...source,
      source: stringValue(source.source, "{{input}}"),
      operation: enumValue(source.operation, ["collect", "count", "sum", "average", "min", "max", "groupBy", "unique", "mergeObjects"], "collect"),
      field: stringValue(source.field, "").trim(),
      groupBy: stringValue(source.groupBy, "").trim()
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
  if (node.type === "loop") {
    return {
      ...source,
      workflowId: stringValue(source.workflowId, "").trim().slice(0, 160),
      source: stringValue(source.source, "{{input}}"),
      mode: enumValue(source.mode, ["items", "batches"], "items"),
      batchSize: integerValue(source.batchSize, 10, 1, 1_000),
      concurrency: integerValue(source.concurrency, 1, 1, 10),
      input: stringValue(source.input, "{{item}}"),
      continueOnError: Boolean(source.continueOnError),
      timeoutMs: integerValue(source.timeoutMs, 300_000, 100, 3_600_000)
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
      maxBytes: integerValue(source.maxBytes, 5_000_000, 1_024, 25_000_000)
    };
  }
  if (node.type === "command") {
    return {
      ...source,
      executable: stringValue(source.executable, ""),
      arguments: stringValue(source.arguments, "[]"),
      workingDirectory: stringValue(source.workingDirectory, ".").trim() || ".",
      environment: stringValue(source.environment, "{}"),
      allowExecution: Boolean(source.allowExecution),
      continueOnError: Boolean(source.continueOnError),
      timeoutMs: integerValue(source.timeoutMs, 300_000, 100, 3_600_000),
      maxBytes: integerValue(source.maxBytes, 5_000_000, 1_024, 25_000_000)
    };
  }
  if (node.type === "git") {
    return {
      ...source,
      operation: enumValue(source.operation, ["status", "diff", "log", "show", "changedFiles"], "status"),
      target: stringValue(source.target, "HEAD"),
      pathspec: stringValue(source.pathspec, ""),
      staged: Boolean(source.staged),
      maxEntries: integerValue(source.maxEntries, 20, 1, 100)
    };
  }
  if (node.type === "database") {
    return {
      ...source,
      operation: enumValue(source.operation, ["query", "execute"], "query"),
      databasePath: stringValue(source.databasePath, "data.sqlite").trim() || "data.sqlite",
      sql: stringValue(source.sql, DEFAULT_CONFIGS.database.sql),
      parameters: stringValue(source.parameters, "[]"),
      allowWrite: Boolean(source.allowWrite),
      maxRows: integerValue(source.maxRows, 1_000, 1, 10_000)
    };
  }
  if (node.type === "executeWorkflow") {
    return {
      ...source,
      workflowId: stringValue(source.workflowId, "").trim().slice(0, 160),
      input: stringValue(source.input, "{{input}}"),
      returnMode: enumValue(source.returnMode, ["output", "run"], "output"),
      continueOnError: Boolean(source.continueOnError),
      timeoutMs: integerValue(source.timeoutMs, 300_000, 100, 3_600_000)
    };
  }
  if (node.type === "notification") {
    return {
      ...source,
      title: stringValue(source.title, "Pixice workflow").slice(0, 240),
      body: stringValue(source.body, "{{input.message ?? input}}").slice(0, 10_000),
      urgency: enumValue(source.urgency, ["low", "normal", "critical"], "normal"),
      silent: Boolean(source.silent)
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
  if (workflowNodeIsTrigger(node) || workflowNodeIsAttachment(node)) return [];
  if (node.type === "loomAgent") return ["input", "skill"];
  return ["input"];
}

export function workflowNodeOutputPorts(node) {
  if (node.type === "output") return [];
  if (node.type === "useSkill") return ["skill"];
  if (node.type === "condition") return ["true", "false"];
  if (node.type === "switch") return [...normalizeWorkflowNodeConfig(node).rules.map((rule) => rule.id), "default"];
  return ["output"];
}

export function workflowNodeIsTrigger(node) {
  return WORKFLOW_TRIGGER_NODE_TYPES.includes(node.type);
}

export function workflowNodeIsAttachment(node) {
  return WORKFLOW_ATTACHMENT_NODE_TYPES.includes(node.type);
}
