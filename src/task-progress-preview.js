const project = {
  id: "preview-project",
  displayName: "Loom",
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
  name: "Build Loom Codex harness",
  preview: "Build Loom Codex harness",
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
    { id: "local-runtime", name: "Local runtime", description: "Loom desktop project and task bridge.", authStatus: "available" }
  ],
  errors: []
};

export function createTaskProgressPreviewApi() {
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
      status: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Loom builds." }),
      check: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Loom builds." }),
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
      read: async ({ path }) => ({ path: `/work/loom/${path}`, relativePath: path, name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content: "# Loom\n", editable: true, size: 7, mtimeMs: 1 }),
      write: async ({ path, content }) => ({ path, relativePath: path.replace("/work/loom/", ""), name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content, editable: true, size: content.length, mtimeMs: 2 })
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
