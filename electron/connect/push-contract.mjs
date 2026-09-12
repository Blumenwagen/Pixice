export const PUSH_ENDPOINT_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
]);

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;
export const MAX_PUSH_IDENTIFIER_LENGTH = 128;
export const PUSH_P256DH_BYTES = 65;
export const PUSH_AUTH_BYTES = 16;
export const VAPID_PUBLIC_BYTES = 65;
export const VAPID_PRIVATE_BYTES = 32;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isKnownPushHost(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return PUSH_ENDPOINT_HOSTS.some((known) => lower === known || lower.endsWith(`.${known}`));
}

export function isIpAddress(hostname) {
  const value = String(hostname || '');
  if (value.includes(':')) return true;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

export function decodeBase64Url(value, expectedBytes) {
  if (typeof value !== 'string' || !value || !BASE64URL_PATTERN.test(value)) return null;
  const padding = '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = globalThis.atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${padding}`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return expectedBytes === undefined || bytes.byteLength === expectedBytes ? bytes : null;
  } catch { return null; }
}

export function validOpaqueIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PUSH_IDENTIFIER_LENGTH && ID_PATTERN.test(value);
}

export function normalizeExternalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || isIpAddress(url.hostname) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch { return null; }
}

export function normalizePushSubscription(input) {
  if (!input || typeof input !== 'object' || typeof input.endpoint !== 'string' || input.endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
    throw new Error('The browser push subscription is invalid.');
  }
  let endpoint;
  try { endpoint = new URL(input.endpoint); } catch { throw new Error('The browser push endpoint is not a valid URL.'); }
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.hash || !isKnownPushHost(host) || isIpAddress(host) || ['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new Error('The browser push endpoint must use a known HTTPS browser push service.');
  }
  const p256dh = decodeBase64Url(input.keys?.p256dh, PUSH_P256DH_BYTES);
  const auth = decodeBase64Url(input.keys?.auth, PUSH_AUTH_BYTES);
  if (!p256dh || p256dh[0] !== 4 || !auth) throw new Error('The browser push subscription keys are invalid.');
  return {
    endpoint: endpoint.href,
    ...(input.expirationTime == null ? {} : { expirationTime: Number.isFinite(input.expirationTime) ? input.expirationTime : null }),
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
  };
}

export function validatePushSubscription(input, { deviceId, origin, allowedOrigins = [] } = {}) {
  if (!validOpaqueIdentifier(deviceId)) throw new Error('A trusted device identifier is required.');
  const receivingOrigin = normalizeExternalOrigin(origin);
  const allowed = new Set(allowedOrigins.map(normalizeExternalOrigin).filter(Boolean));
  if (!receivingOrigin || !allowed.has(receivingOrigin)) throw new Error('The receiving client origin is not allowed.');
  return normalizePushSubscription(input);
}

export function validVapidPublicKey(value) {
  const decoded = decodeBase64Url(value, VAPID_PUBLIC_BYTES);
  return Boolean(decoded && decoded[0] === 4);
}

export function validVapidPrivateKey(value) {
  return Boolean(decodeBase64Url(value, VAPID_PRIVATE_BYTES));
}

export function validVapidKeyPair(value) {
  return Boolean(value && validVapidPublicKey(value.publicKey) && validVapidPrivateKey(value.privateKey));
}

export { BASE64URL_PATTERN, ID_PATTERN };
