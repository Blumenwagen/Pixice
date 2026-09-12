/* Vite injects the same-origin asset list and build id at build time. */
const PRECACHE = __PIXICE_PRECACHE__;
const CACHE_NAME = `pixice-connect-shell-${__PIXICE_BUILD_ID__}`;
const isPushScope = self.registration?.scope?.includes('/connect-push/');
const isSameOrigin = (url) => url.origin === self.location.origin;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]{0,127}$/;
const targetFromObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(['hostId', 'projectId', 'threadId']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const { hostId, projectId, threadId } = value;
  if (![hostId, projectId, threadId].filter((item) => item !== undefined).every((item) => typeof item === 'string' && OPAQUE_ID.test(item))) return null;
  if (!hostId || (threadId !== undefined && projectId === undefined)) return null;
  return { hostId, ...(projectId !== undefined ? { projectId } : {}), ...(threadId !== undefined ? { threadId } : {}) };
};
const targetFromUrl = (value) => {
  try {
    const url = new URL(value, self.location.origin);
    if (!isSameOrigin(url) || url.pathname !== '/' || url.hash || url.username || url.password || url.port) return null;
    const allowed = new Set(['connectHost', 'connectProject', 'connectThread']);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) return false;
    for (const key of allowed) {
      const values = url.searchParams.getAll(key);
      if (values.length > 1 || values.some((item) => !OPAQUE_ID.test(item))) return null;
    }
    const hostId = url.searchParams.get('connectHost');
    const projectId = url.searchParams.get('connectProject');
    const threadId = url.searchParams.get('connectThread');
    return targetFromObject({ hostId, ...(projectId !== null ? { projectId } : {}), ...(threadId !== null ? { threadId } : {}) });
  } catch { return null; }
};
const targetFromNotification = (value) => {
  if (typeof value === 'string') return targetFromUrl(value);
  return targetFromObject(value);
};
const deepLinkForTarget = (target) => {
  const url = new URL('/', self.location.origin);
  url.searchParams.set('connectHost', target.hostId);
  if (target.projectId !== undefined) url.searchParams.set('connectProject', target.projectId);
  if (target.threadId !== undefined) url.searchParams.set('connectThread', target.threadId);
  return url.href;
};

if (!isPushScope) {
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => {
      const shellCaches = keys.filter((key) => key.startsWith('pixice-connect-shell-'));
      const keep = new Set([CACHE_NAME, ...shellCaches.filter((key) => key !== CACHE_NAME).slice(-1)]);
      return Promise.all(shellCaches.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
    }));
  });
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || !isSameOrigin(url) || url.pathname.startsWith('/api/') || request.headers.has('Authorization')) return;
    if (request.mode === 'navigate') {
      event.respondWith(fetch(request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match('/index.html'))));
      return;
    }
    if (PRECACHE.includes(url.pathname)) event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(request).then((cached) => cached || fetch(request))));
  });
}

self.addEventListener('push', (event) => {
  if (!isPushScope) return;
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { /* Malformed push data gets a generic notification. */ }
  const target = targetFromUrl(payload.url);
  event.waitUntil(self.registration.showNotification('Pixice Connect', { body: 'Activity needs your attention in Pixice Connect.', data: target ? { target } : {} }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = targetFromNotification(event.notification?.data?.target || event.notification?.data?.url);
  if (!target) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = clients.find((client) => {
      try {
        const url = new URL(client.url);
        return isSameOrigin(url) && url.pathname === '/';
      } catch { return false; }
    });
    if (current) {
      await current.focus();
      current.postMessage({ type: 'pixice-connect-open', target });
    } else await self.clients.openWindow(deepLinkForTarget(target));
  })());
});
