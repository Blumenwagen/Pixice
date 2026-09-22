import { spawn } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexRuntime } from "../runtime/codex-runtime.mjs";
import { ThreadSessionRegistry } from "../runtime/thread-session-registry.mjs";
import { ThreadNamer } from "../runtime/thread-namer.mjs";
import { TaskResults } from "../runtime/task-results.mjs";
import { buildCodexUserInput } from "../runtime/user-input.mjs";
import {
  MAX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  appendAttachmentContext,
  attachmentProjectRoot,
  stagePromptAttachmentsAsync
} from "../runtime/prompt-attachments.mjs";
import { AGENT_BEHAVIOR_IDS, agentBehaviorCatalog, composeAgentInstructions } from "../runtime/agent-behavior.mjs";
import { CodexProvider } from "../providers/codex-provider.mjs";
import { ClaudeProvider } from "../providers/claude-provider.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";
import { ProviderRuntimeLifecycle } from "../providers/provider-runtime-lifecycle.mjs";
import { browserDynamicTools } from "../browser/browser-workspace.mjs";
import {
  appendPreviewContextHint,
  PIXICE_PREVIEW_NAMESPACE,
  PreviewContextRegistry,
  previewContextDynamicTools,
  stripPreviewContextHint
} from "../runtime/preview-context.mjs";
import {
  isPixiceQuestionToolCall,
  PIXICE_QUESTION_METHOD,
  pixiceQuestionRequest,
  pixiceQuestionToolResult,
  questionDynamicTools
} from "../runtime/question-tool.mjs";
import { PixiceBridge, PIXICE_BRIDGE_NAMESPACE, pixiceBridgeDynamicTools } from "../runtime/pixice-bridge.mjs";
import { BridgeParentContinuation } from "../runtime/bridge-parent-continuation.mjs";
import { FocusStore } from "../persistence/focus-store.mjs";
import { FocusSupervisor } from "../runtime/focus-supervisor.mjs";
import { FocusCoordinationTools } from "../runtime/focus-coordination-tools.mjs";
import { FocusQuestionGroups } from "../runtime/focus-question-groups.mjs";
import { bridgeEligibleModels, recommendBridgeModel } from "../runtime/model-capabilities.mjs";
import { PixiceBoard, PIXICE_BOARD_NAMESPACE, pixiceBoardDynamicTools } from "../runtime/pixice-board.mjs";
import {
  PixiceFocusMemory,
  PIXICE_FOCUS_NAMESPACE,
  pixiceFocusDynamicTools
} from "../runtime/pixice-focus.mjs";
import {
  InstrumentService,
  PIXICE_INSTRUMENTS_NAMESPACE,
  instrumentDynamicTools
} from "../instruments/instrument-service.mjs";

import { PixiceDatabase } from "../persistence/database.mjs";
import { migrateLegacyBrandData } from "../persistence/brand-data-migration.mjs";
import {
  createUpdateDataBackup,
  ensureVersionUpdateDataBackup,
  markUpdateDataVersion,
  readUpdateDataVersion,
  recoverUpdateDataFromBackup
} from "../persistence/update-data-backup.mjs";
import { inspectRepository, readDiff, readDiffManifest, readFileDiff } from "../git/worktrees.mjs";
import { detectGitRuntime, requestCommandLineToolsInstall } from "../git/git-runtime.mjs";
import { projectRendererThread, projectRuntimePayloadForRenderer } from "../runtime/renderer-thread-projection.mjs";
import { projectFolderDialogProperties } from "../projects/project-folder-dialog.mjs";
import { TranscriptionService } from "../transcription/service.mjs";
import { TRANSCRIPTION_MODEL_IDS } from "../transcription/catalog.mjs";
import { GitHubCli, prependGitHubCliToPath } from "../github/github-cli.mjs";
import { calculateUsageCost, listPricingCatalog, PRICING_VERIFIED_AT } from "../usage/pricing.mjs";
import { readProviderRateLimits } from "../usage/provider-limits.mjs";
import { reconcileThreadActivity, withStableCompletionRevision } from "../runtime/thread-activity.mjs";

import { ProactiveStewardship } from "../runtime/proactive-stewardship.mjs";
import { createDefaultWorkflow } from "../workflows/workflow-model.mjs";
import { MAX_EDITABLE_BYTES, previewFileTarget, readPreviewFile } from "../runtime/preview-files.mjs";
import { createTrayViewModel, createTrayWorkItems } from "../tray/tray-view-model.mjs";
import { containListenerErrors } from "../runtime/contained-listener.mjs";
import { resolveThreadProject } from "../runtime/thread-project-context.mjs";
import { IosRuntimeService } from "../ios/ios-runtime-service.mjs";
import { IosTools, PIXICE_IOS_NAMESPACE, iosDynamicTools, iosToolSchemas } from "../ios/ios-tools.mjs";

import { createRemoteInvoker, createRemoteThreadValidator } from "../connect/remote-operations.mjs";
import { EventEmitter } from "node:events";
import { installWorkflowRuntimeHost } from "../workflows/workflow-runtime-host.mjs";

// Application state lives in this service instance. Native UI and network transports
// are adapters; neither owns provider execution, projects, approvals, or workflows.
export function createApplication({ userDataPath, resourcesPath, version, platform, handlers, providerFactories = {}, nativeReadiness = () => ({ available: false, reason: "The Pixice native helper is unavailable." }), transferStore = null }) {
  const events = new EventEmitter();
  let stopped = false;
  let started = false;
  let acceptingWork = true;
  let resolveRuntimeReady;
  const runtimeReady = new Promise((resolve) => { resolveRuntimeReady = resolve; });
const threadSourceKinds = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "pixiceBridge", "unknown"
];

let trayLimits;
let trayRefreshPromise;
let runtime;
let codexRuntime;
let codexProvider;
let claudeProvider;
let threadNamer;
const browserWorkspace = platform.browser;
let previewContextRegistry;
let githubCli;
let pixiceBridge;
let bridgeParentContinuation;
let pixiceBoard;
let pixiceFocusMemory;
let focusStore;
let focusSupervisor;
let pixiceInstruments;
let iosRuntimeService;
let iosTools;
let transcriptionService;
let proactiveStewardship;
let database;
let taskResults;
let runtimeStatus = { state: "starting" };
const activeTurns = new Map();
const startingTurns = new Set();
const turnUsageMetadata = new Map();
const threadSessions = new ThreadSessionRegistry();
const threadPlans = new Map();
const trayCompletionRevisions = new Map();
const threadMonitorCache = new Map();
const threadProjects = new Map();
const projectDeletionTombstones = new Map();
const pendingRequests = new Map();
const pendingTaskNames = new Set();
const scheduledThreadNames = new Set();
const focusSessionEnsures = new Map();
const focusSessionTransitions = new Set();
const focusMemoryReviews = new Map();
const focusMemoryReviewInFlight = new Set();
const focusMemoryInternalThreadIds = new Set();
const focusQuestionReviews = new Map();
const focusQuestionReviewInFlight = new Set();
const focusQuestionInternalThreadIds = new Set();
const focusQuestionReviewTimers = new Map();
const focusQuestionGroups = new FocusQuestionGroups();
const FOCUS_PERMISSION_MODE = "full-access";
const pixiceDynamicTools = [
  ...browserDynamicTools,
  ...previewContextDynamicTools,
  ...questionDynamicTools,
  ...pixiceBridgeDynamicTools,
  ...pixiceBoardDynamicTools,
  ...pixiceFocusDynamicTools,
  ...instrumentDynamicTools,
  ...iosDynamicTools
];
const focusBridgeDynamicTools = pixiceBridgeDynamicTools.map((namespace) => ({
  ...namespace,
  tools: namespace.tools.filter((tool) => tool.name === "list_models")
}));
const focusDynamicTools = [
  ...questionDynamicTools,
  ...focusBridgeDynamicTools,
  ...pixiceBoardDynamicTools,
  ...pixiceFocusDynamicTools,
  ...previewContextDynamicTools,
  ...browserDynamicTools
];
let runtimeGeneration = 0;
let nextAttentionGeneration = 0;
let developerInstructionsPath;
let agentBehaviorsDirectory;

const idPayload = z.object({ projectId: z.string().min(1) });
const threadPayload = idPayload.extend({ threadId: z.string().min(1) });
const forkPointIdSchema = z.string().trim().min(1).max(500);
const threadForkPayload = threadPayload.extend({
  turnId: forkPointIdSchema.optional(),
  itemId: forkPointIdSchema.optional(),
  lastTurnId: forkPointIdSchema.optional(),
  lastItemId: forkPointIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (!value.turnId && !value.lastTurnId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A fork turn is required", path: ["lastTurnId"] });
  }
  if (!value.itemId && !value.lastItemId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A fork answer is required", path: ["lastItemId"] });
  }
  if (value.turnId && value.lastTurnId && value.turnId !== value.lastTurnId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Fork turn identifiers must match", path: ["lastTurnId"] });
  }
  if (value.itemId && value.lastItemId && value.itemId !== value.lastItemId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Fork answer identifiers must match", path: ["lastItemId"] });
  }
});
const projectIconSchema = z.enum([
  "folder", "code", "terminal", "globe", "sparkles", "stack", "brain", "chart", "desktop",
  "file", "files", "git-branch", "image", "lock", "shield", "workflow", "gauge", "connect"
]);
const projectColorSchema = z.enum([
  "gray", "blue", "indigo", "purple", "pink", "rose", "red", "orange", "amber", "yellow", "green", "teal"
]);
const createProjectPayload = z.object({
  displayName: z.string().trim().min(1).max(80),
  icon: projectIconSchema,
  color: projectColorSchema,
  folders: z.array(z.string().trim().min(1)).min(1).max(32)
}).strict();
const boardColumnSchema = z.enum(["backlog", "ready", "active", "done"]);
const boardTaskPayload = idPayload.extend({ taskId: z.string().min(1) });
const boardTaskTitleSchema = z.string().trim().min(1).max(240);
const boardTaskDescriptionSchema = z.string().trim().max(10_000);
const boardTaskKindSchema = z.enum(["task", "milestone", "event"]);
const boardTaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const boardTaskScheduleSchema = z.object({
  plannedStart: z.string().datetime().nullable().optional(), plannedEnd: z.string().datetime().nullable().optional(),
  hardDeadline: z.string().datetime().nullable().optional(), allDay: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  constraintType: z.enum(["flexible", "as-soon-as-possible", "fixed-start", "fixed-window"]).optional(),
  lockedFields: z.array(z.enum(["plannedStart", "plannedEnd", "hardDeadline"])).max(3).optional(),
  autoSchedule: z.boolean().optional(), explanation: z.string().max(2_000).optional()
}).strict();
const boardTaskDependencySchema = z.object({
  dependsOnTaskId: z.string().min(1), type: z.literal("finish-to-start").default("finish-to-start"),
  lagMinutes: z.number().int().min(0).max(525_600).default(0)
}).strict();
const permissionModeSchema = z.enum(["read-only", "workspace-write", "auto-approve", "full-access"]);
const agentBehaviorsSchema = z.object(Object.fromEntries(AGENT_BEHAVIOR_IDS.map((id) => [id, z.boolean().optional()]))).strict();
const threadCompletionsSeenSchema = z.record(z.union([
  z.string().min(1).max(256),
  z.number().finite().nonnegative()
])).refine((value) => Object.keys(value).length <= 10_000, "Too many completion read records");
const providerExecutablePathsSchema = z.object({
  codex: z.string().trim().min(1).max(4_096).refine(path.isAbsolute, "Codex executable path must be absolute").optional(),
  claude: z.string().trim().min(1).max(4_096).refine(path.isAbsolute, "Claude executable path must be absolute").optional()
}).strict();
const accentColorSchema = z.enum(["coral", "rose", "amber", "green", "teal", "blue", "violet", "graphite"]);
const appDefaultsSchema = z.object({
  defaultModel: z.string().trim().min(1).max(128).optional(),
  defaultEffort: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(32).optional(),
  defaultPermissionMode: permissionModeSchema.optional(),
  defaultFastMode: z.boolean().optional(),
  threadNamingModel: z.string().trim().regex(/^(?:auto|off|(?:codex|claude):[a-z0-9._-]+)$/i).max(160).optional(),
  workflowGenerationModel: z.string().trim().regex(/^(?:auto|(?:codex|claude):[a-z0-9._-]+)$/i).max(160).optional(),
  attentionNotifications: z.boolean().optional(),
  completionNotifications: z.boolean().optional(),
  notificationSound: z.boolean().optional(),
  keepSystemAwake: z.boolean().optional(),
  checkProviderUpdates: z.boolean().optional(),
  accentColor: accentColorSchema.optional(),
  reduceTransparency: z.boolean().optional(),
  providerExecutablePaths: providerExecutablePathsSchema.optional(),
  threadCompletionsSeen: threadCompletionsSeenSchema.optional(),
  agentBehaviors: agentBehaviorsSchema.optional(),
  transcriptionModel: z.string().trim().max(128).nullable().optional(),
  transcriptionSettings: z.object({
    numThreads: z.number().int().min(1).max(16),
    provider: z.enum(["cpu", "coreml"]),
    language: z.string().max(16)
  }).strict().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one default must be provided");
const imageDataUrlSchema = z.string().max(30 * 1024 * 1024).refine(
  (value) => /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(value),
  "Image must be a supported base64 data URL"
);
const attachmentDataUrlSchema = z.string().max(35 * 1024 * 1024).refine(
  (value) => /^data:[^;,]*;base64,[a-z0-9+/=]*$/i.test(value),
  "Attachment must be a base64 data URL"
);
const promptAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().max(255).default("application/octet-stream"),
  size: z.number().int().nonnegative().max(MAX_PROMPT_ATTACHMENT_BYTES),
  dataUrl: attachmentDataUrlSchema
}).strict();
const previewContextSchema = z.object({
  open: z.boolean(),
  tabCount: z.number().int().nonnegative().max(100).default(0),
  active: z.object({
    kind: z.enum(["browser", "file", "instrument", "task", "plan", "workflow", "simulator", "thread", "task-map", "new"]),
    id: z.string().max(500).optional(),
    title: z.string().max(500).optional(),
    url: z.string().max(10_000).optional(),
    path: z.string().max(10_000).optional(),
    projectId: z.string().max(500).optional(),
    threadId: z.string().max(500).optional(),
    hostThreadId: z.string().max(500).optional(),
    forkedFromId: z.string().max(500).optional(),
    taskId: z.string().max(500).optional(),
    proposalId: z.string().max(500).optional(),
    workflowId: z.string().max(500).optional(),
    instrumentId: z.string().max(500).optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    editable: z.boolean().optional(),
    dirty: z.boolean().optional(),
    simulatorUdid: z.string().max(200).optional(),
    sessionId: z.string().max(500).optional(),
    status: z.string().max(100).optional()
  }).strict().nullable().default(null)
}).strict();
const promptInputSchema = {
  text: z.string().trim().max(100_000).default(""),
  images: z.array(imageDataUrlSchema).max(10).default([]),
  attachments: z.array(promptAttachmentSchema).max(MAX_PROMPT_ATTACHMENTS).default([]),
  attachmentIds: z.array(z.string().uuid()).max(MAX_PROMPT_ATTACHMENTS).default([]),
  previewContext: previewContextSchema.optional()
};
const requirePromptInput = (value, context) => {
  if (!value.text && value.images.length === 0 && value.attachments.length === 0 && value.attachmentIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A message or attachment is required" });
  }
  if (value.images.length + value.attachments.length + value.attachmentIds.length > MAX_PROMPT_ATTACHMENTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `A message may contain at most ${MAX_PROMPT_ATTACHMENTS} attachments.` });
  }
};
const send = (type, payload = {}) => {
  if (type === "AttentionRequired" && payload.requestGeneration === undefined) payload = { ...payload, requestGeneration: runtimeGeneration };
  const event = { type, payload, at: new Date().toISOString() };
  events.emit("event", event);
};
const RENDERER_STREAM_FRAME_MS = 16;
const pendingRendererDeltas = new Map();
let rendererDeltaTimer = null;

function flushRendererDeltas() {
  if (rendererDeltaTimer) clearTimeout(rendererDeltaTimer);
  rendererDeltaTimer = null;
  for (const { type, payload } of pendingRendererDeltas.values()) send(type, payload);
  pendingRendererDeltas.clear();
}

function sendRuntimeEvent(type, payload = {}) {
  payload = projectRuntimePayloadForRenderer(payload);
  if (payload.method === "item/agentMessage/delta" && payload.threadId && payload.turnId && payload.itemId) {
    const key = `${type}\u0000${payload.projectId ?? ""}\u0000${payload.threadId}\u0000${payload.turnId}\u0000${payload.itemId}`;
    const pending = pendingRendererDeltas.get(key);
    pendingRendererDeltas.set(key, pending
      ? { type, payload: { ...pending.payload, ...payload, delta: `${pending.payload.delta ?? ""}${payload.delta ?? ""}` } }
      : { type, payload });
    if (!rendererDeltaTimer) {
      rendererDeltaTimer = setTimeout(flushRendererDeltas, RENDERER_STREAM_FRAME_MS);
      rendererDeltaTimer.unref?.();
    }
    return;
  }
  flushRendererDeltas();
  send(type, payload);
}

function currentAgentInstructions() {
  return composeAgentInstructions({
    baseInstructionsPath: developerInstructionsPath,
    behaviorsDirectory: agentBehaviorsDirectory,
    settings: database?.getAppSettings().agentBehaviors
  });
}

function focusAgentInstructions(project) {
  const memory = pixiceFocusMemory?.read(project.id) ?? {
    projectMemory: "",
    userMemory: "",
    capacity: null
  };
  return [
    "# Pixice Focus coordinator",
    `You are the single persistent Focus coordinator for the Pixice project \"${project.displayName}\".`,
    "The user is talking directly to the project. This conversation has no permanent goal, completion state, or fixed task boundary.",
    "Keep the conversation calm and direct. Answer small questions yourself. Do not manufacture plans, completion reports, or Board work for ordinary conversation.",
    "Use pixice_focus.list_work and read_work to resolve follow-ups against existing outcomes and artifacts. Interpret references using the conversation and selected Preview. Continue or redirect matching work with follow_up instead of creating duplicate tasks. Ask briefly if an ambiguous reference would materially change the work.",
    "Delegate bounded implementation, research, design, review, and debugging with pixice_focus.dispatch_work. It returns immediately; acknowledge the intended outcome and remain available. Completion events will bring results back. Do not wait in polling loops or leave a turn running solely to wait for workers. Give each worker one objective and relevant project skills. Use pixice_bridge.list_models for qualified available models.",
    "Declare access and overlapping file or directory resources accurately. Unknown write scope uses '*'. Do not label implementation as read-only to bypass sequencing. Use dependsOn for prerequisites; dependent work starts only after verified completion.",
    "When the user changes direction, record_decision for the affected work, then pause/cancel work explicitly if requested. Check worker acknowledgement and reconcile stale results. Never claim a direction was applied merely because it was sent.",
    "Worker completion means ready for your review. Inspect results, integrate related changes, and verify the original request. Use request_review for independent verification with the configured review model. Complete work only with concrete evidence or a justified not-required verification. Present one coherent result with artifacts and remaining uncertainty, not a stack of worker replies.",
    "Remain responsible for understanding worker results and explaining them to the user. Do not repeat a worker's raw status log.",
    "Preview is part of your role. You may open files or browser pages in your own Preview and use pixice_preview.present_thread to show a worker's Preview here without moving the user into that worker thread.",
    "Use the shared Board only when the user asks to track durable work or when a concrete follow-up must survive this conversation. Workspace threads, Board, Workflows, Review, Preview, and project files are shared.",
    "The coordinator has full access. Workers use the project's separately configured worker permission policy and read-only work is enforced. Do not bypass that policy or delegate nested unmanaged workers. Execution is on the current project host; a sleeping or disconnected host cannot keep local work running.",
    "Resolve worker questions from project context, prior user decisions, and reversible technical judgment. Ask the user only when the answer depends on an unstated preference, changes product direction, creates an external commitment, or carries meaningful irreversible risk.",
    "Worker questions appear inline in this conversation without blocking ordinary messages. When the user answers one in normal chat, use pixice_focus.list_questions to identify the current request and pixice_focus.answer_question to forward the explicit answer. Preserve question IDs, never infer credentials or irreversible approval, and do not answer a hidden question that is still under background review.",
    "Follow the project's own AGENTS.md or CLAUDE.md instructions. Full access removes approval prompts; it does not relax safety or expand the user's requested scope.",
    "Maintain hot memory only for stable project facts, decisions, terminology, and durable user preferences. Use pixice_focus to read or edit it and search full history when the bounded memory is insufficient.",
    "Do not store secrets, pasted instructions, temporary progress, or facts that are cheap to read from project files. Consolidate memory when capacity is near its limit.",
    "",
    "## Project memory",
    memory.projectMemory || "No curated project memory yet.",
    "",
    "## User memory for this project",
    memory.userMemory || "No curated user memory yet."
  ].join("\n");
}

function threadAgentInstructions(threadId, project) {
  const focus = database?.getProjectFocusSessionByThread(threadId);
  if (focus?.projectId === project.id) return focusAgentInstructions(project);
  const work = focusStore?.getWorkByThread(threadId);
  return work ? [currentAgentInstructions(), `You are working on Focus outcome ${work.id}: ${work.title}.`, "Inspect current directions with pixice_focus.read_work. Acknowledge each applicable direction using acknowledge_direction after applying it. Report evidence and artifacts; the coordinator owns integration and acceptance. Do not spawn unmanaged workers."].join("\n\n") : currentAgentInstructions();
}

