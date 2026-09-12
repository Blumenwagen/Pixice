import { describe, expect, it, vi } from 'vitest';
import {
  applicationServerKey,
  createPushClient,
  pushScopeForHost,
  sameApplicationServerKey,
  validateBrowserPushSubscription,
  waitForServiceWorkerActivation,
} from '../src/connect/push-client.js';

function encoded(bytes) { return Buffer.from(bytes).toString('base64url'); }
const publicKey = encoded(Uint8Array.from([4, ...new Array(64).fill(1)]));
const otherPublicKey = encoded(Uint8Array.from([4, ...new Array(64).fill(2)]));
const auth = encoded(Uint8Array.from(new Array(16).fill(3)));
const keys = { p256dh: publicKey, auth };
function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/opaque', applicationKey = applicationServerKey(publicKey)) {
  return { endpoint, expirationTime: null, keys, options: { applicationServerKey: applicationKey } };
}
function infoResponse(hostId = 'host', protocol = 1) {
  return { ok: true, status: 200, json: async () => ({ hostId, protocol }) };
}

describe('browser Connect push client', () => {
  it('validates decoded key sizes and keeps provider query parameters', () => {
    expect(validateBrowserPushSubscription(subscription('https://notify.windows.com/?token=opaque'))).toMatchObject({ endpoint: 'https://notify.windows.com/?token=opaque', keys });
    expect(() => validateBrowserPushSubscription({ ...subscription(), keys: { p256dh: 'A'.repeat(87), auth } })).toThrow('keys are invalid');
    expect(() => validateBrowserPushSubscription({ ...subscription(), endpoint: 'https://user:pass@evil.example/push' })).toThrow('known HTTPS');
    expect(() => validateBrowserPushSubscription({ ...subscription(), endpoint: 'https://127.0.0.1/push' })).toThrow('known HTTPS');
    expect(() => validateBrowserPushSubscription({ ...subscription(), endpoint: 'https://fcm.googleapis.com/push#fragment' })).toThrow('known HTTPS');
  });

  it('does not request permission while reading status and uses an exact host scope when enabled', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const requestPermission = vi.fn(async () => 'granted');
    const notification = { permission: 'default', requestPermission };
    const registration = { scope: pushScopeForHost('host/one', 'https://app.example'), active: { state: 'activated' }, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async ({ applicationServerKey: value }) => subscription('https://fcm.googleapis.com/fcm/send/new', value)) } };
    const register = vi.fn(async (_script, options) => { expect(options.scope).toBe(pushScopeForHost('host/one', 'https://app.example')); return registration; });
    const serviceWorkerContainer = { register };
    const fetchImpl = vi.fn(async (_url, options) => new URL(_url).pathname === '/api/connect/info'
      ? infoResponse('host/one')
      : ({ ok: true, status: 200, json: async () => options?.method === 'POST' ? { registered: true } : { state: 'ready', publicKey }, url: _url }));
    const client = createPushClient({ hostId: 'host/one', endpoint: 'https://app.example', token: 'token', fetchImpl, serviceWorkerContainer, notification, locationRef: { origin: 'https://app.example' } });
    await client.status();
    expect(requestPermission).not.toHaveBeenCalled();
    await expect(client.enable()).resolves.toMatchObject({ state: 'enabled', scope: registration.scope });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith('/connect-sw.js', { scope: registration.scope });
    const subscribeCall = fetchImpl.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/subscribe'));
    expect(subscribeCall[1].headers.Authorization).toBe('Bearer token');
  });

  it('waits for the exact registration to activate and handles key rotation', async () => {
    const listeners = new Set();
    const installing = { state: 'installing', addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener) };
    const registration = { scope: pushScopeForHost('host', 'https://app.example'), active: null, installing };
    const pending = waitForServiceWorkerActivation(registration, 100);
    installing.state = 'activated'; registration.active = installing; for (const listener of listeners) listener();
    await expect(pending).resolves.toBe(installing);

    const waitingListeners = new Set();
    const installingAgain = { state: 'installing', addEventListener: (_name, listener) => waitingListeners.add(listener), removeEventListener: (_name, listener) => waitingListeners.delete(listener) };
    const waiting = { state: 'installed', addEventListener: (_name, listener) => waitingListeners.add(listener), removeEventListener: (_name, listener) => waitingListeners.delete(listener) };
    const staged = { scope: pushScopeForHost('host-again', 'https://app.example'), active: null, installing: installingAgain, waiting };
    const stagedPending = waitForServiceWorkerActivation(staged, 100);
    installingAgain.state = 'installed';
    for (const listener of [...waitingListeners]) listener();
    staged.active = waiting; staged.waiting = null; waiting.state = 'activated';
    for (const listener of [...waitingListeners]) listener();
    await expect(stagedPending).resolves.toBe(waiting);

    vi.stubGlobal('PushManager', class PushManager {});
    const old = subscription('https://fcm.googleapis.com/fcm/send/old', applicationServerKey(otherPublicKey));
    const unsubscribe = vi.fn(async () => true);
    old.unsubscribe = unsubscribe;
    const next = subscription('https://fcm.googleapis.com/fcm/send/new', applicationServerKey(publicKey));
    const subscribe = vi.fn(async ({ applicationServerKey: value }) => ({ ...next, options: { applicationServerKey: value } }));
    const workerRegistration = { scope: pushScopeForHost('host', 'https://app.example'), active: { state: 'activated' }, pushManager: { getSubscription: vi.fn(async () => old), subscribe } };
    const container = { register: vi.fn(async () => workerRegistration) };
    const fetchImpl = vi.fn(async (_url, options) => new URL(_url).pathname === '/api/connect/info'
      ? infoResponse('host')
      : ({ ok: true, status: 200, json: async () => options?.method === 'POST' ? {} : { publicKey } }));
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl, serviceWorkerContainer: container, notification: { permission: 'granted', requestPermission: vi.fn(async () => 'granted') }, locationRef: { origin: 'https://app.example' } });
    await client.status();
    await client.enable();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
    expect(sameApplicationServerKey({ options: { applicationServerKey: applicationServerKey(publicKey) } }, applicationServerKey(publicKey))).toBe(true);
  });

  it('disables only the matching scope locally when server cleanup is unavailable', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const local = subscription();
    local.unsubscribe = vi.fn(async () => true);
    const registration = { scope: pushScopeForHost('host', 'https://app.example'), pushManager: { getSubscription: vi.fn(async () => local) }, unregister: vi.fn(async () => true) };
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl, serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async (scope) => scope === registration.scope ? registration : null) }, notification: {}, locationRef: { origin: 'https://app.example' } });
    await expect(client.disable()).resolves.toMatchObject({ state: 'disabled', localSubscription: false, hostCleanup: 'unverified' });
    expect(local.unsubscribe).toHaveBeenCalledOnce();
    expect(registration.unregister).toHaveBeenCalledOnce();
  });

  it('does not request permission until the host is ready and reports repair when its registration is lost', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const requestPermission = vi.fn(async () => 'granted');
    const notification = { permission: 'default', requestPermission };
    const local = subscription('https://fcm.googleapis.com/fcm/send/local', applicationServerKey(publicKey));
    const registration = { scope: pushScopeForHost('host', 'https://app.example'), active: { state: 'activated' }, pushManager: { getSubscription: vi.fn(async () => local), subscribe: vi.fn() } };
    const fetchImpl = vi.fn(async (_url) => new URL(_url).pathname === '/api/connect/info'
      ? infoResponse()
      : ({ ok: true, status: 200, json: async () => ({ state: 'ready', readiness: 'ready', publicKey, registered: false }) }));
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl, serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async () => registration) }, notification, locationRef: { origin: 'https://app.example' } });
    await expect(client.status()).resolves.toMatchObject({ state: 'repair', localSubscription: true, localKeyMatches: true, registered: false, needsRepair: true });
    await client.status();
    await expect(client.enable()).rejects.toThrow();
    expect(requestPermission).toHaveBeenCalledOnce();

    const unavailablePermission = vi.fn();
    const unavailable = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl: vi.fn(async (_url) => new URL(_url).pathname === '/api/connect/info'
      ? infoResponse()
      : ({ ok: true, status: 200, json: async () => ({ state: 'unavailable', readiness: 'unavailable', registered: false }) })), serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async () => registration) }, notification: { permission: 'default', requestPermission: unavailablePermission }, locationRef: { origin: 'https://app.example' } });
    await unavailable.status();
    await expect(unavailable.enable()).resolves.toMatchObject({ state: 'unavailable' });
    expect(unavailablePermission).not.toHaveBeenCalled();
  });

  it('preserves local and repair flags when permission is not granted', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const local = subscription('https://fcm.googleapis.com/fcm/send/local', applicationServerKey(publicKey));
    const registration = { scope: pushScopeForHost('host', 'https://app.example'), active: { state: 'activated' }, pushManager: { getSubscription: vi.fn(async () => local) } };
    const requestPermission = vi.fn(async () => 'default');
    const client = createPushClient({
      hostId: 'host',
      endpoint: 'https://app.example',
      fetchImpl: vi.fn(async (_url) => new URL(_url).pathname === '/api/connect/info'
        ? infoResponse()
        : ({ ok: true, status: 200, json: async () => ({ state: 'ready', readiness: 'ready', publicKey, registered: false }) })),
      serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async () => registration) },
      notification: { permission: 'default', requestPermission },
      locationRef: { origin: 'https://app.example' },
    });

    await client.status();
    await expect(client.enable()).resolves.toMatchObject({ state: 'default', localSubscription: true, localKeyMatches: true, registered: false, needsRepair: true });
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('keeps permission invocation in the click task and never sends a token to a mismatched host', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const requestPermission = vi.fn(async () => 'granted');
    let enabling = false;
    let releaseStatus;
    const slowStatus = new Promise((resolve) => { releaseStatus = resolve; });
    const fetchImpl = vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/connect/info') return infoResponse('host');
      if (enabling && options?.method !== 'POST') return slowStatus;
      return { ok: true, status: 200, json: async () => options?.method === 'POST' ? { registered: true } : { state: 'ready', readiness: 'ready', publicKey, registered: false } };
    });
    const registration = { scope: pushScopeForHost('host', 'https://app.example'), active: { state: 'activated' }, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async ({ applicationServerKey: value }) => subscription(undefined, value)) } };
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', token: 'secret', fetchImpl, serviceWorkerContainer: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => null) }, notification: { permission: 'default', requestPermission }, locationRef: { origin: 'https://app.example' } });
    await client.status();
    enabling = true;
    const pending = client.enable();
    expect(requestPermission).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    const statusCall = fetchImpl.mock.calls.find(([url], index) => index > 1 && new URL(url).pathname === '/api/connect/push');
    expect(statusCall?.[1].headers.Authorization).toBe('Bearer secret');
    releaseStatus({ ok: true, status: 200, json: async () => ({ state: 'ready', readiness: 'ready', publicKey, registered: false }) });
    await pending;

    const mismatchFetch = vi.fn(async (url) => new URL(url).pathname === '/api/connect/info' ? infoResponse('other-host') : { ok: true, status: 200, json: async () => ({ state: 'ready', publicKey }) });
    const mismatch = createPushClient({ hostId: 'host', endpoint: 'https://app.example', token: 'secret', fetchImpl: mismatchFetch, serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async () => null) }, notification: { permission: 'default', requestPermission: vi.fn() }, locationRef: { origin: 'https://app.example' } });
    await expect(mismatch.status()).resolves.toMatchObject({ state: 'error' });
    expect(mismatchFetch).toHaveBeenCalledOnce();
    expect(mismatchFetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('does not ask for permission until a validated ready status is cached', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    const requestPermission = vi.fn(async () => 'granted');
    const fetchImpl = vi.fn(async (url) => new URL(url).pathname === '/api/connect/info' ? infoResponse() : { ok: true, status: 200, json: async () => ({ state: 'ready', readiness: 'ready', publicKey }) });
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl, serviceWorkerContainer: { register: vi.fn(), getRegistration: vi.fn(async () => null) }, notification: { permission: 'default', requestPermission }, locationRef: { origin: 'https://app.example' } });
    await expect(client.enable()).resolves.toMatchObject({ state: 'preparing', readiness: 'preparing' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('aborts a stalled push HTTP request at the client timeout', async () => {
    vi.stubGlobal('PushManager', class PushManager {});
    let seenSignal;
    const fetchImpl = vi.fn(async (_url, options) => new Promise((_, reject) => {
      seenSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const client = createPushClient({ hostId: 'host', endpoint: 'https://app.example', fetchImpl, requestTimeoutMs: 5, serviceWorkerContainer: { register: vi.fn() }, notification: {}, locationRef: { origin: 'https://app.example' } });
    await expect(client.status()).resolves.toMatchObject({ state: 'error' });
    expect(seenSignal.aborted).toBe(true);
  });
});
