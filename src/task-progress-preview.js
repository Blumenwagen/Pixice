const project = {
  id: "preview-project",
  displayName: "Pixice",
  canonicalPath: "/work/loom",
  repository: {
    kind: "git",
    root: "/work/loom",
    baseCommit: "preview",
    dirtyPaths: Array.from({ length: 31 }, (_, index) => `src/auth/file-${index + 1}.js`)
  }
};

const plan = [
  { step: "Analyze current flow", detail: "Lead", status: "completed" },
  { step: "Design cookie model", detail: "Lead", status: "completed" },
  { step: "Migrate backend", detail: "API migration", status: "completed" },
  { step: "Update client sessions", detail: "API migration", status: "inProgress" },
  { step: "Add fingerprinting", detail: "Session tests", status: "inProgress" },
  { step: "Verify and review", detail: "Lead", status: "pending" }
];

const rootThread = {
  id: "preview-task",
  name: "Refactor authentication flow",
  preview: "Refactor authentication flow",
  cwd: "/work/loom",
  parentThreadId: null,
  status: { type: "active" },
  updatedAt: Math.floor(Date.now() / 1000),
  turns: [{
    id: "preview-turn",
    status: "inProgress",
    items: [
      { id: "preview-user", type: "userMessage", content: [{ type: "text", text: "Refactor the authentication flow and keep the session migration safe." }] },
      { id: "preview-reasoning", type: "reasoning", summary: ["Coordinating the backend migration and client-session work in parallel."] }
    ]
  }]
};

const secondaryThread = {
  id: "preview-harness-task",
  name: "Build Pixice Codex harness",
  preview: "Build Pixice Codex harness",
  cwd: "/work/loom",
  parentThreadId: null,
  status: { type: "idle" },
  updatedAt: Math.floor(Date.now() / 1000) - 180,
  turns: []
};

const agents = [
  { id: "api-agent", parentThreadId: rootThread.id, name: "API migration", preview: "Update client sessions", status: "running", agentRole: "API migration", agentStatusMessage: "Updating client sessions" },
  { id: "test-agent", parentThreadId: rootThread.id, name: "Session tests", preview: "Add fingerprinting", status: "running", agentRole: "Session tests", agentStatusMessage: "Adding fingerprint coverage" },
  { id: "model-agent", parentThreadId: rootThread.id, name: "Cookie model", preview: "Design cookie model", status: "completed", agentRole: "Cookie model", agentStatusMessage: "Completed" }
];

const models = [
  {
    id: "gpt-5.6",
    model: "gpt-5.6",
    displayName: "GPT-5.6",
    isDefault: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
  },
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
  }
];

const extensions = {
  skills: [{ name: "Product Design", skills: [
    { id: "image-to-code", name: "Image to code", description: "Implement a selected visual reference as a responsive frontend." },
    { id: "design-qa", name: "Design QA", description: "Compare a rendered build with its source visual." }
  ] }],
  apps: [
    { id: "github", name: "GitHub", description: "Repository, pull request, and issue workflows." },
    { id: "posthog", name: "PostHog", description: "Product analytics and insight workflows." }
  ],
  mcp: [
    { id: "local-runtime", name: "Local runtime", description: "Pixice desktop project and task bridge.", authStatus: "available" }
  ],
  errors: []
};

const releaseToolDocument = {
  version: 1,
  title: "Release cockpit",
  description: "Review the release state, choose a target, and run the approved workflow.",
  parameters: {
    environment: { label: "Environment", description: "Where this release should run.", type: "select", required: true, options: [{ label: "Staging", value: "staging" }, { label: "Production", value: "production" }] },
    dryRun: { label: "Dry run", description: "Prepare the run without publishing.", type: "boolean", required: false, default: true }
  },
  state: { selectedTasks: [] },
  data: {
    release: { version: "0.1.0-beta.1", branch: "main", checks: 18, passing: 17 },
    tasks: [
      { id: "task-1", title: "Verify release notes", column: "done" },
      { id: "task-2", title: "Run desktop smoke test", column: "ready" },
      { id: "task-3", title: "Publish signed artifacts", column: "backlog" }
    ]
  },
  sources: {
    board: { capability: "board.list", arguments: {}, refresh: "event" },
    workflow: { capability: "workflow.output", arguments: { workflowId: "release-workflow" }, refresh: "event" }
  },
  sourceState: {
    board: { status: "ready", refreshedAt: "2026-08-23T09:30:00.000Z", error: null },
    workflow: { status: "ready", refreshedAt: "2026-08-23T09:30:00.000Z", error: null }
  },
  actions: {
    run: { type: "invokeCapability", capability: "workflow.run", arguments: { workflowId: "release-workflow", input: { environment: "$params.environment", dryRun: "$params.dryRun" } }, confirmation: "Run the release workflow with these inputs?" },
    move: { type: "invokeCapability", capability: "board.move", arguments: { taskId: "task-2", column: "done" }, confirmation: "Mark the desktop smoke test complete?" }
  },
  layout: {
    type: "stack",
    gap: "large",
    children: [
      { type: "grid", columns: 3, gap: "medium", children: [
        { type: "metric", label: "Version", value: "$data.release.version", format: "text" },
        { type: "metric", label: "Checks passing", value: 17, detail: "17 of 18", format: "number" },
        { type: "metric", label: "Target", value: "$params.environment", detail: "$params.dryRun", format: "text" }
      ] },
      { type: "card", title: "Release tasks", description: "Board state refreshes after matching Pixice events.", children: [
        { type: "table", columns: [{ key: "title", label: "Task" }, { key: "column", label: "Status" }], rows: "$data.tasks", selection: "selectedTasks", emptyLabel: "No release tasks" }
      ] },
      { type: "grid", columns: 2, gap: "small", children: [
        { type: "button", label: "Run release workflow", action: "run", variant: "primary" },
        { type: "button", label: "Complete smoke test", action: "move", variant: "secondary" }
      ] }
    ]
  }
};

