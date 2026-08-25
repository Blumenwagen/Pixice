export const WORKFLOW_NODE_GUIDE = [
  {
    type: "manualTrigger",
    purpose: "Start a workflow manually with input supplied by the user or calling agent.",
    inputPorts: [], outputPorts: ["output"], config: {}
  },
  {
    type: "scheduleTrigger",
    purpose: "Run an enabled workflow automatically on an interval or five-field cron schedule while Pixice is running.",
    inputPorts: [], outputPorts: ["output"],
    config: {
      mode: "interval | cron", every: "Positive integer", unit: "seconds | minutes | hours | days",
      cron: "Five fields: minute hour day month weekday", runOnStartup: "Boolean", overlapPolicy: "skip | allow"
    }
  },
  {
    type: "taskEventTrigger",
    purpose: "Run an enabled workflow only for work items with an explicit enabled binding to this workflow and event.",
    inputPorts: [], outputPorts: ["output"],
    config: {
      eventType: "planned-start-reached | deadline-approaching | entered-ready | dependencies-completed | became-overdue | schedule-changed",
      leadMinutes: "Minutes before a hard deadline for deadline-approaching"
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
    type: "useSkill",
    purpose: "Attach one installed Codex Skill or one project-scoped .md instruction file directly to a Pixice Agent. Multiple Use Skill nodes may connect to the same Agent Skill port.",
    inputPorts: [], outputPorts: ["skill"],
    connection: "Connect Use Skill · skill directly to Pixice Agent · skill. It is not a normal data edge.",
    config: {
      source: "installed | markdown", skillRef: "Stable installed-skill reference", skillName: "Display name",
      path: "Project-relative .md path when source is markdown", maxBytes: "1024-2000000"
    }
  },
  {
    type: "pixiceAgent",
    purpose: "Run a real Pixice Agent and pass its final answer downstream. Its dedicated Skill input accepts any number of Use Skill attachments.",
    inputPorts: ["input", "skill"], outputPorts: ["output"],
    config: {
      prompt: "Template text; ordinary upstream values are appended as structured context.",
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
    type: "command",
    purpose: "Run an explicitly enabled executable in the current project without invoking a shell.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: {
      executable: "Executable name from Pixice PATH, or project-relative executable path",
      arguments: "JSON array template containing scalar arguments", workingDirectory: "Project-relative directory template",
      environment: "JSON object template containing environment overrides", allowExecution: "Required Boolean safety gate",
      continueOnError: "Boolean", timeoutMs: "100-3600000", maxBytes: "1024-25000000 combined output limit"
    }
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
    type: "planWork",
    purpose: "Build a deterministic, dependency-checked schedule and optionally save it as a reviewable Pixice plan proposal. This node never applies the proposal.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { plan: "Plan object or exact typed template", createProposal: "Boolean" }
  },
  {
    type: "board",
    purpose: "List, create, edit, move, or delete durable tasks on the current Pixice board.",
    inputPorts: ["input"], outputPorts: ["output"],
    config: { operation: "list | create | update | move | delete", taskId: "Task id template", title: "Title template", description: "Description template", column: "backlog | ready | active | done", kind: "task | milestone | event", priority: "low | normal | high | urgent", estimateMinutes: "Value template", owner: "String template", schedule: "Object template or null", dependencies: "Array template", beforeTaskId: "Optional", attachSourceThread: "Boolean" }
  },
  {
    type: "output",
    purpose: "Expose the final active value as the workflow result.",
    inputPorts: ["input"], outputPorts: [], config: {}
  }
];
