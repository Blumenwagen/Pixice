import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, safeStorage, screen, shell, Tray, WebContentsView } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import electronUpdater from 'electron-updater';
import { BrowserWorkspace } from './browser/browser-workspace.mjs';
import { PixiceAppUpdater } from './updater/app-updater.mjs';
import { createSystemAwakeController } from './runtime/system-awake.mjs';
import { ApplicationClient } from './connect/application-client.mjs';
import { APPLICATION_CHANNELS } from './connect/application-protocol.mjs';
import { backendBuildId, descriptorInstance, ensureService, readServiceDescriptor, serviceCall, stopService } from './backend/manager.mjs';
import { BrowserSessions } from './native/browser-sessions.mjs';
import { NativeHelperClient } from './native/helper-client.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const helperOnly = process.argv.includes('--pixice-native-helper');
const dataIndex = process.argv.indexOf('--pixice-data-dir');
if (dataIndex >= 0 && process.argv[dataIndex + 1]) app.setPath('userData', path.resolve(process.argv[dataIndex + 1]));
const dataDirectory = app.getPath('userData');
const browserSessions = new BrowserSessions(dataDirectory);
let mainWindow, tray, trayWindow, trayIconDataUrl, browserWorkspace, appUpdater, client, nativeHelper;
let quitting = false, desktopLoaded = false, connecting;
const loginSupported = process.platform === 'darwin' || process.platform === 'win32';
let connectionState = { state: 'connecting' };
let trayState = { items: [], activeCount: 0 };
const awake = createSystemAwakeController(powerSaveBlocker);
const configuration = {
  dataDirectory, resourcesPath: isDev ? path.join(__dirname, '../resources') : process.resourcesPath, clientDirectory: path.join(__dirname, '../dist/client'),
  version: app.getVersion(), buildId: backendBuildId(), runAsNode: true,
  nativeConfiguration: { command: process.execPath, args: isDev ? [path.resolve(__dirname, '..')] : [] }, waitForReady: false
};
function send(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed() && desktopLoaded) mainWindow.webContents.send('pixice:event', { type, payload, at: new Date().toISOString() });
}
function updateConnection(value) { connectionState = value; send('ServiceConnectionState', value); }
async function connectService({ start = true } = {}) {
  if (connecting) return connecting;
  connecting = (async () => {
    const descriptor = start ? await ensureService(configuration) : await readServiceDescriptor(dataDirectory);
    nativeHelper?.close(); client?.close();
    client = new ApplicationClient(descriptorInstance(descriptor), {
      probe: 'service.status', resolveInstance: async () => descriptorInstance(await readServiceDescriptor(dataDirectory)),
      onState: (value) => { updateConnection(value); },
      onReset: () => send('ServiceReset')
    });
    client.subscribe((event) => {
      if (event.type === 'TrayState') { trayState = event.payload; updateTrayMenu(); }
      send(event.type, event.payload);
    });
    nativeHelper = new NativeHelperClient({ directory: dataDirectory, browser: browserWorkspace, sessions: browserSessions, invokeDesktop, crypto: safeStorage });
    nativeHelper.start();
    await client.connect();
    void refreshTrayState().catch(() => {});
    return { connected: true };
  })().catch((error) => { updateConnection({ state: 'error', error: error.message }); throw error; }).finally(() => { connecting = null; });
  return connecting;
}
async function invokeDesktop(method, args) {
  const value = args[0];
  if (method === 'notify') { if (!Notification.isSupported()) return false; new Notification(value).show(); return true; }
  if (method === 'openExternal') return shell.openExternal(value);
  if (method === 'openDialog') { await openMainWindow(); return dialog.showOpenDialog(mainWindow, value); }
  if (method === 'reveal') { shell.showItemInFolder(value); return true; }
  if (method === 'openTerminal') return openTerminal(value);
  if (method === 'setKeepAwake') return awake.setEnabled(value === true);
  if (method === 'confirmAction') {
    await openMainWindow();
    const { instrument, action, resolution } = value;
    const result = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['Cancel', 'Run action'], defaultId: 0, cancelId: 0,
      message: `Allow ${action.capability}?`, detail: `${resolution.summary}\n\nTool request: ${action.confirmation}\nInstrument: ${instrument.metadata?.name || instrument.document.title}` });
    return result.response === 1;
  }
  if (method === 'serviceStopped') { awake.stop(); updateConnection({ state: 'stopped' }); return { exitHelper: value?.reason === 'user' && !desktopLoaded }; }
  if (method === 'shutdown') return { exitHelper: true };
  if (method === 'finishShutdown') return shutdownNative();
  throw new Error('Unsupported desktop capability');
}
function currentTrayState() { return { ...trayState, appIconDataUrl: trayIconDataUrl }; }
function sendTrayState() { if (trayWindow && !trayWindow.isDestroyed()) trayWindow.webContents.send('tray:state', currentTrayState()); }
function updateTrayMenu() { if (!tray) return; tray.setToolTip('Pixice'); if (process.platform !== 'darwin') tray.setContextMenu(nativeTrayMenu()); sendTrayState(); }
async function refreshTrayState() { trayState = await client.call('tray.refresh'); updateTrayMenu(); return currentTrayState(); }
function nativeTrayMenu() { return Menu.buildFromTemplate([{ label: 'Open Pixice', click: () => void openMainWindow() }, { type: 'separator' }, { label: 'Quit Pixice interface', click: () => app.quit() }]); }
async function openMainWindow(destination = null) {
  trayWindow?.hide(); app.dock?.show();
  if (!desktopLoaded) {
    desktopLoaded = true;
    if (isDev) await mainWindow.loadURL('http://127.0.0.1:5173');
    else await mainWindow.loadFile(path.join(__dirname, '../dist/client/index.html'));
  }
  if (!tray) createTray();
  mainWindow.webContents.setBackgroundThrottling(true);
  mainWindow.show(); mainWindow.focus();
  if (destination) send('TrayNavigate', destination);
}
function shutdownNative() {
  quitting = true;
  nativeHelper?.close(); client?.close(); appUpdater?.stop(); awake.stop();
  browserSessions.flush(); browserWorkspace?.destroy();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(0);
}
function detachDesktop() {
  mainWindow?.hide(); trayWindow?.destroy(); trayWindow = null; tray?.destroy(); tray = null;
  browserWorkspace?.hideViewport();
  desktopLoaded = false; void mainWindow?.loadURL('about:blank'); app.dock?.hide();
}
function positionTrayWindow() {
  if (!trayWindow || trayWindow.isDestroyed() || !tray) return;
  const trayBounds = tray.getBounds();
  const windowBounds = trayWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: Math.round(trayBounds.x), y: Math.round(trayBounds.y) });
  const workArea = display.workArea;
  const x = Math.min(
    workArea.x + workArea.width - windowBounds.width - 8,
    Math.max(workArea.x + 8, Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2))
  );
  const y = Math.min(workArea.y + workArea.height - windowBounds.height - 8, Math.round(trayBounds.y + trayBounds.height + 5));
  trayWindow.setPosition(x, y, false);
}