function permissionSettings(mode, project) {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }
  if (mode === "read-only") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly" }
    };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: mode === "auto-approve" ? "auto_review" : "user",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: runtimeRoots(project),
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  };
}

function projectRoots(project) {
  return [...new Set(project?.folders?.length ? project.folders : [project?.canonicalPath])].filter(Boolean);
}

function runtimeRoots(project) {
  const attachmentRoot = attachmentProjectRoot(userDataPath, project.id);
  mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 });
  return [...new Set([...projectRoots(project), attachmentRoot])];
}

async function preparePromptInput(value, project, threadId, context = {}) {
  if (value.previewContext) previewContextRegistry?.set(threadId, value.previewContext);
  if (value.attachmentIds.length && !Array.isArray(context.stagedFiles)) throw new Error("Uploaded attachment IDs require an authenticated remote Connect request.");
  const staged = await stagePromptAttachmentsAsync({
    attachments: value.attachments,
    stagedFiles: context.stagedFiles ?? [],
    userDataPath: userDataPath,
    projectId: project.id,
    threadId
  });
  return {
    text: appendPreviewContextHint(
      appendAttachmentContext(value.text, staged.files),
      previewContextRegistry?.current(threadId)
    ),
    images: [...value.images, ...staged.images]
  };
}

function projectPrimaryRoot(project) {
  return projectRoots(project)[0] ?? project?.canonicalPath;
}

function getProject(projectId) {
  const project = database.getProject(projectId);
  if (!project) throw new Error("Project not found");
  return project;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectRootForTarget(project, target) {
  return projectRoots(project)
    .filter((root) => isWithin(root, target))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

function isWithinProject(project, target) {
  return Boolean(projectRootForTarget(project, target));
}

function projectTarget(projectId, target) {
  const project = getProject(projectId);
  const primaryRoot = projectPrimaryRoot(project);
  const candidate = target
    ? path.isAbsolute(target) ? path.resolve(target) : path.resolve(primaryRoot, target)
    : primaryRoot;
  const resolved = realpathSync(candidate);
  if (!isWithinProject(project, resolved)) throw new Error("Target is outside the selected project");
  return resolved;
}

function previewFileOptions(projectId, reference, allowExternal = false) {
  const project = getProject(projectId);
  return { reference, primaryRoot: projectPrimaryRoot(project), roots: projectRoots(project), allowExternal };
}

function readProjectFile(projectId, reference) {
  return readPreviewFile(previewFileOptions(projectId, reference));
}

function readLocalPreviewFile(projectId, reference) {
  return readPreviewFile(previewFileOptions(projectId, reference, true));
}

function requestKey(id) {
  return `${typeof id}:${id}`;
}

function projectForPath(target) {
  if (!target) return null;
  let canonicalTarget;
  try {
    canonicalTarget = realpathSync(target);
  } catch {
    return null;
  }
  return database.listProjects()
    .map((project) => ({ project, root: projectRootForTarget(project, canonicalTarget) }))
    .filter((candidate) => candidate.root)
    .sort((left, right) => right.root.length - left.root.length)[0]?.project ?? null;
}

function authoritativeThreadProjectId(threadId, cwd = null) {
  if (!threadId || !database) return null;
  const focusProjectId = database.getProjectFocusSessionByThread(threadId)?.projectId;
  if (focusProjectId && database.getProject(focusProjectId)) return focusProjectId;
  const receiptProjectId = taskResults?.get(threadId)?.projectId;
  if (receiptProjectId && database.getProject(receiptProjectId)) return receiptProjectId;
  const binding = database.getThreadProviderBinding(threadId);
  const project = projectForPath(cwd ?? binding?.cwd);
  if (project) return project.id;
  return null;
}

function rememberThread(project, thread, { loaded = false } = {}) {
  if (!thread?.id) return;
  const binding = database.getThreadProviderBinding(thread.id);
  const cwd = realpathSync(thread.cwd ?? binding?.cwd ?? projectPrimaryRoot(project));
  if (!isWithinProject(project, cwd)) throw new Error("Thread is outside the selected project");
  const ownerProjectId = authoritativeThreadProjectId(thread.id, cwd);
  if (ownerProjectId && ownerProjectId !== project.id) return false;
  threadSessions.remember(thread.id, cwd, { loaded });
  threadProjects.set(thread.id, project.id);
  return true;
}

function withPersistedThreadName(thread) {
  if (!thread?.id) return thread;
  const link = database.getThreadLink?.(thread.id);
  if (link && thread.parentThreadId !== link.parentThreadId) {
    thread = { ...thread, parentThreadId: link.parentThreadId, bridge: link };
  }
  let name = database.getThreadName(thread.id);
  const runtimeName = thread.name?.trim();
  if (!name && runtimeName) {
    database.saveThreadName(thread.id, runtimeName);
    name = runtimeName;
  }
  const namedThread = name && name !== thread.name ? { ...thread, name } : thread;
  const turnTimings = database.listThreadTurnTimings(thread.id);
  const stableThread = withStableCompletionRevision(namedThread, turnTimings);
  const timings = new Map(turnTimings.map((timing) => [timing.turnId, timing]));
  if (!stableThread.turns?.length || !timings.size) return stableThread;
  return {
    ...stableThread,
    turns: stableThread.turns.map((turn) => {
      const timing = timings.get(turn.id);
      if (!timing) return turn;
      const startedAt = turn.startedAt ?? turn.createdAt ?? timing.startedAt;
      const completedAt = turn.completedAt ?? timing.completedAt;
      return {
        ...turn,
        startedAt,
        completedAt,
        items: (turn.items ?? []).map((item) => {
          if (item.type === "userMessage" && !item.createdAt) return { ...item, createdAt: startedAt };
          if (item.type === "agentMessage" && item.phase === "final_answer" && !item.createdAt && completedAt) return { ...item, createdAt: completedAt };
          return item;
        })
      };
    })
  };
}

function validatedForkAnswer(thread, turnId, itemId) {
  if (!thread?.id) throw new Error("The source thread could not be read");
  if (activeTurns.has(thread.id) || thread.status?.type === "active" || (thread.turns ?? []).some((turn) => turn.status === "inProgress")) {
    throw new Error("A running thread cannot be forked");
  }
  const turn = (thread.turns ?? []).find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error("The selected fork turn was not found");
  if (turn.status !== "completed") throw new Error("Only a completed answer can be forked");
  const answers = (turn.items ?? []).filter((item) => item.type === "agentMessage" && String(item.text ?? "").trim());
  const finalAnswer = [...answers].reverse().find((item) => item.phase === "final_answer") ?? answers.at(-1);
  if (!finalAnswer) throw new Error("The selected turn has no assistant answer");
  if (finalAnswer.id !== itemId) throw new Error("Only the final assistant answer in a turn can be forked");
  return finalAnswer;
}

function independentForkThread(thread, forkedFromId) {
  const {
    bridge: _bridge,
    bridgeModel: _bridgeModel,
    bridgeThread: _bridgeThread,
    agentNickname: _agentNickname,
    agentRole: _agentRole,
    agentStatusMessage: _agentStatusMessage,
    ...independentThread
  } = thread;
  return { ...independentThread, parentThreadId: null, forkedFromId };
}

function scheduleThreadName({ project, threadId, source, kind }) {
  if (!threadNamer || !project || !threadId || !String(source ?? "").trim() || scheduledThreadNames.has(threadId)) return;
  scheduledThreadNames.add(threadId);
  void threadNamer.nameThread({
    threadId,
    cwd: database.getThreadProviderBinding(threadId)?.cwd || projectPrimaryRoot(project),
    source,
    kind
  });
}

function scheduleDelegatedThreadNames(event) {
  const item = event.payload?.item;
  if (event.type !== "AgentUpdated" || !["spawnAgent", "spawn_agent"].includes(item?.tool)) return;
  const projectId = threadProjects.get(event.payload?.threadId ?? item.senderThreadId);
  if (!projectId) return;
  const project = database.getProject(projectId);
  if (!project) return;
  const receiverIds = [...new Set([
    ...(item.receiverThreadIds ?? []),
    ...Object.keys(item.agentsStates ?? {})
  ])];
  for (const threadId of receiverIds) {
    if (!threadId || threadId === item.senderThreadId) continue;
    threadProjects.set(threadId, project.id);
    scheduleThreadName({ project, threadId, source: item.prompt, kind: "thread" });
  }
}

async function projectWithRepository(project) {
  return { ...project, repository: await inspectRepository(projectPrimaryRoot(project)) };
}

async function listProjects(projectIds = null) {
  const projects = database.listProjects().filter((project) => !Array.isArray(projectIds) || projectIds.includes(project.id));
  return Promise.all(projects.map(projectWithRepository));
}

function overviewProjectForThread(threadId, cwd = null) {
  const authoritativeProjectId = authoritativeThreadProjectId(threadId, cwd);
  const authoritativeProject = authoritativeProjectId ? database.getProject(authoritativeProjectId) : null;
  if (authoritativeProject) return authoritativeProject;
  const knownProjectId = threadProjects.get(threadId);
  const knownProject = knownProjectId ? database.getProject(knownProjectId) : null;
  return knownProject ?? resolveThreadProject({ database, projectId: null, cwd, projectForPath });
}

function isProjectFocusThread(threadId) {
  return Boolean(threadId && database.getProjectFocusSessionByThread(threadId));
}

function managedFocusAncestor(threadId) {
  const visited = new Set();
  while (threadId && !visited.has(threadId)) {
    visited.add(threadId);
    const work = focusStore?.getWorkByThread(threadId);
    if (work) return work;
    threadId = database.getThreadLink(threadId)?.parentThreadId;
  }
  return null;
}

function projectFocusContextForThread(threadId) {
  let currentThreadId = threadId;
  const visited = new Set();
  while (currentThreadId && !visited.has(currentThreadId)) {
    visited.add(currentThreadId);
    const session = database.getProjectFocusSessionByThread(currentThreadId);
    if (session) {
      return {
        session,
        projectId: session.projectId,
        focusThreadId: currentThreadId,
        sourceThreadId: threadId,
        worker: currentThreadId !== threadId
      };
    }
    currentThreadId = database.getThreadLink(currentThreadId)?.parentThreadId ?? null;
  }
  return null;
}

function connectOverview() {
  const pendingThreadIds = [...pendingRequests.values()]
    .filter((pending) => pending.visible !== false)
    .map(({ request }) => request?.params?.threadId)
    .filter((threadId) => typeof threadId === "string" && threadId.length <= 256);
  const activeThreadIds = [...activeTurns.keys()];
  const snapshot = database.listConnectOverview({ limit: 200, threadIds: [...activeThreadIds, ...pendingThreadIds] });
  const summaries = new Map(snapshot.providerThreads.map((thread) => [thread.id, thread]));
  const receipts = new Map(snapshot.taskResults.map(({ threadId, data, updatedAt }) => [threadId, { ...(data ?? {}), updatedAt: data?.updatedAt ?? updatedAt }]));
  const attention = new Set(pendingThreadIds);
  const threadIds = new Set([...summaries.keys(), ...receipts.keys(), ...activeThreadIds, ...attention]);
  const tasks = [...threadIds].filter((threadId) => !isProjectFocusThread(threadId)).map((threadId) => {
    const summary = summaries.get(threadId);
    const receipt = receipts.get(threadId);
    const project = receipt?.projectId ? database.getProject(receipt.projectId) : overviewProjectForThread(threadId, summary?.cwd);
    if (!project) return null;
    const status = attention.has(threadId)
      ? "waiting"
      : activeTurns.has(threadId) || receipt?.status === "running" || summary?.status?.type === "active"
        ? "running"
        : receipt?.status === "failed"
          ? "failed"
          : "completed";
    return {
      threadId,
      projectId: project.id,
      title: String(database.getThreadName(threadId) ?? receipt?.title ?? summary?.name ?? summary?.preview ?? "Untitled task").slice(0, 240),
      status,
      updatedAt: receipt?.updatedAt ?? summary?.updatedAt ?? new Date().toISOString()
    };
  }).filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 200);
  return {
    projects: database.listProjects().slice(0, 200).map((project) => ({ id: project.id, displayName: project.displayName, canonicalPath: project.canonicalPath })),
    tasks,
    checkedAt: new Date().toISOString()
  };
}

function connectProjectIdForEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.type === "ProjectDeleted" && typeof payload.projectId === "string") {
    const tombstone = projectDeletionTombstones.get(payload.projectId);
    if (tombstone && tombstone.expiresAt > Date.now()) return tombstone.projectId;
    if (tombstone) projectDeletionTombstones.delete(payload.projectId);
    return null;
  }
  if (event?.type === "TaskReceiptUpdated" && typeof payload.threadId === "string") {
    const receipt = taskResults?.get(payload.threadId);
    if (receipt?.projectId && database.getProject(receipt.projectId)) return receipt.projectId;
  }
  const threadId = payload.threadId ?? payload.params?.threadId ?? payload.thread?.id ?? payload.item?.senderThreadId;
  if (typeof threadId === "string") {
    const projectId = authoritativeThreadProjectId(threadId, payload.thread?.cwd);
    if (projectId) return projectId;
  }
  if (event?.type === "BoardUpdated") {
    const task = payload.task?.id ? database.getBoardTask(payload.task.id) : null;
    if (task?.projectId) return task.projectId;
    if (typeof payload.projectId === "string" && database.getProject(payload.projectId)) return payload.projectId;
  }
  return null;
}

async function listProjectThreads(project, parameters = {}) {
  const responses = await Promise.all(projectRoots(project).map((cwd) => runtime.request("thread/list", {
    cwd,
    limit: 200,
    sourceKinds: threadSourceKinds,
    archived: false,
    ...parameters
  })));
  const byId = new Map();
  for (const response of responses) {
    for (const thread of response.data ?? []) byId.set(thread.id, thread);
  }
  return {
    data: [...byId.values()]
      .filter((thread) => database.getProjectFocusSessionByThread(thread.id)?.projectId !== project.id)
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))),
    nextCursor: null
  };
}

function summarizeThreadPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  return {
    completed: plan.filter((step) => step?.status === "completed").length,
    total: plan.length
  };
}

function trayProjectForThread(threadId, cwd = null) {
  const projectId = threadProjects.get(threadId);
  return projectId ? database.getProject(projectId) : projectForPath(cwd ?? database.getThreadProviderBinding(threadId)?.cwd);
}

function currentTrayWorkItems() {
  const byId = new Map(database.listProviderThreadSummaries()
    .filter((thread) => !isProjectFocusThread(thread.id))
    .map((thread) => [thread.id, thread]));
  for (const [threadId] of activeTurns) {
    if (isProjectFocusThread(threadId)) continue;
    if (byId.has(threadId)) continue;
    const binding = database.getThreadProviderBinding(threadId);
    byId.set(threadId, database.getProviderThreadSummary(threadId) ?? {
      id: threadId,
      cwd: binding?.cwd ?? "",
      provider: binding?.provider ?? runtime?.providerForThread?.(threadId) ?? "codex",
      updatedAt: new Date().toISOString()
    });
  }
  const threads = [...byId.values()].map((thread) => {
    const project = trayProjectForThread(thread.id, thread.cwd);
    const link = database.getThreadLink?.(thread.id);
    return {
      ...thread,
      ...(trayCompletionRevisions.get(thread.id) ?? {}),
      name: database.getThreadName(thread.id) ?? thread.name,
      projectId: project?.id ?? null,
      projectName: project?.displayName ?? "Unknown project",
      plan: threadPlans.get(thread.id) ?? database.getThreadPlan(thread.id) ?? [],
      bridgeThread: link?.kind === "pixiceBridge"
    };
  });
  return createTrayWorkItems({
    threads,
    activeTurns: [...activeTurns],
    seenCompletions: database.getAppSettings().threadCompletionsSeen ?? {}
  });
}

function currentTrayState() {
  const workItems = currentTrayWorkItems();
  const settings = database?.getAppSettings() ?? {};
  const activeTaskCount = [...activeTurns.keys()].filter((threadId) => !isProjectFocusThread(threadId)).length;
  return createTrayViewModel({
    limits: trayLimits,
    summary: database?.getUsageSummary({ days: 7 }),
    activeTurns: activeTaskCount,
    workItems,
    keepSystemAwake: settings.keepSystemAwake === true,
    appearance: {
      accentColor: settings.accentColor,
      reduceTransparency: settings.reduceTransparency
    },
    appIconDataUrl: null
  });
}

function sendTrayState() { send("TrayState", currentTrayState()); }
function updateTrayMenu() { if (database) sendTrayState(); }

async function refreshTrayState() {
  if (trayRefreshPromise) return trayRefreshPromise;
  trayRefreshPromise = readProviderRateLimits({ codexProvider, claudeProvider })
    .then((limits) => {
      trayLimits = limits;
      sendTrayState();
      return currentTrayState();
    })
    .finally(() => { trayRefreshPromise = null; });
  return trayRefreshPromise;
}

function monitorStatus(thread) {
  const turn = [...(thread?.turns ?? [])].reverse()[0];
  if (!turn) return { type: "notLoaded" };
  if (turn.status === "inProgress") return { type: "active", activeFlags: [] };
  if (turn.status === "completed") return "completed";
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted" || turn.status === "cancelled") return "interrupted";
  return { type: "notLoaded" };
}

async function listModels() {
  if (!runtime.connected) return [];
  const response = await runtime.request("model/list", { limit: 100 });
  return response.data ?? [];
}

function canonicalInputTokens(usage, inputIncludesCached) {
  const input = Math.max(0, Number(usage?.inputTokens) || 0);
  if (!inputIncludesCached) return input;
  return Math.max(0, input - (Number(usage?.cachedInputTokens) || 0) - (Number(usage?.cacheWriteInputTokens) || 0));
}

function recordUsage(payload) {
  const provider = payload.provider ?? runtime.providerForThread?.(payload.threadId) ?? "codex";
  const metadata = turnUsageMetadata.get(payload.threadId) ?? {};
  if (payload.method === "thread/tokenUsage/updated" && provider === "codex") {
    const usage = payload.tokenUsage?.last;
    const total = payload.tokenUsage?.total;
    if (!usage || !total) return false;
    const model = metadata.model ?? null;
    const serviceTier = metadata.serviceTier ?? null;
    const recordedAt = new Date().toISOString();
    const pricing = calculateUsageCost({
      provider,
      model,
      serviceTier,
      ...usage,
      inputIncludesCached: true,
      recordedAt
    });
    const fingerprint = [
      total.inputTokens,
      total.cachedInputTokens,
      total.cacheWriteInputTokens ?? 0,
      total.outputTokens,
      total.reasoningOutputTokens,
      total.totalTokens
    ].join(":");
    return database.recordUsageEvent({
      id: `codex:${payload.threadId}:${payload.turnId}:${fingerprint}`,
      threadId: payload.threadId,
      turnId: payload.turnId,
      provider,
      model,
      serviceTier,
      recordedAt,
      inputTokens: canonicalInputTokens(usage, true),
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      costUsd: pricing?.costUsd,
      costSource: pricing ? "api-equivalent" : "unpriced",
      pricingModel: pricing?.pricingModel,
      metadata: { longContext: pricing?.longContext ?? false }
    });
  }
  if (payload.method === "provider/usage/recorded") {
    const usage = payload.usage ?? {};
    const recordedAt = new Date().toISOString();
    const model = payload.model ?? metadata.model ?? null;
    const serviceTier = payload.serviceTier ?? metadata.serviceTier ?? null;
    const calculated = calculateUsageCost({
      provider,
      model,
      serviceTier,
      ...usage,
      inputIncludesCached: false,
      recordedAt
    });
    const reportedCost = Number(payload.costUsd);
    const hasReportedCost = Number.isFinite(reportedCost) && reportedCost >= 0;
    return database.recordUsageEvent({
      id: `${provider}:${payload.responseId ?? `${payload.threadId}:${payload.turnId}`}`,
      threadId: payload.threadId,
      turnId: payload.turnId,
      provider,
      model,
      serviceTier,
      recordedAt,
      inputTokens: canonicalInputTokens(usage, false),
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      costUsd: hasReportedCost ? reportedCost : calculated?.costUsd,
      costSource: hasReportedCost ? "provider-reported" : calculated ? "api-equivalent" : "unpriced",
      pricingModel: calculated?.pricingModel,
      metadata: { longContext: calculated?.longContext ?? false }
    });
  }
  return false;
}

async function startProviderLogin(provider) {
  const result = await runtime.loginProvider(provider);
  const authUrl = result?.authUrl ?? result?.url ?? result?.verificationUrl;
  if (!authUrl) throw new Error(`${provider} did not return a sign-in URL`);
  const destination = new URL(authUrl);
  if (destination.protocol !== "https:" && destination.protocol !== "http:") {
    throw new Error("Provider returned an unsupported sign-in URL");
  }
  await platform.openExternal(destination.toString());
  return { provider, opened: true, loginId: result.loginId ?? null };
}

async function locateProviderExecutable(provider, requestedPath = null) {
  let executablePath = requestedPath;
  if (!executablePath) {
    const current = (await runtime.listProviders()).find((candidate) => candidate.id === provider);
    const result = await platform.openDialog({
      title: `Locate ${provider === "codex" ? "Codex" : "Claude Code"}`,
      defaultPath: current?.executablePath ? path.dirname(current.executablePath) : undefined,
      properties: ["openFile", "showHiddenFiles"]
    });
    if (result.canceled || !result.filePaths[0]) return { provider, cancelled: true };
    [executablePath] = result.filePaths;
  }
  return { provider, cancelled: false, ...(await runtime.locateProvider(provider, executablePath)) };
}

