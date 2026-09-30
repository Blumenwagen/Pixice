import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
export function clampCompanionBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return { width, height,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))) };
}

// Presentation changes never replace webContents. It is the sole media owner.
export class CompanionWindow {
  constructor({ BrowserWindow, screen, mainWindow, load, onClose = () => {}, onFailure = () => {}, onDetach = () => {}, platform = process.platform, environment = process.env }) {
    Object.assign(this, { BrowserWindow, screen, mainWindow, load, onClose, onFailure, onDetach });
    this.supported = ['darwin', 'win32', 'linux'].includes(platform) && !(platform === 'linux' && environment.XDG_SESSION_TYPE === 'wayland');
    this.detached = false;
    this.reposition = () => { if (!this.detached) this.positionAttached(); };
    this.clamp = () => this.clampToDisplay();
    this.mainClosed = () => { if (this.window) { this.detach(); this.onDetach(); } };
    for (const event of ['move', 'resize']) mainWindow.on(event, this.reposition);
    for (const event of ['close', 'hide', 'minimize']) mainWindow.on(event, this.mainClosed);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, this.clamp);
  }
  async open() {
    if (!this.supported) throw new Error('Floating Voice is unavailable on this desktop. Linux Wayland cannot reliably place an always-visible companion. Use an X11 session or composer dictation.');
    if (this.window && !this.window.isDestroyed()) { this.window.show(); return; }
    this.detached = false;
    this.offset = null;
    const window = new this.BrowserWindow({ width: 224, height: 240, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, title: 'Pixice Voice',
      webPreferences: { preload: path.join(directory, 'companion-preload.cjs'), partition: 'pixice-voice-companion',
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    this.window = window;
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => this.onFailure('The Voice window stopped responding. Microphone capture has ended.'));
    // A reload must end the current owner rather than silently opening a second call.
    let loaded = false;
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (loaded && isMainFrame) this.onFailure('The Voice window reloaded. Start Voice again in Pixice.');
    });
    window.webContents.once('did-finish-load', () => { loaded = true; });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window.webContents && permission === 'media' && this.isTrustedURL(details.requestingUrl) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
    });
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      contents === window.webContents && permission === 'media' && this.isTrustedURL(details.requestingUrl) && details.mediaType === 'audio');
    window.on('close', (event) => { event.preventDefault(); this.onClose(); });
    window.on('moved', () => {
      if (!this.detached && !this.positioning) {
        const main = this.mainWindow.getBounds(), bounds = window.getBounds();
        this.offset = { x: bounds.x - main.x, y: bounds.y - main.y };
      }
      this.clampToDisplay();
    });
    this.positionAttached();
    try { await this.load(window); }
    catch (error) { this.destroy(); throw error; }
    if (this.window === window && !window.isDestroyed()) window.show();
  }
  isTrustedURL(url) { return typeof url === 'string' && url === this.window?.webContents.getURL(); }
  trusted(event) { return Boolean(this.window && event.sender === this.window.webContents && event.senderFrame === event.sender.mainFrame && this.isTrustedURL(event.senderFrame?.url)); }
  positionAttached() {
    if (!this.window || this.window.isDestroyed() || this.mainWindow.isDestroyed()) return;
    const main = this.mainWindow.getBounds(), bounds = this.window.getBounds();
    const offset = this.offset ?? { x: main.width - bounds.width - 22, y: main.height - bounds.height - 28 };
    this.setBounds({ ...bounds, x: main.x + offset.x, y: main.y + offset.y });
  }
  setBounds(bounds) {
    if (!this.window || this.window.isDestroyed()) return;
    const next = clampCompanionBounds(bounds, this.screen.getDisplayMatching(bounds).workArea);
    if (JSON.stringify(this.window.getBounds()) === JSON.stringify(next)) return;
    this.positioning = true;
    this.window.setBounds(next, false);
    this.positioning = false;
  }
  clampToDisplay() { if (this.window && !this.window.isDestroyed()) this.setBounds(this.window.getBounds()); }
  detach() { this.detached = true; this.clampToDisplay(); this.window?.show(); }
  attach() { this.detached = false; this.offset = null; this.positionAttached(); this.window?.show(); }
  send(type, payload) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('voice-companion:event', { type, payload }); }
  destroy() { const window = this.window; this.window = null; if (window && !window.isDestroyed()) window.destroy(); }
  dispose() {
    this.destroy();
    for (const event of ['move', 'resize']) this.mainWindow.removeListener(event, this.reposition);
    for (const event of ['close', 'hide', 'minimize']) this.mainWindow.removeListener(event, this.mainClosed);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) this.screen.removeListener(event, this.clamp);
  }
}
