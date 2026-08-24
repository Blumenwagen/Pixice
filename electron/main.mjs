import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import electronUpdater from "electron-updater";
import { CodexRuntime } from "./runtime/codex-runtime.mjs";
import { ThreadSessionRegistry } from "./runtime/thread-session-registry.mjs";
import { ThreadNamer } from "./runtime/thread-namer.mjs";
import { buildCodexUserInput } from "./runtime/user-input.mjs";
import {
  MAX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  appendAttachmentContext,
  attachmentProjectRoot,
  stagePromptAttachments
} from "./runtime/prompt-attachments.mjs";
import { AGENT_BEHAVIOR_IDS, agentBehaviorCatalog, composeAgentInstructions } from "./runtime/agent-behavior.mjs";
import { CodexProvider } from "./providers/codex-provider.mjs";
import { ClaudeProvider, resolveClaudeCodeExecutable, resolvePackagedClaudeCodeExecutable } from "./providers/claude-provider.mjs";
import { ProviderRegistry } from "./providers/provider-registry.mjs";
import { BrowserWorkspace, browserDynamicTools } from "./browser/browser-workspace.mjs";
import {
  isPixiceQuestionToolCall,
  LOOM_QUESTION_METHOD,
  loomQuestionRequest,
  loomQuestionToolResult,
  questionDynamicTools
} from "./runtime/question-tool.mjs";
import { PixiceBridge, LOOM_BRIDGE_NAMESPACE, loomBridgeDynamicTools } from "./runtime/loom-bridge.mjs";
import { PixiceBoard, LOOM_BOARD_NAMESPACE, loomBoardDynamicTools } from "./runtime/loom-board.mjs";
import {
  InstrumentService,
  LOOM_INSTRUMENTS_NAMESPACE,
  instrumentDynamicTools
} from "./instruments/instrument-service.mjs";
import { PixiceAppUpdater } from "./updater/app-updater.mjs";
import { PixiceDatabase } from "./persistence/database.mjs";
import { inspectRepository, readDiff } from "./git/worktrees.mjs";
import { GitHubCli, prependGitHubCliToPath } from "./github/github-cli.mjs";
import { calculateUsageCost, listPricingCatalog, PRICING_VERIFIED_AT } from "./usage/pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const isDev = !app.isPackaged;
const threadSourceKinds = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "loomBridge", "unknown"
];

let mainWindow;
let tray;
let runtime;
let codexRuntime;
let threadNamer;
let browserWorkspace;
let appUpdater;
let githubCli;
let loomBridge;
let loomBoard;
let loomInstruments;
let database;
let quitting = false;
let runtimeStatus = { state: "starting" };
const activeTurns = new Map();
const turnUsageMetadata = new Map();
const threadSessions = new ThreadSessionRegistry();
const threadPlans = new Map();
const threadMonitorCache = new Map();
const threadProjects = new Map();
const pendingRequests = new Map();
const pendingTaskNames = new Set();
const scheduledThreadNames = new Set();
const loomDynamicTools = [
  ...browserDynamicTools,
  ...questionDynamicTools,
  ...loomBridgeDynamicTools,
  ...loomBoardDynamicTools,
  ...instrumentDynamicTools
];
let runtimeGeneration = 0;
let developerInstructionsPath;
let agentBehaviorsDirectory;

const idPayload = z.object({ projectId: z.string().min(1) });
const threadPayload = idPayload.extend({ threadId: z.string().min(1) });
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
const permissionModeSchema = z.enum(["read-only", "workspace-write", "auto-approve", "full-access"]);
const agentBehaviorsSchema = z.object(Object.fromEntries(AGENT_BEHAVIOR_IDS.map((id) => [id, z.boolean().optional()]))).strict();
const appDefaultsSchema = z.object({
  defaultModel: z.string().trim().min(1).max(128).optional(),
  defaultEffort: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/i).max(32).optional(),
  defaultPermissionMode: permissionModeSchema.optional(),
  agentBehaviors: agentBehaviorsSchema.optional()
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
const promptInputSchema = {
  text: z.string().trim().max(100_000).default(""),
  images: z.array(imageDataUrlSchema).max(10).default([]),
  attachments: z.array(promptAttachmentSchema).max(MAX_PROMPT_ATTACHMENTS).default([])
};
const requirePromptInput = (value, context) => {
  if (!value.text && value.images.length === 0 && value.attachments.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A message or attachment is required" });
  }
};
const send = (type, payload = {}) => mainWindow?.webContents.send("loom:event", { type, payload, at: new Date().toISOString() });

function currentAgentInstructions() {
  return composeAgentInstructions({
    baseInstructionsPath: developerInstructionsPath,
    behaviorsDirectory: agentBehaviorsDirectory,
    settings: database?.getAppSettings().agentBehaviors
  });
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
  const attachmentRoot = attachmentProjectRoot(app.getPath("userData"), project.id);
  mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 });
  return [...new Set([...projectRoots(project), attachmentRoot])];
}

