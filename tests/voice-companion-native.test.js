import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CompanionWindow, clampCompanionBounds } from '../electron/voice/companion-window.mjs';
function fixture() {
  const main = Object.assign(new EventEmitter(), { getBounds: () => ({ x: 100, y: 100, width: 1100, height: 760 }), isDestroyed: () => false });
  const screen = Object.assign(new EventEmitter(), { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 1000 } }) });
  let options;
  class Window extends EventEmitter {
    constructor(value) { super(); options = value; this.bounds = { x: 0, y: 0, width: value.width, height: value.height }; this.destroyed = false; this.visible = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'file:///app/index.html?voice-companion=1' }, getURL: () => 'file:///app/index.html?voice-companion=1', setWindowOpenHandler: vi.fn(), send: vi.fn(), session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } }); }
    setMenu() {}
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    show() { this.visible = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const presentation = new CompanionWindow({ BrowserWindow: Window, screen, mainWindow: main, load: async () => {}, platform: 'darwin', environment: {} });
  return { presentation, main, screen, options: () => options };
}
describe('native Voice window policy', () => {
  it('uses a dedicated secure session, blocks navigation and limits permissions to trusted audio', async () => {
    const { presentation, options } = fixture(); await presentation.open(); const wc = presentation.window.webContents;
    expect(options()).toMatchObject({ frame: false, transparent: true, alwaysOnTop: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, partition: 'pixice-voice-companion' } });
    expect(wc.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    const prevented = vi.fn(); wc.emit('will-navigate', { preventDefault: prevented }); expect(prevented).toHaveBeenCalled();
    const permission = wc.session.setPermissionRequestHandler.mock.calls[0][0], callback = vi.fn();
    permission(wc, 'media', callback, { requestingUrl: wc.getURL(), mediaTypes: ['audio'] }); expect(callback).toHaveBeenLastCalledWith(true);
    permission(wc, 'media', callback, { requestingUrl: wc.getURL(), mediaTypes: ['video'] }); expect(callback).toHaveBeenLastCalledWith(false);
    permission({}, 'media', callback, { requestingUrl: wc.getURL(), mediaTypes: ['audio'] }); expect(callback).toHaveBeenLastCalledWith(false);
    expect(presentation.trusted({ sender: wc, senderFrame: wc.mainFrame })).toBe(true);
    expect(presentation.trusted({ sender: wc, senderFrame: { url: wc.getURL() } })).toBe(false);
    presentation.dispose();
  });
  it('main close/hide preserves same visible owner; reattach does not load another window', async () => {
    const { presentation, main } = fixture(); const load = vi.spyOn(presentation, 'load'); await presentation.open(); const owner = presentation.window;
    main.emit('close'); main.emit('hide'); expect(presentation.detached).toBe(true); expect(owner.visible).toBe(true);
    presentation.attach(); expect(presentation.detached).toBe(false); expect(presentation.window).toBe(owner); expect(load).toHaveBeenCalledTimes(1);
    presentation.dispose(); expect(owner.isDestroyed()).toBe(true); expect(main.listenerCount('close')).toBe(0);
  });
  it('a companion close or renderer crash delegates cleanup, reload cannot create another owner', async () => {
    const { presentation } = fixture(); presentation.onClose = vi.fn(); presentation.onFailure = vi.fn(); await presentation.open();
    const wc = presentation.window.webContents, preventDefault = vi.fn();
    presentation.window.emit('close', { preventDefault }); expect(preventDefault).toHaveBeenCalled(); expect(presentation.onClose).toHaveBeenCalled();
    wc.emit('render-process-gone'); expect(presentation.onFailure).toHaveBeenCalled();
    wc.emit('did-finish-load'); wc.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);
    expect(presentation.onFailure).toHaveBeenCalledWith(expect.stringContaining('reloaded')); presentation.dispose();
  });
  it('clamps negative/missing displays and oversized bounds, including removed-display events', async () => {
    expect(clampCompanionBounds({ x: 9000, y: -9000, width: 300, height: 394 }, { x: -1440, y: 20, width: 1440, height: 900 })).toEqual({ x: -300, y: 20, width: 300, height: 394 });
    expect(clampCompanionBounds({ x: -10, y: -10, width: 300, height: 394 }, { x: 0, y: 0, width: 200, height: 250 })).toEqual({ x: 0, y: 0, width: 200, height: 250 });
    const { presentation, screen } = fixture(); await presentation.open(); presentation.window.bounds.x = 10000; screen.emit('display-removed'); expect(presentation.window.bounds.x).toBe(1440 - presentation.window.bounds.width); presentation.dispose();
  });
  it('does not promise floating control on Wayland', () => {
    const { presentation, main, screen } = fixture(); const wayland = new CompanionWindow({ BrowserWindow: {}, mainWindow: main, screen, load: async () => {}, platform: 'linux', environment: { XDG_SESSION_TYPE: 'wayland' } }); expect(wayland.supported).toBe(false); wayland.dispose(); presentation.dispose();
  });
});
