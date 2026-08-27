const project = {
  id: "preview-project",
  displayName: "Pixice",
  canonicalPath: "/work/pixice",
  repository: {
    kind: "git",
    root: "/work/pixice",
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

const previewStartedAt = new Date(Date.now() - 108_000).toISOString();
const previewGeneratedImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#c4b9bc"/><stop offset=".54" stop-color="#d9b99d"/><stop offset="1" stop-color="#707377"/></linearGradient>
      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#777b7f"/><stop offset="1" stop-color="#25292d"/></linearGradient>
    </defs>
    <rect width="1440" height="900" fill="url(#sky)"/>
    <circle cx="1050" cy="210" r="72" fill="#f1d2b4" opacity=".76"/>
    <path d="M0 550 260 318 420 474 690 204 980 510 1200 344 1440 558V900H0Z" fill="#34383c"/>
    <path d="M0 584 305 424 488 544 730 362 1040 574 1275 468 1440 586V900H0Z" fill="#505457"/>
    <path d="M0 586H1440V900H0Z" fill="url(#water)"/>
    <path d="M0 660C260 620 380 700 620 662S1060 614 1440 680" fill="none" stroke="#c4b9b4" stroke-width="4" opacity=".22"/>
    <path d="M1020 650h132l-22 26h-90z" fill="#b54f49"/><path d="m1086 650 2-61" stroke="#ddd0c5" stroke-width="5"/>
  </svg>
`)}`;

const rootThread = {
  id: "preview-task",
  name: "Refactor authentication flow",
  preview: "Refactor authentication flow",
  cwd: "/work/pixice",
  parentThreadId: null,
  status: { type: "active" },
  planProgress: { completed: 3, total: 6 },
  updatedAt: Math.floor(Date.now() / 1000),
  turns: [{
    id: "preview-turn",
    status: "inProgress",
    startedAt: previewStartedAt,
    items: [
      { id: "preview-user", type: "userMessage", createdAt: previewStartedAt, content: [{ type: "text", text: "Refactor the authentication flow and keep the session migration safe." }] },
      { id: "preview-reasoning", type: "reasoning", summary: ["Coordinating the backend migration and client-session work in parallel."] },
      { id: "preview-image-tool", type: "dynamicToolCall", tool: "image_gen__imagegen", status: "completed", arguments: { prompt: "a quiet mountain lake at dawn with a small red canoe", size: "1440x900" } },
      { id: "preview-generated-image", type: "imageGeneration", status: "completed", result: previewGeneratedImage, revisedPrompt: "a quiet mountain lake at dawn with a small red canoe" }
    ]
  }]
};

const secondaryThread = {
  id: "preview-harness-task",
  name: "Build Pixice Codex harness",
  preview: "Build Pixice Codex harness",
  cwd: "/work/pixice",
  parentThreadId: null,
  status: "completed",
  planProgress: { completed: 5, total: 5 },
  updatedAt: Math.floor(Date.now() / 1000) - 180,
  turns: [{ id: "preview-harness-turn", status: "completed", items: [] }]
};

const agents = [
  { id: "api-agent", parentThreadId: rootThread.id, name: "API migration", preview: "Update client sessions", status: "running", startedAt: new Date(Date.now() - 82_000).toISOString(), agentRole: "API migration", agentStatusMessage: "Updating client sessions" },
  { id: "test-agent", parentThreadId: rootThread.id, name: "Session tests", preview: "Add fingerprinting", status: "running", startedAt: new Date(Date.now() - 49_000).toISOString(), agentRole: "Session tests", agentStatusMessage: "Adding fingerprint coverage" },
  { id: "model-agent", parentThreadId: rootThread.id, name: "Cookie model", preview: "Design cookie model", status: "completed", agentRole: "Cookie model", agentStatusMessage: "Completed" }
];

const previewProactiveSuggestions = [{
  id: "preview-task-status",
  projectId: project.id,
  threadId: rootThread.id,
  type: "task-status",
  status: "open",
  title: "Ready to close this task?",
  message: "The latest work for “Refactor authentication flow” completed.",
  payload: { taskId: "preview-task", taskTitle: "Refactor authentication flow", targetColumn: "done" }
}];

const previewScheduleTasks = [
  {
    id: "scheduled-temporal-model", projectId: project.id, title: "Temporal model", description: "Unify Board and Timeline around one work item.",
    column: "done", kind: "task", priority: "high", estimateMinutes: 480, owner: "Lead agent", revision: 3, threadId: rootThread.id,
    schedule: { taskId: "scheduled-temporal-model", plannedStart: "2026-08-03T08:00:00.000Z", plannedEnd: "2026-08-07T16:00:00.000Z", hardDeadline: null, allDay: false, timezone: "Europe/Zurich", constraintType: "fixed-window", lockedFields: ["plannedStart"], autoSchedule: false, revision: 2, explanation: "Architecture baseline.", updatedAt: "2026-08-07T16:00:00.000Z" },
    dependencies: [], dependents: [{ taskId: "scheduled-interaction-pass", dependsOnTaskId: "scheduled-temporal-model" }], workflowBindings: [], createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-07T16:00:00.000Z"
  },
  {
    id: "scheduled-interaction-pass", projectId: project.id, title: "Interaction pass", description: "Polish task editing and cross-view selection.",
    column: "done", kind: "task", priority: "normal", estimateMinutes: 720, owner: "Product agent", revision: 4, threadId: null,
    schedule: { taskId: "scheduled-interaction-pass", plannedStart: "2026-08-08T08:00:00.000Z", plannedEnd: "2026-08-14T16:00:00.000Z", hardDeadline: null, allDay: false, timezone: "Europe/Zurich", constraintType: "flexible", lockedFields: [], autoSchedule: true, revision: 3, explanation: "Starts after the model is complete.", updatedAt: "2026-08-14T16:00:00.000Z" },
    dependencies: [{ taskId: "scheduled-interaction-pass", dependsOnTaskId: "scheduled-temporal-model", type: "finish-to-start", lagMinutes: 0 }], dependents: [], workflowBindings: [], createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-14T16:00:00.000Z"
  },
  {
    id: "scheduled-timeline-renderer", projectId: project.id, title: "Timeline renderer", description: "Ship scalable bars, automatic range fitting, and drag rescheduling.",
    column: "active", kind: "task", priority: "high", estimateMinutes: 1_440, owner: "UI agent", revision: 7, threadId: rootThread.id,
    schedule: { taskId: "scheduled-timeline-renderer", plannedStart: "2026-08-11T08:00:00.000Z", plannedEnd: "2026-08-25T16:00:00.000Z", hardDeadline: "2026-08-26T16:00:00.000Z", allDay: false, timezone: "Europe/Zurich", constraintType: "flexible", lockedFields: ["hardDeadline"], autoSchedule: true, revision: 5, explanation: "Deadline protected by the release plan.", updatedAt: "2026-08-24T10:00:00.000Z" },
    dependencies: [], dependents: [{ taskId: "scheduled-schedule-editor", dependsOnTaskId: "scheduled-timeline-renderer" }], workflowBindings: [], createdAt: "2026-08-02T08:00:00.000Z", updatedAt: "2026-08-24T10:00:00.000Z"
  },
  {
    id: "scheduled-schedule-editor", projectId: project.id, title: "Schedule editor", description: "Add shared date and deadline editing for Board and Timeline.",
    column: "active", kind: "task", priority: "high", estimateMinutes: 1_200, owner: "UI agent", revision: 5, threadId: null,
    schedule: { taskId: "scheduled-schedule-editor", plannedStart: "2026-08-17T08:00:00.000Z", plannedEnd: "2026-08-28T16:00:00.000Z", hardDeadline: "2026-08-28T16:00:00.000Z", allDay: false, timezone: "Europe/Zurich", constraintType: "fixed-window", lockedFields: ["hardDeadline"], autoSchedule: true, revision: 4, explanation: "Runs alongside Timeline once its interaction contract is stable.", updatedAt: "2026-08-24T12:00:00.000Z" },
    dependencies: [{ taskId: "scheduled-schedule-editor", dependsOnTaskId: "scheduled-timeline-renderer", type: "finish-to-start", lagMinutes: 0 }], dependents: [{ taskId: "scheduled-qa", dependsOnTaskId: "scheduled-schedule-editor" }], workflowBindings: [{ id: "preview-binding", taskId: "scheduled-schedule-editor", workflowId: "preview-release-workflow", triggerNodeId: "task-ready", triggerType: "entered-ready", enabled: false, missedTriggerPolicy: "ask" }], createdAt: "2026-08-02T08:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z"
  },
  {
    id: "scheduled-qa", projectId: project.id, title: "Keyboard and screen reader QA", description: "Verify Board and Timeline interactions before release.",
    column: "ready", kind: "task", priority: "urgent", estimateMinutes: 480, owner: "QA agent", revision: 2, threadId: null,
    schedule: { taskId: "scheduled-qa", plannedStart: "2026-08-26T08:00:00.000Z", plannedEnd: "2026-08-31T16:00:00.000Z", hardDeadline: "2026-08-31T16:00:00.000Z", allDay: false, timezone: "Europe/Zurich", constraintType: "fixed-window", lockedFields: ["hardDeadline"], autoSchedule: true, revision: 2, explanation: "Final validation window.", updatedAt: "2026-08-24T13:00:00.000Z" },
    dependencies: [{ taskId: "scheduled-qa", dependsOnTaskId: "scheduled-schedule-editor", type: "finish-to-start", lagMinutes: 0 }], dependents: [], workflowBindings: [], createdAt: "2026-08-02T08:00:00.000Z", updatedAt: "2026-08-24T13:00:00.000Z"
  },
  {
    id: "scheduled-release", projectId: project.id, title: "Release candidate", description: "Scheduled-work milestone.",
    column: "backlog", kind: "milestone", priority: "urgent", estimateMinutes: 0, owner: "Lead agent", revision: 1, threadId: null,
    schedule: { taskId: "scheduled-release", plannedStart: "2026-09-03T09:00:00.000Z", plannedEnd: "2026-09-03T09:00:00.000Z", hardDeadline: "2026-09-03T09:00:00.000Z", allDay: false, timezone: "Europe/Zurich", constraintType: "fixed-start", lockedFields: ["plannedStart", "plannedEnd", "hardDeadline"], autoSchedule: false, revision: 1, explanation: "Release milestone.", updatedAt: "2026-08-24T14:00:00.000Z" },
    dependencies: [{ taskId: "scheduled-release", dependsOnTaskId: "scheduled-qa", type: "finish-to-start", lagMinutes: 0 }], dependents: [], workflowBindings: [], createdAt: "2026-08-02T08:00:00.000Z", updatedAt: "2026-08-24T14:00:00.000Z"
  }
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

export function createTaskProgressPreviewApi({ gitUnavailable = false } = {}) {
  const gitStatus = gitUnavailable
    ? { state: "command-line-tools-missing", available: false, installSupported: true, executablePath: null, version: null, message: "Apple Command Line Tools are not installed. Pixice can still work with folders, but Git features are unavailable." }
    : { state: "ready", available: true, installSupported: false, executablePath: "/usr/bin/git", version: "git version 2.50.1", message: "git version 2.50.1 is ready." };
  let currentGitStatus = gitStatus;
  const previewProject = gitUnavailable
    ? { ...project, repository: { kind: "folder", root: project.canonicalPath, baseCommit: null, dirtyPaths: [], git: gitStatus } }
    : { ...project, repository: { ...project.repository, git: gitStatus } };
  let previewTools = [releaseTool];
  let boardTasks = structuredClone(previewScheduleTasks);
  let boardPhases = [];
  let proactiveSuggestions = structuredClone(previewProactiveSuggestions);
  const boardActivity = new Map(boardTasks.map((task) => [task.id, [{ id: `${task.id}:activity`, taskId: task.id, projectId: project.id, kind: "schedule-changed", summary: task.schedule.explanation, actorKind: "agent", actorId: task.owner, createdAt: task.updatedAt }]]));
  const listeners = new Set();
  const emit = (type, payload) => listeners.forEach((listener) => listener({ type, payload }));
  const findBoardTask = (taskId) => boardTasks.find((task) => task.id === taskId);
  const touchBoardTask = (task, patch = {}) => {
    const updatedAt = new Date().toISOString();
    const next = { ...task, ...patch, revision: task.revision + 1, updatedAt };
    boardTasks = boardTasks.map((candidate) => candidate.id === task.id ? next : candidate);
    emit("BoardUpdated", { action: "updated", projectId: project.id, task: next });
    return next;
  };
  const threads = [rootThread, secondaryThread, ...agents];
  let browserTabSequence = 1;
  let browserState = {
    native: false,
    activeTabId: "preview-browser-tab",
    tabs: [{ id: "preview-browser-tab", title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false }]
  };
  return {
    app: { bootstrap: async () => ({ projects: [previewProject], models, runtime: { state: "ready", connected: true, userAgent: "Preview runtime" } }) },
    runtime: { status: async () => ({ state: "ready", connected: true }) },
    git: {
      status: async () => currentGitStatus,
      installCommandLineTools: async () => {
        currentGitStatus = { ...gitStatus, state: "install-requested", installRequested: true, message: "Finish the Apple Command Line Tools installation, then choose Check again." };
        return currentGitStatus;
      }
    },
    updates: {
      status: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      check: async () => ({ supported: false, state: "development", currentVersion: "0.0.0", availableVersion: null, percent: 0, message: "Updates are available in packaged Pixice builds." }),
      download: async () => ({}),
      install: async () => ({ ok: true })
    },
    browser: {
      state: async () => browserState,
      create: async () => {
        const tab = { id: `preview-browser-tab-${++browserTabSequence}`, title: "New tab", url: "", loading: false, error: null, canGoBack: false, canGoForward: false };
        browserState = { ...browserState, activeTabId: tab.id, tabs: [...browserState.tabs, tab] };
        return browserState;
      },
      close: async ({ tabId }) => {
        const tabs = browserState.tabs.filter((tab) => tab.id !== tabId);
        browserState = { ...browserState, tabs, activeTabId: browserState.activeTabId === tabId ? tabs.at(-1)?.id ?? null : browserState.activeTabId };
        return browserState;
      },
      activate: async ({ tabId }) => {
        if (browserState.tabs.some((tab) => tab.id === tabId)) browserState = { ...browserState, activeTabId: tabId };
        return browserState;
      },
      navigate: async () => browserState,
      history: async () => browserState,
      setViewport: async () => browserState
    },
    preview: { setContext: async ({ context }) => context },
    files: {
      read: async ({ path }) => ({ path: `/work/pixice/${path}`, relativePath: path, name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content: "# Pixice\n", editable: true, size: 7, mtimeMs: 1 }),
      write: async ({ path, content }) => ({ path, relativePath: path.replace("/work/pixice/", ""), name: path.split("/").at(-1), extension: `.${path.split(".").at(-1)}`, kind: path.endsWith(".md") ? "markdown" : "text", content, editable: true, size: content.length, mtimeMs: 2 })
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
    projects: { list: async () => [previewProject], open: async () => previewProject },
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
    review: { read: async () => ({ repository: previewProject.repository, diff: "" }) },
    proactivity: {
      list: async ({ threadId }) => ({ data: proactiveSuggestions.filter((suggestion) => !threadId || suggestion.threadId === threadId) }),
      resolve: async ({ suggestionId, decision }) => {
        const suggestion = proactiveSuggestions.find((candidate) => candidate.id === suggestionId);
        proactiveSuggestions = proactiveSuggestions.filter((candidate) => candidate.id !== suggestionId);
        return { suggestion: { ...suggestion, status: decision === "accept" ? "accepted" : "dismissed" } };
      }
    },
    board: {
      list: async () => ({ data: boardTasks, phases: boardPhases }),
      read: async ({ taskId }) => ({ task: findBoardTask(taskId), activity: boardActivity.get(taskId) ?? [] }),
      create: async ({ title, description = "", column = "backlog", ...details }) => {
        const now = new Date().toISOString();
        const task = { id: `preview-task-${boardTasks.length + 1}`, projectId: project.id, title, description, column, kind: details.kind ?? "task", priority: details.priority ?? "normal", estimateMinutes: details.estimateMinutes ?? null, owner: details.owner ?? "", revision: 1, threadId: null, schedule: details.schedule ?? null, dependencies: details.dependencies ?? [], dependents: [], workflowBindings: [], createdAt: now, updatedAt: now };
        boardTasks = [...boardTasks, task];
        emit("BoardUpdated", { action: "created", projectId: project.id, task });
        return task;
      },
      update: async ({ taskId, projectId: _projectId, expectedRevision: _expectedRevision, expectedScheduleRevision: _expectedScheduleRevision, ...patch }) => {
        const task = findBoardTask(taskId);
        const schedule = Object.hasOwn(patch, "schedule") ? (patch.schedule ? { ...task.schedule, ...patch.schedule, taskId, revision: (task.schedule?.revision ?? 0) + 1, updatedAt: new Date().toISOString() } : null) : task.schedule;
        return touchBoardTask(task, { ...patch, schedule });
      },
      move: async ({ taskId, column }) => touchBoardTask(findBoardTask(taskId), { column }),
      delete: async ({ taskId }) => { const task = findBoardTask(taskId); boardTasks = boardTasks.filter((candidate) => candidate.id !== taskId); emit("BoardUpdated", { action: "deleted", projectId: project.id, task }); return task; },
      attach: async ({ taskId, threadId }) => touchBoardTask(findBoardTask(taskId), { threadId }),
      createPhase: async ({ title, taskIds }) => {
        const phaseTasks = boardTasks.filter((task) => taskIds.includes(task.id));
        const starts = phaseTasks.map((task) => Date.parse(task.schedule?.plannedStart)).filter(Number.isFinite);
        const ends = phaseTasks.map((task) => Date.parse(task.schedule?.plannedEnd ?? task.schedule?.plannedStart)).filter(Number.isFinite);
        const phase = {
          id: `preview-phase-${boardPhases.length + 1}`,
          projectId: project.id,
          title,
          taskIds,
          tasks: phaseTasks.map((task) => ({ id: task.id, title: task.title, column: task.column })),
          plannedStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
          plannedEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
          completedCount: phaseTasks.filter((task) => task.column === "done").length
        };
        boardPhases = [...boardPhases, phase];
        boardTasks = boardTasks.map((task) => taskIds.includes(task.id) ? { ...task, phaseId: phase.id } : task);
        emit("BoardUpdated", { action: "phase-created", projectId: project.id, phase });
        return phase;
      },
      saveBinding: async ({ taskId, bindingId, workflowId, triggerNodeId = null, triggerType, enabled = false, missedTriggerPolicy = "ask" }) => {
        const task = findBoardTask(taskId);
        const id = bindingId ?? `preview-binding-${Date.now()}`;
        const binding = { id, taskId, workflowId, triggerNodeId, triggerType, enabled, missedTriggerPolicy };
        const workflowBindings = [...(task.workflowBindings ?? []).filter((candidate) => candidate.id !== id), binding];
        touchBoardTask(task, { workflowBindings });
        return binding;
      },
      deleteBinding: async ({ taskId, bindingId }) => touchBoardTask(findBoardTask(taskId), { workflowBindings: findBoardTask(taskId).workflowBindings.filter((binding) => binding.id !== bindingId) }),
      readProposal: async () => null,
      applyProposal: async () => null,
      discardProposal: async () => null
    },
    workflows: { list: async () => ({ data: [{ id: "preview-release-workflow", projectId: project.id, name: "Release readiness", description: "Run checks when a bound task enters Ready.", enabled: true, updatedAt: "2026-08-24T12:00:00.000Z" }] }) },
    models: { list: async () => models },
    extensions: { list: async () => extensions },
    external: { openEditor: async () => {}, openTerminal: async () => {}, reveal: async () => {} },
    events: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }
  };
}