function canonicalProjectFolders(folders) {
  const canonical = [];
  const seen = new Set();
  for (const folder of folders) {
    const resolved = realpathSync(folder);
    if (!statSync(resolved).isDirectory()) throw new Error(`${folder} is not a directory`);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    canonical.push(resolved);
  }
  if (!canonical.length) throw new Error("A project needs at least one folder");
  return canonical;
}

async function pickProjectFolders({ multiple = true } = {}) {
  const properties = projectFolderDialogProperties({ multiple });
  const result = await platform.openDialog({ properties });
  if (result.canceled) return [];
  return canonicalProjectFolders(result.filePaths);
}

async function ensureThreadLoaded(project, threadId) {
  const cwd = await threadSessions.ensure(threadId, async () => {
    const focus = database.getProjectFocusSessionByThread(threadId)?.projectId === project.id;
    const response = await runtime.request("thread/resume", {
      threadId,
      developerInstructions: threadAgentInstructions(threadId, project),
      dynamicTools: focus ? focusDynamicTools : pixiceDynamicTools
    });
    const resumedCwd = response.thread?.cwd;
    if (!resumedCwd) throw new Error("Runtime returned a thread without a working directory");
    return realpathSync(resumedCwd);
  });
  if (!isWithinProject(project, cwd)) throw new Error("Thread is outside the selected project");
  const ownerProjectId = authoritativeThreadProjectId(threadId, cwd);
  if (ownerProjectId && ownerProjectId !== project.id) throw new Error("Thread is outside the selected project");
  threadProjects.set(threadId, project.id);
  return cwd;
}

async function startTrackedTurn({ project, threadId, input, text, model, effort, serviceTier, frozenAttachments, permissionMode = "workspace-write", trackTask = true }) {
  if (!acceptingWork) throw new Error("The Pixice service is stopping. Your task was not started.");
  if (activeTurns.has(threadId) || startingTurns.has(threadId)) throw new Error("This task is already running.");
  runtime.assertModelForThread(threadId, model);
  startingTurns.add(threadId);
  try {
    const cwd = await ensureThreadLoaded(project, threadId);
    const permissions = permissionSettings(permissionMode, project);
    if (trackTask) {
      await taskResults.begin({ project, threadId, input, prompt: text, model, effort, serviceTier, frozenAttachments,
        attachmentRoot: attachmentProjectRoot(userDataPath, project.id) });
    }
    turnUsageMetadata.set(threadId, { turnId: null, model: model || null, serviceTier: serviceTier ?? null,
      effort: effort || null, permissionMode, provider: runtime.providerForThread(threadId) });
    try {
      const response = await runtime.request("turn/start", {
        threadId, input, cwd, runtimeWorkspaceRoots: runtimeRoots(project), model: model || null,
        ...(serviceTier !== undefined ? { serviceTier } : {}), effort: effort || null, permissionMode,
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer, sandboxPolicy: permissions.sandboxPolicy
      });
      if (trackTask) taskResults.started(threadId, response.turn.id);
      if (!response.turn.status || response.turn.status === "inProgress") activeTurns.set(threadId, response.turn.id);
      const metadata = turnUsageMetadata.get(threadId);
      if (metadata) metadata.turnId = response.turn.id;
      updateTrayMenu();
      return response;
    } catch (error) {
      if (trackTask) taskResults.failed(threadId, error);
      throw error;
    }
  } finally {
    startingTurns.delete(threadId);
  }
}

function finalAgentText(turn) {
  const messages = (turn?.items ?? []).filter((item) => item.type === "agentMessage" && String(item.text ?? "").trim());
  return [...messages].reverse().find((item) => item.phase === "final_answer")?.text
    ?? messages.at(-1)?.text
    ?? "";
}

function focusMemoryTranscript(thread) {
  return (thread?.turns ?? []).slice(-12).flatMap((turn) => (turn.items ?? []).flatMap((item) => {
    if (item.type === "userMessage") {
      const text = (item.content ?? [])
        .filter((part) => part?.type === "text" || part?.type === "inputText")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      return text && !text.startsWith("[Pixice Focus work updates]\n") ? [`USER: ${text}`] : [];
    }
    if (item.type === "agentMessage" && item.phase === "final_answer" && String(item.text ?? "").trim()) {
      return [`COORDINATOR: ${item.text.trim()}`];
    }
    return [];
  })).join("\n\n").slice(-60_000);
}

function parseFocusMemoryReview(text) {
  const source = String(text ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || typeof parsed.projectMemory !== "string" || typeof parsed.userMemory !== "string") {
    throw new Error("Focus memory review returned an invalid document");
  }
  return parsed;
}

async function completeFocusMemoryReview(threadId, turn) {
  const review = focusMemoryReviews.get(threadId);
  if (!review) return;
  focusMemoryReviews.delete(threadId);
  focusMemoryReviewInFlight.delete(review.focusThreadId);
  try {
    const result = parseFocusMemoryReview(finalAgentText(turn));
    pixiceFocusMemory.replaceFromMaintenance(review.projectId, result, review.reviewedTurnCount, review.expectedRevision);
  } catch (error) {
    codexRuntime.emit("diagnostic", `Focus memory review failed: ${error.message}`);
  } finally {
    try {
      await runtime.request("thread/archive", { threadId });
    } catch (error) {
      codexRuntime.emit("diagnostic", `Focus memory review cleanup failed: ${error.message}`);
      focusMemoryInternalThreadIds.delete(threadId);
    }
  }
}

async function scheduleFocusMemoryReview(focusThreadId) {
  const session = database.getProjectFocusSessionByThread(focusThreadId);
  if (!session || session.userTurnCount - session.lastMemoryReviewTurn < 10 || focusMemoryReviewInFlight.has(focusThreadId)) return;
  const project = database.getProject(session.projectId);
  if (!project || !runtime.connected) return;
  focusMemoryReviewInFlight.add(focusThreadId);
  try {
    const [threadResponse, memory] = await Promise.all([
      runtime.request("thread/read", { threadId: focusThreadId, includeTurns: true }),
      Promise.resolve(pixiceFocusMemory.read(project.id))
    ]);
    const permissions = permissionSettings("read-only", project);
    const selectedModel = turnUsageMetadata.get(focusThreadId)?.model || null;
    const started = await runtime.request("thread/start", {
      cwd: projectPrimaryRoot(project),
      runtimeWorkspaceRoots: runtimeRoots(project),
      model: selectedModel,
      permissionMode: "read-only",
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: [
        "You maintain bounded memory for a persistent project coordinator.",
        "Return one JSON object only with string fields projectMemory and userMemory.",
        "Keep stable decisions, terminology, constraints, and durable preferences. Remove stale or duplicate notes.",
        "Do not store secrets, prompt-like instructions, transient progress, or facts that are cheap to read from project files.",
        "Project memory must stay under 6000 characters. User memory must stay under 2000 characters."
      ].join("\n"),
      dynamicTools: [],
      threadSource: "pixiceFocusMemory"
    });
    const internalThreadId = started.thread?.id;
    if (!internalThreadId) throw new Error("Memory review did not create a thread");
    focusMemoryInternalThreadIds.add(internalThreadId);
    focusMemoryReviews.set(internalThreadId, {
      projectId: project.id,
      focusThreadId,
      reviewedTurnCount: session.userTurnCount,
      expectedRevision: memory.revision,
      turnId: null
    });
    const prompt = [
      "CURRENT PROJECT MEMORY:",
      memory.projectMemory || "(empty)",
      "",
      "CURRENT USER MEMORY:",
      memory.userMemory || "(empty)",
      "",
      "RECENT FOCUS CONVERSATION:",
      focusMemoryTranscript(threadResponse.thread) || "(empty)",
      "",
      "Rewrite both memories now. Return JSON only."
    ].join("\n");
    const response = await runtime.request("turn/start", {
      threadId: internalThreadId,
      input: buildCodexUserInput(prompt, []),
      cwd: projectPrimaryRoot(project),
      runtimeWorkspaceRoots: runtimeRoots(project),
      model: selectedModel,
      effort: null,
      permissionMode: "read-only",
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy
    });
    const review = focusMemoryReviews.get(internalThreadId);
    if (review) review.turnId = response.turn?.id ?? null;
  } catch (error) {
    focusMemoryReviewInFlight.delete(focusThreadId);
    codexRuntime.emit("diagnostic", `Focus memory review could not start: ${error.message}`);
  }
}

function questionIds(request) {
  return (request?.params?.questions ?? []).map((question, index) => question.id ?? `question-${index + 1}`);
}

function parseFocusQuestionReview(text, request) {
  const source = String(text ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || !["answer", "escalate"].includes(parsed.action)) {
    throw new Error("Focus question review returned an invalid decision");
  }
  if (parsed.action === "escalate") {
    const validIds = new Set(questionIds(request));
    const questions = parsed.questions && typeof parsed.questions === "object"
      ? Object.fromEntries(Object.entries(parsed.questions).filter(([id]) => validIds.has(id)).map(([id, value]) => [id, {
        question: String(value?.question ?? value ?? "").trim(),
        recommendation: String(value?.recommendation ?? "").trim()
      }]))
      : {};
    return {
      action: "escalate",
      reason: String(parsed.reason ?? "").trim(),
      question: String(parsed.question ?? "").trim(),
      recommendation: String(parsed.recommendation ?? "").trim(),
      questions
    };
  }
  const answers = parsed.answers && typeof parsed.answers === "object" ? parsed.answers : {};
  const normalized = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, String(answer ?? "").trim()]));
  if (questionIds(request).some((id) => !normalized[id])) {
    throw new Error("Focus question review did not answer every question");
  }
  return { action: "answer", answers: normalized };
}

function secretFocusQuestion(question) {
  const kind = String(question?.inputType ?? question?.type ?? "").toLowerCase();
  const text = `${question?.header ?? ""} ${question?.question ?? ""} ${question?.originalQuestion ?? ""}`.toLowerCase();
  return question?.isSecret === true || question?.secret === true || question?.sensitive === true
    || kind === "password" || /\b(password|secret|api key|access token|credential)\b/.test(text);
}

function boundedFocusQuestion(question) {
  return {
    id: String(question?.id ?? "").slice(0, 160),
    header: String(question?.header ?? "").slice(0, 160),
    question: String(question?.question ?? "").slice(0, 2_000),
    options: (question?.options ?? []).slice(0, 20).map((option) => ({
      label: String(option?.label ?? "").slice(0, 300),
      description: String(option?.description ?? "").slice(0, 1_000)
    }))
  };
}

function recordFocusQuestionAnswer(pending, members, source) {
  const focusContext = pending.focusContext;
  if (!focusContext?.projectId || !focusStore) return;
  const leaderQuestions = pending.displayRequest.params?.questions ?? [];
  const leaderAnswers = members.find((member) => member.key === requestKey(pending.request.id))?.answers ?? {};
  const safeQuestions = leaderQuestions.filter((question) => !secretFocusQuestion(question)).map(boundedFocusQuestion);
  const safeIds = new Set(safeQuestions.map((question) => question.id));
  const answers = Object.fromEntries(Object.entries(leaderAnswers)
    .filter(([id]) => safeIds.has(id))
    .map(([id, answer]) => [id, (Array.isArray(answer) ? answer : [answer]).map((value) => String(value).slice(0, 10_000))]));
  const work = focusStore.getWorkByThread(focusContext.sourceThreadId);
  const summary = safeQuestions.map((question) => {
    const values = answers[question.id] ?? [];
    return `${question.question || question.header}: ${values.join("; ")}`;
  }).filter(Boolean).join(" | ").slice(0, 3_000);
  try {
    focusStore.appendEvent(focusContext.projectId, {
      workId: work?.id ?? null,
      kind: "question-answered",
      message: `${source === "user" ? "The user" : "The Focus coordinator"} answered a worker question.${summary ? ` Quoted question and answer context: ${summary}` : " Secret answer omitted from durable context."}`,
      focusCoordinatorQuestion: true,
      wasVisible: pending.visible === true,
      userEscalated: pending.visible === true,
      source,
      sourceThreadId: focusContext.sourceThreadId,
      workerCount: members.length,
      request: {
        id: String(pending.request.id),
        generation: pending.generation,
        questions: safeQuestions
      },
      answers,
      redactedCount: leaderQuestions.length - safeQuestions.length
    });
    send("FocusUpdated", { projectId: focusContext.projectId });
    void focusSupervisor.flush(focusContext.projectId).catch((error) => {
      codexRuntime.emit("diagnostic", `Focus question receipt delivery failed: ${error.message}`);
    });
  } catch (error) {
    codexRuntime.emit("diagnostic", `Focus question receipt could not be saved: ${error.message}`);
  }
}

function respondToPendingQuestion(pending, { action = "answer", answers = {} } = {}) {
  const textAnswers = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, Array.isArray(answer) ? answer.join("\n") : answer]));
  if (pending.kind === "pixice-question-tool") {
    runtime.respond(pending.request.id, pixiceQuestionToolResult({ action, answers: textAnswers }));
    return;
  }
  if (pending.kind === "pixice-question") {
    runtime.respond(pending.request.id, { action, answers: textAnswers });
    return;
  }
  if (pending.request.method?.includes("requestUserInput")) {
    const nativeAnswers = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: Array.isArray(answer) ? answer : [answer] }]));
    runtime.respond(pending.request.id, { answers: nativeAnswers });
    return;
  }
  throw new Error("Pending request is not a question");
}

function respondToFocusQuestion(pending, result, { source = "coordinator" } = {}) {
  const key = requestKey(pending.request.id);
  const grouped = focusQuestionGroups.resolve(key, pending.generation, result.answers ?? {});
  const members = grouped.length ? grouped : [{ key, generation: pending.generation, answers: result.answers ?? {} }];
  for (const member of members) {
    const current = pendingRequests.get(member.key);
    if (current?.generation !== member.generation) continue;
    respondToPendingQuestion(current, { ...result, answers: member.answers });
    pendingRequests.delete(member.key);
    send("AttentionResolved", { requestId: current.request.id, requestGeneration: current.generation, threadId: current.request.params?.threadId });
  }
  recordFocusQuestionAnswer(pending, members, source);
}

function removeFocusQuestionMember(key, generation) {
  const next = focusQuestionGroups.remove(key, generation);
  if (!next?.promoted) return;
  const promoted = pendingRequests.get(next.leaderKey);
  if (promoted?.generation !== next.leaderGeneration || !promoted.focusContext) return;
  void scheduleFocusQuestionReview(next.leaderKey, promoted.focusContext);
}

function showFocusCoordinatorQuestion(pending, focusContext, escalation = "") {
  const detail = typeof escalation === "string" ? { reason: escalation } : escalation ?? {};
  const memberCount = focusQuestionGroups.members(requestKey(pending.request.id)).length;
  const taskTitle = memberCount > 1 ? `${memberCount} workers need this decision` : focusContext.worker ? database.getThreadName(focusContext.sourceThreadId) : null;
  const originalQuestions = pending.displayRequest.params?.questions ?? [];
  const questions = originalQuestions.map((question, index) => {
    const rewrite = detail.questions?.[question.id] ?? {};
    const coordinatorQuestion = rewrite.question || (originalQuestions.length === 1 ? detail.question : "");
    const recommendation = rewrite.recommendation || (originalQuestions.length === 1 ? detail.recommendation : "");
    return {
      ...question,
      id: question.id ?? `question-${index + 1}`,
      ...(secretFocusQuestion(question) ? { isSecret: true } : {}),
      ...(coordinatorQuestion ? { question: coordinatorQuestion, originalQuestion: question.question } : {}),
      ...(recommendation ? { coordinatorRecommendation: recommendation } : {})
    };
  });
  const displayRequest = {
    ...pending.displayRequest,
    requestGeneration: pending.generation,
    focusManaged: true,
    focusCoordinatorQuestion: true,
    taskTitle,
    projectId: focusContext.projectId,
    params: {
      ...pending.displayRequest.params,
      threadId: focusContext.focusThreadId,
      sourceThreadId: focusContext.sourceThreadId,
      isBlocking: false,
      ...(focusContext.worker ? { workerCount: memberCount || 1 } : {}),
      questions,
      ...(detail.reason ? { coordinatorReason: detail.reason } : {}),
      ...(detail.question ? { coordinatorQuestion: detail.question } : {}),
      ...(detail.recommendation ? { coordinatorRecommendation: detail.recommendation } : {})
    }
  };
  pending.displayRequest = displayRequest;
  pending.visible = true;
  send("AttentionRequired", displayRequest);
}

function listFocusCoordinatorQuestions(projectId) {
  return [...pendingRequests.values()]
    .filter((pending) => pending.visible === true
      && pending.displayRequest?.focusCoordinatorQuestion === true
      && pending.focusContext?.projectId === projectId)
    .map((pending) => ({
      requestId: String(pending.request.id),
      requestGeneration: pending.generation,
      questions: pending.displayRequest.params?.questions ?? [],
      reason: pending.displayRequest.params?.coordinatorReason ?? "",
      recommendation: pending.displayRequest.params?.coordinatorRecommendation ?? "",
      sourceThreadId: pending.focusContext.sourceThreadId,
      taskTitle: pending.displayRequest.taskTitle ?? null
    }));
}

function answerFocusCoordinatorQuestion(projectId, input) {
  const pending = [...pendingRequests.values()].find((candidate) =>
    candidate.visible === true
    && candidate.displayRequest?.focusCoordinatorQuestion === true
    && candidate.focusContext?.projectId === projectId
    && String(candidate.request.id) === String(input.requestId)
    && candidate.generation === input.requestGeneration
  );
  if (!pending) throw new Error("Worker question is no longer pending in this Focus conversation");
  const answers = input.answers ?? {};
  const requiredIds = questionIds(pending.displayRequest);
  if (requiredIds.some((id) => !String(answers[id] ?? "").trim())) {
    throw new Error("Answer every worker question using its original question ID");
  }
  respondToFocusQuestion(pending, { action: "answer", answers }, { source: "coordinator" });
  pendingRequests.delete(requestKey(pending.request.id));
  return { ok: true, requestId: String(pending.request.id), requestGeneration: pending.generation };
}

async function completeFocusQuestionReview(threadId, turn) {
  const review = focusQuestionReviews.get(threadId);
  if (!review) return;
  focusQuestionReviews.delete(threadId);
  clearTimeout(focusQuestionReviewTimers.get(threadId));
  focusQuestionReviewTimers.delete(threadId);
  focusQuestionReviewInFlight.delete(review.requestKey);
  const pending = pendingRequests.get(review.requestKey);
  try {
    if (!pending || pending.generation !== review.requestGeneration) return;
    let answer = finalAgentText(turn);
    if (!answer) {
      const response = await runtime.request("thread/read", { threadId, includeTurns: true });
      const current = pendingRequests.get(review.requestKey);
      if (!current || current.generation !== review.requestGeneration) return;
      const hydrated = (response?.thread?.turns ?? []).find((candidate) => candidate.id === (review.turnId ?? turn?.id));
      answer = finalAgentText(hydrated);
    }
    const result = parseFocusQuestionReview(answer, pending.displayRequest);
    if (result.action === "answer") {
      respondToFocusQuestion(pending, result);
      pendingRequests.delete(review.requestKey);
    } else {
      showFocusCoordinatorQuestion(pending, review.focusContext, result);
    }
  } catch (error) {
    if (pending?.generation === review.requestGeneration) {
      showFocusCoordinatorQuestion(pending, review.focusContext, "The coordinator could not resolve this safely from project context.");
    }
    codexRuntime.emit("diagnostic", `Focus question review failed: ${error.message}`);
  } finally {
    try {
      await runtime.request("thread/archive", { threadId });
    } catch (error) {
      codexRuntime.emit("diagnostic", `Focus question review cleanup failed: ${error.message}`);
      focusQuestionInternalThreadIds.delete(threadId);
    }
  }
}

async function focusQuestionReviewModel(focusContext) {
  const provider = runtime.providerForThread(focusContext.focusThreadId);
  const policy = focusStore.getPolicy(focusContext.projectId);
  const candidates = [turnUsageMetadata.get(focusContext.focusThreadId)?.model, policy.coordinatorModel].filter(Boolean);
  for (const model of candidates) {
    if (runtime.providerForModel(model) === provider) return model;
  }
  const models = (await runtime.request("model/list", { limit: 100 })).data ?? [];
  const matching = models.filter((model) => model.provider === provider);
  const selected = matching.find((model) => model.isDefault) ?? matching[0];
  if (!selected?.id) throw new Error(`No ${provider} model is available for coordinator question review.`);
  return selected.id;
}