const releaseTool = {
  id: "preview-release-tool",
  projectId: project.id,
  threadId: rootThread.id,
  lifecycle: "pinned",
  documentVersion: 3,
  document: releaseToolDocument,
  metadata: { name: "Release cockpit" },
  grants: ["workflow.run"],
  requestedCapabilities: ["board.move", "workflow.run"],
  usageCount: 7,
  lastError: null,
  status: "ready",
  createdAt: "2026-08-20T09:00:00.000Z",
  updatedAt: "2026-08-23T09:30:00.000Z",
  lastOpenedAt: "2026-08-23T09:30:00.000Z"
};

export function createTaskProgressPreviewApi() {
  let previewTools = [releaseTool];
  const threads = [rootThread, secondaryThread, ...agents];
  const browserState = {
    native: false,
    activeTabId: "preview-browser-tab",
    tabs: [{ id: "preview-browser-tab", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }]
  };
  return {
    app: { bootstrap: async () => ({ projects: [project], models, runtime: { state: "ready", connected: true, userAgent: "Preview runtime" } }) },
    runtime: { status: async () => ({ state: "ready", connected: true }) },
    updates: {
      status: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      check: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      download: async () => ({}),
      install: async () => ({ ok: true })
    },
    browser: {
      state: async () => browserState,
      create: async () => browserState,
      close: async () => browserState,
      activate: async () => browserState,
      navigate: async () => browserState,
      history: async () => browserState,
      setViewport: async () => browserState
    },
    files: {
      read: async ({ path }) => ({ path: `/work/loom/${path}`, relativePath: path, name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content: "# Pixice\n", editable: true, size: 7, mtimeMs: 1 }),
      write: async ({ path, content }) => ({ path, relativePath: path.replace("/work/loom/", ""), name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content, editable: true, size: content.length, mtimeMs: 2 })
    },
    instruments: {
      list: async () => ({ data: previewTools }),
      tools: async () => ({ data: previewTools }),
      launch: async ({ instrumentId, values }) => ({ ...previewTools.find((tool) => tool.id === instrumentId), launchValues: values, usageCount: 8, lastOpenedAt: new Date().toISOString() }),
      rename: async ({ instrumentId, name }) => {
        previewTools = previewTools.map((tool) => tool.id === instrumentId ? { ...tool, metadata: { ...tool.metadata, name } } : tool);
        return previewTools.find((tool) => tool.id === instrumentId);
      },
      grants: async ({ instrumentId, grants }) => {
        previewTools = previewTools.map((tool) => tool.id === instrumentId ? { ...tool, grants } : tool);
        return previewTools.find((tool) => tool.id === instrumentId);
      },
      duplicate: async ({ instrumentId }) => {
        const source = previewTools.find((tool) => tool.id === instrumentId);
        const copy = { ...source, id: `${source.id}-copy`, metadata: { ...source.metadata, name: `${source.metadata.name} copy` }, usageCount: 0 };
        previewTools = [copy, ...previewTools];
        return copy;
      },
      deleteTool: async ({ instrumentId }) => {
        const deleted = previewTools.find((tool) => tool.id === instrumentId);
        previewTools = previewTools.filter((tool) => tool.id !== instrumentId);
        return deleted;
      },
      revisions: async ({ instrumentId }) => ({ data: [3, 2, 1].map((version) => ({ id: `${instrumentId}:${version}`, instrumentId, version, document: releaseToolDocument, createdAt: `2026-08-${20 + version}T09:00:00.000Z` })) }),
      receipts: async ({ instrumentId }) => ({ data: [{ requestId: `${instrumentId}:run`, instrumentId, capability: "workflow.run", effectSummary: "Run workflow “Desktop release”.", status: "sent", createdAt: "2026-08-23T09:20:00.000Z" }] }),
      restore: async ({ instrumentId }) => previewTools.find((tool) => tool.id === instrumentId),
      refresh: async ({ instrumentId }) => previewTools.find((tool) => tool.id === instrumentId),
      event: async () => ({ status: "sent" }),
      invoke: async () => ({ cancelled: true, receipt: null, result: null }),
      pin: async ({ instrumentId }) => previewTools.find((tool) => tool.id === instrumentId),
      read: async ({ instrumentId }) => previewTools.find((tool) => tool.id === instrumentId),
      open: async ({ instrumentId }) => previewTools.find((tool) => tool.id === instrumentId),
      events: async () => ({ data: [] }),
      delete: async () => null
    },
    projects: { list: async () => [project], open: async () => project },
    threads: {
      list: async () => ({ data: threads, nextCursor: null }),
      read: async ({ threadId }) => threadId === secondaryThread.id ? { thread: secondaryThread, plan: [] } : { thread: rootThread, plan },
      children: async ({ threadId }) => ({ data: threadId === rootThread.id ? agents : [], nextCursor: null }),
      create: async () => ({ thread: rootThread }),
      archive: async () => ({})
    },
    turns: { start: async () => ({ turn: rootThread.turns[0] }), steer: async () => ({}), interrupt: async () => ({}) },
    approvals: { resolve: async () => ({ ok: true }) },
    requests: { respond: async () => ({ ok: true }) },
    review: { read: async () => ({ repository: project.repository, diff: "" }) },
    models: { list: async () => models },
    extensions: { list: async () => extensions },
    external: { openEditor: async () => {}, openTerminal: async () => {}, reveal: async () => {} },
    events: { subscribe: () => () => {} }
  };
}