function preparePromptInput(value, project, threadId) {
  const staged = stagePromptAttachments({
    attachments: value.attachments,
    userDataPath: app.getPath("userData"),
    projectId: project.id,
    threadId
  });
  return {
    text: appendAttachmentContext(value.text, staged.files),
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

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"],
  [".svg", "image/svg+xml"], [".bmp", "image/bmp"], [".ico", "image/x-icon"]
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;

function cleanFileReference(reference) {
  let value = String(reference ?? "").trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  if (value.startsWith("file://")) value = fileURLToPath(value);
  try { value = decodeURIComponent(value); } catch { /* Keep the original path when it is not URI encoded. */ }
  value = value.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:(\d+)(?::\d+)?$/, "");
  return value;
}

function projectFileTarget(projectId, reference) {
  const project = getProject(projectId);
  const cleaned = cleanFileReference(reference);
  if (!cleaned) throw new Error("File path is required");
  const candidate = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(projectPrimaryRoot(project), cleaned);
  const resolved = realpathSync(candidate);
  if (!isWithinProject(project, resolved)) throw new Error("File is outside the selected project");
  const metadata = statSync(resolved);
  if (!metadata.isFile()) throw new Error("The selected path is not a file");
  return { project, resolved, metadata };
}

function readProjectFile(projectId, reference) {
  const { project, resolved, metadata } = projectFileTarget(projectId, reference);
  const folderPath = projectRootForTarget(project, resolved) ?? projectPrimaryRoot(project);
  if (metadata.size > MAX_PREVIEW_BYTES) throw new Error("File is too large to open in Pixice");
  const extension = path.extname(resolved).toLowerCase();
  const buffer = readFileSync(resolved);
  const imageMime = IMAGE_MIME_TYPES.get(extension);
  const isPdf = extension === ".pdf";
  if (imageMime || isPdf) {
    const mimeType = imageMime || "application/pdf";
    return {
      path: resolved,
      relativePath: path.relative(folderPath, resolved),
      folderPath,
      name: path.basename(resolved),
      extension,
      kind: imageMime ? "image" : "pdf",
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      editable: false,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    };
  }
  const content = buffer.toString("utf8");
  const binary = content.includes("\u0000");
  const editable = !binary && metadata.size <= MAX_EDITABLE_BYTES;
  return {
    path: resolved,
    relativePath: path.relative(folderPath, resolved),
    folderPath,
    name: path.basename(resolved),
    extension,
    kind: binary ? "unsupported" : MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : HTML_EXTENSIONS.has(extension) ? "html" : "text",
    content: binary ? null : content,
    editable,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs
  };
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

function rememberThread(project, thread, { loaded = false } = {}) {
  if (!thread?.id) return;
  const cwd = realpathSync(thread.cwd ?? projectPrimaryRoot(project));
  if (!isWithinProject(project, cwd)) throw new Error("Thread is outside the selected project");
  threadSessions.remember(thread.id, cwd, { loaded });
  threadProjects.set(thread.id, project.id);
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
  return name && name !== thread.name ? { ...thread, name } : thread;
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

async function listProjects() {
  return Promise.all(database.listProjects().map(projectWithRepository));
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
    data: [...byId.values()].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))),
    nextCursor: null
  };
}

function updateTrayMenu() {
  if (!tray) return;
  const count = activeTurns.size;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Pixice", click: () => mainWindow.show() },
    { label: count ? `${count} active turn${count === 1 ? "" : "s"}` : "No active turns", enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]));
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

function createWindow() {
  const captureWidth = Number(process.env.LOOM_CAPTURE_WIDTH || 1480);
  const captureHeight = Number(process.env.LOOM_CAPTURE_HEIGHT || 1000);
  const usesNativeGlass = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: captureWidth,
    height: captureHeight,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    backgroundColor: usesNativeGlass ? "#00000000" : "#242424",
    transparent: usesNativeGlass,
    vibrancy: usesNativeGlass ? "under-window" : undefined,
    visualEffectState: usesNativeGlass ? "active" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (isDev) mainWindow.loadURL("http://127.0.0.1:5173");
  else mainWindow.loadFile(path.join(__dirname, "../dist/client/index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const destination = new URL(url);
    const allowed = isDev
      ? destination.origin === "http://127.0.0.1:5173"
      : destination.protocol === "file:" && path.normalize(fileURLToPath(destination)) === path.normalize(path.join(__dirname, "../dist/client/index.html"));
    if (allowed) return;
    event.preventDefault();
    if (destination.protocol === "https:" || destination.protocol === "http:") shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.once("did-finish-load", () => {
    if (!process.env.LOOM_CAPTURE_PATH) return;
    setTimeout(async () => {
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(process.env.LOOM_CAPTURE_PATH, image.toPNG());
      quitting = true;
      appUpdater?.stop();
      browserWorkspace?.destroy();
      await runtime?.stop();
      app.quit();
    }, 700);
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = isDev ? path.join(__dirname, "../build/icon.png") : path.join(process.resourcesPath, "app-icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Pixice");
  updateTrayMenu();
  tray.on("click", () => mainWindow.show());
}

function launchDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function openTerminal(target) {
  if (process.platform === "darwin") return launchDetached("open", ["-a", "Terminal", target]);
  if (process.platform === "win32") return launchDetached("wt.exe", ["-d", target]);
  return launchDetached("x-terminal-emulator", ["--working-directory", target]);
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
  await shell.openExternal(destination.toString());
  return { provider, opened: true, loginId: result.loginId ?? null };
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
  const properties = multiple ? ["openDirectory", "multiSelections"] : ["openDirectory"];
  const result = await dialog.showOpenDialog(mainWindow, { properties });
  if (result.canceled) return [];
  return canonicalProjectFolders(result.filePaths);
}

async function ensureThreadLoaded(project, threadId) {
  const cwd = await threadSessions.ensure(threadId, async () => {
    const response = await runtime.request("thread/resume", { threadId, developerInstructions: currentAgentInstructions(), dynamicTools: loomDynamicTools });
    const resumedCwd = response.thread?.cwd;
    if (!resumedCwd) throw new Error("Runtime returned a thread without a working directory");
    return realpathSync(resumedCwd);
  });
  if (!isWithinProject(project, cwd)) throw new Error("Thread is outside the selected project");
  threadProjects.set(threadId, project.id);
  return cwd;
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
      ? await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: primaryRoot })
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
    const integration = loomBridge.workflowIntegration ?? await loomBridge.workflowReady;
    if (!integration) throw loomBridge.workflowError ?? new Error("Pixice workflows are unavailable");
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
    const integration = loomBridge.workflowIntegration ?? await loomBridge.workflowReady;
    if (!integration) throw loomBridge.workflowError ?? new Error("Pixice workflows are unavailable");
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
    if (!task || task.projectId !== projectId) throw new Error("Kanban task not found in this project");
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
    if (!task || task.projectId !== projectId) throw new Error("Kanban task not found in this project");
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
    const integration = loomBridge.workflowIntegration ?? await loomBridge.workflowReady;
    if (!integration) throw loomBridge.workflowError ?? new Error("Pixice workflows are unavailable");
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
    if (!task || task.projectId !== projectId) throw new Error("Kanban task not found in this project");
    const updated = database.updateBoardTask(value.taskId, value);
    send("BoardUpdated", { action: "updated", projectId, task: updated });
    return updated;
  }
  if (capability === "board.move") {
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== projectId) throw new Error("Kanban task not found in this project");
    if (value.beforeTaskId) {
      const before = database.getBoardTask(value.beforeTaskId);
      if (!before || before.projectId !== projectId || before.column !== value.column) throw new Error("The target task is invalid for this move");
    }
    const moved = database.moveBoardTask(value.taskId, value.column, value.beforeTaskId ?? null);
    send("BoardUpdated", { action: "moved", projectId, task: moved });
    return moved;
  }
  if (capability === "workflow.run") {
    const integration = loomBridge.workflowIntegration ?? await loomBridge.workflowReady;
    if (!integration) throw loomBridge.workflowError ?? new Error("Pixice workflows are unavailable");
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
    provider: runtime.providerForThread(instrument.threadId)
  });
  updateTrayMenu();
  return response;
}