async function scheduleFocusQuestionReview(requestKeyValue, focusContext) {
  if (focusQuestionReviewInFlight.has(requestKeyValue)) return;
  const pending = pendingRequests.get(requestKeyValue);
  const project = database.getProject(focusContext.projectId);
  if (!pending || !project || !runtime.connected) {
    if (pending) showFocusCoordinatorQuestion(pending, focusContext);
    return;
  }
  focusQuestionReviewInFlight.add(requestKeyValue);
  let internalThreadId = null;
  try {
    const [focusResponse, workerResponse] = await Promise.all([
      runtime.request("thread/read", { threadId: focusContext.focusThreadId, includeTurns: true }),
      runtime.request("thread/read", { threadId: focusContext.sourceThreadId, includeTurns: true })
    ]);
    const permissions = permissionSettings("read-only", project);
    const selectedModel = await focusQuestionReviewModel(focusContext);
    const work = focusStore.getWorkByThread(focusContext.sourceThreadId);
    const decisions = work ? focusStore.listDecisions(focusContext.projectId, { workId: work.id, limit: 40 }) : [];
    const memory = pixiceFocusMemory.read(focusContext.projectId);
    const latestSequence = focusStore.latestSequence(focusContext.projectId);
    const priorAnswers = focusStore.listEvents(focusContext.projectId, { after: Math.max(0, latestSequence - 100), limit: 100 })
      .filter((event) => event.kind === "question-answered")
      .slice(-10)
      .map(({ request, answers, source, createdAt }) => ({ request, answers, source, createdAt }));
    const started = await runtime.request("thread/start", {
      cwd: projectPrimaryRoot(project),
      runtimeWorkspaceRoots: runtimeRoots(project),
      model: selectedModel,
      ephemeral: true,
      permissionMode: "read-only",
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: [
        focusAgentInstructions(project),
        "",
        "# Worker question review",
        "Resolve as much as the project coordinator safely can without interrupting the user.",
        "Answer from explicit durable directions, prior accepted answers, known project facts, or conservative reversible technical judgment. For option questions, use the exact option label. Never invent a personal preference or unknown fact.",
        "Escalate only when work needs an unknown external fact, credential, meaningful irreversible authority, external commitment, or a genuine user choice that changes product direction.",
        "When escalating, rewrite each question in calm coordinator language and recommend an option when project evidence supports one. Preserve the supplied question IDs and option meanings.",
        "Return JSON only. Answer: {\"action\":\"answer\",\"answers\":{\"question_id\":\"answer\"}}. Escalate: {\"action\":\"escalate\",\"reason\":\"why user input is required\",\"questions\":{\"question_id\":{\"question\":\"coordinator wording\",\"recommendation\":\"recommended choice and why\"}}}."
      ].join("\n"),
      dynamicTools: [],
      internalNoTools: true,
      threadSource: "pixiceFocusQuestionReview"
    });
    internalThreadId = started.thread?.id;
    if (!internalThreadId) throw new Error("Question review did not create a thread");
    focusQuestionInternalThreadIds.add(internalThreadId);
    focusQuestionReviews.set(internalThreadId, {
      requestKey: requestKeyValue,
      requestGeneration: pending.generation,
      focusContext,
      turnId: null
    });
    const prompt = [
      "DURABLE WORK:",
      work ? JSON.stringify({ id: work.id, title: work.title, prompt: work.prompt, access: work.access, resources: work.resources, status: work.status }, null, 2) : "(untracked Focus worker)",
      "",
      "CURRENT SCOPED DIRECTIONS:",
      decisions.length ? JSON.stringify(decisions.map(({ revision, text, sourceThreadId, createdAt }) => ({ revision, text, sourceThreadId, createdAt })), null, 2) : "(none)",
      "",
      "PROJECT MEMORY:",
      String(memory.projectMemory || "(empty)").slice(0, 12_000),
      "",
      "USER PREFERENCES:",
      String(memory.userMemory || "(empty)").slice(0, 8_000),
      "",
      "PRIOR ACCEPTED WORKER ANSWERS:",
      priorAnswers.length ? JSON.stringify(priorAnswers, null, 2).slice(0, 16_000) : "(none)",
      "",
      "RECENT FOCUS CONVERSATION:",
      String(focusMemoryTranscript(focusResponse.thread) || "(empty)").slice(-24_000),
      "",
      `WORKER: ${database.getThreadName(focusContext.sourceThreadId) || focusContext.sourceThreadId}`,
      String(focusMemoryTranscript(workerResponse.thread) || "(no worker transcript)").slice(-20_000),
      "",
      "WORKER QUESTIONS:",
      JSON.stringify(pending.displayRequest.params?.questions ?? [], null, 2),
      "",
      "Return the coordinator decision as JSON only."
    ].join("\n").slice(-90_000);
    const response = await runtime.request("turn/start", {
      threadId: internalThreadId,
      input: buildCodexUserInput(prompt, []),
      cwd: projectPrimaryRoot(project),
      runtimeWorkspaceRoots: runtimeRoots(project),
      model: selectedModel,
      effort: null,
      permissionMode: "read-only",
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy
    });
    const review = focusQuestionReviews.get(internalThreadId);
    if (review) {
      review.turnId = response.turn?.id ?? null;
      const timer = setTimeout(() => {
        const expired = focusQuestionReviews.get(internalThreadId);
        if (!expired) return;
        focusQuestionReviews.delete(internalThreadId);
        focusQuestionReviewTimers.delete(internalThreadId);
        focusQuestionReviewInFlight.delete(expired.requestKey);
        const latest = pendingRequests.get(expired.requestKey);
        if (latest?.generation === expired.requestGeneration) {
          showFocusCoordinatorQuestion(latest, expired.focusContext, "The coordinator could not resolve this worker question in time.");
        }
        if (expired.turnId) void runtime.request("turn/interrupt", { threadId: internalThreadId, turnId: expired.turnId }).catch(() => {});
        void runtime.request("thread/archive", { threadId: internalThreadId }).catch(() => {});
      }, 120_000);
      timer.unref?.();
      focusQuestionReviewTimers.set(internalThreadId, timer);
    }
  } catch (error) {
    focusQuestionReviewInFlight.delete(requestKeyValue);
    if (internalThreadId) {
      focusQuestionReviews.delete(internalThreadId);
      focusQuestionInternalThreadIds.delete(internalThreadId);
      clearTimeout(focusQuestionReviewTimers.get(internalThreadId));
      focusQuestionReviewTimers.delete(internalThreadId);
    }
    const latest = pendingRequests.get(requestKeyValue);
    if (latest?.generation === pending?.generation) showFocusCoordinatorQuestion(latest, focusContext);
    codexRuntime.emit("diagnostic", `Focus question review could not start: ${error.message}`);
  }
}

async function createProjectFocusSession({ project, model, serviceTier }) {
  const focusPermissionMode = FOCUS_PERMISSION_MODE;
  const permissions = permissionSettings(focusPermissionMode, project);
  const response = await runtime.request("thread/start", {
    cwd: projectPrimaryRoot(project),
    runtimeWorkspaceRoots: runtimeRoots(project),
    model: model || null,
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    permissionMode: focusPermissionMode,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandbox: permissions.sandbox,
    developerInstructions: focusAgentInstructions(project),
    dynamicTools: focusDynamicTools,
    threadSource: "pixice"
  });
  rememberThread(project, response.thread, { loaded: true });
  const session = database.saveProjectFocusSession({ projectId: project.id, threadId: response.thread.id });
  focusStore?.updatePolicy(project.id, { coordinatorModel: model || null });
  const name = `${project.displayName} Focus`;
  database.saveThreadName(response.thread.id, name);
  try {
    await runtime.request("thread/name/set", { threadId: response.thread.id, name });
  } catch (error) {
    codexRuntime.emit("diagnostic", `Focus thread name could not be saved to the provider: ${error.message}`);
  }
  return {
    created: true,
    session,
    memory: pixiceFocusMemory.read(project.id),
    configuration: { provider: runtime.providerForThread(response.thread.id), model: model || null },
    thread: projectRendererThread(withPersistedThreadName({ ...response.thread, name }))
  };
}

async function ensureProjectFocusSession({ project, model, serviceTier, replaceEmpty = false }) {
  if (!replaceEmpty) model = focusStore?.getPolicy(project.id).coordinatorModel ?? model;
  const existing = database.getProjectFocusSession(project.id);
  if (existing) {
    await ensureThreadLoaded(project, existing.threadId);
    const response = await runtime.request("thread/read", { threadId: existing.threadId, includeTurns: true });
    rememberThread(project, response.thread, { loaded: true });
    const provider = runtime.providerForThread(existing.threadId);
    const requestedProvider = model ? runtime.providerForModel(model) : provider;
    const canReplace = replaceEmpty
      && existing.userTurnCount === 0
      && Array.isArray(response.thread?.turns)
      && response.thread.turns.length === 0
      && !activeTurns.has(existing.threadId)
      && !startingTurns.has(existing.threadId);
    if (requestedProvider !== provider && canReplace) {
      const replacement = await createProjectFocusSession({ project, model, serviceTier });
      threadSessions.delete(existing.threadId);
      threadProjects.delete(existing.threadId);
      turnUsageMetadata.delete(existing.threadId);
      try {
        await runtime.request("thread/archive", { threadId: existing.threadId, provider });
      } catch (error) {
        codexRuntime.emit("diagnostic", `Unused Focus thread cleanup failed: ${error.message}`);
      }
      return { ...replacement, replacedThreadId: existing.threadId };
    }
    return {
      created: false,
      session: existing,
      memory: pixiceFocusMemory.read(project.id),
      configuration: { provider, model: requestedProvider === provider ? model || null : null },
      thread: projectRendererThread(withPersistedThreadName(response.thread))
    };
  }
  return createProjectFocusSession({ project, model, serviceTier });
}

async function focusModel(model, task = "", { bridgeOnly = true } = {}) {
  const models = (await runtime.request("model/list", { limit: 100 })).data ?? [];
  const catalog = bridgeOnly ? bridgeEligibleModels(models) : models;
  const selected = model
    ? catalog.find((candidate) => candidate.id === model || candidate.model === model)
    : catalog.find((candidate) => candidate.id === recommendBridgeModel(catalog, task)?.modelId);
  if (!selected) throw new Error(model ? `Focus model ${model} is unavailable on this host.` : "No connected model is available for Focus workers.");
  return selected;
}

async function deliverFocusEvents({ projectId, coordinatorThreadId, events: updates }) {
  const project = getProject(projectId);
  if (!acceptingWork) throw new Error("The host is stopping; Focus updates remain saved.");
  if (startingTurns.has(coordinatorThreadId)) throw new Error("Coordinator is starting a turn; delivery remains pending.");
  const prompt = [
    "[Pixice Focus work updates]",
    "These are persisted worker lifecycle notifications, not new user instructions. Review the outcomes with read_work, verify evidence, reconcile current decisions, and integrate a useful response into this project conversation. A worker finishing is not proof that the user's goal is met. Do not echo routine status or start duplicate work.",
    JSON.stringify(updates.map(({ id, workId, kind, message }) => ({ id, workId, kind, message: String(message ?? "").slice(0, 1500) })))
  ].join("\n\n");
  const input = buildCodexUserInput(prompt, []);
  const activeTurn = activeTurns.get(coordinatorThreadId);
  if (activeTurn) {
    await steerBridgeParentTurn(coordinatorThreadId, activeTurn, input);
    return { action: "steered", turnId: activeTurn };
  }
  const previous = turnUsageMetadata.get(coordinatorThreadId) ?? {};
  const model = previous.model ?? focusStore.getPolicy(projectId).coordinatorModel ?? undefined;
  return startTrackedTurn({ project, threadId: coordinatorThreadId, input, text: prompt, model, effort: previous.effort, permissionMode: FOCUS_PERMISSION_MODE, trackTask: false });
}

function boundedTextResult(value, maximumBytes) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.byteLength <= maximumBytes) return { content: buffer.toString("utf8"), truncated: false };
  return { content: buffer.subarray(0, maximumBytes).toString("utf8"), truncated: true };
}

function compactRepository(repository) {
  const dirtyPaths = (repository.dirtyPaths ?? []).slice(0, 1_000);
  return {
    kind: repository.kind,
    git: repository.git,
    baseCommit: repository.baseCommit,
    dirtyPaths,
    dirtyCount: repository.dirtyPaths?.length ?? 0,
    truncated: (repository.dirtyPaths?.length ?? 0) > dirtyPaths.length
  };
}

function instrumentTargetVersion(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readInstrumentCapability({ projectId, threadId, capability, arguments: rawArguments }) {
  const project = getProject(projectId);
  const emptyArguments = z.object({}).strict();
  if (capability === "project.summary") {
    emptyArguments.parse(rawArguments);
    return {
      id: project.id,
      name: project.displayName,
      folders: projectRoots(project).slice(0, 20),
      repository: compactRepository(await inspectRepository(projectPrimaryRoot(project)))
    };
  }
  if (capability === "git.status") {
    emptyArguments.parse(rawArguments);
    const repository = await inspectRepository(projectPrimaryRoot(project));
    return compactRepository(repository);
  }
  if (capability === "git.diff") {
    const value = z.object({ maxBytes: z.number().int().min(1_000).max(160_000).default(80_000) }).strict().parse(rawArguments);
    const primaryRoot = projectPrimaryRoot(project);
    const repository = await inspectRepository(primaryRoot);
    const diff = repository.kind === "git"
      ? await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: primaryRoot, gitExecutablePath: repository.git?.executablePath })
      : "";
    return { ...boundedTextResult(diff, value.maxBytes), baseCommit: repository.baseCommit };
  }
  if (capability === "files.readText") {
    const value = z.object({ path: z.string().trim().min(1), maxBytes: z.number().int().min(1_000).max(160_000).default(80_000) }).strict().parse(rawArguments);
    const file = readProjectFile(projectId, value.path);
    if (typeof file.content !== "string") throw new Error("Instrument file sources support text files only");
    return { path: file.relativePath, language: file.language, ...boundedTextResult(file.content, value.maxBytes) };
  }
  if (capability === "board.list") {
    emptyArguments.parse(rawArguments);
    return database.listBoardTasks(projectId).slice(0, 200).map((task) => ({
      id: task.id,
      title: task.title,
      description: String(task.description ?? "").slice(0, 500),
      column: task.column,
      threadId: task.threadId,
      updatedAt: task.updatedAt
    }));
  }
  if (capability === "workflows.list") {
    emptyArguments.parse(rawArguments);
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
    return integration.workflows.list(projectId).slice(0, 200).map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: String(workflow.description ?? "").slice(0, 500),
      enabled: workflow.enabled,
      updatedAt: workflow.updatedAt
    }));
  }
  if (capability === "workflow.output") {
    const value = z.object({
      workflowId: z.string().trim().min(1).max(160),
      runId: z.string().trim().min(1).max(160).optional()
    }).strict().parse(rawArguments);
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
    const result = integration.workflows.read(projectId, value.workflowId);
    const run = value.runId ? result.runs.find((candidate) => candidate.id === value.runId) : result.runs[0];
    if (value.runId && !run) throw new Error("Workflow run not found in this project");
    return run ? {
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      output: run.output,
      error: run.error,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt
    } : null;
  }
  if (capability === "tasks.plan") {
    emptyArguments.parse(rawArguments);
    if (!threadId) throw new Error("The Instrument is not attached to a thread");
    return (threadPlans.get(threadId) ?? database.getThreadPlan(threadId) ?? []).slice(0, 200).map((step) => ({
      step: String(step.step ?? step.description ?? "").slice(0, 1_000),
      status: step.status,
      detail: step.detail ? String(step.detail).slice(0, 500) : undefined
    }));
  }
  throw new Error(`Unsupported Instrument capability: ${capability}`);
}

async function resolveInstrumentCapability({ projectId, capability, arguments: rawArguments }) {
  getProject(projectId);
  if (capability === "board.create") {
    const value = z.object({
      title: boardTaskTitleSchema,
      description: boardTaskDescriptionSchema.default(""),
      column: boardColumnSchema.default("backlog")
    }).strict().parse(rawArguments);
    return { arguments: value, targetVersion: null, summary: `Create “${value.title}” in ${value.column}.` };
  }
  if (capability === "board.update") {
    const value = z.object({
      taskId: z.string().min(1),
      title: boardTaskTitleSchema.optional(),
      description: boardTaskDescriptionSchema.optional()
    }).strict().refine((entry) => entry.title !== undefined || entry.description !== undefined, "A board task change is required").parse(rawArguments);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== projectId) throw new Error("Work item not found in this project");
    const changes = [value.title !== undefined ? `rename it to “${value.title}”` : null, value.description !== undefined ? "replace its description" : null].filter(Boolean).join(" and ");
    return { arguments: value, targetVersion: instrumentTargetVersion(task), summary: `Update “${task.title}”: ${changes}.` };
  }
  if (capability === "board.move") {
    const value = z.object({
      taskId: z.string().min(1),
      column: boardColumnSchema,
      beforeTaskId: z.string().min(1).optional()
    }).strict().parse(rawArguments);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== projectId) throw new Error("Work item not found in this project");
    let before = null;
    if (value.beforeTaskId) {
      before = database.getBoardTask(value.beforeTaskId);
      if (!before || before.projectId !== projectId || before.column !== value.column) throw new Error("The target task is invalid for this move");
    }
    return {
      arguments: value,
      targetVersion: instrumentTargetVersion([task, before]),
      summary: `Move “${task.title}” from ${task.column} to ${value.column}${before ? ` before “${before.title}”` : ""}.`
    };
  }
  if (capability === "workflow.run") {
    const value = z.object({
      workflowId: z.string().trim().min(1).max(160),
      input: z.unknown().optional(),
      triggerNodeId: z.string().trim().min(1).max(160).optional()
    }).strict().parse(rawArguments);
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
    const { workflow } = integration.workflows.read(projectId, value.workflowId);
    return { arguments: value, targetVersion: instrumentTargetVersion(workflow), summary: `Run workflow “${workflow.name}”.` };
  }
  throw new Error(`Unsupported trusted Instrument capability: ${capability}`);
}

async function invokeInstrumentCapability({ projectId, threadId, capability, arguments: rawArguments, resolution }) {
  const currentResolution = await resolveInstrumentCapability({ projectId, threadId, capability, arguments: rawArguments });
  if (resolution?.targetVersion !== null && resolution?.targetVersion !== undefined && resolution.targetVersion !== currentResolution.targetVersion) {
    throw new Error("The action target changed after confirmation. Review the current state and try again.");
  }
  const value = currentResolution.arguments;
  if (capability === "board.create") {
    const task = database.createBoardTask({ id: randomUUID(), projectId, ...value, createdByThreadId: threadId });
    send("BoardUpdated", { action: "created", projectId, task });
    return task;
  }
  if (capability === "board.update") {
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== projectId) throw new Error("Work item not found in this project");
    const updated = database.updateBoardTask(value.taskId, value);
    send("BoardUpdated", { action: "updated", projectId, task: updated });
    return updated;
  }
  if (capability === "board.move") {
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== projectId) throw new Error("Work item not found in this project");
    if (value.beforeTaskId) {
      const before = database.getBoardTask(value.beforeTaskId);
      if (!before || before.projectId !== projectId || before.column !== value.column) throw new Error("The target task is invalid for this move");
    }
    const moved = database.moveBoardTask(value.taskId, value.column, value.beforeTaskId ?? null);
    send("BoardUpdated", { action: "moved", projectId, task: moved });
    return moved;
  }
  if (capability === "workflow.run") {
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
    return integration.workflows.startRun({
      projectId,
      workflowId: value.workflowId,
      input: value.input ?? {},
      triggerNodeId: value.triggerNodeId ?? null,
      sourceThreadId: threadId
    });
  }
  throw new Error(`Unsupported trusted Instrument capability: ${capability}`);
}

function instrumentEventPrompt(instrument, event) {
  return [
    `[Pixice Instrument interaction: ${event.event}]`,
    `Instrument: ${instrument.document.title}`,
    `Instrument ID: ${instrument.id}`,
    "The user deliberately activated this Instrument action.",
    "Payload:",
    JSON.stringify(event.payload, null, 2),
    "Continue the task using this input. Inspect and update the same Instrument when its interface or data should change."
  ].join("\n");
}

async function deliverInstrumentAgentEvent({ instrument, event, runtimeOptions }) {
  const project = getProject(instrument.projectId);
  const cwd = await ensureThreadLoaded(project, instrument.threadId);
  const prompt = instrumentEventPrompt(instrument, event);
  const activeTurnId = activeTurns.get(instrument.threadId);
  if (activeTurnId) {
    return runtime.request("turn/steer", {
      threadId: instrument.threadId,
      expectedTurnId: activeTurnId,
      input: buildCodexUserInput(prompt, [])
    });
  }
  const defaults = database.getAppSettings();
  const permissionMode = runtimeOptions.permissionMode ?? defaults.defaultPermissionMode ?? "workspace-write";
  const permissions = permissionSettings(permissionMode, project);
  const model = runtimeOptions.model ?? defaults.defaultModel ?? null;
  const effort = runtimeOptions.effort ?? defaults.defaultEffort ?? null;
  const serviceTier = runtimeOptions.serviceTier ?? null;
  const response = await runtime.request("turn/start", {
    threadId: instrument.threadId,
    input: buildCodexUserInput(prompt, []),
    cwd,
    runtimeWorkspaceRoots: runtimeRoots(project),
    model,
    ...(runtimeOptions.serviceTier !== undefined ? { serviceTier } : {}),
    effort,
    permissionMode,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy
  });
  activeTurns.set(instrument.threadId, response.turn.id);
  turnUsageMetadata.set(instrument.threadId, {
    turnId: response.turn.id,
    model,
    serviceTier,
    effort,
    permissionMode,
    provider: runtime.providerForThread(instrument.threadId)
  });
  updateTrayMenu();
  return response;
}

