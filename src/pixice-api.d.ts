export {};

type PixiceEvent = {
  type:
    | "TaskUpdated"
    | "AgentUpdated"
    | "ActivityReceived"
    | "AttentionRequired"
    | "AttentionReset"
    | "RuntimeError"
    | "RuntimeStatus"
    | "ProviderLifecycleState"
    | "BrowserState"
    | "BrowserOpenRequested"
    | "BoardUpdated"
    | "InstrumentUpdated"
    | "InstrumentOpenRequested"
    | "InstrumentInteractionUpdated"
    | "WorkflowUpdated"
    | "WorkflowRunUpdated"
    | "WorkflowOpenRequested"
    | "WorkflowForegroundRequested"
    | "WorkflowTriggersUpdated"
    | "WorkflowCredentialsUpdated"
    | "IosSessionUpdated"
    | "IosPreviewOpenRequested"
    | "UpdateState"
    | "TrayNavigate"
    | "TraySettingsUpdated"
    | "UsageUpdated"
    | "CodexLimitsUpdated"
    | "ProjectDeleted";
  payload: any;
  at: string;
};

type ProjectScope = { projectId: string };
type ThreadScope = ProjectScope & { threadId: string };
type PixiceProvider = {
  id: "codex" | "claude" | string;
  connected?: boolean;
  installed?: boolean;
  installState?: { state?: string; operation?: string | null; message?: string | null; progress?: string | null; error?: string | null };
  updateState?: { state?: string; availableVersion?: string | null; checkedAt?: string | null; message?: string | null; error?: string | null };
  executablePath?: string | null;
  version?: string | null;
  compatible?: boolean;
  health?: { state?: "missing" | "broken" | "incompatible" | "healthy" | string; message?: string | null };
  status?: { state?: string; message?: string | null };
  authenticated?: boolean;
  externallyManagedAuth?: boolean;
  requiresAuth?: boolean;
  account?: { email?: string | null; organization?: string | null; type?: string | null; planType?: string | null; subscriptionType?: string | null } | null;
  accountError?: string | null;
  sessionCount?: number;
  actions?: { install?: boolean; locate?: boolean; repair?: boolean; checkUpdate?: boolean; update?: boolean; login?: boolean; logout?: boolean };
  installAvailable?: boolean;
  locateAvailable?: boolean;
  repairAvailable?: boolean;
  checkUpdateAvailable?: boolean;
  updateAvailable?: boolean;
  loginAvailable?: boolean;
  logoutAvailable?: boolean;
};
type ProjectIcon = "folder" | "code" | "terminal" | "globe" | "sparkles" | "stack" | "brain" | "chart" | "desktop" | "file" | "files" | "git-branch" | "image" | "lock" | "shield" | "workflow" | "gauge" | "connect";
type ProjectColor = "gray" | "blue" | "indigo" | "purple" | "pink" | "rose" | "red" | "orange" | "amber" | "yellow" | "green" | "teal";
type PixiceProject = {
  id: string;
  canonicalPath: string;
  displayName: string;
  icon: ProjectIcon;
  color: ProjectColor;
  folders: string[];
  lastUsedAt: string;
  repository?: any;
  createdAt: string;
  updatedAt: string;
};
type InstrumentDocument = {
  id: string;
  projectId: string;
  threadId: string;
  lifecycle: "ephemeral" | "pinned";
  documentVersion: number;
  document: {
    version: 1;
    title: string;
    description: string;
    parameters: Record<string, { label: string; description: string; type: "string" | "number" | "boolean" | "select"; required: boolean; default?: string | number | boolean; placeholder?: string; options?: Array<{ label: string; value: string | number | boolean }> }>;
    state: Record<string, unknown>;
    data: Record<string, unknown>;
    sources: Record<string, { capability: "project.summary" | "git.status" | "git.diff" | "files.readText" | "board.list" | "workflows.list" | "workflow.output" | "tasks.plan"; arguments: Record<string, unknown>; refresh: "manual" | "onOpen" | "event" }>;
    sourceState: Record<string, { status: "pending" | "ready" | "error"; refreshedAt: string | null; error: string | null }>;
    layout: Record<string, unknown>;
    actions: Record<string, unknown>;
  };
  status: string;
  metadata: { name?: string };
  grants: string[];
  requestedCapabilities: string[];
  usageCount: number;
  lastError: string | null;
  launchValues?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
};
type WorkflowNodeType =
  | "manualTrigger"
  | "scheduleTrigger"
  | "taskEventTrigger"
  | "webhookTrigger"
  | "useSkill"
  | "pixiceAgent"
  | "output"
  | "httpRequest"
  | "transform"
  | "aggregate"
  | "condition"
  | "switch"
  | "merge"
  | "delay"
  | "loop"
  | "file"
  | "command"
  | "git"
  | "database"
  | "executeWorkflow"
  | "notification"
  | "planWork"
  | "board";
