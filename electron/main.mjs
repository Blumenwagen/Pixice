import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import electronUpdater from "electron-updater";
import { CodexRuntime } from "./runtime/codex-runtime.mjs";
import { ThreadSessionRegistry } from "./runtime/thread-session-registry.mjs";
import { ThreadNamer } from "./runtime/thread-namer.mjs";
import { buildCodexUserInput } from "./runtime/user-input.mjs";
import { CodexProvider } from "./providers/codex-provider.mjs";
import { ClaudeProvider, resolveClaudeCodeExecutable, resolvePackagedClaudeCodeExecutable } from "./providers/claude-provider.mjs";
import { ProviderRegistry } from "./providers/provider-registry.mjs";
import { BrowserWorkspace, browserDynamicTools } from "./browser/browser-workspace.mjs";
import { LoomAppUpdater } from "./updater/app-updater.mjs";
import { LoomDatabase } from "./persistence/database.mjs";
import { inspectRepository, readDiff } from "./git/worktrees.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const isDev = !app.isPackaged;
const threadSourceKinds = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
];

let mainWindow;
let tray;
let runtime;
let codexRuntime;
let threadNamer;
let browserWorkspace;
let appUpdater;
let database;
let quitting = false;
let runtimeStatus = { state: "starting" };
const activeTurns = new Map();
const threadSessions = new ThreadSessionRegistry();
const threadPlans = new Map();
const threadMonitorCache = new Map();
const threadProjects = new Map();
const pendingRequests = new Map();
const pendingTaskNames = new Set();
const scheduledThreadNames = new Set();
let runtimeGeneration = 0;

const idPayload = z.object({ projectId: z.string().min(1) });
const threadPayload = idPayload.extend({ threadId: z.string().min(1) });
const permissionModeSchema = z.enum(["read-only", "workspace-write", "auto-approve", "full-access"]);
const imageDataUrlSchema = z.string().max(30 * 1024 * 1024).refine(
  (value) => /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(value),
  "Image must be a supported base64 data URL"
);
const promptInputSchema = {
  text: z.string().trim().max(100_000).default(""),
  images: z.array(imageDataUrlSchema).max(10).default([])
};
const requirePromptInput = (value, context) => {
  if (!value.text && value.images.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A message or image is required" });
  }
};
const send = (type, payload = {}) => mainWindow?.webContents.send("loom:event", { type, payload, at: new Date().toISOString() });

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
      writableRoots: [project.canonicalPath],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  };
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

function projectTarget(projectId, target) {
  const project = getProject(projectId);
  const resolved = realpathSync(path.resolve(target ?? project.canonicalPath));
  if (!isWithin(project.canonicalPath, resolved)) throw new Error("Target is outside the selected project");
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
  const candidate = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(project.canonicalPath, cleaned);
  const resolved = realpathSync(candidate);
  if (!isWithin(project.canonicalPath, resolved)) throw new Error("File is outside the selected project");
  const metadata = statSync(resolved);
  if (!metadata.isFile()) throw new Error("The selected path is not a file");
  return { project, resolved, metadata };
}