async function startBridgeParentTurn(parentThreadId, input) {
  const project = trayProjectForThread(parentThreadId);
  if (!project) throw new Error("The bridge parent is not linked to a Pixice project");
  const cwd = await ensureThreadLoaded(project, parentThreadId);
  const defaults = database.getAppSettings();
  const previous = turnUsageMetadata.get(parentThreadId) ?? {};
  const permissionMode = previous.permissionMode ?? defaults.defaultPermissionMode ?? "workspace-write";
  const permissions = permissionSettings(permissionMode, project);
  const model = previous.model ?? defaults.defaultModel ?? null;
  const effort = previous.effort ?? defaults.defaultEffort ?? null;
  const serviceTier = previous.serviceTier ?? null;
  const response = await runtime.request("turn/start", {
    threadId: parentThreadId,
    input,
    cwd,
    runtimeWorkspaceRoots: runtimeRoots(project),
    model,
    serviceTier,
    effort,
    permissionMode,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy
  });
  activeTurns.set(parentThreadId, response.turn.id);
  turnUsageMetadata.set(parentThreadId, {
    ...previous,
    turnId: response.turn.id,
    model,
    serviceTier,
    effort,
    permissionMode,
    provider: runtime.providerForThread(parentThreadId)
  });
  updateTrayMenu();
  return response.turn;
}

async function steerBridgeParentTurn(parentThreadId, turnId, input) {
  const project = trayProjectForThread(parentThreadId);
  if (!project) throw new Error("The bridge parent is not linked to a Pixice project");
  await ensureThreadLoaded(project, parentThreadId);
  return runtime.request("turn/steer", {
    threadId: parentThreadId,
    expectedTurnId: turnId,
    input
  });
}