function toggleTrayWindow() {
  if (!trayWindow || trayWindow.isDestroyed()) return;
  if (trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }
  positionTrayWindow();
  sendTrayState();
  trayWindow.show();
  trayWindow.focus();
  void refreshTrayState();
}

function createWindow() {
  const captureWidth = Number(process.env.PIXICE_CAPTURE_WIDTH || 1480);
  const captureHeight = Number(process.env.PIXICE_CAPTURE_HEIGHT || 1000);
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
      sandbox: true,
      backgroundThrottling: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const destination = new URL(url);
    if (url === "about:blank") return;
    const allowed = isDev
      ? destination.origin === "http://127.0.0.1:5173"
      : destination.protocol === "file:" && path.normalize(fileURLToPath(destination)) === path.normalize(path.join(__dirname, "../dist/client/index.html"));
    if (allowed) return;
    event.preventDefault();
    if (destination.protocol === "https:" || destination.protocol === "http:") shell.openExternal(url);
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTrayWindow() {
  trayWindow = new BrowserWindow({
    width: 382,
    height: 480,
    minWidth: 382,
    maxWidth: 382,
    minHeight: 180,
    maxHeight: 620,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "popover",
    visualEffectState: "active",
    roundedCorners: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "tray/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  trayWindow.loadFile(path.join(__dirname, "tray/tray.html"));
  trayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  trayWindow.webContents.once("did-finish-load", sendTrayState);
  trayWindow.on("blur", () => trayWindow?.hide());
  trayWindow.on("closed", () => { trayWindow = null; });
}

function createTray() {
  const iconPath = isDev ? path.join(__dirname, "../build/icon.png") : path.join(process.resourcesPath, "app-icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  trayIconDataUrl = nativeImage.createFromPath(iconPath).resize({ width: 64, height: 64 }).toDataURL();
  tray = new Tray(icon);
  tray.setToolTip("Pixice");
  updateTrayMenu();
  if (process.platform === "darwin") {
    createTrayWindow();
    tray.on("click", toggleTrayWindow);
    tray.on("right-click", () => tray.popUpContextMenu(nativeTrayMenu()));
  } else {
    tray.on("click", () => openMainWindow());
  }
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

function registerIpc() {
  const handle = (channel, handler) => ipcMain.handle(channel, (event, payload) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Untrusted desktop sender');
    return handler(payload);
  });
  for (const [channel, operation] of APPLICATION_CHANNELS) {
    if (operation.startsWith('native.') || operation.startsWith('service.') || operation.startsWith('tray.')) continue;
    handle(channel, async (payload) => {
      if (!client) { if (!connecting) throw new Error('The backend is offline. Start it in Connections.'); await connecting; }
      return client.call(operation, payload);
    });
  }
  handle('service:connection', () => connectionState);
  handle('service:status', async () => ({ ...await serviceCall(await readServiceDescriptor(dataDirectory), 'service.status'), loginSupported, openAtLogin: loginSupported ? app.getLoginItemSettings().openAtLogin : false }));
  handle('service:start', () => connectService());
  handle('service:stop', () => stopService(dataDirectory));
  handle('service:restart', async () => { await stopService(dataDirectory, { restart: true }); return connectService(); });
  handle('service:login', (value) => { const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(value); if (!loginSupported) throw new Error('Use your system service manager to start Pixice at login on this platform.'); app.setLoginItemSettings({ openAtLogin: enabled, args: [...(isDev ? [path.resolve(__dirname, '..')] : []), '--pixice-native-helper'] }); return { enabled }; });
  for (const action of ['status', 'check', 'download', 'install']) handle(`updates:${action}`, () => action === 'status' ? appUpdater.snapshot() : appUpdater[action]());
  ipcMain.handle('tray:action', async (event, payload) => {
    if (event.sender !== trayWindow?.webContents) throw new Error('Untrusted tray sender');
    const { action, value } = z.object({ action: z.enum(['open', 'open-thread', 'usage', 'refresh', 'follow-up', 'keep-awake', 'resize', 'dismiss', 'quit']), value: z.unknown().optional() }).strict().parse(payload);
    if (action === 'open') await openMainWindow();
    if (action === 'open-thread') await openMainWindow(await client.call('tray.thread', value));
    if (action === 'usage') await openMainWindow({ view: 'settings', settingsPage: 'usage' });
    if (action === 'refresh') return refreshTrayState();
    if (action === 'follow-up') return client.call('tray.followUp', value);
    if (action === 'keep-awake') { await client.call('app.saveSettings', { keepSystemAwake: value === true }); send('TraySettingsUpdated', { keepSystemAwake: value === true }); }
    if (action === 'resize') { trayWindow.setSize(382, Math.max(180, Math.min(620, Math.round(Number(value) || 480))), false); positionTrayWindow(); }
    if (action === 'dismiss') trayWindow.hide();
    if (action === 'quit') app.quit();
    return currentTrayState();
  });
}
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', (_event, argv) => { if (!argv.includes('--pixice-native-helper')) void openMainWindow(); });
  app.whenReady().then(async () => {
    // A window starts Electron's event loop before asynchronous service discovery.
    createWindow();
    browserWorkspace = new BrowserWorkspace({ window: mainWindow, WebContentsView, BrowserWindow, emit: (type, payload) => nativeHelper?.event({ type, payload }) });
    registerIpc();
    appUpdater = new PixiceAppUpdater({ updater: electronUpdater.autoUpdater, app, prepareInstall: async ({ currentVersion, availableVersion }) => {
      const descriptor = await readServiceDescriptor(dataDirectory);
      const backup = await serviceCall(descriptor, 'service.backup', { currentVersion, targetVersion: availableVersion });
      await stopService(dataDirectory, { update: true, keepDesktop: true });
      quitting = true; return backup;
    } });
    appUpdater.on('status', (status) => send('UpdateState', status)); appUpdater.start();
    const connection = connectService();
    if (!helperOnly) await openMainWindow(); else app.dock?.hide();
    await connection;
  }).catch((error) => { console.error(error); updateConnection({ state: 'error', error: error.message }); });
  app.on('activate', () => { if (mainWindow) void openMainWindow(); });
  app.on('before-quit', (event) => {
    if (!quitting) { event.preventDefault(); detachDesktop(); return; }
    nativeHelper?.close(); client?.close(); appUpdater?.stop(); awake.stop(); browserWorkspace?.destroy();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdownNative);
  app.on('window-all-closed', () => {});
}
