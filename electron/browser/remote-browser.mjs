import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const scope = z.object({ workspaceId: z.string().trim().min(1).max(240), tabId: z.string().min(1).max(160) });
export const MIN_BROWSER_QUALITY = 35;
export const MAX_BROWSER_QUALITY = 90;
export const DEFAULT_BROWSER_QUALITY = 72;
export const browserFrameSchema = scope.extend({
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  quality: z.number().int().min(MIN_BROWSER_QUALITY).max(MAX_BROWSER_QUALITY).optional()
}).strict();
const modifiers = z.array(z.enum(['alt', 'control', 'meta', 'shift'])).max(4).default([]);
const point = { x: z.number().finite().min(0), y: z.number().finite().min(0) };
const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...point, button: z.enum(['left', 'right']).default('left'), clickCount: z.number().int().min(1).max(2).default(1), modifiers }).strict(),
  z.object({ type: z.literal('scroll'), ...point, deltaX: z.number().finite().min(-2000).max(2000), deltaY: z.number().finite().min(-2000).max(2000), modifiers }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(10000) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'a']), modifiers }).strict()
]);
export const browserInputSchema = scope.extend({ frameId: z.string().uuid(), input }).strict();
const keyCodes = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, a: 65 };
const flags = (values) => values.reduce((value, key) => value | ({ alt: 1, control: 2, meta: 4, shift: 8 }[key] ?? 0), 0);
const sameSize = (a, b) => a.width === b.width && a.height === b.height;

// Only these fixed browser operations are exposed. Clients never send script or CDP method names.
export class RemoteBrowser {
  constructor({ target, now = Date.now }) { this.target = target; this.now = now; this.frames = new Map(); this.pages = new WeakMap(); }
  page(contents) {
    let page = this.pages.get(contents);
    if (!page) {
      page = { revision: 0, pending: Promise.resolve(), count: 0 };
      contents.on('did-start-navigation', () => { page.revision++; });
      contents.on('did-navigate', () => { page.revision++; });
      contents.on('did-navigate-in-page', () => { page.revision++; });
      this.pages.set(contents, page);
    }
    return page;
  }
  serialize(contents, operation) {
    const page = this.page(contents);
    if (page.count >= 8) return Promise.reject(new Error('The browser is busy. Wait before interacting again.'));
    page.count++;
    const result = page.pending.then(() => operation(page)).finally(() => { page.count--; });
    page.pending = result.catch(() => {});
    return result;
  }
  async command(contents, method, params) {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    let timer;
    try {
      return await Promise.race([
        contents.debugger.sendCommand(method, params),
        new Promise((_, reject) => { timer = setTimeout(() => {
          if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
          reject(new Error('The host browser did not respond. Refresh the preview.'));
        }, 5000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async keepRendering(contents, page) {
    clearTimeout(page.idle);
    if (page.previousThrottling === undefined) page.previousThrottling = contents.backgroundThrottling;
    contents.backgroundThrottling = false;
    try { await this.command(contents, 'Emulation.setFocusEmulationEnabled', { enabled: true }); }
    finally { page.idle = setTimeout(() => {
      if (contents.isDestroyed()) return;
      contents.backgroundThrottling = page.previousThrottling;
      page.previousThrottling = undefined;
      if (contents.debugger.isAttached()) void contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }, 5000);
    page.idle.unref?.(); }
  }
  prune() {
    for (const [id, frame] of this.frames) if (this.now() - frame.at > 5000) this.frames.delete(id);
    while (this.frames.size > 200) this.frames.delete(this.frames.keys().next().value);
  }
  async frame(payload) {
    const value = browserFrameSchema.parse(payload);
    const { tab, locallyVisible } = this.target(value.workspaceId, value.tabId);
    const contents = tab.view.webContents;
    return this.serialize(contents, async (page) => {
      if (contents.isDestroyed()) throw new Error('Browser tab closed');
      if (!locallyVisible()) {
        const size = { width: Math.max(320, Math.min(1600, value.width)), height: Math.max(200, Math.min(1200, value.height)) };
        if (!sameSize(tab.view.getBounds(), size)) tab.view.setBounds({ x: 0, y: 0, ...size });
      }
      const bounds = tab.view.getBounds();
      const revision = page.revision;
      // Wake only this page's renderer; the native window remains hidden and unfocused.
      await this.keepRendering(contents, page);
      // Capture through Chromium: capturePage can stall on tabs that have never been shown.
      const screenshot = await this.command(contents, 'Page.captureScreenshot', {
        format: 'jpeg', quality: value.quality ?? DEFAULT_BROWSER_QUALITY, fromSurface: true, captureBeyondViewport: false
      });
      const encoded = screenshot.data;
      if (typeof encoded !== 'string' || !encoded || encoded.length > 8 * 1024 * 1024) throw new Error('The browser could not produce a bounded preview.');
      if (contents.isDestroyed() || revision !== page.revision || !sameSize(bounds, tab.view.getBounds())) throw new Error('The page changed while capturing. Refreshing…');
      const frameId = randomUUID();
      this.prune();
      this.frames.set(frameId, { workspaceId: value.workspaceId, tabId: value.tabId, revision, bounds, at: this.now() });
      return { frameId, width: bounds.width, height: bounds.height, image: `data:image/jpeg;base64,${encoded}`, supportedOptions: ['quality'] };
    });
  }
  async input(payload) {
    const value = browserInputSchema.parse(payload);
    const { tab } = this.target(value.workspaceId, value.tabId);
    const contents = tab.view.webContents;
    return this.serialize(contents, async (page) => {
      this.prune();
      const frame = this.frames.get(value.frameId);
      if (!frame || frame.workspaceId !== value.workspaceId || frame.tabId !== value.tabId || frame.revision !== page.revision || !sameSize(frame.bounds, tab.view.getBounds())) throw new Error('This preview changed or expired. Wait for a fresh frame before interacting.');
      if (contents.isDestroyed()) throw new Error('Browser tab closed');
      const action = value.input;
      if ('x' in action && (action.x >= frame.bounds.width || action.y >= frame.bounds.height)) throw new Error('Input is outside the browser preview');
      // Chromium input works for hidden host tabs without focusing or moving the host window.
      const send = (method, params) => this.command(contents, method, params);
      if (action.type === 'text') await send('Input.insertText', { text: action.text });
      if (action.type === 'click') {
        const params = { x: action.x, y: action.y, button: action.button, clickCount: action.clickCount, modifiers: flags(action.modifiers) };
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
      }
      if (action.type === 'scroll') await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY, modifiers: flags(action.modifiers) });
      if (action.type === 'key') {
        const params = { key: action.key, windowsVirtualKeyCode: keyCodes[action.key], modifiers: flags(action.modifiers) };
        if (action.key === 'a' && (action.modifiers.includes('meta') || action.modifiers.includes('control'))) params.commands = ['selectAll'];
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(action.key === 'Enter' ? { text: '\r' } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      }
      return { ok: true };
    });
  }
}
