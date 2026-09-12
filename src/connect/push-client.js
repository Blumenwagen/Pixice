import {
  PUSH_ENDPOINT_HOSTS,
  decodeBase64Url,
  normalizePushSubscription,
  isKnownPushHost,
  PUSH_P256DH_BYTES,
} from '../../electron/connect/push-contract.mjs';
import { PROTOCOL_VERSION } from '../../electron/connect/protocol.mjs';

export { PUSH_ENDPOINT_HOSTS, isKnownPushHost };

const MAX_VAPID_PUBLIC_KEY_LENGTH = 128;
export const PUSH_WORKER_ACTIVATION_TIMEOUT_MS = 15_000;
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

export function validateBrowserPushSubscription(input) {
  try { return normalizePushSubscription(input); }
  catch (cause) { throw new Error(cause.message || 'The browser push subscription is invalid.'); }
}

export function pushScopeForHost(hostId, origin = globalThis.location?.origin) {
  if (typeof hostId !== 'string' || !hostId || hostId.length > 128 || !/^[A-Za-z0-9._~:@/-]+$/.test(hostId)) throw new Error('The host identifier is invalid.');
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Push notifications require an HTTP(S) receiving client.');
  return new URL(`/connect-push/${encodeURIComponent(hostId)}/`, base).href;
}

export function applicationServerKey(value) {
  if (typeof value !== 'string' || value.length > MAX_VAPID_PUBLIC_KEY_LENGTH) throw new Error('The host did not return a valid push public key.');
  const bytes = decodeBase64Url(value, PUSH_P256DH_BYTES);
  if (!bytes || bytes[0] !== 4) throw new Error('The host did not return a valid push public key.');
  return bytes;
}

function workerIsActive(worker) {
  return Boolean(worker && (!worker.state || worker.state === 'activated'));
}

export function waitForServiceWorkerActivation(registration, timeoutMs = PUSH_WORKER_ACTIVATION_TIMEOUT_MS) {
  if (workerIsActive(registration?.active)) return Promise.resolve(registration.active);
  const initialWorker = registration?.installing || registration?.waiting || registration?.active;
  if (!initialWorker) return Promise.reject(new Error('The host push service worker did not start installing.'));
  return new Promise((resolve, reject) => {
    let timer;
    let watchedWorker = null;
    const cleanup = () => {
      clearTimeout(timer);
      watchedWorker?.removeEventListener?.('statechange', onStateChange);
      registration.removeEventListener?.('updatefound', onUpdateFound);
    };
    const finish = (callback, value) => { cleanup(); callback(value); };
    const onStateChange = () => {
      if (workerIsActive(registration.active) || watchedWorker?.state === 'activated') finish(resolve, registration.active || watchedWorker);
      else if (watchedWorker?.state === 'redundant') finish(reject, new Error('The host push service worker failed to activate.'));
      else if (registration.waiting && registration.waiting !== watchedWorker) watchWorker(registration.waiting);
    };
    const watchWorker = (worker) => {
      if (!worker || worker === watchedWorker) return;
      watchedWorker?.removeEventListener?.('statechange', onStateChange);
      watchedWorker = worker;
      watchedWorker.addEventListener?.('statechange', onStateChange);
      onStateChange();
    };
    const onUpdateFound = () => watchWorker(registration.installing);
    registration.addEventListener?.('updatefound', onUpdateFound);
    timer = setTimeout(() => finish(reject, new Error('The host push service worker did not activate in time.')), timeoutMs);
    watchWorker(initialWorker);
    onStateChange();
  });
}