function registerHandlers() {
  handlers.handle("tray:state", () => currentTrayState());
  handlers.handle("tray:refresh", () => refreshTrayState());
  handlers.handle("tray:thread", (_event, payload) => {
    const { threadId } = z.object({ threadId: z.string().min(1) }).strict().parse(payload);
    const project = trayProjectForThread(threadId);
    if (!project) throw new Error("This thread is not linked to a Pixice project");
    return { view: "task", projectId: project.id, threadId };
  });
  handlers.handle("tray:follow-up", async (_event, payload) => {
    const { threadId, text } = z.object({ threadId: z.string().min(1), text: z.string().trim().min(1).max(100_000) }).strict().parse(payload);
    const turnId = activeTurns.get(threadId);
    if (!turnId) throw new Error("This turn finished before the follow-up could be queued.");
    const project = trayProjectForThread(threadId);
    if (!project) throw new Error("This thread is not linked to a Pixice project");
    await ensureThreadLoaded(project, threadId);
    taskResults.stopReplay(threadId, true);
    await runtime.request("turn/steer", { threadId, expectedTurnId: turnId, input: buildCodexUserInput(text, []) });
    return { queued: true, threadId, turnId };
  });
  handlers.handle("app:bootstrap", async (context = {}, _payload) => ({
    projects: await listProjects(context.remote && context.access?.role === "observer" ? context.access.projectIds : null),
    models: await listModels().catch(() => []),
    runtime: { ...runtimeStatus, connected: runtime.connected },
    settings: database.getAppSettings(),
    agentBehaviors: agentBehaviorCatalog()
  }));
  handlers.handle("app:overview", () => connectOverview());
  handlers.handle("app:settings:update", async (_event, payload) => {
    const value = appDefaultsSchema.parse(payload);
    const settings = database.saveAppSettings(value);
    if (value.keepSystemAwake !== undefined) await platform.setKeepAwake(value.keepSystemAwake);
    if (value.agentBehaviors !== undefined) runtime.refreshDeveloperInstructions();
    if (value.checkProviderUpdates !== undefined) runtime.setProviderUpdateChecksEnabled(value.checkProviderUpdates);
    sendTrayState();
    return settings;
  });
  handlers.handle("runtime:status", () => ({ ...runtimeStatus, connected: runtime.connected }));
  handlers.handle("git:status", () => detectGitRuntime());
  handlers.handle("git:install-command-line-tools", () => requestCommandLineToolsInstall());
  handlers.handle("providers:list", () => runtime.listProviders());
  handlers.handle("usage:summary", (_event, payload) => {
    const { days } = z.object({ days: z.number().int().min(7).max(365).default(30) }).parse(payload ?? {});
    return {
      ...database.getUsageSummary({ days }),
      pricingVerifiedAt: PRICING_VERIFIED_AT,
      pricing: listPricingCatalog()
    };
  });
  handlers.handle("usage:limits", () => readProviderRateLimits({ codexProvider, claudeProvider }));
  handlers.handle("tasks:receipts", (_event, payload) => {
    const value = z.object({ projectId: z.string().optional(), groupId: z.string().optional() }).strict().parse(payload ?? {});
    return taskResults.list(value);
  });
  handlers.handle("tasks:receipt", (_event, payload) => {
    const { projectId, threadId } = threadPayload.strict().parse(payload);
    const receipt = taskResults.receipt(threadId);
    if (receipt && receipt.projectId !== projectId) throw new Error("This result belongs to another project.");
    return receipt;
  });
  handlers.handle("tasks:replay", async (_event, payload) => {
    const value = threadPayload.extend({ revision: z.string(), model: z.string().min(1), effort: z.string().optional(), serviceTier: z.string().nullable().optional() }).strict().parse(payload);
    if (taskResults.get(value.threadId)?.projectId !== value.projectId) throw new Error("Task result not found.");
    const models = await listModels();
    const selected = models.find((model) => model.id === value.model || model.model === value.model);
    if (!selected) throw new Error("This model is no longer connected. Refresh the model list and try again.");
    const efforts = (selected.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort ?? option.effort ?? option);
    if (value.effort && efforts.length && !efforts.includes(value.effort)) throw new Error("This model does not support the selected reasoning effort.");
    const tiers = selected.serviceTiers?.length ? selected.serviceTiers : selected.additionalSpeedTiers ?? [];
    if (value.serviceTier && !tiers.some((tier) => (tier.id ?? tier) === value.serviceTier)) throw new Error("This model does not support the selected speed tier.");
    return taskResults.replay({ ...value, model: selected.id ?? selected.model });
  });
  handlers.handle("tasks:interventions", () => ({
    requests: [...pendingRequests.values()].filter((pending) => pending.visible !== false).map(({ request, displayRequest, generation }) => {
      const threadId = request.params?.threadId;
      const projectId = connectProjectIdForEvent({ type: "AttentionRequired", payload: { ...(displayRequest ?? request), threadId } });
      return { ...(displayRequest ?? request), requestGeneration: generation, taskTitle: displayRequest?.taskTitle ?? (threadId ? database.getThreadName(threadId) : null), projectId };
    }),
  }));
  handlers.handle("providers:login", (_event, payload) => {
    const { provider } = z.object({ provider: z.string().trim().min(1).max(64) }).parse(payload);
    return startProviderLogin(provider);
  });
  const providerActionSchema = z.object({ provider: z.enum(["codex", "claude"]) }).strict();
  handlers.handle("providers:install", (_event, payload) => {
    const { provider } = providerActionSchema.parse(payload);
    return runtime.installProvider(provider);
  });
  handlers.handle("providers:locate", (_event, payload) => {
    const { provider, executablePath } = providerActionSchema.extend({
      executablePath: z.string().trim().min(1).max(4_096).optional()
    }).parse(payload);
    return locateProviderExecutable(provider, executablePath);
  });
  handlers.handle("providers:repair", (_event, payload) => {
    const { provider } = providerActionSchema.parse(payload);
    return runtime.repairProvider(provider);
  });
  handlers.handle("providers:check-updates", (_event, payload) => {
    const { provider } = z.object({ provider: z.enum(["codex", "claude"]).optional() }).strict().parse(payload ?? {});
    return runtime.checkProviderUpdates(provider);
  });
  handlers.handle("providers:update", (_event, payload) => {
    const { provider } = providerActionSchema.parse(payload);
    return runtime.updateProvider(provider);
  });
  handlers.handle("providers:logout", (_event, payload) => {
    const { provider } = providerActionSchema.parse(payload);
    return runtime.logoutProvider(provider);
  });
  handlers.handle("github:status", () => githubCli.status());
  handlers.handle("github:login", () => githubCli.login());
  handlers.handle("github:logout", () => githubCli.logout());
  const browserScope = z.object({ workspaceId: z.string().trim().min(1) });
  handlers.handle("browser:remote-frame", (_event, payload) => browserWorkspace.remoteFrame(payload));
  handlers.handle("browser:remote-input", (_event, payload) => browserWorkspace.remoteInput(payload));
  handlers.handle("browser:remote-adopt", (_event, payload) => {
    const value = z.object({ fromWorkspaceId: z.string().trim().min(1).max(240), toWorkspaceId: z.string().trim().min(1).max(240) }).strict().parse(payload);
    return browserWorkspace.adoptWorkspace(value.fromWorkspaceId, value.toWorkspaceId);
  });
  handlers.handle("browser:remote-destroy", async (_event, payload) => {
    const value = browserScope.strict().parse(payload);
    await browserWorkspace.destroyWorkspace(value.workspaceId);
    return { destroyed: true, workspaceId: value.workspaceId };
  });
  handlers.handle("browser:state", (_event, payload) => {
    const value = browserScope.parse(payload);
    return browserWorkspace.snapshot(value.workspaceId);
  });
  handlers.handle("browser:create", (_event, payload) => {
    const value = browserScope.extend({ url: z.string().optional() }).parse(payload);
    return browserWorkspace.createTab(value.workspaceId, value.url);
  });
  handlers.handle("browser:close", (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1) }).parse(payload);
    return browserWorkspace.closeTab(value.workspaceId, value.tabId);
  });
  handlers.handle("browser:activate", (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1) }).parse(payload);
    return browserWorkspace.activateTab(value.workspaceId, value.tabId);
  });
  handlers.handle("browser:navigate", async (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1).optional(), url: z.string().trim().min(1) }).parse(payload);
    return browserWorkspace.navigate(value);
  });
  handlers.handle("browser:history", (_event, payload) => {
    const value = browserScope.extend({ action: z.enum(["back", "forward", "reload", "stop"]) }).parse(payload);
    return browserWorkspace.history(value.workspaceId, value.action);
  });
  handlers.handle("browser:viewport", (_event, payload) => {
    const value = browserScope.extend({
      visible: z.boolean(),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional()
    }).parse(payload);
    return browserWorkspace.setViewport(value);
  });
  handlers.handle("browser:adopt", async (_event, payload) => {
    const value = z.object({ fromWorkspaceId: z.string().trim().min(1), toWorkspaceId: z.string().trim().min(1) }).parse(payload);
    const state = await browserWorkspace.adoptWorkspace(value.fromWorkspaceId, value.toWorkspaceId);
    previewContextRegistry.adopt(value.fromWorkspaceId, value.toWorkspaceId);
    await iosRuntimeService?.adopt(value.fromWorkspaceId, value.toWorkspaceId);
    return state;
  });
  handlers.handle("browser:destroy", async (_event, payload) => {
    const value = browserScope.parse(payload);
    await browserWorkspace.destroyWorkspace(value.workspaceId);
    previewContextRegistry.clear(value.workspaceId);
    await iosRuntimeService?.stop(value.workspaceId, "Preview workspace closed");
    return { destroyed: true, workspaceId: value.workspaceId };
  });
  handlers.handle("preview:context", (_event, payload) => {
    const value = z.object({ threadId: z.string().trim().min(1), context: previewContextSchema }).strict().parse(payload);
    return previewContextRegistry.set(value.threadId, value.context);
  });

  const transcriptionModelPayload = z.object({ modelId: z.enum(TRANSCRIPTION_MODEL_IDS) }).strict();
  const transcriptionSessionPayload = z.object({ sessionId: z.string().uuid() }).strict();
  handlers.handle("transcription:state", () => transcriptionService.state());
  handlers.handle("transcription:install", (_event, payload) => {
    return transcriptionService.install(transcriptionModelPayload.parse(payload).modelId);
  });
  handlers.handle("transcription:install-cancel", (_event, payload) => {
    return transcriptionService.cancelInstall(transcriptionModelPayload.parse(payload).modelId);
  });
  handlers.handle("transcription:remove", (_event, payload) => {
    return transcriptionService.remove(transcriptionModelPayload.parse(payload).modelId);
  });
  handlers.handle("transcription:select", async (_event, payload) => {
    const value = z.object({ modelId: z.enum(TRANSCRIPTION_MODEL_IDS).nullable() }).strict().parse(payload);
    database.saveAppSettings({ transcriptionModel: value.modelId });
    return transcriptionService.select(value.modelId);
  });
  handlers.handle("transcription:configure", async (_event, payload) => {
    const value = z.object({
      numThreads: z.number().int().min(1).max(16).optional(),
      provider: z.enum(["cpu", "coreml"]).optional(),
      language: z.string().trim().max(16).optional()
    }).strict().parse(payload);
    const state = await transcriptionService.configure(value);
    database.saveAppSettings({ transcriptionSettings: state.settings });
    return state;
  });
  handlers.handle("transcription:start", (_event, payload) => {
    const value = z.object({
      modelId: z.enum(TRANSCRIPTION_MODEL_IDS).nullish(),
      deviceId: z.string().trim().max(200).nullish()
    }).strict().parse(payload ?? {});
    return transcriptionService.startSession({ modelId: value.modelId ?? null, deviceId: value.deviceId ?? null });
  });
  handlers.handle("transcription:chunk", (_event, payload) => {
    // Audio arrives base64-encoded so it survives the JSON transport that both
    // the local IPC bridge and Pixice Connect already use.
    const value = transcriptionSessionPayload.extend({
      pcm: z.string().max(4 * 1024 * 1024)
    }).strict().parse(payload);
    return transcriptionService.appendChunk(value.sessionId, Buffer.from(value.pcm, "base64"));
  });
  handlers.handle("transcription:finish", (_event, payload) => {
    return transcriptionService.finishSession(transcriptionSessionPayload.parse(payload).sessionId);
  });
  handlers.handle("transcription:abort", (_event, payload) => {
    return transcriptionService.abortSession(transcriptionSessionPayload.parse(payload).sessionId);
  });

  const iosWorkspaceScope = z.object({ workspaceId: z.string().trim().min(1).max(200) }).strict();
  const iosProjectContext = (projectId) => {
    const project = getProject(projectId);
    return {
      projectId: project.id,
      cwd: projectPrimaryRoot(project),
      roots: projectRoots(project)
    };
  };
  handlers.handle("ios:environment", () => iosRuntimeService.environment());
  handlers.handle("ios:discover", async (_event, payload) => {
    const value = idPayload.strict().parse(payload);
    const result = await iosRuntimeService.discover(iosProjectContext(value.projectId));
    return result.containers ?? result;
  });
  handlers.handle("ios:create-starter", (_event, payload) => {
    const value = idPayload.extend({
      name: z.string().trim().min(1).max(80),
      relativeDirectory: z.string().trim().min(1).max(1_000).optional()
    }).strict().parse(payload);
    return iosRuntimeService.createStarter(iosProjectContext(value.projectId), {
      name: value.name,
      productName: value.name,
      displayName: value.name,
      relativeDirectory: value.relativeDirectory,
      directory: value.relativeDirectory
    });
  });
  handlers.handle("ios:start", (_event, payload) => {
    const value = iosWorkspaceScope.extend({
      projectId: z.string().trim().min(1),
      containerPath: z.string().trim().min(1).max(10_000),
      scheme: z.string().trim().min(1).max(500),
      simulatorUdid: z.string().trim().min(1).max(200),
      configuration: z.string().trim().min(1).max(200).default("Debug")
    }).parse(payload);
    return iosRuntimeService.start({ ...iosProjectContext(value.projectId), ...value, source: "user" });
  });
  handlers.handle("ios:state", (_event, payload) => {
    const value = iosWorkspaceScope.parse(payload);
    return iosRuntimeService.status(value.workspaceId);
  });
  handlers.handle("ios:stop", (_event, payload) => {
    const value = iosWorkspaceScope.parse(payload);
    return iosRuntimeService.stop(value.workspaceId, "Stopped from Preview");
  });
  handlers.handle("ios:action", (_event, payload) => {
    const value = iosWorkspaceScope.extend({
      action: z.enum(["inspect", "tap", "type", "swipe", "button", "rotate", "appearance", "screenshot", "logs"])
    }).passthrough().parse(payload);
    const { workspaceId, action, ...argumentsValue } = value;
    return iosRuntimeService.action(workspaceId, action, iosToolSchemas[action].parse(argumentsValue));
  });
  handlers.handle("ios:adopt", (_event, payload) => {
    const value = z.object({
      fromWorkspaceId: z.string().trim().min(1).max(200),
      toWorkspaceId: z.string().trim().min(1).max(200)
    }).strict().parse(payload);
    return iosRuntimeService.adopt(value.fromWorkspaceId, value.toWorkspaceId);
  });

  handlers.handle("projects:list", (context = {}, _payload) => listProjects(context.remote && context.access?.role === "observer" ? context.access.projectIds : null));
  handlers.handle("projects:touch", (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = database.touchProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  });
  handlers.handle("projects:pick-folders", () => pickProjectFolders());
  handlers.handle("projects:create", async (_event, payload) => {
    const value = createProjectPayload.parse(payload);
    const folders = canonicalProjectFolders(value.folders);
    const existing = folders.map((folder) => database.getProjectByFolder(folder)).find(Boolean);
    if (existing) throw new Error(`A selected folder already belongs to ${existing.displayName}`);
    const now = new Date().toISOString();
    const project = database.createProject({
      id: randomUUID(),
      canonicalPath: folders[0],
      displayName: value.displayName,
      icon: value.icon,
      color: value.color,
      folders,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now
    });
    return projectWithRepository(project);
  });
  handlers.handle("projects:delete", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    projectDeletionTombstones.set(projectId, { projectId, expiresAt: Date.now() + 60 * 60_000 });
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    integration.workflows.deleteProject(projectId);
    integration.credentialStore.deleteProject(projectId);
    pixiceInstruments.deleteProject(projectId);
    database.deleteProject(projectId);
    for (const [threadId, knownProjectId] of threadProjects) {
      if (knownProjectId === projectId) threadProjects.delete(threadId);
    }
    send("ProjectDeleted", { projectId });
    return project;
  });
  handlers.handle("projects:open", async () => {
    const [canonicalPath] = await pickProjectFolders({ multiple: false });
    if (!canonicalPath) return null;
    const existing = database.getProjectByFolder(canonicalPath);
    if (existing) return projectWithRepository(database.touchProject(existing.id));
    const now = new Date().toISOString();
    const project = database.upsertProject({
      id: randomUUID(),
      canonicalPath,
      displayName: path.basename(canonicalPath),
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now
    });
    return projectWithRepository(project);
  });

  handlers.handle("board:list", (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    getProject(projectId);
    return { data: database.listBoardTasks(projectId), phases: database.listBoardPhases(projectId) };
  });
  handlers.handle("board:read", (_event, payload) => {
    const value = boardTaskPayload.parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    return { task, activity: database.listBoardTaskActivity(task.id) };
  });
  handlers.handle("proactivity:list", (_event, payload) => {
    const value = idPayload.extend({ threadId: z.string().min(1).optional() }).parse(payload);
    getProject(value.projectId);
    return { data: proactiveStewardship.list(value.projectId, value.threadId ?? null) };
  });
  handlers.handle("proactivity:resolve", async (_event, payload) => {
    const value = idPayload.extend({
      suggestionId: z.string().min(1),
      decision: z.enum(["accept", "dismiss"])
    }).parse(payload);
    getProject(value.projectId);
    return proactiveStewardship.resolve(value);
  });
  handlers.handle("board:create", (_event, payload) => {
    const value = idPayload.extend({
      title: boardTaskTitleSchema,
      description: boardTaskDescriptionSchema.default(""),
      column: boardColumnSchema.default("backlog"),
      kind: boardTaskKindSchema.default("task"),
      priority: boardTaskPrioritySchema.default("normal"),
      estimateMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
      owner: z.string().trim().max(160).default(""),
      schedule: boardTaskScheduleSchema.optional(),
      dependencies: z.array(boardTaskDependencySchema).max(100).default([])
    }).parse(payload);
    getProject(value.projectId);
    const task = database.createBoardTask({ id: randomUUID(), ...value });
    send("BoardUpdated", { action: "created", projectId: value.projectId, task });
    return task;
  });
  handlers.handle("board:phase:create", (_event, payload) => {
    const value = idPayload.extend({
      title: boardTaskTitleSchema,
      taskIds: z.array(z.string().trim().min(1).max(160)).min(2).max(100)
    }).parse(payload);
    getProject(value.projectId);
    const phase = database.createBoardPhase({ id: randomUUID(), ...value, actorKind: "user" });
    send("BoardUpdated", { action: "phase-created", projectId: value.projectId, phase });
    return phase;
  });
  handlers.handle("board:update", (_event, payload) => {
    const value = boardTaskPayload.extend({
      title: boardTaskTitleSchema.optional(),
      description: boardTaskDescriptionSchema.optional(),
      kind: boardTaskKindSchema.optional(),
      priority: boardTaskPrioritySchema.optional(),
      estimateMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
      owner: z.string().trim().max(160).optional(),
      schedule: boardTaskScheduleSchema.nullable().optional(),
      dependencies: z.array(boardTaskDependencySchema).max(100).optional(),
      expectedRevision: z.number().int().positive().optional(),
      expectedScheduleRevision: z.number().int().nonnegative().optional()
    }).refine((candidate) => Object.keys(candidate).some((key) => !["projectId", "taskId", "expectedRevision", "expectedScheduleRevision"].includes(key)), "A board task change is required").parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const updated = database.updateBoardTask(value.taskId, value);
    send("BoardUpdated", { action: "updated", projectId: value.projectId, task: updated });
    return updated;
  });
  handlers.handle("board:activity", (_event, payload) => {
    const value = boardTaskPayload.parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    return { data: database.listBoardTaskActivity(value.taskId) };
  });
  handlers.handle("board:proposal:read", (_event, payload) => {
    const value = idPayload.extend({ proposalId: z.string().min(1) }).parse(payload);
    getProject(value.projectId);
    const proposal = database.getBoardPlanProposal(value.proposalId);
    if (!proposal || proposal.projectId !== value.projectId) throw new Error("Plan proposal not found in this project");
    return proposal;
  });
  handlers.handle("board:proposal:apply", (_event, payload) => {
    const value = idPayload.extend({ proposalId: z.string().min(1) }).parse(payload);
    getProject(value.projectId);
    const proposal = database.getBoardPlanProposal(value.proposalId);
    if (!proposal || proposal.projectId !== value.projectId) throw new Error("Plan proposal not found in this project");
    const result = database.applyBoardPlanProposal(value.proposalId, { actorKind: "user" });
    send("BoardUpdated", { action: "plan-applied", projectId: value.projectId, proposalId: value.proposalId });
    return result;
  });
  handlers.handle("board:proposal:discard", (_event, payload) => {
    const value = idPayload.extend({ proposalId: z.string().min(1) }).parse(payload);
    getProject(value.projectId);
    const proposal = database.getBoardPlanProposal(value.proposalId);
    if (!proposal || proposal.projectId !== value.projectId) throw new Error("Plan proposal not found in this project");
    return database.setBoardPlanProposalStatus(value.proposalId, "discarded");
  });
  handlers.handle("board:binding:save", async (_event, payload) => {
    const value = boardTaskPayload.extend({
      bindingId: z.string().min(1).optional(), workflowId: z.string().min(1), triggerNodeId: z.string().min(1).nullable().optional(),
      triggerType: z.enum(["planned-start-reached", "deadline-approaching", "entered-ready", "dependencies-completed", "became-overdue", "schedule-changed"]),
      enabled: z.boolean().default(false), missedTriggerPolicy: z.enum(["skip", "ask", "notify", "run"]).default("ask")
    }).parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
    if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
    integration.workflows.read(value.projectId, value.workflowId);
    const binding = database.upsertBoardTaskWorkflowBinding({ id: value.bindingId ?? randomUUID(), ...value });
    send("BoardUpdated", { action: "binding-updated", projectId: value.projectId, task: database.getBoardTask(value.taskId) });
    return binding;
  });
  handlers.handle("board:binding:delete", (_event, payload) => {
    const value = boardTaskPayload.extend({ bindingId: z.string().min(1) }).parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const binding = database.deleteBoardTaskWorkflowBinding(value.taskId, value.bindingId);
    send("BoardUpdated", { action: "binding-deleted", projectId: value.projectId, task: database.getBoardTask(value.taskId) });
    return binding;
  });
  handlers.handle("board:move", (_event, payload) => {
    const value = boardTaskPayload.extend({
      column: boardColumnSchema,
      beforeTaskId: z.string().min(1).optional()
    }).parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    if (value.beforeTaskId) {
      const beforeTask = database.getBoardTask(value.beforeTaskId);
      if (!beforeTask || beforeTask.projectId !== value.projectId) throw new Error("The target task is outside this project");
      if (beforeTask.column !== value.column) throw new Error("The target task is not in the destination column");
    }
    const moved = database.moveBoardTask(value.taskId, value.column, value.beforeTaskId ?? null);
    send("BoardUpdated", { action: "moved", projectId: value.projectId, task: moved });
    return moved;
  });
  handlers.handle("board:delete", (_event, payload) => {
    const value = boardTaskPayload.parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const deleted = database.deleteBoardTask(value.taskId);
    send("BoardUpdated", { action: "deleted", projectId: value.projectId, task: deleted });
    return deleted;
  });
  handlers.handle("board:attach", (_event, payload) => {
    const value = boardTaskPayload.extend({ threadId: z.string().min(1) }).parse(payload);
    const project = getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const knownProjectId = threadProjects.get(value.threadId);
    const binding = database.getThreadProviderBinding(value.threadId);
    if ((knownProjectId && knownProjectId !== value.projectId) || (binding?.cwd && !isWithinProject(project, binding.cwd))) {
      throw new Error("Thread is outside the selected project");
    }
    const updated = database.updateBoardTask(value.taskId, { threadId: value.threadId });
    send("BoardUpdated", { action: "updated", projectId: value.projectId, task: updated });
    return updated;
  });

  const instrumentScope = idPayload.extend({ instrumentId: z.string().trim().min(1).max(160) });
  handlers.handle("instruments:list", (_event, payload) => {
    const value = idPayload.extend({ threadId: z.string().trim().min(1).max(160).optional() }).parse(payload);
    getProject(value.projectId);
    return { data: pixiceInstruments.list(value.projectId, value.threadId) };
  });
  handlers.handle("instruments:tools", (_event, payload) => {
    const value = idPayload.parse(payload);
    getProject(value.projectId);
    return { data: pixiceInstruments.listTools(value.projectId) };
  });
  handlers.handle("instruments:read", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.read(value.projectId, value.instrumentId);
  });
  handlers.handle("instruments:open", (_event, payload) => {
    const value = instrumentScope.extend({ workspaceId: z.string().trim().min(1).max(240).optional() }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.open(value.projectId, value.instrumentId, value.workspaceId);
  });
  handlers.handle("instruments:refresh", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), source: z.string().trim().min(1).max(160).optional() }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.refresh(value.projectId, value.instrumentId, value.source, value.threadId);
  });
  handlers.handle("instruments:event", (_event, payload) => {
    const value = instrumentScope.extend({
      threadId: z.string().trim().min(1).max(160),
      actionId: z.string().trim().min(1).max(160),
      payload: z.unknown().optional(),
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      effort: z.string().optional(),
      permissionMode: permissionModeSchema.optional()
    }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.dispatchAgentEvent(value.projectId, value.instrumentId, value.actionId, value.payload, {
      model: value.model,
      serviceTier: value.serviceTier,
      effort: value.effort,
      permissionMode: value.permissionMode
    }, value.threadId);
  });
  handlers.handle("instruments:invoke", (_event, payload) => {
    const value = instrumentScope.extend({
      threadId: z.string().trim().min(1).max(160),
      actionId: z.string().trim().min(1).max(160),
      arguments: z.unknown().optional(),
      requestId: z.string().uuid()
    }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.dispatchCapability(value.projectId, value.instrumentId, value.actionId, value.arguments, value.threadId, value.requestId);
  });
  handlers.handle("instruments:pin", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), pinned: z.boolean() }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.setPinned(value.projectId, value.instrumentId, value.pinned, value.threadId);
  });
  handlers.handle("instruments:events", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: pixiceInstruments.listEvents(value.projectId, value.instrumentId) };
  });
  handlers.handle("instruments:receipts", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: pixiceInstruments.listReceipts(value.projectId, value.instrumentId) };
  });
  handlers.handle("instruments:launch", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), values: z.record(z.unknown()).default({}) }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.launch(value.projectId, value.instrumentId, value.values, value.threadId);
  });
  handlers.handle("instruments:rename", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.renameTool(value.projectId, value.instrumentId, value.name, value.threadId);
  });
  handlers.handle("instruments:grants", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), grants: z.array(z.string().trim().min(1).max(120)).max(20) }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.setGrants(value.projectId, value.instrumentId, value.grants, value.threadId);
  });
  handlers.handle("instruments:duplicate", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.duplicateTool(value.projectId, value.instrumentId, value.threadId);
  });
  handlers.handle("instruments:revisions", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: pixiceInstruments.listRevisions(value.projectId, value.instrumentId) };
  });
  handlers.handle("instruments:restore", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), version: z.number().int().positive() }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.restoreRevision(value.projectId, value.instrumentId, value.version, value.threadId);
  });
  handlers.handle("instruments:delete-tool", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.deleteTool(value.projectId, value.instrumentId, value.threadId);
  });
  handlers.handle("instruments:delete", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return pixiceInstruments.delete(value.projectId, value.instrumentId);
  });

  handlers.handle("focus:ensure", async (_event, payload) => {
    const value = idPayload.extend({
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      replaceEmpty: z.boolean().default(false),
      permissionMode: permissionModeSchema.default(FOCUS_PERMISSION_MODE)
    }).strict().parse(payload);
    const project = getProject(value.projectId);
    const pending = focusSessionEnsures.get(project.id);
    if (pending) return pending;
    if (value.replaceEmpty && focusSessionTransitions.has(project.id)) throw new Error("The Focus coordinator is already switching providers.");
    if (value.replaceEmpty) focusSessionTransitions.add(project.id);
    const promise = ensureProjectFocusSession({ project, ...value })
      .finally(() => {
        if (focusSessionEnsures.get(project.id) === promise) focusSessionEnsures.delete(project.id);
        if (value.replaceEmpty) focusSessionTransitions.delete(project.id);
      });
    focusSessionEnsures.set(project.id, promise);
    return promise;
  });
  handlers.handle("focus:memory", (_event, payload) => {
    const { projectId } = idPayload.strict().parse(payload);
    getProject(projectId);
    return pixiceFocusMemory.read(projectId);
  });
  handlers.handle("focus:memory:update", (_event, payload) => {
    const value = idPayload.extend({
      expectedRevision: z.number().int().nonnegative(),
      projectMemory: z.string().max(6_000),
      userMemory: z.string().max(2_000)
    }).strict().parse(payload);
    getProject(value.projectId);
    return pixiceFocusMemory.replaceCurated(value.projectId, value, value.expectedRevision);
  });
  handlers.handle("focus:memory:clear", (_event, payload) => {
    const value = idPayload.extend({ expectedRevision: z.number().int().nonnegative() }).strict().parse(payload);
    getProject(value.projectId);
    return pixiceFocusMemory.replaceCurated(value.projectId, { projectMemory: "", userMemory: "" }, value.expectedRevision);
  });
  handlers.handle("focus:state", (_event, payload) => {
    const { projectId } = idPayload.strict().parse(payload);
    getProject(projectId);
    return focusSupervisor.state(projectId);
  });
  handlers.handle("focus:work:control", (_event, payload) => {
    const value = idPayload.extend({ workId: z.string().min(1), action: z.enum(["pause", "resume", "cancel"]) }).strict().parse(payload);
    getProject(value.projectId);
    return focusSupervisor.control(value.projectId, value.workId, value);
  });
  handlers.handle("focus:work:follow-up", (_event, payload) => {
    const value = idPayload.extend({ workId: z.string().min(1), prompt: z.string().trim().min(1).max(100_000) }).strict().parse(payload);
    getProject(value.projectId);
    return focusSupervisor.followUp(value.projectId, value.workId, value);
  });
  handlers.handle("focus:seen", (_event, payload) => {
    const value = idPayload.extend({ sequence: z.number().int().nonnegative() }).strict().parse(payload);
    getProject(value.projectId);
    const seenSequence = focusStore.markSeen(value.projectId, value.sequence);
    send("FocusUpdated", { projectId: value.projectId });
    return { seenSequence };
  });
  handlers.handle("focus:policy:update", async (_event, payload) => {
    const value = idPayload.extend({ patch: z.object({
      coordinatorModel: z.string().min(1).max(160).nullable().optional(),
      workerModel: z.string().min(1).max(160).nullable().optional(),
      reviewModel: z.string().min(1).max(160).nullable().optional(),
      maxWorkers: z.number().int().min(1).max(8).optional(),
      permissionMode: permissionModeSchema.optional(), executionHost: z.literal("current").optional()
    }).strict() }).strict().parse(payload);
    getProject(value.projectId);
    const session = database.getProjectFocusSession(value.projectId);
    for (const field of ["coordinatorModel", "workerModel", "reviewModel"]) {
      if (!value.patch[field]) continue;
      const selected = await focusModel(value.patch[field], "", { bridgeOnly: field !== "coordinatorModel" });
      if (field === "coordinatorModel" && session && runtime.providerForThread(session.threadId) !== selected.provider) {
        throw new Error("The current coordinator stays with its provider. Choose a model from that provider; worker and review providers are independent.");
      }
      value.patch[field] = selected.id;
    }
    const policy = focusStore.updatePolicy(value.projectId, value.patch);
    if (session && Object.hasOwn(value.patch, "coordinatorModel") && policy.coordinatorModel) {
      turnUsageMetadata.set(session.threadId, { ...turnUsageMetadata.get(session.threadId), model: policy.coordinatorModel });
    }
    if (session) threadSessions.delete(session.threadId);
    send("FocusUpdated", { projectId: value.projectId });
    send("FocusPolicyUpdated", { projectId: value.projectId, policy });
    focusSupervisor.policyChanged(value.projectId);
    return policy;
  });

  handlers.handle("threads:list", async (context = {}, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    const response = await listProjectThreads(project);
    const observer = context.remote && context.access?.role === "observer";
    const data = (response.data ?? []).map((thread) => {
      const ownerProjectId = authoritativeThreadProjectId(thread.id, thread.cwd);
      if (observer && ownerProjectId !== project.id) return null;
      if (ownerProjectId && ownerProjectId !== project.id) return thread;
      rememberThread(project, thread);
      const plan = threadPlans.get(thread.id) ?? database.getThreadPlan(thread.id);
      return {
        ...reconcileThreadActivity(withPersistedThreadName(thread), activeTurns.get(thread.id)),
        planProgress: summarizeThreadPlan(plan)
      };
    }).filter(Boolean);
    return { ...response, data };
  });
  handlers.handle("threads:read", async (context = {}, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    const response = await runtime.request("thread/read", { threadId, includeTurns: true });
    if (!isWithinProject(project, response.thread.cwd)) throw new Error("Thread is outside the selected project");
    const ownerProjectId = authoritativeThreadProjectId(threadId, response.thread.cwd);
    if (context.remote && context.access?.role === "observer" && ownerProjectId !== project.id) throw new Error("Thread is outside the selected project");
    if (!ownerProjectId || ownerProjectId === project.id) {
      await taskResults.observeThread(project, response.thread);
      rememberThread(project, response.thread);
    }
    const thread = projectRendererThread(withPersistedThreadName(response.thread));
    return { ...response, thread, plan: threadPlans.get(threadId) ?? database.getThreadPlan(threadId) };
  });
  handlers.handle("threads:children", async (context = {}, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    if (!runtime.connected) return { data: [], nextCursor: null };
    const response = await listProjectThreads(project, { ancestorThreadId: threadId });
    const observer = context.remote && context.access?.role === "observer";
    const candidates = (response.data ?? []).filter((candidate) => {
      const ownerProjectId = authoritativeThreadProjectId(candidate.id, candidate.cwd);
      if (observer) return ownerProjectId === project.id;
      return true;
    });
    for (const thread of candidates) {
      const ownerProjectId = authoritativeThreadProjectId(thread.id, thread.cwd);
      if (!ownerProjectId || ownerProjectId === project.id) rememberThread(project, thread);
    }
    const data = await Promise.all(candidates.map(async (rawCandidate) => {
      const candidate = withPersistedThreadName(rawCandidate);
      if (candidate.status?.type !== "notLoaded") return reconcileThreadActivity(candidate, activeTurns.get(candidate.id));
      const cached = threadMonitorCache.get(candidate.id);
      if (cached?.updatedAt === candidate.updatedAt) {
        return reconcileThreadActivity({ ...candidate, status: cached.status }, activeTurns.get(candidate.id));
      }
      try {
        const detail = await runtime.request("thread/read", { threadId: candidate.id, includeTurns: true });
        const status = monitorStatus(detail.thread);
        threadMonitorCache.set(candidate.id, { updatedAt: candidate.updatedAt, status });
        return reconcileThreadActivity({ ...candidate, status }, activeTurns.get(candidate.id));
      } catch {
        return candidate;
      }
    }));
    return { ...response, data };
  });
  handlers.handle("threads:create", async (_event, payload) => {
    const value = idPayload.extend({
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      permissionMode: permissionModeSchema.default("workspace-write"),
      parentThreadId: z.string().min(1).optional()
    }).parse(payload);
    const project = getProject(value.projectId);
    const focusContext = value.parentThreadId ? projectFocusContextForThread(value.parentThreadId) : null;
    if (focusContext && focusContext.projectId !== project.id) throw new Error("Focus parent belongs to another project");
    if (value.parentThreadId && managedFocusAncestor(value.parentThreadId)) throw new Error("Managed Focus workers cannot create unsupervised children. Ask the coordinator to delegate the outcome.");
    const permissionMode = focusContext ? FOCUS_PERMISSION_MODE : value.permissionMode;
    const permissions = permissionSettings(permissionMode, project);
    const roots = runtimeRoots(project);
    const cwd = projectPrimaryRoot(project);
    const response = await runtime.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: roots,
      model: value.model || null,
      ...(value.serviceTier !== undefined ? { serviceTier: value.serviceTier } : {}),
      ...(focusContext ? { parentThreadId: value.parentThreadId } : {}),
      permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: currentAgentInstructions(),
      dynamicTools: pixiceDynamicTools,
      threadSource: "pixice"
    });
    rememberThread(project, response.thread, { loaded: true });
    if (focusContext) {
      database.saveThreadLink({
        childThreadId: response.thread.id,
        parentThreadId: value.parentThreadId,
        kind: "focusSideThread",
        model: value.model || null
      });
    }
    pendingTaskNames.add(response.thread.id);
    return response;
  });
  handlers.handle("threads:fork", async (_event, payload) => {
    const value = threadForkPayload.parse(payload);
    const lastTurnId = value.lastTurnId ?? value.turnId;
    const lastItemId = value.lastItemId ?? value.itemId;
    const project = getProject(value.projectId);
    await ensureThreadLoaded(project, value.threadId);
    const sourceResponse = await runtime.request("thread/read", { threadId: value.threadId, includeTurns: true });
    if (!isWithinProject(project, sourceResponse.thread?.cwd)) throw new Error("Thread is outside the selected project");
    const sourceThread = withPersistedThreadName(sourceResponse.thread);
    validatedForkAnswer(sourceThread, lastTurnId, lastItemId);

    const response = await runtime.request("thread/fork", {
      threadId: value.threadId,
      lastTurnId,
      lastItemId,
      deferGoalContinuation: true
    });
    if (!response.thread?.id || !response.thread.cwd) throw new Error("Runtime returned an invalid forked thread");
    if (!isWithinProject(project, response.thread.cwd)) throw new Error("Forked thread is outside the selected project");

    let thread = independentForkThread(response.thread, sourceThread.id);
    rememberThread(project, thread, { loaded: true });
    const binding = database.getThreadProviderBinding(thread.id);
    if (binding) database.saveThreadProviderBinding({ ...binding, forkedFromId: sourceThread.id });

    const sourceName = stripPreviewContextHint(sourceThread.name ?? sourceThread.preview ?? "Untitled task").trim() || "Untitled task";
    const providerName = String(thread.name ?? "").trim();
    const providerPreservedForkName = providerName && providerName !== sourceName;
    const name = providerPreservedForkName ? providerName : `${sourceName} (fork)`;
    database.saveThreadName(thread.id, name);
    thread = { ...thread, name };
    const providerSnapshot = database.getProviderThreadSnapshot?.(thread.id);
    database.saveProviderThreadSnapshot?.(thread.id, { ...(providerSnapshot ?? {}), ...thread });
    if (!providerPreservedForkName) {
      try {
        await runtime.request("thread/name/set", { threadId: thread.id, name });
      } catch (error) {
        codexRuntime.emit("diagnostic", `Fork name could not be saved to the provider: ${error.message}`);
      }
    }
    return { ...response, thread: projectRendererThread(withPersistedThreadName(thread)) };
  });
  handlers.handle("threads:archive", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    if (database.getProjectFocusSession(projectId)?.threadId === threadId) {
      throw new Error("The project Focus coordinator cannot be deleted. Switch back to Workspace to manage worker threads.");
    }
    await ensureThreadLoaded(project, threadId);
    const response = await runtime.request("thread/archive", { threadId });
    threadSessions.delete(threadId);
    threadProjects.delete(threadId);
    turnUsageMetadata.delete(threadId);
    await browserWorkspace.destroyWorkspace(threadId);
    previewContextRegistry.clear(threadId);
    await iosRuntimeService.stop(threadId, "Thread archived");
    database.deleteThreadLink(threadId);
    database.deleteThreadBoardState(threadId);
    database.detachBoardTasksForThread(threadId);
    return response;
  });

  handlers.handle("turns:start", async (context = {}, payload) => {
    const value = threadPayload.extend({
      ...promptInputSchema,
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      effort: z.string().optional(),
      permissionMode: permissionModeSchema.default("workspace-write")
    }).superRefine(requirePromptInput).parse(payload);
    const project = getProject(value.projectId);
    if (focusStore.getWorkByThread(value.threadId)) throw new Error("Continue this managed worker through Focus's Redirect control so its work stays supervised.");
    const focusSession = database.getProjectFocusSessionByThread(value.threadId);
    const isFocus = focusSession?.projectId === project.id;
    if (isFocus && focusSessionTransitions.has(project.id)) {
      throw new Error("The Focus coordinator is switching providers. Your message was not submitted; retry in a moment.");
    }
    const focusContext = projectFocusContextForThread(value.threadId);
    const prompt = await preparePromptInput(value, project, value.threadId, context);
    if (isFocus && (focusSessionTransitions.has(project.id) || database.getProjectFocusSession(project.id)?.threadId !== value.threadId)) {
      throw new Error("The Focus coordinator changed while preparing your message. Your message was not submitted; retry now.");
    }
    const response = await startTrackedTurn({
      project, threadId: value.threadId, input: buildCodexUserInput(prompt.text, prompt.images),
      text: value.text, model: value.model, effort: value.effort, serviceTier: value.serviceTier,
      permissionMode: focusStore.getWorkByThread(value.threadId)?.permissionMode ?? (focusContext ? FOCUS_PERMISSION_MODE : value.permissionMode), trackTask: !isFocus
    });
    if (isFocus) {
      database.incrementProjectFocusTurn(project.id, value.threadId);
    }
    if (pendingTaskNames.delete(value.threadId)) {
      const attachmentCount = value.images.length + value.attachments.length + value.attachmentIds.length;
      scheduleThreadName({ project, threadId: value.threadId, source: value.text || `${attachmentCount} attached file${attachmentCount === 1 ? "" : "s"}`, kind: "task" });
    }
    if (!isFocus) try {
      proactiveStewardship.startTurn({
        projectId: value.projectId,
        threadId: value.threadId,
        turnId: response.turn.id,
        prompt: value.text,
        threadName: database.getThreadName(value.threadId) ?? ""
      });
    } catch (error) {
      codexRuntime.emit("diagnostic", `Task stewardship failed: ${error.message}`);
    }
    return response;
  });
  handlers.handle("turns:steer", async (context = {}, payload) => {
    const value = threadPayload.extend({
      turnId: z.string().min(1),
      ...promptInputSchema
    }).superRefine(requirePromptInput).parse(payload);
    const project = getProject(value.projectId);
    const managed = focusStore.getWorkByThread(value.threadId);
    if (managed) {
      if (managed.projectId !== project.id) throw new Error("Worker is outside this project");
      if (value.images.length || value.attachments.length || value.attachmentIds.length) throw new Error("Send attachments to the Focus coordinator so it can include them in the worker's brief.");
      return focusSupervisor.followUp(project.id, managed.id, { prompt: value.text });
    }
    await ensureThreadLoaded(project, value.threadId);
    const prompt = await preparePromptInput(value, project, value.threadId, context);
    taskResults.stopReplay(value.threadId, true);
    const response = await runtime.request("turn/steer", {
      threadId: value.threadId,
      expectedTurnId: value.turnId,
      input: buildCodexUserInput(prompt.text, prompt.images)
    });
    if (database.getProjectFocusSessionByThread(value.threadId)?.projectId === project.id) {
      database.incrementProjectFocusTurn(project.id, value.threadId);
    }
    return response;
  });
  handlers.handle("turns:interrupt", async (_event, payload) => {
    const value = threadPayload.extend({ turnId: z.string().min(1) }).parse(payload);
    const managed = focusStore.getWorkByThread(value.threadId);
    if (managed) {
      if (managed.projectId !== value.projectId) throw new Error("Worker is outside this project");
      return focusSupervisor.control(value.projectId, managed.id, { action: "pause" });
    }
    const project = getProject(value.projectId);
    await ensureThreadLoaded(project, value.threadId);
    taskResults.stopReplay(value.threadId);
    const response = await runtime.request("turn/interrupt", { threadId: value.threadId, turnId: value.turnId });
    activeTurns.delete(value.threadId);
    updateTrayMenu();
    return response;
  });

  handlers.handle("approvals:resolve", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      requestGeneration: z.number().int().nonnegative(),
      decision: z.enum(["accept", "decline", "acceptForSession", "cancel"])
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || value.requestGeneration !== pending.generation) throw new Error("Approval request is no longer pending");
    if (!pending.request.method?.toLowerCase().includes("approval")) throw new Error("Pending request is not an approval");
    runtime.respond(value.requestId, { decision: value.decision });
    pendingRequests.delete(key);
    return { ok: true };
  });
  handlers.handle("requests:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      requestGeneration: z.number().int().nonnegative(),
      answers: z.record(z.object({ answers: z.array(z.string().trim().min(1)).min(1).max(20) }))
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || value.requestGeneration !== pending.generation) throw new Error("Input request is no longer pending");
    if (!pending.request.method?.includes("requestUserInput")) throw new Error("Pending request does not accept user input");
    respondToFocusQuestion(pending, { answers: Object.fromEntries(Object.entries(value.answers).map(([id, answer]) => [id, answer.answers])) }, { source: "user" });
    pendingRequests.delete(key);
    return { ok: true };
  });
  handlers.handle("questions:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      requestGeneration: z.number().int().nonnegative(),
      action: z.enum(["answer", "cancel"]).default("answer"),
      answers: z.record(z.string().trim().min(1).max(10_000)).default({})
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || value.requestGeneration !== pending.generation) throw new Error("Question is no longer pending");
    respondToFocusQuestion(pending, value, { source: "user" });
    pendingRequests.delete(key);
    return { ok: true };
  });
  handlers.handle("elicitations:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      requestGeneration: z.number().int().nonnegative(),
      action: z.enum(["accept", "decline", "cancel"]),
      content: z.record(z.unknown()).optional()
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || value.requestGeneration !== pending.generation) throw new Error("Elicitation request is no longer pending");
    if (!pending.request.method?.toLowerCase().includes("elicitation")) throw new Error("Pending request is not an elicitation");
    runtime.respond(value.requestId, {
      action: value.action,
      ...(value.action === "accept" && value.content ? { content: value.content } : {})
    });
    pendingRequests.delete(key);
    return { ok: true };
  });

  handlers.handle("review:read", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    const primaryRoot = projectPrimaryRoot(project);
    const repository = await inspectRepository(primaryRoot);
    const files = repository.kind === "git"
      ? await readDiffManifest({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: primaryRoot, gitExecutablePath: repository.git?.executablePath })
      : [];
    return { repository, files };
  });
  handlers.handle("review:file", async (_event, payload) => {
    const value = idPayload.extend({ path: z.string().trim().min(1).max(10_000) }).parse(payload);
    const project = getProject(value.projectId);
    const primaryRoot = projectPrimaryRoot(project);
    const repository = await inspectRepository(primaryRoot);
    if (repository.kind !== "git") return { path: value.path, diff: "", baseCommit: null };
    const diff = await readFileDiff({
      workingPath: repository.root,
      baseCommit: repository.baseCommit,
      scopePath: primaryRoot,
      filePath: value.path,
      gitExecutablePath: repository.git?.executablePath
    });
    return { path: value.path, diff, baseCommit: repository.baseCommit };
  });
  handlers.handle("files:read", (_event, payload) => {
    const value = idPayload.extend({ path: z.string().trim().min(1) }).parse(payload);
    return readProjectFile(value.projectId, value.path);
  });
  handlers.handle("files:preview", (_event, payload) => {
    const value = idPayload.extend({ path: z.string().trim().min(1).max(10_000) }).parse(payload);
    return readLocalPreviewFile(value.projectId, value.path);
  });
  handlers.handle("files:write", (_event, payload) => {
    const value = idPayload.extend({
      path: z.string().trim().min(1),
      content: z.string(),
      expectedMtimeMs: z.number().nonnegative().optional()
    }).parse(payload);
    const current = previewFileTarget(previewFileOptions(value.projectId, value.path, true));
    const file = readLocalPreviewFile(value.projectId, current.resolved);
    if (!file.editable) throw new Error("This file cannot be edited in Pixice");
    if (Buffer.byteLength(value.content, "utf8") > MAX_EDITABLE_BYTES) throw new Error("Edited file is too large to save in Pixice");
    if (value.expectedMtimeMs !== undefined && Math.abs(current.metadata.mtimeMs - value.expectedMtimeMs) > 1) {
      throw new Error("This file changed on disk. Reopen it before saving so those changes are not overwritten.");
    }
    writeFileSync(current.resolved, value.content, "utf8");
    return readLocalPreviewFile(value.projectId, current.resolved);
  });
  handlers.handle("external:editor", async (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    const target = projectTarget(value.projectId, value.path);
    return platform.openExternal(`vscode://file/${encodeURI(target)}`);
  });
  handlers.handle("external:terminal", async (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    return platform.openTerminal(projectTarget(value.projectId, value.path));
  });
  handlers.handle("external:reveal", (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    platform.reveal(projectTarget(value.projectId, value.path));
    return { ok: true };
  });

  handlers.handle("models:list", () => listModels());
  handlers.handle("extensions:list", async (_event, payload) => {
    const value = z.object({ projectId: z.string().min(1).optional(), threadId: z.string().min(1).optional() }).parse(payload ?? {});
    const project = value.projectId ? getProject(value.projectId) : null;
    if (value.threadId) {
      if (!project) throw new Error("A project is required when loading thread extensions");
      await ensureThreadLoaded(project, value.threadId);
    }
    const [skills, apps, mcp] = await Promise.allSettled([
      runtime.request("skills/list", { cwds: project ? projectRoots(project) : [] }),
      runtime.request("app/list", { limit: 100, threadId: value.threadId || null }),
      runtime.request("mcpServerStatus/list", {})
    ]);
    return {
      skills: skills.status === "fulfilled" ? skills.value.data ?? [] : [],
      apps: apps.status === "fulfilled" ? apps.value.data ?? [] : [],
      mcp: mcp.status === "fulfilled" ? mcp.value.data ?? [] : [],
      errors: [skills, apps, mcp].filter((entry) => entry.status === "rejected").map((entry) => entry.reason?.message ?? String(entry.reason))
    };
  });
}

  async function start() {
    if (started) return;
    started = true;
  migrateLegacyBrandData(userDataPath);
  const recordedDataVersion = readUpdateDataVersion(userDataPath);
  if (recordedDataVersion && recordedDataVersion !== version) recoverUpdateDataFromBackup({ userDataPath });
  await ensureVersionUpdateDataBackup({ userDataPath, currentVersion: version });
  database = new PixiceDatabase(userDataPath);
  focusStore = new FocusStore(database);
  pixiceFocusMemory = new PixiceFocusMemory({
    database,
    onChange: ({ projectId }) => {
      const session = database.getProjectFocusSession(projectId);
      if (session?.threadId) threadSessions.delete(session.threadId);
    }
  });
  taskResults = new TaskResults({
    database, directory: path.join(userDataPath, "task-results"),
    onChange: (payload) => { send("TaskReceiptUpdated", payload); send("UsageUpdated", payload); },
    readThread: (threadId) => runtime.request("thread/read", { threadId, includeTurns: true }),
    startTurn: startTrackedTurn,
    startThread: async ({ project, model, serviceTier }) => {
      const permissions = permissionSettings("workspace-write", project);
      const response = await runtime.request("thread/start", {
        cwd: projectPrimaryRoot(project), runtimeWorkspaceRoots: runtimeRoots(project), model, serviceTier,
        permissionMode: "workspace-write", approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer,
        sandbox: permissions.sandbox, developerInstructions: currentAgentInstructions(), dynamicTools: pixiceDynamicTools, threadSource: "pixice"
      });
      rememberThread(project, response.thread, { loaded: true });
      database.saveThreadName(response.thread.id, `${project.displayName} · ${model}`);
      return response;
    }
  });
  const previewThreadContext = (threadId) => {
    const binding = database.getThreadProviderBinding(threadId);
    const project = resolveThreadProject({
      database,
      projectId: threadProjects.get(threadId),
      cwd: binding?.cwd,
      projectForPath
    });
    return project ? {
      projectId: project.id,
      cwd: binding?.cwd || projectPrimaryRoot(project),
      roots: projectRoots(project)
    } : null;
  };
  previewContextRegistry = new PreviewContextRegistry({
    openFile: ({ threadId, path: filePath, source }) => {
      const context = previewThreadContext(threadId);
      if (!context) throw new Error("The controlling thread is not linked to a Pixice project");
      const file = readLocalPreviewFile(context.projectId, filePath);
      send("FilePreviewOpenRequested", { workspaceId: threadId, threadId, projectId: context.projectId, source, file });
      return { opened: true, path: file.path, name: file.name, external: file.external, editable: file.editable };
    },
    presentThread: ({ threadId, sourceThreadId, source }) => {
      if (threadId === sourceThreadId) throw new Error("That Preview is already attached to this conversation");
      const target = previewThreadContext(threadId);
      const origin = previewThreadContext(sourceThreadId);
      if (!target || !origin || target.projectId !== origin.projectId) {
        throw new Error("The Preview source must be another thread in this Pixice project");
      }
      const context = previewContextRegistry.current(sourceThreadId);
      send("PreviewWorkspacePresentRequested", {
        workspaceId: threadId,
        threadId,
        sourceWorkspaceId: sourceThreadId,
        sourceThreadId,
        projectId: target.projectId,
        source,
        context,
        title: database.getThreadName(sourceThreadId) ?? "Worker Preview"
      });
      return {
        presented: true,
        sourceThreadId,
        title: database.getThreadName(sourceThreadId) ?? null,
        context
      };
    }
  });
  iosRuntimeService = new IosRuntimeService({ scratchRoot: path.join(userDataPath, "ios-sessions") });
  iosRuntimeService.on("updated", (session) => {
    send("IosSessionUpdated", { workspaceId: session.workspaceId, projectId: session.projectId, session });
  });
  {
    const saved = database.getAppSettings();
    transcriptionService = new TranscriptionService({ userDataPath, send });
    await transcriptionService.start({
      selectedModelId: saved.transcriptionModel ?? undefined,
      ...(saved.transcriptionSettings ?? {})
    });
  }
  iosTools = new IosTools({
    service: iosRuntimeService,
    threadContext: previewThreadContext,
    onOpen: ({ workspaceId, projectId, session, source }) => {
      send("IosPreviewOpenRequested", { workspaceId, threadId: workspaceId, projectId, session, source });
    }
  });
  if (database.getAppSettings().keepSystemAwake === true) await platform.setKeepAwake(true).catch((error) => send("NativeError", { message: error.message }));
  developerInstructionsPath = path.join(resourcesPath, "runtime/pixice-developer-instructions.md");
  agentBehaviorsDirectory = path.join(resourcesPath, "runtime/agent-behaviors");
  githubCli = new GitHubCli({ resourcesPath });
  prependGitHubCliToPath(process.env, githubCli.resolved);
  githubCli.on("progress", (payload) => send("GitHubAuthProgress", payload));
  const codexRuntimeLifecycle = new ProviderRuntimeLifecycle({ provider: "codex", database });
  codexRuntime = new CodexRuntime({
    executablePath: null,
    clientVersion: version
  });
  runtime = new ProviderRegistry({ database });
  codexProvider = runtime.register(providerFactories.codex?.({ database, codexRuntime }) ?? new CodexProvider(codexRuntime, { runtimeLifecycle: codexRuntimeLifecycle }));
  const boardThreadContext = previewThreadContext;
  pixiceBoard = new PixiceBoard({
    database,
    threadContext: boardThreadContext,
    resolveWorkflow: async (projectId, workflowId) => {
      const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
      if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
      return integration.workflows.read(projectId, workflowId).workflow;
    },
    onChange: (payload) => send("BoardUpdated", payload),
    onOpen: (payload) => send("TaskPreviewOpenRequested", payload)
  });
  pixiceInstruments = new InstrumentService({
    userDataPath: userDataPath,
    threadContext: boardThreadContext,
    readCapability: readInstrumentCapability,
    onAgentEvent: deliverInstrumentAgentEvent,
    resolveCapability: resolveInstrumentCapability,
    confirmCapability: (value) => platform.confirmAction(value),
    invokeCapability: invokeInstrumentCapability,
    onChange: (payload) => send("InstrumentUpdated", payload),
    onOpen: (payload) => send("InstrumentOpenRequested", payload),
    onEventChange: (payload) => send("InstrumentInteractionUpdated", payload)
  });
  bridgeParentContinuation = new BridgeParentContinuation({
    activeTurnId: (threadId) => activeTurns.get(threadId) ?? null,
    startTurn: startBridgeParentTurn,
    steerTurn: steerBridgeParentTurn,
    onError: (error, completion) => codexRuntime.emit(
      "diagnostic",
      `Bridge completion delivery failed for ${completion.parentThreadId}: ${error.message}`
    )
  });
  pixiceBridge = new PixiceBridge({
    installWorkflows: (options) => runtimeReady.then(() => installWorkflowRuntimeHost({ ...options, userDataPath, resourcesPath, handlers,
      send, credentialCrypto: platform.credentialCrypto, notify: platform.notify })),
    runtime,
    database,
    dynamicTools: () => pixiceDynamicTools,
    threadContext: (threadId) => {
      const binding = database.getThreadProviderBinding(threadId);
      const project = resolveThreadProject({
        database,
        projectId: threadProjects.get(threadId),
        cwd: binding?.cwd,
        projectForPath
      });
      if (!project) return null;
      const focusContext = projectFocusContextForThread(threadId);
      const managedWork = managedFocusAncestor(threadId);
      return {
        projectId: project.id,
        cwd: binding?.cwd || projectPrimaryRoot(project),
        runtimeWorkspaceRoots: projectRoots(project),
        developerInstructions: currentAgentInstructions(),
        focusCoordinator: Boolean(focusContext && !focusContext.worker),
        managedFocusWork: Boolean(managedWork),
        enforcedPermissionMode: managedWork?.permissionMode ?? (focusContext ? focusStore.getPolicy(project.id).permissionMode : null),
        permissionMode: turnUsageMetadata.get(threadId)?.permissionMode
          ?? database.getAppSettings().defaultPermissionMode
          ?? "workspace-write",
        permissionSettings: (mode) => permissionSettings(mode, project)
      };
    },
    onThreadCreated: ({ context, thread, prompt, model, permissionMode }) => {
      const project = database.getProject(context.projectId);
      if (!project) return;
      rememberThread(project, thread, { loaded: true });
      turnUsageMetadata.set(thread.id, { turnId: null, model: model.id, serviceTier: null, permissionMode, provider: model.provider });
      scheduleThreadName({ project, threadId: thread.id, source: prompt, kind: "thread" });
    },
    onCompletion: (completion) => bridgeParentContinuation.notify(completion),
    onActivity: (payload) => send("AgentUpdated", {
      ...payload,
      projectId: threadProjects.get(payload.threadId)
    })
  });
  focusSupervisor = new FocusSupervisor({
    store: focusStore, runtime,
    contextForProject: (projectId) => {
      const project = getProject(projectId);
      const session = database.getProjectFocusSession(projectId);
      if (!session) throw new Error("Open the project's Focus coordinator before delegating work.");
      return { coordinatorThreadId: session.threadId, cwd: projectPrimaryRoot(project) };
    },
    startWorker: async ({ projectId, workId, coordinatorThreadId, prompt, model, effort, permissionMode }) => {
      if (!acceptingWork) throw new Error("The host is stopping; queued work remains saved.");
      const selected = await focusModel(model, prompt);
      return pixiceBridge.startDetached({ threadId: coordinatorThreadId }, {
        prompt, model: selected.id, ...(effort ? { effort } : {}), permissionMode
      }, { onCreated: (thread) => {
        if (workId) focusStore.updateWork(projectId, workId, { threadId: thread.id, model: selected.id });
      } });
    },
    continueWorker: async ({ projectId, threadId, turnId, prompt, model, effort, permissionMode }) => {
      const project = getProject(projectId);
      await ensureThreadLoaded(project, threadId);
      if (turnId) {
        await runtime.request("turn/steer", { threadId, expectedTurnId: turnId, input: buildCodexUserInput(prompt, []) });
        return { turnId };
      }
      const response = await startTrackedTurn({ project, threadId, input: buildCodexUserInput(prompt, []), text: prompt, model: model ?? undefined, effort, permissionMode });
      return { turnId: response.turn.id };
    },
    interruptWorker: async ({ projectId, threadId, turnId }) => {
      getProject(projectId);
      if (turnId) await runtime.request("turn/interrupt", { threadId, turnId });
    },
    deliver: deliverFocusEvents,
    onChange: (projectId) => send("FocusUpdated", { projectId })
  });
  pixiceFocusMemory.coordination = new FocusCoordinationTools({
    database, store: focusStore, supervisor: focusSupervisor, validateModel: focusModel,
    listQuestions: listFocusCoordinatorQuestions,
    answerQuestion: answerFocusCoordinatorQuestion
  });
  proactiveStewardship = new ProactiveStewardship({
    database,
    onBoardChange: (payload) => send("BoardUpdated", payload),
    onSuggestionChange: (payload) => send("ProactivityUpdated", payload),
    createWorkflowDraft: async ({ projectId, threadId, suggestedName, count, steps }) => {
      const integration = pixiceBridge.workflowIntegration ?? await pixiceBridge.workflowReady;
      if (!integration) throw pixiceBridge.workflowError ?? new Error("Pixice workflows are unavailable");
      const description = `Suggested by Pixice after this sequence completed ${count} times. Review the draft before running it.`;
      const prompt = [
        "Pixice detected this repeated project routine. Review the current project state, then perform these steps in order:",
        ...steps.map((step, index) => `${index + 1}. ${step.label}`),
        "Stop on failure and report the failed step. Do not add automatic triggers until the user explicitly enables them."
      ].join("\n");
      const draft = createDefaultWorkflow({
        projectId,
        name: suggestedName,
        description,
        enabled: false,
        createdByThreadId: threadId
      });
      const graph = {
        ...draft.graph,
        nodes: draft.graph.nodes.map((node) => node.type === "pixiceAgent"
          ? { ...node, name: "Run detected routine", description: "Execute the reviewed steps from the repeated task pattern.", config: { ...node.config, prompt } }
          : node)
      };
      const workflow = integration.workflows.create({
        projectId,
        name: suggestedName,
        description,
        enabled: false,
        graph,
        createdByThreadId: threadId
      });
      send("WorkflowOpenRequested", {
        projectId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        threadId,
        workspaceId: threadId,
        reason: "edit"
      });
      return { id: workflow.id, name: workflow.name, enabled: workflow.enabled };
    }
  });
  const claudeRuntimeLifecycle = new ProviderRuntimeLifecycle({ provider: "claude", database });
  claudeProvider = runtime.register(providerFactories.claude?.({ database }) ?? new ClaudeProvider({
    database,
    clientVersion: version,
    developerInstructions: currentAgentInstructions,
    pixiceBridge,
    pixiceBoard,
    pixiceFocus: pixiceFocusMemory,
    pixiceInstruments,
    pixiceBrowser: {
      handleToolCall: (params) => {
        if (!browserWorkspace) throw new Error("Pixice browser is not ready");
        return browserWorkspace.handleToolCall(params);
      }
    },
    pixicePreview: previewContextRegistry,
    pixiceIos: iosTools,
    pathToClaudeCodeExecutable: null,
    requireExternalExecutable: true,
    runtimeLifecycle: claudeRuntimeLifecycle
  }));
  threadNamer = new ThreadNamer(runtime, {
    models: () => listModels(),
    selection: () => database.getAppSettings().threadNamingModel ?? "auto"
  });
  threadNamer.on("failure", (error) => codexRuntime.emit("diagnostic", `Automatic thread naming failed: ${error.message}`));
  threadNamer.on("named", ({ threadId, name }) => {
    database.saveThreadName(threadId, name);
    updateTrayMenu();
    send("TaskUpdated", {
      method: "thread/name/updated",
      threadId,
      name,
      projectId: threadProjects.get(threadId)
    });
  });
  runtime.on("status", (status) => {
    const providerState = status.provider ? status.providers?.[status.provider]?.state ?? status.state : status.state;
    if (status.provider && ["connecting", "reconnecting", "stopped", "unavailable"].includes(providerState)) {
      const provider = status.provider;
      const affectedThreadIds = new Set(database.listThreadProviderBindings({ provider }).map((binding) => binding.threadId));
      focusSupervisor?.providerUnavailable(provider);
      for (const threadId of affectedThreadIds) {
        threadSessions.delete(threadId);
        threadProjects.delete(threadId);
        activeTurns.delete(threadId);
        startingTurns.delete(threadId);
        pendingTaskNames.delete(threadId);
        scheduledThreadNames.delete(threadId);
        turnUsageMetadata.delete(threadId);
      }
      for (const [key, pending] of pendingRequests) {
        const threadId = pending.request?.params?.threadId;
        if (!threadId || runtime.providerForThread(threadId) !== provider) continue;
        pendingRequests.delete(key);
        removeFocusQuestionMember(key, pending.generation);
        send("AttentionResolved", { requestId: pending.request?.id, threadId });
      }
      for (const [projectId] of focusSessionEnsures) {
        const threadId = database.getProjectFocusSession(projectId)?.threadId;
        if (threadId && runtime.providerForThread(threadId) === provider) {
          focusSessionEnsures.delete(projectId);
          focusSessionTransitions.delete(projectId);
        }
      }
      for (const [threadId, review] of focusMemoryReviews) {
        if (runtime.providerForThread(threadId) !== provider) continue;
        focusMemoryReviews.delete(threadId);
        focusMemoryReviewInFlight.delete(review.focusThreadId);
        focusMemoryInternalThreadIds.delete(threadId);
      }
      for (const [threadId, review] of focusQuestionReviews) {
        if (runtime.providerForThread(threadId) !== provider) continue;
        const pending = pendingRequests.get(review.requestKey);
        if (pending?.generation === review.requestGeneration) {
          showFocusCoordinatorQuestion(pending, review.focusContext, "The background coordinator became unavailable, so this worker question needs your input.");
        }
        focusQuestionReviews.delete(threadId);
        focusQuestionReviewInFlight.delete(review.requestKey);
        focusQuestionInternalThreadIds.delete(threadId);
        clearTimeout(focusQuestionReviewTimers.get(threadId));
        focusQuestionReviewTimers.delete(threadId);
      }
      updateTrayMenu();
    }
    runtimeStatus = status;
    send("RuntimeStatus", { ...status, connected: runtime.connected });
    if (focusSupervisor && providerState === "ready") {
      void focusSupervisor.recover().catch((error) => codexRuntime.emit("diagnostic", `Focus recovery: ${error.message}`));
    }
  });
  runtime.on("event", containListenerErrors((event) => {
    const receivedAt = event.payload?.receivedAt ?? new Date().toISOString();
    event.payload = { ...event.payload, receivedAt };
    const { method, threadId, turn } = event.payload ?? {};
    if (event.payload?.thread?.source === "pixiceFocusMemory") {
      if (event.payload.thread.id) focusMemoryInternalThreadIds.add(event.payload.thread.id);
      return;
    }
    if (event.payload?.thread?.source === "pixiceFocusQuestionReview") {
      if (event.payload.thread.id) focusQuestionInternalThreadIds.add(event.payload.thread.id);
      return;
    }
    if (threadId && focusMemoryInternalThreadIds.has(threadId)) {
      if (method === "turn/completed") void completeFocusMemoryReview(threadId, turn);
      if (method === "thread/archived" || method === "thread/deleted") {
        focusMemoryInternalThreadIds.delete(threadId);
        focusMemoryReviews.delete(threadId);
      }
      return;
    }
    if (threadId && focusQuestionInternalThreadIds.has(threadId)) {
      if (method === "turn/completed") void completeFocusQuestionReview(threadId, turn);
      if (method === "thread/archived" || method === "thread/deleted") {
        focusQuestionInternalThreadIds.delete(threadId);
        const review = focusQuestionReviews.get(threadId);
        if (review) focusQuestionReviewInFlight.delete(review.requestKey);
        focusQuestionReviews.delete(threadId);
      }
      return;
    }
    const focusSession = threadId ? database.getProjectFocusSessionByThread(threadId) : null;
    if (method === "serverRequest/resolved") {
      const key = requestKey(event.payload.requestId);
      const pending = pendingRequests.get(key);
      pendingRequests.delete(key);
      if (pending) removeFocusQuestionMember(key, pending.generation);
      send("AttentionResolved", { requestId: event.payload.requestId, threadId });
    }
    if (method === "account/rateLimits/updated") {
      trayLimits = null;
      send("CodexLimitsUpdated", { receivedAt });
      sendTrayState();
    }
    if (threadNamer.rememberInternalThread(event.payload?.thread) || threadNamer.isInternalThread(threadId)) return;
    if (!focusSession) proactiveStewardship.observeActivity(event.payload ?? {});
    const collabItem = event.payload?.item;
    if ((collabItem?.type === "collabAgentToolCall" || collabItem?.type === "collabToolCall") && collabItem.receiverThreadIds?.length) {
      const parentThreadId = collabItem.senderThreadId ?? threadId;
      const parentUsage = turnUsageMetadata.get(parentThreadId) ?? {};
      const parentFocusContext = projectFocusContextForThread(parentThreadId);
      for (const receiverThreadId of collabItem.receiverThreadIds) {
        if (parentFocusContext && !database.getThreadLink(receiverThreadId)) {
          database.saveThreadLink({
            childThreadId: receiverThreadId,
            parentThreadId,
            kind: "focusCollaboration",
            model: collabItem.model ?? parentUsage.model ?? null,
            effort: collabItem.effort ?? parentUsage.effort ?? null
          });
        }
        turnUsageMetadata.set(receiverThreadId, {
          turnId: null,
          model: collabItem.model ?? parentUsage.model ?? null,
          serviceTier: parentUsage.serviceTier ?? null,
          effort: collabItem.effort ?? parentUsage.effort ?? null,
          permissionMode: managedFocusAncestor(parentThreadId)?.permissionMode ?? (parentFocusContext ? FOCUS_PERMISSION_MODE : parentUsage.permissionMode ?? database.getAppSettings().defaultPermissionMode ?? "workspace-write"),
          provider: event.payload?.provider ?? parentUsage.provider ?? "codex"
        });
      }
    }
    try {
      if (recordUsage(event.payload ?? {})) {
        send("UsageUpdated", { recordedAt: new Date().toISOString() });
        updateTrayMenu();
      }
    } catch (error) {
      codexRuntime.emit("diagnostic", `Usage recording failed: ${error.message}`);
    }
    if (method === "thread/name/updated" && threadId && event.payload?.name) {
      database.saveThreadName(threadId, event.payload.name);
    }
    if (method === "turn/started" && threadId) {
      if (!focusSession) taskResults.observeStart(threadId, turn?.id);
      threadPlans.set(threadId, []);
      database.saveThreadPlan(threadId, []);
    }
    if ((method === "turn/started" || method === "turn/completed") && threadId && turn?.id) {
      const existingTiming = database.getThreadTurnTiming(threadId, turn.id);
      const startedAt = turn.startedAt ?? turn.createdAt ?? existingTiming?.startedAt ?? receivedAt;
      const completedAt = method === "turn/completed"
        ? turn.completedAt ?? existingTiming?.completedAt ?? receivedAt
        : existingTiming?.completedAt ?? null;
      database.saveThreadTurnTiming({ threadId, turnId: turn.id, startedAt, completedAt });
      event.payload.turn = { ...turn, startedAt, ...(completedAt ? { completedAt } : {}) };
    }
    if (method === "turn/started" && threadId && !focusSession) {
      const projectId = threadProjects.get(threadId) ?? boardThreadContext(threadId)?.projectId;
      if (projectId) {
        try {
          proactiveStewardship.startTurn({ projectId, threadId, turnId: turn?.id ?? null, threadName: database.getThreadName(threadId) ?? "" });
        } catch (error) {
          codexRuntime.emit("diagnostic", `Task stewardship failed: ${error.message}`);
        }
      }
    }
    if (method === "turn/completed" && threadId && event.payload.turn && !focusSession) {
      const completed = taskResults.get(threadId)
        ? taskResults.complete(threadId, event.payload.turn, threadPlans.get(threadId) ?? [])
        : Promise.resolve().then(async () => {
          if (database.getThreadLink(threadId)) return;
          const projectId = threadProjects.get(threadId) ?? boardThreadContext(threadId)?.projectId;
          const project = projectId && database.getProject(projectId);
          if (!project) return;
          const response = await runtime.request("thread/read", { threadId, includeTurns: true });
          taskResults.importThread(project, response.thread);
        });
      void completed
        .catch((error) => { taskResults.failed(threadId, error); codexRuntime.emit("diagnostic", `Task receipt failed: ${error.message}`); });
    }
    if (method === "turn/completed" && threadId && event.payload.turn && !database.getThreadLink(threadId) && !focusSession) {
      const projectId = threadProjects.get(threadId) ?? boardThreadContext(threadId)?.projectId;
      if (projectId) {
        try {
          proactiveStewardship.completeTurn({ projectId, threadId, turn: event.payload.turn });
        } catch (error) {
          codexRuntime.emit("diagnostic", `Work pattern detection failed: ${error.message}`);
        }
      }
      const settings = database.getAppSettings();
      if (settings.completionNotifications === true) {
        void platform.notify({
          title: "Task finished",
          body: database.getThreadName(threadId) ?? "A Pixice task finished its active turn.",
          silent: settings.notificationSound === false
        }).catch((error) => send("NativeError", { message: error.message }));
      }
    }
    if (method === "turn/plan/updated" && threadId) {
      const plan = event.payload.plan ?? [];
      threadPlans.set(threadId, plan);
      database.saveThreadPlan(threadId, plan);
      updateTrayMenu();
    }
    if ((method === "thread/deleted" || method === "thread/archived") && threadId) {
      pixiceInstruments.removeEphemeralForThread(threadId);
      threadPlans.delete(threadId);
      trayCompletionRevisions.delete(threadId);
      threadMonitorCache.delete(threadId);
      threadSessions.delete(threadId);
      threadProjects.delete(threadId);
      turnUsageMetadata.delete(threadId);
      database.deleteThreadRuntimeState(threadId);
      if (method === "thread/deleted") database.deleteThreadTurnTimings(threadId);
      database.deleteThreadProviderBinding(threadId);
      database.deleteThreadLink(threadId);
      database.detachBoardTasksForThread(threadId);
      void browserWorkspace.destroyWorkspace(threadId).catch((error) => send("NativeError", { message: error.message }));
      previewContextRegistry?.clear(threadId);
      if (method === "thread/deleted") database.deleteThreadName(threadId);
    }
    if (threadId && (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed")) {
      threadMonitorCache.delete(threadId);
    }
    if (method === "thread/started" && event.payload?.thread?.id) {
      const project = projectForPath(event.payload.thread.cwd);
      if (project) rememberThread(project, event.payload.thread, { loaded: true });
    }
    if (method === "turn/started" && threadId && turn?.id) {
      activeTurns.set(threadId, turn.id);
      trayCompletionRevisions.delete(threadId);
    }
    if (method === "turn/completed" && threadId) {
      activeTurns.delete(threadId);
      trayCompletionRevisions.set(threadId, {
        completionRevision: `turn:${turn?.id ?? event.payload?.turnId ?? receivedAt}`,
        updatedAt: turn?.completedAt ?? receivedAt
      });
      if (focusSession) {
        void scheduleFocusMemoryReview(threadId);
        void focusSupervisor?.flush(focusSession.projectId).catch((error) => codexRuntime.emit("diagnostic", `Focus delivery: ${error.message}`));
      }
    }
    if (method === "turn/started" || method === "turn/completed") updateTrayMenu();
    scheduleDelegatedThreadNames(event);
    sendRuntimeEvent(event.type, {
      ...event.payload,
      projectId: authoritativeThreadProjectId(threadId ?? event.payload?.thread?.id, event.payload?.thread?.cwd)
    });
  }, (error, event) => {
    const method = event?.payload?.method ?? event?.type ?? "unknown";
    codexRuntime.emit("diagnostic", `Runtime event ${method} failed: ${error.message}`);
  }));
  runtime.on("server-request", (request) => {
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_FOCUS_NAMESPACE) {
      void pixiceFocusMemory.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_BOARD_NAMESPACE) {
      void pixiceBoard.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_INSTRUMENTS_NAMESPACE) {
      void pixiceInstruments.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_BRIDGE_NAMESPACE) {
      void pixiceBridge.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === "pixice_browser") {
      void browserWorkspace.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_PREVIEW_NAMESPACE) {
      void Promise.resolve(previewContextRegistry.handleToolCall(request.params))
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === PIXICE_IOS_NAMESPACE) {
      void iosTools.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    const threadId = request.params?.threadId;
    const focusContext = threadId ? projectFocusContextForThread(threadId) : null;
    const focusAccess = focusContext ? managedFocusAncestor(threadId)?.permissionMode ?? FOCUS_PERMISSION_MODE : null;
    if (focusContext && focusAccess === "full-access" && request.method?.toLowerCase().includes("approval")) {
      runtime.respond(request.id, { decision: "accept" });
      return;
    }
    let displayRequest = request;
    let kind = "runtime-request";
    if (isPixiceQuestionToolCall(request)) {
      try {
        displayRequest = pixiceQuestionRequest(request);
        kind = "pixice-question-tool";
      } catch (error) {
        runtime.respond(request.id, {
          success: false,
          contentItems: [{ type: "inputText", text: `Invalid Pixice question: ${error.message}` }]
        });
        return;
      }
    } else if (request.method === PIXICE_QUESTION_METHOD) kind = "pixice-question";
    const key = requestKey(request.id);
    const question = displayRequest.method?.includes("requestUserInput") && Array.isArray(displayRequest.params?.questions);
    const pending = { request, displayRequest, kind, generation: ++nextAttentionGeneration, visible: !(focusContext?.worker && question), focusContext };
    pendingRequests.set(key, pending);
    if (focusContext && question) {
      if (focusContext.worker) {
        const group = focusQuestionGroups.add({ key, generation: pending.generation, projectId: focusContext.projectId, questions: displayRequest.params.questions });
        if (group.duplicate) {
          const leader = pendingRequests.get(group.leaderKey);
          if (leader?.visible && leader.focusContext) showFocusCoordinatorQuestion(leader, leader.focusContext);
        } else void scheduleFocusQuestionReview(key, focusContext);
      }
      else showFocusCoordinatorQuestion(pending, focusContext);
      return;
    }
    send("AttentionRequired", { ...displayRequest, requestGeneration: pending.generation, taskTitle: threadId ? database.getThreadName(threadId) : null, projectId: threadId ? authoritativeThreadProjectId(threadId) : null });
    const settings = database.getAppSettings();
    if (!focusContext && settings.attentionNotifications !== false) {
      void platform.notify({
        title: displayRequest.method?.includes("requestUserInput") ? "A task has a question" : "Pixice needs your attention",
        body: displayRequest.method,
        silent: settings.notificationSound === false
      }).catch((error) => send("NativeError", { message: error.message }));
    }
  });
  runtime.on("recoverable-error", (error) => send("RuntimeError", error));
  runtime.on("provider-lifecycle", (state) => send("ProviderLifecycleState", state));

  registerHandlers();
  await runtime.start();
  resolveRuntimeReady();
  await focusSupervisor.recover();
  runtime.startProviderUpdateChecks({ enabled: database.getAppSettings().checkProviderUpdates !== false });
  await pixiceBridge.workflowReady;
  if (!pixiceBridge.workflowError) markUpdateDataVersion(userDataPath, version);
  }

  async function quiesce() {
    acceptingWork = false;
    const workflows = pixiceBridge?.workflowIntegration?.workflows;
    if (workflows) await workflows.close();
    await Promise.allSettled([...activeTurns].map(([threadId, turnId]) => runtime.request("turn/interrupt", { threadId, turnId })));
  }
  async function stop({ force = false } = {}) {
    if (stopped) return;
    if ((activeTurns.size || startingTurns.size || pixiceBridge?.workflowIntegration?.workflows.activeRuns.size) && !force) throw new Error("Active work is still running. Stop it first or explicitly interrupt it.");
    stopped = true;
    acceptingWork = false;
    focusSupervisor?.dispose();
    flushRendererDeltas();
    await pixiceBridge?.workflowIntegration?.close();
    await iosRuntimeService?.destroy();
    if (force) await Promise.allSettled([...activeTurns].map(([threadId, turnId]) => runtime.request("turn/interrupt", { threadId, turnId })));
    await runtime?.stop();
    await Promise.allSettled([...(taskResults?.finishing.values() ?? [])]);
    pixiceInstruments?.close();
    await transcriptionService?.close().catch(() => {});
    database?.db.close();
    events.removeAllListeners();
  }
  return {
    handlers, events, start, stop, quiesce,
    backup: ({ currentVersion, targetVersion }) => createUpdateDataBackup({ userDataPath, currentVersion, targetVersion, reason: "app-update" }),
    freeze: (value) => { acceptingWork = !value; if (pixiceBridge?.workflowIntegration) pixiceBridge.workflowIntegration.workflows.acceptingRuns = !value; },
    state: () => ({ activeTurns: activeTurns.size, startingTurns: startingTurns.size, activeWorkflows: pixiceBridge?.workflowIntegration?.workflows.activeRuns.size ?? 0, runtime: { ...runtimeStatus, connected: Boolean(runtime?.connected) }, workflowError: pixiceBridge?.workflowError?.message ?? null }),
    attention: () => [...pendingRequests.values()].filter((pending) => pending.visible !== false).map(({ request, displayRequest, generation }) => {
      const threadId = request.params?.threadId;
      return { ...(displayRequest ?? request), requestGeneration: generation, projectId: threadId ? authoritativeThreadProjectId(threadId) : null };
    }),
    knownProjectIds: () => database?.listProjects().map((project) => project.id) ?? [],
    connectReadiness: () => {
      const connected = runtime?.connected === true;
      const runtimeReason = connected ? null : String(runtimeStatus?.error ?? `Provider runtime is ${runtimeStatus?.state ?? "unavailable"}.`).slice(0, 240);
      let browserStatus;
      try { browserStatus = nativeReadiness(); }
      catch { browserStatus = { available: false, reason: "The Pixice native helper is unavailable." }; }
      const browserAvailable = browserStatus?.available === true;
      const browserCanStart = browserAvailable || browserStatus?.canStart === true;
      const browserReason = browserAvailable ? null : String(browserStatus?.reason ?? "The Pixice native helper is unavailable.").slice(0, 240);
      return {
        provider: { connected, reason: runtimeReason },
        browser: { available: browserAvailable, canStart: browserCanStart, reason: browserReason }
      };
    },
    resolveConnectEventProject: connectProjectIdForEvent,
    connectProjectExists: (projectId) => database ? Boolean(database.getProject(projectId)) : true,
    connectFileOptions: (projectId, reference, allowExternal = false) => previewFileOptions(projectId, reference, allowExternal),
    connectTaskReceipt: (threadId) => taskResults?.get(threadId) ?? null,
    remoteInvoker: (hostId) => createRemoteInvoker({ handlers: { get: (channel) => handlers.entries.has(channel) ? (_event, payload, context) => handlers.invoke(channel, payload, { remote: true, ...context }) : undefined },
      validateThread: createRemoteThreadValidator({ getProject, contains: isWithinProject, request: (method, payload) => runtime.request(method, payload), resolveOwner: ({ threadId, thread }) => authoritativeThreadProjectId(threadId, thread.cwd) }),
      pendingRequest: (id) => pendingRequests.get(requestKey(id)), generation: () => runtimeGeneration,
      activeTurnId: (id) => activeTurns.get(id), fileOptions: previewFileOptions, hostId, transferStore })
  };
}
