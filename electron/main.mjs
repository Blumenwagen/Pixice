import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
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
let mainWindow;
let tray;
let runtime;
let database;
let quitting = false;
let activeTurns = 0;

const send = (type, payload = {}) => mainWindow?.webContents.send("loom:event", { type, payload, at: new Date().toISOString() });

function createWindow() {
  const captureWidth = Number(process.env.LOOM_CAPTURE_WIDTH || 1480);
  const captureHeight = Number(process.env.LOOM_CAPTURE_HEIGHT || 1000);
  mainWindow = new BrowserWindow({
    width: captureWidth,
    height: captureHeight,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#080b11",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
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
    if (!quitting) { event.preventDefault(); mainWindow.hide(); }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Loom");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loom", click: () => mainWindow.show() },
    { label: activeTurns ? `${activeTurns} active turn${activeTurns === 1 ? "" : "s"}` : "No active turns", enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]));
  tray.on("click", () => mainWindow.show());
}

function registerIpc() {
  const taskPayload = z.object({ threadId: z.string().optional(), text: z.string().min(1).optional() }).passthrough();
  ipcMain.handle("projects:list", () => database.listProjects());
  ipcMain.handle("projects:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled) return null;
    const canonicalPath = path.resolve(result.filePaths[0]);
    const repository = await inspectRepository(canonicalPath);
    const now = new Date().toISOString();
    return database.upsertProject({ id: randomUUID(), canonicalPath, displayName: path.basename(canonicalPath), createdAt: now, updatedAt: now, repository });
  });
  ipcMain.handle("turns:start", async (_event, payload) => {
    const value = taskPayload.parse(payload);
    activeTurns += 1;
    send("TaskUpdated", { state: "running" });
    return runtime.connected ? runtime.request("turn/start", value) : { queued: false, demo: true };
  });
  ipcMain.handle("turns:steer", (_event, payload) => runtime.request("turn/steer", taskPayload.parse(payload)));
  ipcMain.handle("tasks:interrupt", async (_event, payload) => {
    if (runtime.connected) await runtime.request("turn/interrupt", taskPayload.parse(payload));
    activeTurns = Math.max(0, activeTurns - 1);
    send("TaskUpdated", { state: "interrupted" });
    return { ok: true };
  });
  ipcMain.handle("approvals:resolve", (_event, payload) => {
    const value = z.object({ requestId: z.string(), decision: z.enum(["accept", "decline", "acceptForSession"]) }).parse(payload);
    if (runtime.connected) runtime.respond(value.requestId, { decision: value.decision });
    return { ok: true };
  });
  ipcMain.handle("review:read", (_event, payload) => readDiff(z.object({ workingPath: z.string(), baseCommit: z.string().nullable() }).parse(payload)));
  ipcMain.handle("external:editor", (_event, { path: target }) => shell.openPath(target));
  ipcMain.handle("external:terminal", (_event, { path: target }) => shell.openPath(target));
  ipcMain.handle("external:reveal", (_event, { path: target }) => shell.showItemInFolder(target));
  ipcMain.handle("tasks:create", () => ({ id: randomUUID(), state: "draft" }));
  ipcMain.handle("tasks:archive", () => ({ ok: true }));
  ipcMain.handle("extensions:list", () => ({ skills: [], apps: [], mcp: [] }));
  ipcMain.handle("extensions:update", (_event, payload) => ({ ...payload, ok: true }));
}

app.whenReady().then(async () => {
  database = new LoomDatabase(app.getPath("userData"));
  createWindow();
  createTray();
  registerIpc();
  runtime = new CodexRuntime({ resourcesPath: process.resourcesPath, clientVersion: app.getVersion() });
  runtime.on("event", (event) => send(event.type, event.payload));
  runtime.on("server-request", (request) => {
    send("AttentionRequired", request);
    if (Notification.isSupported()) new Notification({ title: "Loom needs your attention", body: request.method }).show();
  });
  runtime.on("recoverable-error", (error) => send("RuntimeError", error));
  await runtime.start();
  app.on("activate", () => mainWindow.show());
});

app.on("before-quit", async (event) => {
  if (quitting) return;
  if (activeTurns) {
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning", buttons: ["Keep Loom running", "Interrupt and quit"], defaultId: 0, cancelId: 0,
      message: `${activeTurns} active turn${activeTurns === 1 ? " is" : "s are"} still running.`,
      detail: "Quitting will interrupt active work. Closing the window keeps Loom running in the tray."
    });
    if (result.response === 0) return;
  }
  quitting = true;
  await runtime?.stop();
  app.quit();
});

app.on("window-all-closed", () => {});