function registerIpc() {
  ipcMain.handle("app:bootstrap", async () => ({
    projects: await listProjects(),
    models: await listModels().catch(() => []),
    runtime: { ...runtimeStatus, connected: runtime.connected },
    settings: database.getAppSettings(),
    agentBehaviors: agentBehaviorCatalog()
  }));
  ipcMain.handle("app:settings:update", (_event, payload) => database.saveAppSettings(appDefaultsSchema.parse(payload)));
  ipcMain.handle("runtime:status", () => ({ ...runtimeStatus, connected: runtime.connected }));
  ipcMain.handle("providers:list", () => runtime.listProviders());
  ipcMain.handle("usage:summary", (_event, payload) => {
    const { days } = z.object({ days: z.number().int().min(7).max(365).default(30) }).parse(payload ?? {});
    return {
      ...database.getUsageSummary({ days }),
      pricingVerifiedAt: PRICING_VERIFIED_AT,
      pricing: listPricingCatalog()
    };
  });
  ipcMain.handle("providers:login", (_event, payload) => {
    const { provider } = z.object({ provider: z.string().trim().min(1).max(64) }).parse(payload);
    return startProviderLogin(provider);
  });
  ipcMain.handle("github:status", () => githubCli.status());
  ipcMain.handle("github:login", () => githubCli.login());
  ipcMain.handle("github:logout", () => githubCli.logout());
  ipcMain.handle("updates:status", () => appUpdater.snapshot());
  ipcMain.handle("updates:check", () => appUpdater.check());
  ipcMain.handle("updates:download", () => appUpdater.download());
  ipcMain.handle("updates:install", () => appUpdater.install());
  const browserScope = z.object({ workspaceId: z.string().trim().min(1) });
  ipcMain.handle("browser:state", (_event, payload) => {
    const value = browserScope.parse(payload);
    return browserWorkspace.snapshot(value.workspaceId);
  });
  ipcMain.handle("browser:create", (_event, payload) => {
    const value = browserScope.extend({ url: z.string().optional() }).parse(payload);
    return browserWorkspace.createTab(value.workspaceId, value.url);
  });
  ipcMain.handle("browser:close", (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1) }).parse(payload);
    return browserWorkspace.closeTab(value.workspaceId, value.tabId);
  });
  ipcMain.handle("browser:activate", (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1) }).parse(payload);
    return browserWorkspace.activateTab(value.workspaceId, value.tabId);
  });
  ipcMain.handle("browser:navigate", async (_event, payload) => {
    const value = browserScope.extend({ tabId: z.string().min(1).optional(), url: z.string().trim().min(1) }).parse(payload);
    return browserWorkspace.navigate(value);
  });
  ipcMain.handle("browser:history", (_event, payload) => {
    const value = browserScope.extend({ action: z.enum(["back", "forward", "reload", "stop"]) }).parse(payload);
    return browserWorkspace.history(value.workspaceId, value.action);
  });
  ipcMain.handle("browser:viewport", (_event, payload) => {
    const value = browserScope.extend({
      visible: z.boolean(),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional()
    }).parse(payload);
    return browserWorkspace.setViewport(value);
  });
  ipcMain.handle("browser:adopt", (_event, payload) => {
    const value = z.object({ fromWorkspaceId: z.string().trim().min(1), toWorkspaceId: z.string().trim().min(1) }).parse(payload);
    return browserWorkspace.adoptWorkspace(value.fromWorkspaceId, value.toWorkspaceId);
  });
  ipcMain.handle("browser:destroy", (_event, payload) => {
    const value = browserScope.parse(payload);
    browserWorkspace.destroyWorkspace(value.workspaceId);
    return { destroyed: true, workspaceId: value.workspaceId };
  });

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:touch", (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = database.touchProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  });
  ipcMain.handle("projects:pick-folders", () => pickProjectFolders());
  ipcMain.handle("projects:create", async (_event, payload) => {
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
  ipcMain.handle("projects:open", async () => {
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

  ipcMain.handle("board:list", (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    getProject(projectId);
    return { data: database.listBoardTasks(projectId) };
  });
  ipcMain.handle("board:create", (_event, payload) => {
    const value = idPayload.extend({
      title: boardTaskTitleSchema,
      description: boardTaskDescriptionSchema.default(""),
      column: boardColumnSchema.default("backlog")
    }).parse(payload);
    getProject(value.projectId);
    const task = database.createBoardTask({ id: randomUUID(), ...value });
    send("BoardUpdated", { action: "created", projectId: value.projectId, task });
    return task;
  });
  ipcMain.handle("board:update", (_event, payload) => {
    const value = boardTaskPayload.extend({
      title: boardTaskTitleSchema.optional(),
      description: boardTaskDescriptionSchema.optional()
    }).refine((candidate) => candidate.title !== undefined || candidate.description !== undefined, "A board task change is required").parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Kanban task not found in this project");
    const updated = database.updateBoardTask(value.taskId, value);
    send("BoardUpdated", { action: "updated", projectId: value.projectId, task: updated });
    return updated;
  });
  ipcMain.handle("board:move", (_event, payload) => {
    const value = boardTaskPayload.extend({
      column: boardColumnSchema,
      beforeTaskId: z.string().min(1).optional()
    }).parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Kanban task not found in this project");
    if (value.beforeTaskId) {
      const beforeTask = database.getBoardTask(value.beforeTaskId);
      if (!beforeTask || beforeTask.projectId !== value.projectId) throw new Error("The target task is outside this project");
      if (beforeTask.column !== value.column) throw new Error("The target task is not in the destination column");
    }
    const moved = database.moveBoardTask(value.taskId, value.column, value.beforeTaskId ?? null);
    send("BoardUpdated", { action: "moved", projectId: value.projectId, task: moved });
    return moved;
  });
  ipcMain.handle("board:delete", (_event, payload) => {
    const value = boardTaskPayload.parse(payload);
    getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Kanban task not found in this project");
    const deleted = database.deleteBoardTask(value.taskId);
    send("BoardUpdated", { action: "deleted", projectId: value.projectId, task: deleted });
    return deleted;
  });
  ipcMain.handle("board:attach", (_event, payload) => {
    const value = boardTaskPayload.extend({ threadId: z.string().min(1) }).parse(payload);
    const project = getProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Kanban task not found in this project");
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
  ipcMain.handle("instruments:list", (_event, payload) => {
    const value = idPayload.extend({ threadId: z.string().trim().min(1).max(160).optional() }).parse(payload);
    getProject(value.projectId);
    return { data: loomInstruments.list(value.projectId, value.threadId) };
  });
  ipcMain.handle("instruments:tools", (_event, payload) => {
    const value = idPayload.parse(payload);
    getProject(value.projectId);
    return { data: loomInstruments.listTools(value.projectId) };
  });
  ipcMain.handle("instruments:read", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return loomInstruments.read(value.projectId, value.instrumentId);
  });
  ipcMain.handle("instruments:open", (_event, payload) => {
    const value = instrumentScope.extend({ workspaceId: z.string().trim().min(1).max(240).optional() }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.open(value.projectId, value.instrumentId, value.workspaceId);
  });
  ipcMain.handle("instruments:refresh", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), source: z.string().trim().min(1).max(160).optional() }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.refresh(value.projectId, value.instrumentId, value.source, value.threadId);
  });
  ipcMain.handle("instruments:event", (_event, payload) => {
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
    return loomInstruments.dispatchAgentEvent(value.projectId, value.instrumentId, value.actionId, value.payload, {
      model: value.model,
      serviceTier: value.serviceTier,
      effort: value.effort,
      permissionMode: value.permissionMode
    }, value.threadId);
  });
  ipcMain.handle("instruments:invoke", (_event, payload) => {
    const value = instrumentScope.extend({
      threadId: z.string().trim().min(1).max(160),
      actionId: z.string().trim().min(1).max(160),
      arguments: z.unknown().optional(),
      requestId: z.string().uuid()
    }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.dispatchCapability(value.projectId, value.instrumentId, value.actionId, value.arguments, value.threadId, value.requestId);
  });
  ipcMain.handle("instruments:pin", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), pinned: z.boolean() }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.setPinned(value.projectId, value.instrumentId, value.pinned, value.threadId);
  });
  ipcMain.handle("instruments:events", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: loomInstruments.listEvents(value.projectId, value.instrumentId) };
  });
  ipcMain.handle("instruments:receipts", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: loomInstruments.listReceipts(value.projectId, value.instrumentId) };
  });
  ipcMain.handle("instruments:launch", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), values: z.record(z.unknown()).default({}) }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.launch(value.projectId, value.instrumentId, value.values, value.threadId);
  });
  ipcMain.handle("instruments:rename", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.renameTool(value.projectId, value.instrumentId, value.name, value.threadId);
  });
  ipcMain.handle("instruments:grants", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), grants: z.array(z.string().trim().min(1).max(120)).max(20) }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.setGrants(value.projectId, value.instrumentId, value.grants, value.threadId);
  });
  ipcMain.handle("instruments:duplicate", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.duplicateTool(value.projectId, value.instrumentId, value.threadId);
  });
  ipcMain.handle("instruments:revisions", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return { data: loomInstruments.listRevisions(value.projectId, value.instrumentId) };
  });
  ipcMain.handle("instruments:restore", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160), version: z.number().int().positive() }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.restoreRevision(value.projectId, value.instrumentId, value.version, value.threadId);
  });
  ipcMain.handle("instruments:delete-tool", (_event, payload) => {
    const value = instrumentScope.extend({ threadId: z.string().trim().min(1).max(160) }).parse(payload);
    getProject(value.projectId);
    return loomInstruments.deleteTool(value.projectId, value.instrumentId, value.threadId);
  });
  ipcMain.handle("instruments:delete", (_event, payload) => {
    const value = instrumentScope.parse(payload);
    getProject(value.projectId);
    return loomInstruments.delete(value.projectId, value.instrumentId);
  });

  ipcMain.handle("threads:list", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    const response = await listProjectThreads(project);
    const data = (response.data ?? []).map((thread) => {
      rememberThread(project, thread);
      return withPersistedThreadName(thread);
    });
    return { ...response, data };
  });
  ipcMain.handle("threads:read", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    const response = await runtime.request("thread/read", { threadId, includeTurns: true });
    if (!isWithinProject(project, response.thread.cwd)) throw new Error("Thread is outside the selected project");
    rememberThread(project, response.thread);
    const thread = withPersistedThreadName(response.thread);
    return { ...response, thread, plan: threadPlans.get(threadId) ?? database.getThreadPlan(threadId) };
  });
  ipcMain.handle("threads:children", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    if (!runtime.connected) return { data: [], nextCursor: null };
    const response = await listProjectThreads(project, { ancestorThreadId: threadId });
    for (const thread of response.data ?? []) rememberThread(project, thread);
    const data = await Promise.all((response.data ?? []).map(async (rawCandidate) => {
      const candidate = withPersistedThreadName(rawCandidate);
      if (candidate.status?.type !== "notLoaded") return candidate;
      const cached = threadMonitorCache.get(candidate.id);
      if (cached?.updatedAt === candidate.updatedAt) return { ...candidate, status: cached.status };
      try {
        const detail = await runtime.request("thread/read", { threadId: candidate.id, includeTurns: true });
        const status = monitorStatus(detail.thread);
        threadMonitorCache.set(candidate.id, { updatedAt: candidate.updatedAt, status });
        return { ...candidate, status };
      } catch {
        return candidate;
      }
    }));
    return { ...response, data };
  });
  ipcMain.handle("threads:create", async (_event, payload) => {
    const value = idPayload.extend({
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      permissionMode: permissionModeSchema.default("workspace-write")
    }).parse(payload);
    const project = getProject(value.projectId);
    const permissions = permissionSettings(value.permissionMode, project);
    const roots = runtimeRoots(project);
    const cwd = projectPrimaryRoot(project);
    const response = await runtime.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: roots,
      model: value.model || null,
      ...(value.serviceTier !== undefined ? { serviceTier: value.serviceTier } : {}),
      permissionMode: value.permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      developerInstructions: currentAgentInstructions(),
      dynamicTools: loomDynamicTools,
      threadSource: "loom"
    });
    rememberThread(project, response.thread, { loaded: true });
    pendingTaskNames.add(response.thread.id);
    return response;
  });
  ipcMain.handle("threads:archive", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    await ensureThreadLoaded(project, threadId);
    const response = await runtime.request("thread/archive", { threadId });
    threadSessions.delete(threadId);
    threadProjects.delete(threadId);
    turnUsageMetadata.delete(threadId);
    browserWorkspace.destroyWorkspace(threadId);
    database.deleteThreadLink(threadId);
    database.deleteThreadBoardState(threadId);
    database.detachBoardTasksForThread(threadId);
    return response;
  });

  ipcMain.handle("turns:start", async (_event, payload) => {
    const value = threadPayload.extend({
      ...promptInputSchema,
      model: z.string().optional(),
      serviceTier: z.string().nullable().optional(),
      effort: z.string().optional(),
      permissionMode: permissionModeSchema.default("workspace-write")
    }).superRefine(requirePromptInput).parse(payload);
    const project = getProject(value.projectId);
    const permissions = permissionSettings(value.permissionMode, project);
    const cwd = await ensureThreadLoaded(project, value.threadId);
    const prompt = preparePromptInput(value, project, value.threadId);
    const response = await runtime.request("turn/start", {
      threadId: value.threadId,
      input: buildCodexUserInput(prompt.text, prompt.images),
      cwd,
      runtimeWorkspaceRoots: runtimeRoots(project),
      model: value.model || null,
      ...(value.serviceTier !== undefined ? { serviceTier: value.serviceTier } : {}),
      effort: value.effort || null,
      permissionMode: value.permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy
    });
    activeTurns.set(value.threadId, response.turn.id);
    turnUsageMetadata.set(value.threadId, {
      turnId: response.turn.id,
      model: value.model || null,
      serviceTier: value.serviceTier ?? null,
      provider: runtime.providerForThread(value.threadId)
    });
    updateTrayMenu();
    if (pendingTaskNames.delete(value.threadId)) {
      const attachmentCount = value.images.length + value.attachments.length;
      scheduleThreadName({ project, threadId: value.threadId, source: value.text || `${attachmentCount} attached file${attachmentCount === 1 ? "" : "s"}`, kind: "task" });
    }
    return response;
  });
  ipcMain.handle("turns:steer", async (_event, payload) => {
    const value = threadPayload.extend({
      turnId: z.string().min(1),
      ...promptInputSchema
    }).superRefine(requirePromptInput).parse(payload);
    const project = getProject(value.projectId);
    await ensureThreadLoaded(project, value.threadId);
    const prompt = preparePromptInput(value, project, value.threadId);
    return runtime.request("turn/steer", {
      threadId: value.threadId,
      expectedTurnId: value.turnId,
      input: buildCodexUserInput(prompt.text, prompt.images)
    });
  });
  ipcMain.handle("turns:interrupt", async (_event, payload) => {
    const value = threadPayload.extend({ turnId: z.string().min(1) }).parse(payload);
    const project = getProject(value.projectId);
    await ensureThreadLoaded(project, value.threadId);
    const response = await runtime.request("turn/interrupt", { threadId: value.threadId, turnId: value.turnId });
    activeTurns.delete(value.threadId);
    updateTrayMenu();
    return response;
  });

  ipcMain.handle("approvals:resolve", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      decision: z.enum(["accept", "decline", "acceptForSession", "cancel"])
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || pending.generation !== runtimeGeneration) throw new Error("Approval request is no longer pending");
    if (!pending.request.method?.toLowerCase().includes("approval")) throw new Error("Pending request is not an approval");
    runtime.respond(value.requestId, { decision: value.decision });
    pendingRequests.delete(key);
    return { ok: true };
  });
  ipcMain.handle("requests:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      answers: z.record(z.object({ answers: z.array(z.string().trim().min(1)).min(1).max(20) }))
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || pending.generation !== runtimeGeneration) throw new Error("Input request is no longer pending");
    if (!pending.request.method?.includes("requestUserInput")) throw new Error("Pending request does not accept user input");
    runtime.respond(value.requestId, { answers: value.answers });
    pendingRequests.delete(key);
    return { ok: true };
  });
  ipcMain.handle("questions:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      action: z.enum(["answer", "cancel"]).default("answer"),
      answers: z.record(z.string().trim().min(1).max(10_000)).default({})
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || pending.generation !== runtimeGeneration) throw new Error("Question is no longer pending");
    if (pending.kind === "loom-question-tool") {
      runtime.respond(value.requestId, loomQuestionToolResult(value));
    } else if (pending.kind === "loom-question") {
      runtime.respond(value.requestId, value);
    } else if (pending.request.method?.includes("requestUserInput")) {
      const answers = Object.fromEntries(Object.entries(value.answers).map(([id, answer]) => [id, { answers: [answer] }]));
      runtime.respond(value.requestId, { answers });
    } else {
      throw new Error("Pending request is not a question");
    }
    pendingRequests.delete(key);
    return { ok: true };
  });
  ipcMain.handle("elicitations:respond", (_event, payload) => {
    const value = z.object({
      requestId: z.union([z.string(), z.number()]),
      action: z.enum(["accept", "decline", "cancel"]),
      content: z.record(z.unknown()).optional()
    }).parse(payload);
    const key = requestKey(value.requestId);
    const pending = pendingRequests.get(key);
    if (!pending || pending.generation !== runtimeGeneration) throw new Error("Elicitation request is no longer pending");
    if (!pending.request.method?.toLowerCase().includes("elicitation")) throw new Error("Pending request is not an elicitation");
    runtime.respond(value.requestId, {
      action: value.action,
      ...(value.action === "accept" && value.content ? { content: value.content } : {})
    });
    pendingRequests.delete(key);
    return { ok: true };
  });

  ipcMain.handle("review:read", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    const primaryRoot = projectPrimaryRoot(project);
    const repository = await inspectRepository(primaryRoot);
    const diff = repository.kind === "git"
      ? await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: primaryRoot })
      : "";
    return { repository, diff };
  });
  ipcMain.handle("files:read", (_event, payload) => {
    const value = idPayload.extend({ path: z.string().trim().min(1) }).parse(payload);
    return readProjectFile(value.projectId, value.path);
  });
  ipcMain.handle("files:write", (_event, payload) => {
    const value = idPayload.extend({
      path: z.string().trim().min(1),
      content: z.string(),
      expectedMtimeMs: z.number().nonnegative().optional()
    }).parse(payload);
    const current = projectFileTarget(value.projectId, value.path);
    const file = readProjectFile(value.projectId, current.resolved);
    if (!file.editable) throw new Error("This file cannot be edited in Pixice");
    if (Buffer.byteLength(value.content, "utf8") > MAX_EDITABLE_BYTES) throw new Error("Edited file is too large to save in Pixice");
    if (value.expectedMtimeMs !== undefined && Math.abs(current.metadata.mtimeMs - value.expectedMtimeMs) > 1) {
      throw new Error("This file changed on disk. Reopen it before saving so those changes are not overwritten.");
    }
    writeFileSync(current.resolved, value.content, "utf8");
    return readProjectFile(value.projectId, current.resolved);
  });
  ipcMain.handle("external:editor", async (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    const target = projectTarget(value.projectId, value.path);
    return shell.openExternal(`vscode://file/${encodeURI(target)}`);
  });
  ipcMain.handle("external:terminal", async (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    return openTerminal(projectTarget(value.projectId, value.path));
  });
  ipcMain.handle("external:reveal", (_event, payload) => {
    const value = idPayload.extend({ path: z.string().optional() }).parse(payload);
    shell.showItemInFolder(projectTarget(value.projectId, value.path));
    return { ok: true };
  });

  ipcMain.handle("models:list", () => listModels());
  ipcMain.handle("extensions:list", async (_event, payload) => {
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

app.whenReady().then(async () => {
  database = new PixiceDatabase(app.getPath("userData"));
  developerInstructionsPath = isDev
    ? path.join(__dirname, "../resources/runtime/loom-developer-instructions.md")
    : path.join(process.resourcesPath, "runtime/loom-developer-instructions.md");
  agentBehaviorsDirectory = isDev
    ? path.join(__dirname, "../resources/runtime/agent-behaviors")
    : path.join(process.resourcesPath, "runtime/agent-behaviors");
  githubCli = new GitHubCli({ resourcesPath: isDev ? path.join(__dirname, "../resources") : process.resourcesPath });
  prependGitHubCliToPath(process.env, githubCli.resolved);
  githubCli.on("progress", (payload) => send("GitHubAuthProgress", payload));
  codexRuntime = new CodexRuntime({
    resourcesPath: process.resourcesPath,
    clientVersion: app.getVersion(),
    allowDevelopmentRuntime: !app.isPackaged,
    developerInstructionsPath
  });
  runtime = new ProviderRegistry({ database });
  runtime.register(new CodexProvider(codexRuntime));
  const boardThreadContext = (threadId) => {
    const binding = database.getThreadProviderBinding(threadId);
    const project = database.getProject(threadProjects.get(threadId)) ?? projectForPath(binding?.cwd);
    return project ? { projectId: project.id, cwd: binding?.cwd || projectPrimaryRoot(project) } : null;
  };
  loomBoard = new PixiceBoard({
    database,
    threadContext: boardThreadContext,
    onChange: (payload) => send("BoardUpdated", payload)
  });
  loomInstruments = new InstrumentService({
    userDataPath: app.getPath("userData"),
    threadContext: boardThreadContext,
    readCapability: readInstrumentCapability,
    onAgentEvent: deliverInstrumentAgentEvent,
    resolveCapability: resolveInstrumentCapability,
    confirmCapability: async ({ instrument, action, resolution }) => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["Cancel", "Run action"],
        defaultId: 0,
        cancelId: 0,
        message: `Allow ${action.capability}?`,
        detail: `${resolution.summary}\n\nTool request: ${action.confirmation}\nInstrument: ${instrument.metadata?.name || instrument.document.title}`
      });
      return result.response === 1;
    },
    invokeCapability: invokeInstrumentCapability,
    onChange: (payload) => send("InstrumentUpdated", payload),
    onOpen: (payload) => send("InstrumentOpenRequested", payload),
    onEventChange: (payload) => send("InstrumentInteractionUpdated", payload)
  });
  loomBridge = new PixiceBridge({
    runtime,
    database,
    dynamicTools: () => loomDynamicTools,
    threadContext: (threadId) => {
      const binding = database.getThreadProviderBinding(threadId);
      const project = database.getProject(threadProjects.get(threadId)) ?? projectForPath(binding?.cwd);
      if (!project) return null;
      return {
        projectId: project.id,
        cwd: binding?.cwd || projectPrimaryRoot(project),
        runtimeWorkspaceRoots: projectRoots(project),
        developerInstructions: currentAgentInstructions(),
        permissionSettings: (mode) => permissionSettings(mode, project)
      };
    },
    onThreadCreated: ({ context, thread, prompt, model }) => {
      const project = database.getProject(context.projectId);
      if (!project) return;
      rememberThread(project, thread, { loaded: true });
      turnUsageMetadata.set(thread.id, { turnId: null, model: model.id, serviceTier: null, provider: model.provider });
      scheduleThreadName({ project, threadId: thread.id, source: prompt, kind: "thread" });
    },
    onActivity: (payload) => send("AgentUpdated", {
      ...payload,
      projectId: threadProjects.get(payload.threadId)
    })
  });
  runtime.register(new ClaudeProvider({
    database,
    clientVersion: app.getVersion(),
    developerInstructions: currentAgentInstructions,
    loomBridge,
    loomBoard,
    loomInstruments,
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutable()
      ?? (app.isPackaged ? resolvePackagedClaudeCodeExecutable({ resourcesPath: process.resourcesPath }) : undefined),
    requireExternalExecutable: app.isPackaged
  }));
  threadNamer = new ThreadNamer(codexRuntime, { targetRuntime: runtime });
  threadNamer.on("failure", (error) => codexRuntime.emit("diagnostic", `Automatic thread naming failed: ${error.message}`));
  threadNamer.on("named", ({ threadId, name }) => {
    database.saveThreadName(threadId, name);
    send("TaskUpdated", {
      method: "thread/name/updated",
      threadId,
      name,
      projectId: threadProjects.get(threadId)
    });
  });
  runtime.on("status", (status) => {
    if (status.state === "connecting" || status.state === "reconnecting" || status.state === "stopped") {
      threadSessions.clear();
      threadProjects.clear();
      pendingRequests.clear();
      activeTurns.clear();
      pendingTaskNames.clear();
      scheduledThreadNames.clear();
      turnUsageMetadata.clear();
      runtimeGeneration += 1;
      updateTrayMenu();
      send("AttentionReset");
    }
    runtimeStatus = status;
    send("RuntimeStatus", { ...status, connected: runtime.connected });
  });
  runtime.on("event", (event) => {
    const { method, threadId, turn } = event.payload ?? {};
    if (threadNamer.rememberInternalThread(event.payload?.thread) || threadNamer.isInternalThread(threadId)) return;
    const collabItem = event.payload?.item;
    if ((collabItem?.type === "collabAgentToolCall" || collabItem?.type === "collabToolCall") && collabItem.receiverThreadIds?.length) {
      const parentUsage = turnUsageMetadata.get(collabItem.senderThreadId ?? threadId) ?? {};
      for (const receiverThreadId of collabItem.receiverThreadIds) {
        turnUsageMetadata.set(receiverThreadId, {
          turnId: null,
          model: collabItem.model ?? parentUsage.model ?? null,
          serviceTier: parentUsage.serviceTier ?? null,
          provider: event.payload?.provider ?? parentUsage.provider ?? "codex"
        });
      }
    }
    try {
      if (recordUsage(event.payload ?? {})) send("UsageUpdated", { recordedAt: new Date().toISOString() });
    } catch (error) {
      codexRuntime.emit("diagnostic", `Usage recording failed: ${error.message}`);
    }
    if (method === "thread/name/updated" && threadId && event.payload?.name) {
      database.saveThreadName(threadId, event.payload.name);
    }
    if (method === "turn/started" && threadId) {
      threadPlans.set(threadId, []);
      database.saveThreadPlan(threadId, []);
    }
    if (method === "turn/plan/updated" && threadId) {
      const plan = event.payload.plan ?? [];
      threadPlans.set(threadId, plan);
      database.saveThreadPlan(threadId, plan);
    }
    if ((method === "thread/deleted" || method === "thread/archived") && threadId) {
      loomInstruments.removeEphemeralForThread(threadId);
      threadPlans.delete(threadId);
      threadMonitorCache.delete(threadId);
      threadSessions.delete(threadId);
      threadProjects.delete(threadId);
      turnUsageMetadata.delete(threadId);
      database.deleteThreadRuntimeState(threadId);
      database.deleteThreadProviderBinding(threadId);
      database.deleteThreadLink(threadId);
      database.detachBoardTasksForThread(threadId);
      browserWorkspace?.destroyWorkspace(threadId);
      if (method === "thread/deleted") database.deleteThreadName(threadId);
    }
    if (threadId && (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed")) {
      threadMonitorCache.delete(threadId);
    }
    if (method === "thread/started" && event.payload?.thread?.id) {
      const project = projectForPath(event.payload.thread.cwd);
      if (project) rememberThread(project, event.payload.thread, { loaded: true });
    }
    if (method === "turn/started" && threadId && turn?.id) activeTurns.set(threadId, turn.id);
    if (method === "turn/completed" && threadId) activeTurns.delete(threadId);
    if (method === "turn/started" || method === "turn/completed") updateTrayMenu();
    scheduleDelegatedThreadNames(event);
    send(event.type, {
      ...event.payload,
      projectId: threadProjects.get(threadId ?? event.payload?.thread?.id)
    });
  });
  runtime.on("server-request", (request) => {
    if (request.method === "item/tool/call" && request.params?.namespace === LOOM_BOARD_NAMESPACE) {
      void loomBoard.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === LOOM_INSTRUMENTS_NAMESPACE) {
      void loomInstruments.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === LOOM_BRIDGE_NAMESPACE) {
      void loomBridge.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    if (request.method === "item/tool/call" && request.params?.namespace === "loom_browser") {
      void browserWorkspace.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    let displayRequest = request;
    let kind = "runtime-request";
    if (isPixiceQuestionToolCall(request)) {
      try {
        displayRequest = loomQuestionRequest(request);
        kind = "loom-question-tool";
      } catch (error) {
        runtime.respond(request.id, {
          success: false,
          contentItems: [{ type: "inputText", text: `Invalid Pixice question: ${error.message}` }]
        });
        return;
      }
    } else if (request.method === LOOM_QUESTION_METHOD) kind = "loom-question";
    pendingRequests.set(requestKey(request.id), { request, kind, generation: runtimeGeneration });
    send("AttentionRequired", { ...displayRequest, projectId: threadProjects.get(request.params?.threadId) });
    if (Notification.isSupported()) {
      new Notification({ title: kind.startsWith("loom-question") ? "A task has a question" : "Pixice needs your attention", body: displayRequest.method }).show();
    }
  });
  runtime.on("recoverable-error", (error) => send("RuntimeError", error));

  createWindow();
  browserWorkspace = new BrowserWorkspace({ window: mainWindow, WebContentsView, emit: send });
  appUpdater = new PixiceAppUpdater({ updater: autoUpdater, app });
  appUpdater.on("status", (status) => {
    send("UpdateState", status);
    if (status.state === "downloaded" && Notification.isSupported()) {
      new Notification({ title: "Pixice update ready", body: "Restart Pixice when you are ready to install it." }).show();
    }
  });
  createTray();
  registerIpc();
  appUpdater.start();
  await runtime.start();
  app.on("activate", () => mainWindow.show());
});

app.on("before-quit", async (event) => {
  if (quitting) return;
  if (activeTurns.size) {
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Keep Pixice running", "Interrupt and quit"],
      defaultId: 0,
      cancelId: 0,
      message: `${activeTurns.size} active turn${activeTurns.size === 1 ? " is" : "s are"} still running.`,
      detail: "Quitting will interrupt active work. Closing the window keeps Pixice running in the tray."
    });
    if (result.response === 0) return;
    await Promise.allSettled([...activeTurns].map(([threadId, turnId]) =>
      Promise.resolve().then(() => runtime.request("turn/interrupt", { threadId, turnId }))
    ));
  }
  quitting = true;
  appUpdater?.stop();
  browserWorkspace?.destroy();
  await runtime?.stop();
  loomInstruments?.close();
  app.quit();
});

app.on("window-all-closed", () => {});