type WorkflowAgentExecutionMode = "background" | "foreground";
type WorkflowSkillAttachment = {
  source: "installed" | "markdown";
  reference: string | null;
  name: string;
  description: string;
  path: string | null;
  bytes: number;
};
type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  name: string;
  description: string;
  position: { x: number; y: number };
  config: Record<string, unknown> & { executionMode?: WorkflowAgentExecutionMode };
};
type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
};
type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
};
type WorkflowDocument = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  enabled: boolean;
  graph: WorkflowGraph;
  createdByThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: WorkflowRun | null;
};
type WorkflowNodeRun = {
  nodeId: string;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled" | string;
  input?: unknown;
  output?: unknown;
  error?: string;
  skipReason?: string;
  activePorts?: string[];
  threadId?: string;
  turnId?: string;
  model?: string;
  effort?: string;
  executionMode?: WorkflowAgentExecutionMode;
  attachedSkills?: WorkflowSkillAttachment[];
  startedAt?: string;
  completedAt?: string;
};
type WorkflowRun = {
  id: string;
  workflowId: string;
  projectId: string;
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  input: unknown;
  nodeRuns: Record<string, WorkflowNodeRun>;
  output: unknown;
  error: string | null;
  sourceThreadId: string | null;
  triggerNodeId: string | null;
  parentRunId: string | null;
  parentNodeId: string | null;
  callStack: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
type WorkflowCredentialType = "bearer" | "basic" | "apiKey" | "headers";
type WorkflowCredential = {
  id: string;
  projectId: string;
  name: string;
  type: WorkflowCredentialType;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
};
type WorkflowTriggerStatus = {
  workflowId: string;
  workflowName: string;
  projectId: string;
  nodeId: string;
  nodeName: string;
  type: "schedule" | "task" | "webhook";
  status: "active" | "error" | string;
  error: string | null;
  nextRunAt: string | null;
  url: string | null;
  lastTriggeredAt: string | null;
  lastRunId: string | null;
  lastResult: string | null;
};

declare global {
  interface Window {
    pixice?: {
      app: {
        bootstrap(): Promise<{ projects: PixiceProject[]; models: any[]; runtime: any; settings?: Record<string, unknown>; agentBehaviors?: Array<{ id: string; label: string; description: string; category: "core" | "pixice-native"; defaultEnabled: boolean }> }>;
        saveSettings(payload: { defaultModel?: string; defaultEffort?: string; defaultPermissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access"; defaultFastMode?: boolean; threadNamingModel?: "auto" | "off" | `codex:${string}` | `claude:${string}`; workflowGenerationModel?: "auto" | `codex:${string}` | `claude:${string}`; attentionNotifications?: boolean; completionNotifications?: boolean; notificationSound?: boolean; keepSystemAwake?: boolean; checkProviderUpdates?: boolean; threadCompletionsSeen?: Record<string, string | number>; agentBehaviors?: Record<string, boolean> }): Promise<any>;
      };
      runtime: { status(): Promise<any> };
      providers: {
        list(): Promise<PixiceProvider[]>;
        install(payload: { provider: "codex" | "claude" }): Promise<PixiceProvider>;
        locate(payload: { provider: "codex" | "claude"; executablePath?: string }): Promise<PixiceProvider | { cancelled: true }>;
        repair(payload: { provider: "codex" | "claude" }): Promise<PixiceProvider>;
        checkUpdates(payload?: { provider?: "codex" | "claude" }): Promise<PixiceProvider[]>;
        update(payload: { provider: "codex" | "claude" }): Promise<PixiceProvider>;
        login(payload: { provider: string }): Promise<{ provider: string; opened: boolean; loginId?: string | null }>;
        logout(payload: { provider: "codex" | "claude" }): Promise<PixiceProvider>;
      };
      github: {
        status(): Promise<{ available: boolean; authenticated: boolean; source: "bundled" | "system" | null; version: string | null; account: { login: string; name?: string | null; avatarUrl?: string | null } | null; message: string }>;
        login(): Promise<any>;
        logout(): Promise<any>;
      };
      usage: {
        summary(payload: { days: number }): Promise<any>;
        limits(): Promise<{
          status: "available" | "unavailable";
          fetchedAt: string;
          message?: string;
          providers: Array<{
            provider: "codex" | "claude";
            label: string;
            status: "available" | "unavailable";
            fetchedAt: string;
            planType?: string | null;
            message?: string;
            limits?: Array<{
              id: string;
              name: string | null;
              planType: string | null;
              windows: Array<{ usedPercent: number | null; remainingPercent: number | null; windowDurationMins: number | null; resetsAt: number | null; label?: string | null; detail?: { used: number; limit: number; currency: string } | null }>;
              credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
              individualLimit: number | null;
              spendControlReached: boolean;
              rateLimitReachedType: string | null;
            }>;
            resetCredits?: { availableCount: number; credits: Array<{ id: string; title: string | null; description: string | null; expiresAt: number | null }> };
          }>;
        }>;
      };
      updates: {
        status(): Promise<any>;
        check(): Promise<any>;
        download(): Promise<any>;
        install(): Promise<{ ok: boolean }>;
      };
      browser: {
        state(payload: { workspaceId: string }): Promise<any>;
        create(payload: { workspaceId: string; url?: string }): Promise<any>;
        close(payload: { workspaceId: string; tabId: string }): Promise<any>;
        activate(payload: { workspaceId: string; tabId: string }): Promise<any>;
        navigate(payload: { workspaceId: string; tabId?: string; url: string }): Promise<any>;
        history(payload: { workspaceId: string; action: "back" | "forward" | "reload" | "stop" }): Promise<any>;
        setViewport(payload: { workspaceId: string; visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }): Promise<any>;
        adopt(payload: { fromWorkspaceId: string; toWorkspaceId: string }): Promise<any>;
        destroy(payload: { workspaceId: string }): Promise<{ destroyed: boolean; workspaceId: string }>;
      };
      preview: {
        setContext(payload: {
          threadId: string;
          context: {
            open: boolean;
            tabCount: number;
            active: null | {
              kind: "browser" | "file" | "instrument" | "task" | "plan" | "workflow" | "simulator" | "new";
              id?: string;
              title?: string;
              url?: string;
              path?: string;
              projectId?: string;
              taskId?: string;
              proposalId?: string;
              workflowId?: string;
              instrumentId?: string;
              documentVersion?: number;
              editable?: boolean;
              dirty?: boolean;
              simulatorUdid?: string;
              sessionId?: string;
              status?: string;
            };
          };
        }): Promise<any>;
      };
      ios: {
        environment(): Promise<any>;
        discover(payload: ProjectScope): Promise<any[]>;
        createStarter(payload: ProjectScope & { name: string; relativeDirectory?: string }): Promise<any>;
        start(payload: ProjectScope & { workspaceId: string; containerPath: string; scheme: string; simulatorUdid: string; configuration?: string }): Promise<any>;
        state(payload: { workspaceId: string }): Promise<any | null>;
        stop(payload: { workspaceId: string }): Promise<any | null>;
        action(payload: { workspaceId: string; action: "inspect" | "tap" | "type" | "swipe" | "button" | "rotate" | "appearance" | "screenshot" | "logs"; [key: string]: unknown }): Promise<any>;
        adopt(payload: { fromWorkspaceId: string; toWorkspaceId: string }): Promise<any | null>;
      };
      files: {
        read(payload: ProjectScope & { path: string }): Promise<any>;
        preview(payload: ProjectScope & { path: string }): Promise<any>;
        write(payload: ProjectScope & { path: string; content: string; expectedMtimeMs?: number }): Promise<any>;
      };
      projects: {
        list(): Promise<PixiceProject[]>;
        touch(payload: ProjectScope): Promise<PixiceProject>;
        pickFolders(): Promise<string[]>;
        create(payload: { displayName: string; icon: ProjectIcon; color: ProjectColor; folders: string[] }): Promise<PixiceProject>;
        delete(payload: ProjectScope): Promise<PixiceProject>;
        open(): Promise<PixiceProject | null>;
      };
      board: {
        list(payload: ProjectScope): Promise<{ data: Array<any>; phases: Array<any> }>;
        read(payload: ProjectScope & { taskId: string }): Promise<{ task: any; activity: Array<any> }>;
        create(payload: ProjectScope & { title: string; description?: string; column?: "backlog" | "ready" | "active" | "done"; kind?: "task" | "milestone" | "event"; priority?: "low" | "normal" | "high" | "urgent"; estimateMinutes?: number | null; owner?: string; schedule?: Record<string, unknown>; dependencies?: Array<Record<string, unknown>> }): Promise<any>;
        update(payload: ProjectScope & { taskId: string; title?: string; description?: string; kind?: "task" | "milestone" | "event"; priority?: "low" | "normal" | "high" | "urgent"; estimateMinutes?: number | null; owner?: string; schedule?: Record<string, unknown> | null; dependencies?: Array<Record<string, unknown>>; expectedRevision?: number; expectedScheduleRevision?: number }): Promise<any>;
        move(payload: ProjectScope & { taskId: string; column: "backlog" | "ready" | "active" | "done"; beforeTaskId?: string }): Promise<any>;
        delete(payload: ProjectScope & { taskId: string }): Promise<any>;
        attach(payload: ProjectScope & { taskId: string; threadId: string }): Promise<any>;
        createPhase(payload: ProjectScope & { title: string; taskIds: string[] }): Promise<any>;
        activity(payload: ProjectScope & { taskId: string }): Promise<{ data: Array<any> }>;
        readProposal(payload: ProjectScope & { proposalId: string }): Promise<any>;
        applyProposal(payload: ProjectScope & { proposalId: string }): Promise<any>;
        discardProposal(payload: ProjectScope & { proposalId: string }): Promise<any>;
        saveBinding(payload: ProjectScope & { taskId: string; bindingId?: string; workflowId: string; triggerNodeId?: string | null; triggerType: string; enabled?: boolean; missedTriggerPolicy?: "skip" | "ask" | "notify" | "run" }): Promise<any>;
        deleteBinding(payload: ProjectScope & { taskId: string; bindingId: string }): Promise<any>;
      };
      proactivity: {
        list(payload: ProjectScope & { threadId?: string }): Promise<{ data: Array<{
          id: string;
          projectId: string;
          threadId: string | null;
          type: "task-stewarded" | "task-status" | "workflow-pattern";
          status: "open" | "accepted" | "dismissed";
          title: string;
          message: string;
          payload: Record<string, any>;
          createdAt: string;
          updatedAt: string;
        }> }>;
        resolve(payload: ProjectScope & { suggestionId: string; decision: "accept" | "dismiss" }): Promise<any>;
      };
      instruments: {
        list(payload: ProjectScope & { threadId?: string }): Promise<{ data: InstrumentDocument[] }>;
        tools(payload: ProjectScope): Promise<{ data: InstrumentDocument[] }>;
        read(payload: ProjectScope & { instrumentId: string }): Promise<InstrumentDocument>;
        open(payload: ProjectScope & { instrumentId: string; workspaceId?: string }): Promise<InstrumentDocument>;
        refresh(payload: ProjectScope & { threadId: string; instrumentId: string; source?: string }): Promise<InstrumentDocument>;
        event(payload: ProjectScope & { threadId: string; instrumentId: string; actionId: string; payload?: unknown; model?: string; serviceTier?: string | null; effort?: string; permissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access" }): Promise<{ id: string; status: string; turnId: string | null }>;
        invoke(payload: ProjectScope & { threadId: string; instrumentId: string; actionId: string; arguments?: unknown; requestId: string }): Promise<{ cancelled?: boolean; duplicate?: boolean; receipt: unknown; result: unknown }>;
        pin(payload: ProjectScope & { threadId: string; instrumentId: string; pinned: boolean }): Promise<InstrumentDocument>;
        events(payload: ProjectScope & { instrumentId: string }): Promise<{ data: Array<{ id: string; instrumentId: string; event: string; payload: unknown; status: string; turnId: string | null; error: string | null; createdAt: string; updatedAt: string }> }>;
        receipts(payload: ProjectScope & { instrumentId: string }): Promise<{ data: unknown[] }>;
        launch(payload: ProjectScope & { threadId: string; instrumentId: string; values?: Record<string, unknown> }): Promise<InstrumentDocument>;
        rename(payload: ProjectScope & { threadId: string; instrumentId: string; name: string }): Promise<InstrumentDocument>;
        grants(payload: ProjectScope & { threadId: string; instrumentId: string; grants: string[] }): Promise<InstrumentDocument>;
        duplicate(payload: ProjectScope & { threadId: string; instrumentId: string }): Promise<InstrumentDocument>;
        revisions(payload: ProjectScope & { instrumentId: string }): Promise<{ data: Array<{ id: string; instrumentId: string; version: number; document: unknown; createdAt: string }> }>;
        restore(payload: ProjectScope & { threadId: string; instrumentId: string; version: number }): Promise<InstrumentDocument>;
        deleteTool(payload: ProjectScope & { threadId: string; instrumentId: string }): Promise<InstrumentDocument>;
        delete(payload: ProjectScope & { instrumentId: string }): Promise<InstrumentDocument>;
      };
      workflows: {
        list(payload: ProjectScope): Promise<{ data: WorkflowDocument[] }>;
        read(payload: ProjectScope & { workflowId: string }): Promise<{ workflow: WorkflowDocument; runs: WorkflowRun[] }>;
        taskRuns(payload: ProjectScope & { taskId: string }): Promise<{ data: Array<WorkflowRun & { workflowName: string; eventType: string | null }> }>;
        create(payload: ProjectScope & { name: string; description?: string; enabled?: boolean }): Promise<WorkflowDocument>;
        save(payload: ProjectScope & { workflowId: string; name: string; description: string; enabled: boolean; graph: WorkflowGraph; expectedUpdatedAt?: string }): Promise<WorkflowDocument>;
        generate(payload: ProjectScope & { workflowId: string }): Promise<{ graph: WorkflowGraph; model: string; generatedAt: string }>;
        delete(payload: ProjectScope & { workflowId: string }): Promise<WorkflowDocument>;
        run(payload: ProjectScope & { workflowId: string; input?: unknown; triggerNodeId?: string }): Promise<WorkflowRun>;
        cancel(payload: ProjectScope & { runId: string }): Promise<WorkflowRun>;
        triggers(payload: ProjectScope): Promise<{ data: WorkflowTriggerStatus[] }>;
        resolveMissedTrigger(payload: ProjectScope & { requestId: string; decision: "accept" | "decline" }): Promise<unknown>;
      };
      workflowCredentials: {
        list(projectId: string): Promise<{ data: WorkflowCredential[] }>;
        create(payload: ProjectScope & { name: string; type: WorkflowCredentialType; values: Record<string, unknown> }): Promise<WorkflowCredential>;
        update(payload: ProjectScope & { credentialId: string; name?: string; type?: WorkflowCredentialType; values?: Record<string, unknown> }): Promise<WorkflowCredential>;
        delete(projectId: string, credentialId: string): Promise<WorkflowCredential | null>;
      };
      threads: {
        list(payload: ProjectScope): Promise<{ data: any[]; nextCursor: string | null }>;
        read(payload: ThreadScope): Promise<{ thread: any; plan?: any[] | null }>;
        children(payload: ThreadScope): Promise<{ data: any[]; nextCursor: string | null }>;
        create(payload: ProjectScope & { model?: string; serviceTier?: string | null; permissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access" }): Promise<{ thread: any }>;
        archive(payload: ThreadScope): Promise<unknown>;
      };
      turns: {
        start(payload: ThreadScope & { text: string; images?: string[]; attachments?: Array<{ name: string; type: string; size: number; dataUrl: string }>; model?: string; serviceTier?: string | null; effort?: string; permissionMode?: "read-only" | "workspace-write" | "auto-approve" | "full-access" }): Promise<{ turn: any }>;
        steer(payload: ThreadScope & { turnId: string; text: string; images?: string[]; attachments?: Array<{ name: string; type: string; size: number; dataUrl: string }> }): Promise<unknown>;
        interrupt(payload: ThreadScope & { turnId: string }): Promise<unknown>;
      };
      approvals: {
        resolve(payload: { requestId: string | number; decision: "accept" | "decline" | "acceptForSession" | "cancel" }): Promise<unknown>;
      };
      requests: {
        respond(payload: { requestId: string | number; answers: Record<string, { answers: string[] }> }): Promise<unknown>;
      };
      questions: {
        respond(payload: { requestId: string | number; action: "answer" | "cancel"; answers: Record<string, string> }): Promise<unknown>;
      };
      elicitations: {
        respond(payload: { requestId: string | number; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }): Promise<unknown>;
      };
      review: {
        read(payload: ProjectScope): Promise<{ repository: any; files: Array<{ path: string; plus: number; minus: number; binary?: boolean }> }>;
        file(payload: ProjectScope & { path: string }): Promise<{ path: string; diff: string; baseCommit: string | null }>;
      };
      models: { list(): Promise<any[]> };
      extensions: { list(payload?: { projectId?: string; threadId?: string }): Promise<any> };
      external: {
        openEditor(payload: ProjectScope & { path?: string }): Promise<unknown>;
        openTerminal(payload: ProjectScope & { path?: string }): Promise<unknown>;
        reveal(payload: ProjectScope & { path?: string }): Promise<unknown>;
      };
      events: { subscribe(listener: (event: PixiceEvent) => void): () => void };
    };
  }
}