function readProjectFile(projectId, reference) {
  const { project, resolved, metadata } = projectFileTarget(projectId, reference);
  if (metadata.size > MAX_PREVIEW_BYTES) throw new Error("File is too large to open in Loom");
  const extension = path.extname(resolved).toLowerCase();
  const buffer = readFileSync(resolved);
  const imageMime = IMAGE_MIME_TYPES.get(extension);
  const isPdf = extension === ".pdf";
  if (imageMime || isPdf) {
    const mimeType = imageMime || "application/pdf";
    return {
      path: resolved,
      relativePath: path.relative(project.canonicalPath, resolved),
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
    relativePath: path.relative(project.canonicalPath, resolved),
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
    .filter((project) => isWithin(project.canonicalPath, canonicalTarget))
    .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0] ?? null;
}

function rememberThread(project, thread, { loaded = false } = {}) {
  if (!thread?.id) return;
  const cwd = realpathSync(thread.cwd ?? project.canonicalPath);
  if (!isWithin(project.canonicalPath, cwd)) throw new Error("Thread is outside the selected project");
  threadSessions.remember(thread.id, cwd, { loaded });
  threadProjects.set(thread.id, project.id);
}

function withPersistedThreadName(thread) {
  if (!thread?.id) return thread;
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
    cwd: project.canonicalPath,
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
  return { ...project, repository: await inspectRepository(project.canonicalPath) };
}

async function listProjects() {
  return Promise.all(database.listProjects().map(projectWithRepository));
}

function updateTrayMenu() {
  if (!tray) return;
  const count = activeTurns.size;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loom", click: () => mainWindow.show() },
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
  tray.setToolTip("Loom");
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

async function ensureThreadLoaded(project, threadId) {
  const cwd = await threadSessions.ensure(threadId, async () => {
    const response = await runtime.request("thread/resume", { threadId });
    const resumedCwd = response.thread?.cwd;
    if (!resumedCwd) throw new Error("Runtime returned a thread without a working directory");
    return realpathSync(resumedCwd);
  });
  if (!isWithin(project.canonicalPath, cwd)) throw new Error("Thread is outside the selected project");
  threadProjects.set(threadId, project.id);
}

function registerIpc() {
  ipcMain.handle("app:bootstrap", async () => ({
    projects: await listProjects(),
    models: await listModels().catch(() => []),
    runtime: { ...runtimeStatus, connected: runtime.connected }
  }));
  ipcMain.handle("runtime:status", () => ({ ...runtimeStatus, connected: runtime.connected }));
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

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    const canonicalPath = realpathSync(result.filePaths[0]);
    const now = new Date().toISOString();
    const project = database.upsertProject({
      id: randomUUID(),
      canonicalPath,
      displayName: path.basename(canonicalPath),
      createdAt: now,
      updatedAt: now
    });
    return projectWithRepository(project);
  });

  ipcMain.handle("threads:list", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    if (!runtime.connected) return { data: [], nextCursor: null };
    const response = await runtime.request("thread/list", {
      cwd: project.canonicalPath,
      limit: 200,
      sourceKinds: threadSourceKinds,
      archived: false
    });
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
    if (!isWithin(project.canonicalPath, response.thread.cwd)) throw new Error("Thread is outside the selected project");
    rememberThread(project, response.thread);
    const thread = withPersistedThreadName(response.thread);
    return { ...response, thread, plan: threadPlans.get(threadId) ?? database.getThreadPlan(threadId) };
  });
  ipcMain.handle("threads:children", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    if (!runtime.connected) return { data: [], nextCursor: null };
    const response = await runtime.request("thread/list", {
      cwd: project.canonicalPath,
      ancestorThreadId: threadId,
      limit: 200,
      sourceKinds: threadSourceKinds,
      archived: false
    });
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
      permissionMode: permissionModeSchema.default("workspace-write")
    }).parse(payload);
    const project = getProject(value.projectId);
    const permissions = permissionSettings(value.permissionMode, project);
    const response = await runtime.request("thread/start", {
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      model: value.model || null,
      permissionMode: value.permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
      dynamicTools: browserDynamicTools,
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
    browserWorkspace.destroyWorkspace(threadId);
    return response;
  });

  ipcMain.handle("turns:start", async (_event, payload) => {
    const value = threadPayload.extend({
      ...promptInputSchema,
      model: z.string().optional(),
      effort: z.string().optional(),
      permissionMode: permissionModeSchema.default("workspace-write")
    }).superRefine(requirePromptInput).parse(payload);
    const project = getProject(value.projectId);
    const permissions = permissionSettings(value.permissionMode, project);
    await ensureThreadLoaded(project, value.threadId);
    const response = await runtime.request("turn/start", {
      threadId: value.threadId,
      input: buildCodexUserInput(value.text, value.images),
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      model: value.model || null,
      effort: value.effort || null,
      permissionMode: value.permissionMode,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy
    });
    activeTurns.set(value.threadId, response.turn.id);
    updateTrayMenu();
    if (pendingTaskNames.delete(value.threadId)) {
      scheduleThreadName({ project, threadId: value.threadId, source: value.text || `${value.images.length} attached image${value.images.length === 1 ? "" : "s"}`, kind: "task" });
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
    return runtime.request("turn/steer", {
      threadId: value.threadId,
      expectedTurnId: value.turnId,
      input: buildCodexUserInput(value.text, value.images)
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
    const repository = await inspectRepository(project.canonicalPath);
    const diff = repository.kind === "git"
      ? await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: project.canonicalPath })
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
    if (!file.editable) throw new Error("This file cannot be edited in Loom");
    if (Buffer.byteLength(value.content, "utf8") > MAX_EDITABLE_BYTES) throw new Error("Edited file is too large to save in Loom");
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
      runtime.request("skills/list", { cwds: project ? [project.canonicalPath] : [] }),
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
  database = new LoomDatabase(app.getPath("userData"));
  const developerInstructionsPath = isDev
    ? path.join(__dirname, "../resources/runtime/loom-developer-instructions.md")
    : path.join(process.resourcesPath, "runtime/loom-developer-instructions.md");
  codexRuntime = new CodexRuntime({
    resourcesPath: process.resourcesPath,
    clientVersion: app.getVersion(),
    allowDevelopmentRuntime: !app.isPackaged,
    developerInstructionsPath
  });
  runtime = new ProviderRegistry({ database });
  runtime.register(new CodexProvider(codexRuntime));
  runtime.register(new ClaudeProvider({
    database,
    clientVersion: app.getVersion(),
    developerInstructionsPath,
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
      threadPlans.delete(threadId);
      threadMonitorCache.delete(threadId);
      threadSessions.delete(threadId);
      threadProjects.delete(threadId);
      database.deleteThreadRuntimeState(threadId);
      database.deleteThreadProviderBinding(threadId);
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
    if (request.method === "item/tool/call" && request.params?.namespace === "loom_browser") {
      void browserWorkspace.handleToolCall(request.params)
        .then((response) => runtime.respond(request.id, response))
        .catch((error) => runtime.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] }));
      return;
    }
    pendingRequests.set(requestKey(request.id), { request, generation: runtimeGeneration });
    send("AttentionRequired", { ...request, projectId: threadProjects.get(request.params?.threadId) });
    if (Notification.isSupported()) {
      new Notification({ title: "Loom needs your attention", body: request.method }).show();
    }
  });
  runtime.on("recoverable-error", (error) => send("RuntimeError", error));

  createWindow();
  browserWorkspace = new BrowserWorkspace({ window: mainWindow, WebContentsView, emit: send });
  appUpdater = new LoomAppUpdater({ updater: autoUpdater, app });
  appUpdater.on("status", (status) => {
    send("UpdateState", status);
    if (status.state === "downloaded" && Notification.isSupported()) {
      new Notification({ title: "Loom update ready", body: "Restart Loom when you are ready to install it." }).show();
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
      buttons: ["Keep Loom running", "Interrupt and quit"],
      defaultId: 0,
      cancelId: 0,
      message: `${activeTurns.size} active turn${activeTurns.size === 1 ? " is" : "s are"} still running.`,
      detail: "Quitting will interrupt active work. Closing the window keeps Loom running in the tray."
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
  app.quit();
});

app.on("window-all-closed", () => {});
