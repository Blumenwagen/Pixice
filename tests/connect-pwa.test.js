import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { getInstallState, installHelp, registerRootConnectServiceWorker, secureBrowserClient } from '../src/connect/push-pwa.js';

describe('Connect install and service worker shell', () => {
  it('does not register a worker for Electron or file clients', async () => {
    const register = vi.fn();
    const navigatorRef = { serviceWorker: { register } };
    expect(secureBrowserClient({ windowRef: { pixice: {} }, navigatorRef, locationRef: { protocol: 'https:', hostname: 'app.example' } })).toBe(false);
    await expect(registerRootConnectServiceWorker({ windowRef: { pixice: {} }, navigatorRef, locationRef: { protocol: 'file:', hostname: '' } })).resolves.toEqual({ state: 'skipped' });
    expect(register).not.toHaveBeenCalled();
  });

  it('registers only a secure web root and recognizes standalone iOS install state', async () => {
    const registration = { scope: 'https://app.example/' };
    const register = vi.fn(async () => registration);
    const windowRef = { isSecureContext: true, addEventListener: vi.fn(), matchMedia: vi.fn(() => ({ matches: false })) };
    const navigatorRef = { serviceWorker: { register }, userAgent: 'iPhone', standalone: true };
    await expect(registerRootConnectServiceWorker({ windowRef, navigatorRef, locationRef: { protocol: 'https:', hostname: 'app.example' } })).resolves.toMatchObject({ state: 'registered' });
    expect(register).toHaveBeenCalledWith('/connect-sw.js', { scope: '/' });
    expect(getInstallState(windowRef).standalone).toBe(false);
    expect(installHelp({ windowRef, navigatorRef })).toContain('already installed');
  });

  it('keeps the worker to a fixed static shell and safe update lifecycle', async () => {
    const source = await readFile(path.resolve(process.cwd(), 'public/connect-sw.js'), 'utf8');
    expect(source).toContain("request.method !== 'GET'");
    expect(source).toContain("url.pathname.startsWith('/api/')");
    expect(source).toContain("request.headers.has('Authorization')");
    expect(source).toContain('request.mode === \'navigate\'');
    expect(source).not.toContain('skipWaiting');
    expect(source).not.toContain('clients.claim');
    expect(source).toContain('/connect-push/');
  });

  it('executes two cache updates, serves only the current scoped cache, and bounds cache history', async () => {
    const source = await readFile(path.resolve(process.cwd(), 'public/connect-sw.js'), 'utf8');
    const cacheData = new Map();
    const cacheOrder = [];
    const makeCaches = () => ({
      open: async (name) => {
        if (!cacheData.has(name)) { cacheData.set(name, new Map()); cacheOrder.push(name); }
        const entries = cacheData.get(name);
        return {
          addAll: async (paths) => { for (const value of paths) entries.set(value, { cache: name, path: value }); },
          match: async (request) => entries.get(typeof request === 'string' ? request : new URL(request.url).pathname) || null,
        };
      },
      keys: async () => [...cacheOrder],
      delete: async (name) => { cacheData.delete(name); const index = cacheOrder.indexOf(name); if (index >= 0) cacheOrder.splice(index, 1); return true; },
    });
    function worker(buildId, clientList = [], openWindow = vi.fn(async () => null)) {
      const events = new Map();
      const context = {
        URL,
        Headers,
        caches: makeCaches(),
        fetch: vi.fn(async () => { throw new Error('offline'); }),
        self: {
          location: new URL('https://app.example/'),
          registration: { scope: 'https://app.example/' },
          addEventListener: (type, listener) => events.set(type, listener),
          clients: { matchAll: async () => clientList, openWindow },
        },
      };
      const compiled = source.replace('__PIXICE_PRECACHE__', JSON.stringify(['/index.html', '/assets/app.js'])).replace('__PIXICE_BUILD_ID__', JSON.stringify(buildId));
      vm.runInNewContext(compiled, context);
      return { context, events };
    }
    async function installAndActivate(value) {
      const install = { waitUntil(promise) { this.promise = promise; } };
      await value.events.get('install')(install); await install.promise;
      const activate = { waitUntil(promise) { this.promise = promise; } };
      await value.events.get('activate')(activate); await activate.promise;
    }
    const first = worker('v1'); await installAndActivate(first);
    const firstNavigation = { request: { method: 'GET', url: 'https://app.example/', mode: 'navigate', headers: new Headers() }, respondWith(promise) { this.response = promise; } };
    await first.events.get('fetch')(firstNavigation);
    await expect(firstNavigation.response).resolves.toMatchObject({ cache: 'pixice-connect-shell-v1', path: '/index.html' });
    const api = { request: { method: 'GET', url: 'https://app.example/api/connect/info', mode: 'cors', headers: new Headers() }, respondWith() { throw new Error('API must bypass the worker'); } };
    await first.events.get('fetch')(api);
    expect(api.response).toBeUndefined();
    const second = worker('v2'); await installAndActivate(second);
    const third = worker('v3'); await installAndActivate(third);
    await expect(third.context.caches.keys()).resolves.toEqual(['pixice-connect-shell-v2', 'pixice-connect-shell-v3']);
    const asset = { request: { method: 'GET', url: 'https://app.example/assets/app.js', mode: 'cors', headers: new Headers() }, respondWith(promise) { this.response = promise; } };
    await third.events.get('fetch')(asset);
    await expect(asset.response).resolves.toMatchObject({ cache: 'pixice-connect-shell-v3', path: '/assets/app.js' });
    const authorized = { request: { method: 'GET', url: 'https://app.example/assets/app.js', mode: 'cors', headers: new Headers([['Authorization', 'Bearer secret']]) }, respondWith() { throw new Error('Authorized assets must bypass the worker'); } };
    await third.events.get('fetch')(authorized);
    expect(authorized.response).toBeUndefined();
  });

  it('focuses an existing Pixice root and posts a bounded target without navigating it', async () => {
    const source = await readFile(path.resolve(process.cwd(), 'public/connect-sw.js'), 'utf8');
    const events = new Map();
    const focused = vi.fn(async () => undefined);
    const postMessage = vi.fn();
    const navigate = vi.fn();
    const openWindow = vi.fn(async () => null);
    const existing = { url: 'https://app.example/?draft=1', focus: focused, postMessage, navigate };
    const value = { events };
    vm.runInNewContext(source.replace('__PIXICE_PRECACHE__', '[]').replace('__PIXICE_BUILD_ID__', '"click"'), {
      URL,
      self: { location: new URL('https://app.example/'), registration: { scope: 'https://app.example/' }, addEventListener: (type, listener) => events.set(type, listener), clients: { matchAll: async () => [existing], openWindow } },
    });
    const notification = { data: { url: 'https://app.example/?connectHost=host-1&connectProject=project-1&connectThread=thread-1' }, close: vi.fn() };
    const event = { notification, waitUntil(promise) { this.promise = promise; } };
    await value.events.get('notificationclick')(event);
    await event.promise;
    expect(focused).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'pixice-connect-open', target: { hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1' } });
    expect(navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('ignores other-origin and non-root clients, then opens only a validated root URL', async () => {
    const source = await readFile(path.resolve(process.cwd(), 'public/connect-sw.js'), 'utf8');
    const events = new Map();
    const postMessage = vi.fn();
    const openWindow = vi.fn(async () => null);
    const value = { events };
    vm.runInNewContext(source.replace('__PIXICE_PRECACHE__', '[]').replace('__PIXICE_BUILD_ID__', '"click-open"'), {
      URL,
      self: { location: new URL('https://app.example/'), registration: { scope: 'https://app.example/' }, addEventListener: (type, listener) => events.set(type, listener), clients: { matchAll: async () => [{ url: 'https://evil.example/?connectHost=evil', focus: vi.fn(), postMessage }, { url: 'https://app.example/pairing?connectHost=host-1', focus: vi.fn(), postMessage }], openWindow } },
    });
    const notification = { data: { url: 'https://app.example/?connectHost=host-1&connectProject=project-1' }, close: vi.fn() };
    const event = { notification, waitUntil(promise) { this.promise = promise; } };
    await value.events.get('notificationclick')(event);
    await event.promise;
    expect(openWindow).toHaveBeenCalledWith('https://app.example/?connectHost=host-1&connectProject=project-1');
    expect(postMessage).not.toHaveBeenCalled();

    const invalidEvent = { notification: { data: { url: 'https://app.example/?connectThread=thread-without-project&connectHost=host-1' }, close: vi.fn() }, waitUntil: vi.fn() };
    await value.events.get('notificationclick')(invalidEvent);
    expect(invalidEvent.waitUntil).not.toHaveBeenCalled();
  });
});