function bytesFrom(value) {
  if (typeof value === 'string') return decodeBase64Url(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export function sameApplicationServerKey(subscription, expected) {
  const actual = bytesFrom(subscription?.options?.applicationServerKey);
  if (!actual || !expected || actual.byteLength !== expected.byteLength) return false;
  return actual.every((value, index) => value === expected[index]);
}

async function readResponse(response) {
  let body = {};
  try { body = await response.json(); } catch { /* Error responses may have no JSON body. */ }
  if (!response.ok) {
    const error = new Error(body?.error || `Push setup failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createPushClient({
  hostId,
  endpoint,
  token,
  fetchImpl = globalThis.fetch,
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  notification = globalThis.Notification,
  locationRef = globalThis.location,
  activationTimeoutMs = PUSH_WORKER_ACTIVATION_TIMEOUT_MS,
  requestTimeoutMs = PUSH_REQUEST_TIMEOUT_MS,
} = {}) {
  const base = new URL(endpoint || locationRef?.origin);
  const scope = pushScopeForHost(hostId, locationRef?.origin || base.origin);
  let lastRegistration = null;
  let cachedStatus = null;
  let endpointVerified = false;
  let endpointVerification = null;
  async function verifyEndpoint() {
    if (endpointVerified) return;
    endpointVerification ||= (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(new URL('/api/connect/info', base), {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        const info = await readResponse(response);
        if (info?.hostId !== hostId) throw new Error('This address belongs to a different Pixice host. Pair again to verify its identity.');
        if (info?.protocol !== PROTOCOL_VERSION) throw new Error('Incompatible Pixice Connect version. Update the host and client.');
        endpointVerified = true;
      } finally {
        clearTimeout(timer);
        endpointVerification = null;
      }
    })();
    return endpointVerification;
  }
  const request = async (route, options = {}) => {
    await verifyEndpoint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(new URL(`/api/connect/push${route}`, base), {
        method: options.method || 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: controller.signal,
      });
      return readResponse(response);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  };
  const supported = () => Boolean(notification && serviceWorkerContainer?.register && typeof PushManager !== 'undefined');

  async function existingRegistration() {
    if (typeof serviceWorkerContainer?.getRegistration !== 'function') return lastRegistration;
    const value = await serviceWorkerContainer.getRegistration(scope) || lastRegistration;
    if (value && value.scope !== scope) throw new Error('The browser returned the wrong per-host push scope.');
    return value || null;
  }

  async function registration() {
    const value = await serviceWorkerContainer.register('/connect-sw.js', { scope });
    if (!value || value.scope !== scope) throw new Error('The browser returned the wrong per-host push scope.');
    await waitForServiceWorkerActivation(value, activationTimeoutMs);
    lastRegistration = value;
    return value;
  }

  async function localSubscription() {
    const value = await existingRegistration();
    const subscription = await value?.pushManager?.getSubscription?.();
    return { registration: value, subscription: subscription || null };
  }

  async function status() {
    if (!supported()) return { state: 'unsupported', message: 'This browser does not support web push notifications.' };
    const local = await localSubscription().catch(() => ({ registration: null, subscription: null }));
    try {
      const result = await request('');
      const hasLocalSubscription = Boolean(local.subscription);
      if (!result?.publicKey) {
        const value = {
          ...result,
          state: result?.state || 'unconfigured',
          permission: notification.permission,
          scope,
          localSubscription: hasLocalSubscription,
          localKeyMatches: false,
          needsRepair: hasLocalSubscription,
          message: result?.message || 'Configure a public HTTPS address on the host before enabling notifications.',
        };
        cachedStatus = value;
        return value;
      }
      let key;
      try { key = applicationServerKey(result.publicKey); } catch {
        const value = {
          ...result,
          state: 'unavailable',
          publicKey: null,
          permission: notification.permission,
          scope,
          registered: false,
          localSubscription: hasLocalSubscription,
          localKeyMatches: false,
          needsRepair: hasLocalSubscription,
          message: 'The host returned an invalid push public key.',
        };
        cachedStatus = value;
        return value;
      }
      const localKeyMatches = hasLocalSubscription && sameApplicationServerKey(local.subscription, key);
      const hostRegistered = result.registered === true;
      const enabled = hostRegistered && localKeyMatches;
      const needsRepair = !enabled && (hostRegistered || hasLocalSubscription);
      const value = {
        ...result,
        state: enabled ? 'enabled' : needsRepair ? 'repair' : (result.state || 'ready'),
        permission: notification.permission,
        scope,
        registered: hostRegistered,
        localSubscription: hasLocalSubscription,
        localKeyMatches,
        needsRepair,
      };
      cachedStatus = value;
      return value;
    } catch (cause) {
      const hasLocalSubscription = Boolean(local.subscription);
      const value = {
        state: hasLocalSubscription ? 'unverified' : (cause.status === 404 ? 'unconfigured' : 'error'),
        message: hasLocalSubscription ? 'The host could not be reached, so this local notification subscription cannot be verified.' : cause.message,
        status: cause.status,
        permission: notification.permission,
        scope,
        registered: false,
        localSubscription: hasLocalSubscription,
        localKeyMatches: null,
        needsRepair: hasLocalSubscription,
      };
      cachedStatus = value;
      return value;
    }
  }

  async function enable() {
    if (!supported()) return { state: 'unsupported', message: 'This browser does not support web push notifications.' };
    const prepared = cachedStatus;
    const hostReady = prepared?.publicKey && (prepared.readiness === 'ready' || ['ready', 'enabled', 'repair'].includes(prepared.state));
    if (!hostReady) {
      return prepared || {
        state: 'preparing',
        readiness: 'preparing',
        publicKey: null,
        registered: false,
        localSubscription: false,
        localKeyMatches: false,
        needsRepair: false,
        permission: notification.permission,
        scope,
        message: 'Check this host status before enabling notifications.',
      };
    }
    applicationServerKey(prepared.publicKey);
    // Keep the permission call in the click task. Do not await status or any
    // other network operation before invoking the browser permission API.
    const permissionRequest = notification.requestPermission();
    const permission = await permissionRequest;
    if (permission !== 'granted') return { ...prepared, state: permission === 'denied' ? 'denied' : 'default', permission, message: 'Notifications remain off until you allow them.' };
    const available = await status();
    const stillReady = available?.publicKey && (available.readiness === 'ready' || ['ready', 'enabled', 'repair'].includes(available.state));
    if (!stillReady) return available;
    const verifiedKey = applicationServerKey(available.publicKey);
    const worker = await registration();
    if (!worker.pushManager?.subscribe) return { state: 'unsupported', message: 'This browser has no push subscription support for this host.' };
    let subscription = await worker.pushManager.getSubscription?.();
    if (subscription && !sameApplicationServerKey(subscription, verifiedKey)) {
      const removed = await subscription.unsubscribe();
      if (!removed) throw new Error('The previous host notification subscription could not be removed.');
      subscription = null;
    }
    if (!subscription) subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: verifiedKey });
    const normalized = validateBrowserPushSubscription(subscription.toJSON ? subscription.toJSON() : subscription);
    const result = await request('/subscribe', { method: 'POST', body: { subscription: normalized } });
    if (result?.registered === false) throw new Error('The host did not confirm the browser push registration.');
    const enabled = { ...available, ...result, state: 'enabled', permission, scope: worker.scope, registered: true, localSubscription: true, localKeyMatches: true, needsRepair: false, readiness: 'ready', publicKey: available.publicKey };
    cachedStatus = enabled;
    return enabled;
  }

  async function disable() {
    let result = {};
    let hostError = null;
    try {
      result = await request('/unsubscribe', { method: 'POST', body: {} });
    } catch (cause) {
      hostError = cause;
    }
    let local;
    try {
      local = await localSubscription();
      if (local.subscription) {
        const removed = await local.subscription.unsubscribe();
        if (removed !== true) throw new Error('The browser notification subscription could not be removed.');
      }
    } catch (cause) {
      cause.localSubscription = true;
      if (hostError) cause.hostCleanupError = hostError.message;
      throw cause;
    }
    try { if (local.registration?.scope === scope) await local.registration.unregister?.(); } catch { /* Unregister is an optional cleanup after unsubscribe succeeded. */ }
    return {
      ...result,
      state: 'disabled',
      scope,
      localSubscription: false,
      hostCleanup: hostError ? 'unverified' : 'removed',
      ...(hostError ? { message: 'Notifications are off on this device. The host could not confirm cleanup while it was unreachable.', hostError: hostError.message } : {}),
    };
  }

  async function forget() {
    return disable();
  }

  return Object.freeze({ status, enable, disable, forget, registration, supported, scope });
}

export { decodeBase64Url };
