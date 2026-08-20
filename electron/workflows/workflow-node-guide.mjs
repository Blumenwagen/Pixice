export const WORKFLOW_NODE_GUIDE = [
  {
    type: "manualTrigger",
    purpose: "Start a workflow manually with input supplied by the user or calling agent.",
    inputPorts: [], outputPorts: ["output"], config: {}
  },
  {
    type: "scheduleTrigger",
    purpose: "Run an enabled workflow automatically on an interval or five-field cron schedule while Loom is running.",
    inputPorts: [], outputPorts: ["output"],
    config: {
      mode: "interval | cron", every: "Positive integer", unit: "seconds | minutes | hours | days",
      cron: "Five fields: minute hour day month weekday", runOnStartup: "Boolean", overlapPolicy: "skip | allow"
    }
  },
  {
    type: "webhookTrigger",
    purpose: "Expose an enabled workflow through a loopback-only HTTP webhook on 127.0.0.1.",
    inputPorts: [], outputPorts: ["output"],
    config: {
      method: "GET | POST | PUT | PATCH | DELETE", port: "1024-65535", path: "Absolute local path",
      responseMode: "immediate | workflow", timeoutMs: "100-300000", authCredentialId: "Reusable credential id or null",
      maxBytes: "1024-25000000"
    }
  },
  {
    type: "loomAgent",
    purpose: "Run a real Loom Agent and pass its final answer downstream.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: {
      prompt: "Template text; upstream values are appended as structured context.",
      model: "Qualified or provider model id, or null for project default.", effort: "Reasoning effort or null.",
      permissionMode: "read-only | workspace-write | auto-approve | full-access", executionMode: "background | foreground"
    }
  },
  {
    type: "httpRequest",
    purpose: "Call an HTTP or HTTPS API with templates and an optional encrypted reusable credential.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: {
      method: "GET | POST | PUT | PATCH | DELETE | HEAD", url: "URL template", headers: "JSON template",
      query: "JSON template", bodyMode: "json | text | none", body: "JSON or text template",
      responseType: "auto | json | text", failOnHttpError: "Boolean", timeoutMs: "100-300000",
      maxBytes: "1024-25000000", credentialId: "Reusable credential id or null"
    }
  },
  {
    type: "transform",
    purpose: "Build deterministic JSON or text from typed workflow expressions.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { mode: "json | text", template: "JSON or text template", mergeInput: "Boolean" }
  },
  {
    type: "aggregate",
    purpose: "Collect, count, calculate, group, deduplicate, or merge an array without using an agent.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: {
      source: "Array expression", operation: "collect | count | sum | average | min | max | groupBy | unique | mergeObjects",
      field: "Optional field path selected from every item", groupBy: "Field path used by groupBy"
    }
  },
  {
    type: "condition",
    purpose: "Route data through true or false based on a typed comparison.",
    inputPorts: ["input"], outputPorts: ["true", "false"],
    config: { left: "Value template", operator: "Call describe_nodes for operators", right: "Value template" }
  },
  {
    type: "switch",
    purpose: "Route data through the first matching named case or the default port.",
    inputPorts: ["input"], outputPorts: "One port per rules[].id plus default",
    config: { value: "Value template", rules: [{ id: "success", label: "Success", operator: "equals", compare: "ok" }] }
  },
  {
    type: "merge",
    purpose: "Join active branches after conditions or parallel work.",
    inputPorts: ["input"], outputPorts: ["output"], config: { mode: "array | object | keyed | concatenate | first | last" }
  },
  {
    type: "delay",
    purpose: "Wait without blocking the UI, while remaining cancellable.",
    inputPorts: ["input"], outputPorts: ["output"], config: { amount: "Number", unit: "milliseconds | seconds | minutes | hours" }
  },
  {
    type: "loop",
    purpose: "Run another workflow once per item or batch with bounded concurrency and ordered results.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: {
      workflowId: "Target workflow id", source: "Array expression", mode: "items | batches", batchSize: "1-1000",
      concurrency: "1-10", input: "Template with item/index/batch/batchIndex/items", continueOnError: "Boolean", timeoutMs: "Per iteration timeout"
    }
  },
  {
    type: "file",
    purpose: "Read, inspect, list, or explicitly write project-scoped files.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { operation: "readText | writeText | list | stat | exists", path: "Project-relative template", content: "Write template", allowWrite: "Boolean", createDirectories: "Boolean", recursive: "Boolean", maxBytes: "Limit" }
  },
  {
    type: "git",
    purpose: "Inspect repository status, diffs, changed files, history, or a commit without invoking a shell.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { operation: "status | diff | changedFiles | log | show", target: "Git ref template", pathspec: "Optional path", staged: "Boolean", maxEntries: "1-100" }
  },
  {
    type: "database",
    purpose: "Query or explicitly mutate a project-scoped SQLite database using parameter binding.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { operation: "query | execute", databasePath: "Project-relative .sqlite path", sql: "SQL template", parameters: "JSON array or object template", allowWrite: "Required for execute", maxRows: "1-10000" }
  },
  {
    type: "executeWorkflow",
    purpose: "Run another workflow, wait for it, and return its output or run record.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { workflowId: "Target workflow id", input: "Input template", returnMode: "output | run", continueOnError: "Boolean", timeoutMs: "100-3600000" }
  },
  {
    type: "notification",
    purpose: "Show a native desktop notification from deterministic workflow data.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { title: "Template", body: "Template", urgency: "low | normal | critical", silent: "Boolean" }
  },
  {
    type: "board",
    purpose: "List, create, edit, move, or delete durable tasks on the current Loom board.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { operation: "list | create | update | move | delete", taskId: "Task id template", title: "Title template", description: "Description template", column: "backlog | ready | active | done", beforeTaskId: "Optional", attachSourceThread: "Boolean" }
  },
  {
    type: "output",
    purpose: "Expose the final active value as the workflow result.",
    inputPorts: ["input"], outputPorts: [], config: {}
  }
];
