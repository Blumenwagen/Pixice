const MAX_OPAQUE_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]{0,127}$/;
const CONNECT_KEYS = new Set(['connectHost', 'connectProject', 'connectThread']);

function opaqueId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OPAQUE_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw new Error(`${label} is not a valid Pixice Connect identifier.`);
  }
  return value;
}

function sameOrigin(url, origin) {
  return typeof origin === 'string' && url.origin === origin;
}

export function createConnectDeepLink({ origin, hostId, projectId, threadId } = {}) {
  const base = new URL(origin || globalThis.location?.origin || 'http://localhost');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Connect links require an HTTP(S) receiving client.');
  base.pathname = '/';
  base.search = '';
  base.hash = '';
  if (hostId !== undefined) base.searchParams.set('connectHost', opaqueId(hostId, 'Host'));
  if (projectId !== undefined) {
    if (hostId === undefined) throw new Error('A project link also needs a host identifier.');
    base.searchParams.set('connectProject', opaqueId(projectId, 'Project'));
  }
  if (threadId !== undefined) {
    if (projectId === undefined) throw new Error('A thread link also needs a project identifier.');
    base.searchParams.set('connectThread', opaqueId(threadId, 'Thread'));
  }
  return base.href;
}

export function parseConnectDeepLink(value, { origin = globalThis.location?.origin } = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(value, origin); } catch { throw new Error('This Connect link is not a valid URL.'); }
  if (!sameOrigin(url, origin) || url.pathname !== '/' || url.hash) throw new Error('Connect links must stay on this receiving client.');
  for (const key of url.searchParams.keys()) if (!CONNECT_KEYS.has(key)) throw new Error('This Connect link contains an unsupported parameter.');
  const values = Object.fromEntries([...CONNECT_KEYS].map((key) => [key, url.searchParams.getAll(key)]));
  if (Object.values(values).some((items) => items.length > 1)) throw new Error('This Connect link contains a duplicate identifier.');
  const hostId = values.connectHost[0];
  const projectId = values.connectProject[0];
  const threadId = values.connectThread[0];
  if (!hostId) return null;
  opaqueId(hostId, 'Host');
  if (projectId !== undefined) opaqueId(projectId, 'Project');
  if (threadId !== undefined) opaqueId(threadId, 'Thread');
  if (threadId !== undefined && projectId === undefined) throw new Error('This Connect link is missing its project identifier.');
  return { hostId, ...(projectId !== undefined ? { projectId } : {}), ...(threadId !== undefined ? { threadId } : {}) };
}

export function routeConnectDeepLink({ location = globalThis.location, onRoute } = {}) {
  const route = parseConnectDeepLink(location?.href, { origin: location?.origin });
  if (!route) return false;
  onRoute?.(route);
  return route;
}

export { MAX_OPAQUE_ID_LENGTH, ID_PATTERN };
