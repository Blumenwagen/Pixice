import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexRuntime } from "./runtime/codex-runtime.mjs";
import { LoomDatabase } from "./persistence/database.mjs";
import { inspectRepository, readDiff } from "./git/worktrees.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const threadSourceKinds = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
];

let mainWindow;
let tray;
let runtime;
let database;
let quitting = false;
let runtimeStatus = { state: "starting" };
const activeTurns = new Map();

const idPayload = z.object({ projectId: z.string().min(1) });
const threadPayload = idPayload.extend({ threadId: z.string().min(1) });
const send = (type, payload = {}) => mainWindow?.webContents.send("loom:event", { type, payload, at: new Date().toISOString() });

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
  const resolved = path.resolve(target ?? project.canonicalPath);
  if (!isWithin(project.canonicalPath, resolved)) throw new Error("Target is outside the selected project");
  return resolved;
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.once("did-finish-load", () => {
    if (!process.env.LOOM_CAPTURE_PATH) return;
    setTimeout(async () => {
      const image = await mainWindow.webContents.capturePage();
      writeFileSync(process.env.LOOM_CAPTURE_PATH, image.toPNG());
      quitting = true;
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
  tray = new Tray(nativeImage.createEmpty());
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

function registerIpc() {
  ipcMain.handle("app:bootstrap", async () => ({
    projects: await listProjects(),
    models: await listModels().catch(() => []),
    runtime: { ...runtimeStatus, connected: runtime.connected }
  }));
  ipcMain.handle("runtime:status", () => ({ ...runtimeStatus, connected: runtime.connected }));

  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    const canonicalPath = path.resolve(result.filePaths[0]);
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
    return runtime.request("thread/list", {
      cwd: project.canonicalPath,
      limit: 200,
      sourceKinds: threadSourceKinds,
      archived: false
    });
  });
  ipcMain.handle("threads:read", async (_event, payload) => {
    const { projectId, threadId } = threadPayload.parse(payload);
    const project = getProject(projectId);
    const response = await runtime.request("thread/read", { threadId, includeTurns: true });
    if (!isWithin(project.canonicalPath, response.thread.cwd)) throw new Error("Thread is outside the selected project");
    return response;
  });
  ipcMain.handle("threads:create", async (_event, payload) => {
    const value = idPayload.extend({ model: z.string().optional() }).parse(payload);
    const project = getProject(value.projectId);
    return runtime.request("thread/start", {
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      model: value.model || null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      threadSource: "loom"
    });
  });
  ipcMain.handle("threads:archive", (_event, payload) => {
    const { threadId } = threadPayload.parse(payload);
    return runtime.request("thread/archive", { threadId });
  });

  ipcMain.handle("turns:start", async (_event, payload) => {
    const value = threadPayload.extend({
      text: z.string().trim().min(1),
      model: z.string().optional(),
      effort: z.string().optional()
    }).parse(payload);
    const project = getProject(value.projectId);
    const response = await runtime.request("turn/start", {
      threadId: value.threadId,
      input: [{ type: "text", text: value.text, text_elements: [] }],
      cwd: project.canonicalPath,
      runtimeWorkspaceRoots: [project.canonicalPath],
      model: value.model || null,
      effort: value.effort || null
    });
    activeTurns.set(value.threadId, response.turn.id);
    updateTrayMenu();
    return response;
  });
  ipcMain.handle("turns:steer", (_event, payload) => {
    const value = threadPayload.extend({
      turnId: z.string().min(1),
      text: z.string().trim().min(1)
    }).parse(payload);
    return runtime.request("turn/steer", {
      threadId: value.threadId,
      expectedTurnId: value.turnId,
      input: [{ type: "text", text: value.text, text_elements: [] }]
    });
  });
  ipcMain.handle("turns:interrupt", async (_event, payload) => {
    const value = threadPayload.extend({ turnId: z.string().min(1) }).parse(payload);
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
    runtime.respond(value.requestId, { decision: value.decision });
    return { ok: true };
  });

  ipcMain.handle("review:read", async (_event, payload) => {
    const { projectId } = idPayload.parse(payload);
    const project = getProject(projectId);
    const repository = await inspectRepository(project.canonicalPath);
    const diff = repository.kind === "git"
      ? await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit })
      : "";
    return { repository, diff };
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
    const value = z.object({ cwd: z.string().optional(), threadId: z.string().optional() }).parse(payload ?? {});
    const [skills, apps, mcp] = await Promise.allSettled([
      runtime.request("skills/list", { cwds: value.cwd ? [value.cwd] : [] }),
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
  runtime = new CodexRuntime({ resourcesPath: process.resourcesPath, clientVersion: app.getVersion() });
  runtime.on("status", (status) => {
    runtimeStatus = status;
    send("RuntimeStatus", { ...status, connected: runtime.connected });
  });
  runtime.on("event", (event) => {
    const { method, threadId, turn } = event.payload ?? {};
    if (method === "turn/started" && threadId && turn?.id) activeTurns.set(threadId, turn.id);
    if (method === "turn/completed" && threadId) activeTurns.delete(threadId);
    if (method === "turn/started" || method === "turn/completed") updateTrayMenu();
    send(event.type, event.payload);
  });
  runtime.on("server-request", (request) => {
    send("AttentionRequired", request);
    if (Notification.isSupported()) {
      new Notification({ title: "Loom needs your attention", body: request.method }).show();
    }
  });
  runtime.on("recoverable-error", (error) => send("RuntimeError", error));

  createWindow();
  createTray();
  registerIpc();
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
    await Promise.allSettled([...activeTurns].map(([threadId, turnId]) => runtime.request("turn/interrupt", { threadId, turnId })));
  }
  quitting = true;
  await runtime?.stop();
  app.quit();
});

app.on("window-all-closed", () => {});
