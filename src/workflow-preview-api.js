const PROJECT_ID = "workflow-preview-project";
const WORKFLOW_ID = "workflow-preview";
const RUN_ID = "workflow-preview-run";
const NOW = "2026-08-20T06:30:00.000Z";

const workflow = {
  id: WORKFLOW_ID,
  projectId: PROJECT_ID,
  name: "Release intelligence",
  description: "Collect release context, review it in the background, then hand the final decision to a foreground Loom thread.",
  createdByThreadId: null,
  createdAt: NOW,
  updatedAt: NOW,
  graph: {
    viewport: { x: 36, y: 150, zoom: 0.55 },
    nodes: [
      {
        id: "trigger",
        type: "manualTrigger",
        name: "Release requested",
        description: "Start with the release candidate supplied by the user.",
        position: { x: 20, y: 170 },
        config: {}
      },
      {
        id: "background-agent",
        type: "loomAgent",
        name: "Inspect changes",
        description: "Review commits, tests, and known risks without taking over the foreground.",
        position: { x: 390, y: 170 },
        config: {
          prompt: "Inspect the release candidate and summarize the important changes, test state, and risks.",
          model: null,
          effort: "high",
          permissionMode: "read-only",
          executionMode: "background"
        }
      },
      {
        id: "foreground-agent",
        type: "loomAgent",
        name: "Approve release",
        description: "Open a normal Loom task so the final decision can be inspected or steered.",
        position: { x: 760, y: 170 },
        config: {
          prompt: "Use the review context to decide whether this release is ready and explain the decision.",
          model: null,
          effort: "high",
          permissionMode: "workspace-write",
          executionMode: "foreground"
        }
      },
      {
        id: "output",
        type: "output",
        name: "Release decision",
        description: "Return the foreground agent's final decision.",
        position: { x: 1130, y: 170 },
        config: {}
      }
    ],
    edges: [
      { id: "edge-one", source: "trigger", target: "background-agent", sourcePort: "output", targetPort: "input" },
      { id: "edge-two", source: "background-agent", target: "foreground-agent", sourcePort: "output", targetPort: "input" },
      { id: "edge-three", source: "foreground-agent", target: "output", sourcePort: "output", targetPort: "input" }
    ]
  }
};

const run = {
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  projectId: PROJECT_ID,
  status: "running",
  input: { version: "0.2.0", channel: "beta" },
  nodeRuns: {
    trigger: { nodeId: "trigger", status: "completed", output: { version: "0.2.0", channel: "beta" }, completedAt: NOW },
    "background-agent": {
      nodeId: "background-agent",
      status: "completed",
      executionMode: "background",
      threadId: "preview-background-thread",
      output: "All checks passed. One migration deserves a final review.",
      completedAt: NOW
    },
    "foreground-agent": {
      nodeId: "foreground-agent",
      status: "running",
      executionMode: "foreground",
      threadId: "preview-foreground-thread",
      turnId: "preview-turn",
      model: "gpt-5.6",
      effort: "high",
      startedAt: NOW
    }
  },
  output: null,
  error: null,
  sourceThreadId: null,
  createdAt: NOW,
  startedAt: NOW,
  completedAt: null
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createWorkflowPreviewApi() {
  localStorage.setItem("loom.activeProjectId", PROJECT_ID);
  let currentWorkflow = clone(workflow);
  let currentRun = clone(run);
  const listeners = new Set();
  const emit = (type, payload) => listeners.forEach((listener) => listener({ type, payload, at: new Date().toISOString() }));
  const project = {
    id: PROJECT_ID,
    displayName: "Loom",
    canonicalPath: "/Users/izunim/Projects/Loom",
    createdAt: NOW,
    updatedAt: NOW,
    repository: { kind: "git", dirtyPaths: [] }
  };
  const models = [
    {
      id: "codex:gpt-5.6",
      model: "gpt-5.6",
      provider: "codex",
      displayName: "GPT-5.6 Terra",
      description: "Balanced implementation model",
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }]
    },
    {
      id: "claude:sonnet",
      model: "claude-sonnet",
      provider: "claude",
      displayName: "Claude Sonnet",
      description: "UI and product work",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }]
    }
  ];

  return {
    app: {
      bootstrap: async () => ({
        projects: [project],
        models,
        runtime: { state: "ready", connected: true, userAgent: "Loom preview runtime" },
        settings: {
          defaultModel: "gpt-5.6",
          defaultEffort: "high",
          defaultPermissionMode: "workspace-write"
        },
        agentBehaviors: []
      }),
      saveSettings: async (payload) => payload
    },
    runtime: { status: async () => ({ state: "ready", connected: true }) },
    providers: { list: async () => [], login: async () => ({ opened: false }) },
    usage: { summary: async () => ({}) },
    updates: {
      status: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", percent: 0, message: "Preview build" }),
      check: async () => ({}),
      download: async () => ({}),
      install: async () => ({ ok: false })
    },
    browser: {
      state: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      create: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      close: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      activate: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      navigate: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      history: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      setViewport: async ({ workspaceId }) => ({ workspaceId, native: false, activeTabId: null, tabs: [] }),
      adopt: async () => ({ native: false, activeTabId: null, tabs: [] })
    },
    files: { read: async () => null, write: async () => null },
    projects: { list: async () => [project], open: async () => null },
    board: {
      list: async () => ({ data: [] }),
      create: async () => null,
      update: async () => null,
      move: async () => null,
      delete: async () => null,
      attach: async () => null
    },
    workflows: {
      list: async () => ({ data: [{ ...clone(currentWorkflow), latestRun: clone(currentRun) }] }),
      read: async () => ({ workflow: clone(currentWorkflow), runs: [clone(currentRun)] }),
      create: async () => clone(currentWorkflow),
      save: async (payload) => {
        currentWorkflow = {
          ...currentWorkflow,
          name: payload.name,
          description: payload.description,
          graph: clone(payload.graph),
          updatedAt: new Date().toISOString()
        };
        emit("WorkflowUpdated", { action: "updated", projectId: PROJECT_ID, workflow: clone(currentWorkflow) });
        return clone(currentWorkflow);
      },
      delete: async () => clone(currentWorkflow),
      run: async () => clone(currentRun),
      cancel: async () => {
        currentRun = { ...currentRun, status: "cancelled", completedAt: new Date().toISOString() };
        emit("WorkflowRunUpdated", { projectId: PROJECT_ID, workflowId: WORKFLOW_ID, run: clone(currentRun) });
        return clone(currentRun);
      }
    },
    threads: {
      list: async () => ({ data: [], nextCursor: null }),
      read: async () => ({ thread: null }),
      children: async () => ({ data: [], nextCursor: null }),
      create: async () => ({ thread: null }),
      archive: async () => ({})
    },
    turns: { start: async () => ({}), steer: async () => ({}), interrupt: async () => ({}) },
    approvals: { resolve: async () => ({}) },
    requests: { respond: async () => ({}) },
    questions: { respond: async () => ({}) },
    elicitations: { respond: async () => ({}) },
    review: { read: async () => ({ repository: project.repository, diff: "" }) },
    models: { list: async () => models },
    extensions: { list: async () => ({ skills: [], apps: [], mcp: [], errors: [] }) },
    external: { openEditor: async () => ({}), openTerminal: async () => ({}), reveal: async () => ({}) },
    events: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    }
  };
}
