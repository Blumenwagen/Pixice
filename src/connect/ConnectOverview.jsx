import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise } from '../components/icons/index.jsx';
import { LOCAL_HOST_ID, requestJson, savedInstances } from './client.js';
import { PROTOCOL_VERSION } from '../../electron/connect/protocol.mjs';
import { useConnect } from './ConnectRoot.jsx';
import { MobileAttentionPanel } from './mobile-attention.jsx';
import './mobile-connect.css';

export const OVERVIEW_TIMEOUT_MS = 10_000;
export const OVERVIEW_MAX_CONCURRENT = 4;
export const OVERVIEW_MAX_HOSTS = 100;
export const OVERVIEW_MAX_PROJECTS = 500;
export const OVERVIEW_MAX_TASKS = 1000;
const TASK_STATUSES = new Set(['running', 'waiting', 'failed', 'completed']);
const overviewCache = new Map();
export const OVERVIEW_MAX_CACHE_ENTRIES = 256;

function abortError(message = 'Overview request was cancelled.') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function awaitWithAbort(promise, signal, message) {
  if (signal?.aborted) return Promise.reject(abortError(message));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(message));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

function normalizeProject(project) {
  if (!project || typeof project.id !== 'string') return null;
  return { id: project.id, displayName: String(project.displayName || project.name || project.id), canonicalPath: typeof project.canonicalPath === 'string' ? project.canonicalPath : null };
}

function normalizeTask(task) {
  if (!task || typeof task.threadId !== 'string' || typeof task.projectId !== 'string' || !TASK_STATUSES.has(task.status)) return null;
  return { threadId: task.threadId, projectId: task.projectId, title: String(task.title || 'Untitled task'), status: task.status, updatedAt: task.updatedAt || null };
}

function normalizedResult(value) {
  return {
    projects: (Array.isArray(value?.projects) ? value.projects : []).map(normalizeProject).filter(Boolean).slice(0, OVERVIEW_MAX_PROJECTS),
    tasks: (Array.isArray(value?.tasks) ? value.tasks : []).map(normalizeTask).filter(Boolean).slice(0, OVERVIEW_MAX_TASKS),
    checkedAt: value?.checkedAt || new Date().toISOString(),
  };
}

function cacheKeyForTarget(target) {
  const instance = target.instance;
  const credentialGeneration = instance?.credentialGeneration || [instance?.deviceId, instance?.expiresAt].filter(Boolean).join(':');
  if (!credentialGeneration) return null;
  const policy = JSON.stringify({ role: instance?.role || null, projectIds: Array.isArray(instance?.projectIds) ? [...instance.projectIds].sort() : null });
  return [target.hostId, target.identityId || '', target.endpoint || '', credentialGeneration, policy].join('|');
}

function discardOtherCredentialCaches(target) {
  for (const [key, value] of overviewCache) {
    if (value.hostId === target.hostId && key !== target.cacheKey) overviewCache.delete(key);
  }
}

function pruneOverviewCache() {
  if (overviewCache.size <= OVERVIEW_MAX_CACHE_ENTRIES) return;
  const entries = [...overviewCache.entries()].sort((left, right) => (left[1].usedAt ?? 0) - (right[1].usedAt ?? 0));
  for (const [key] of entries.slice(0, overviewCache.size - OVERVIEW_MAX_CACHE_ENTRIES)) overviewCache.delete(key);
}

async function localIdentityWithDeadline(localApi, signal, timeoutMs) {
  if (!localApi?.connect?.status) return LOCAL_HOST_ID;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const value = await awaitWithAbort(Promise.resolve().then(() => localApi.connect.status({ signal: controller.signal })), controller.signal, 'Local host identity lookup timed out.');
    return value?.hostId || LOCAL_HOST_ID;
  } catch (cause) {
    if (signal?.aborted) throw abortError();
    return LOCAL_HOST_ID;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function hostTargets({ instances = [], localApi, apiForHost, localIdentity = LOCAL_HOST_ID } = {}) {
  const targets = [];
  if (localApi) targets.push({ hostId: LOCAL_HOST_ID, identityId: localIdentity, hostName: 'This device', api: localApi, cacheKey: `local|${localIdentity}` });
  for (const instance of instances.slice(0, OVERVIEW_MAX_HOSTS)) {
    if (!instance?.id || targets.some((target) => target.hostId === instance.id || target.identityId === instance.id)) continue;
    const target = { hostId: instance.id, identityId: instance.id, hostName: instance.name || instance.id, api: apiForHost?.(instance.id), endpoint: instance.endpoint, instance };
    target.cacheKey = cacheKeyForTarget(target);
    if (target.cacheKey) discardOtherCredentialCaches(target);
    targets.push(target);
  }
  return targets;
}

async function queryHost(target, { signal, timeoutMs }) {
  if (signal?.aborted) throw abortError();
  if (!target.api?.app?.overview) return { ...target, state: 'unsupported', message: 'Update this host to view its overview.' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const remote = Promise.resolve().then(() => target.api.app.overview({ signal: controller.signal }));
    const result = normalizedResult(await awaitWithAbort(remote, controller.signal, timedOut ? 'The host overview timed out.' : undefined));
    const fresh = { ...target, ...result, state: 'ready', stale: false, message: '', lastSuccessfulCheckedAt: result.checkedAt };
    if (target.cacheKey) {
      overviewCache.set(target.cacheKey, { hostId: target.hostId, identityId: target.identityId, hostName: target.hostName, projects: fresh.projects, tasks: fresh.tasks, checkedAt: fresh.checkedAt, lastSuccessfulCheckedAt: fresh.lastSuccessfulCheckedAt, usedAt: Date.now() });
      pruneOverviewCache();
    }
    return fresh;
  } catch (cause) {
    if (signal?.aborted) throw abortError();
    const cached = target.cacheKey ? overviewCache.get(target.cacheKey) : null;
    if (cached) cached.usedAt = Date.now();
    return cached
      ? { ...target, ...cached, state: 'stale', stale: true, message: cause.message || 'Host could not be checked.' }
      : { ...target, state: cause?.status === 404 ? 'unsupported' : 'error', message: cause.message || 'Host could not be checked.' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function mapConcurrent(targets, worker, limit, signal) {
  const output = new Array(targets.length);
  let next = 0;
  async function run() {
    while (true) {
      if (signal?.aborted) throw abortError();
      const index = next++;
      if (index >= targets.length) return;
      output[index] = await worker(targets[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.min(OVERVIEW_MAX_CONCURRENT, Number(limit) || OVERVIEW_MAX_CONCURRENT)), targets.length) }, run));
  return output;
}

export async function loadConnectOverview({ instances = [], localApi, apiForHost, signal, timeoutMs = OVERVIEW_TIMEOUT_MS, maxConcurrent = OVERVIEW_MAX_CONCURRENT } = {}) {
  const localIdentity = localApi?.connect?.status
    ? await localIdentityWithDeadline(localApi, signal, Math.min(timeoutMs, 2_000))
    : LOCAL_HOST_ID;
  const targets = hostTargets({ instances, localApi, apiForHost, localIdentity });
  const hosts = await mapConcurrent(targets, (target) => queryHost(target, { signal, timeoutMs }), maxConcurrent, signal);
  const projects = hosts.flatMap((host) => host.projects?.map((project) => ({ ...project, hostId: host.hostId, hostName: host.hostName })) || []).slice(0, OVERVIEW_MAX_PROJECTS);
  const projectNames = new Map(projects.map((project) => [`${project.hostId}:${project.id}`, project.displayName]));
  const tasks = hosts.flatMap((host) => host.tasks?.map((task) => ({ ...task, hostId: host.hostId, hostName: host.hostName, projectName: projectNames.get(`${host.hostId}:${task.projectId}`) || task.projectId })) || []).slice(0, OVERVIEW_MAX_TASKS);
  const successfulChecks = hosts.map((host) => host.lastSuccessfulCheckedAt).filter(Boolean).sort();
  return { hosts, projects, tasks, checkedAt: new Date().toISOString(), lastSuccessfulCheckedAt: successfulChecks.at(-1) || null, partial: hosts.some((host) => host.state !== 'ready') };
}

export function createRemoteOverviewApi(instance) {
  if (!instance?.endpoint || !instance?.id) return { app: { overview: async () => { throw new Error('That saved environment is no longer available.'); } } };
  return {
    app: {
      overview: async ({ signal } = {}) => {
        const info = await requestJson(instance.endpoint, 'info', { signal });
        if (info.hostId !== instance.id) throw new Error('This address belongs to a different Pixice host. Pair again to verify its identity.');
        if (info.protocol !== PROTOCOL_VERSION) throw new Error('Incompatible Pixice Connect version. Update the host and client.');
        const response = await requestJson(instance.endpoint, 'call', {
          token: instance.token,
          signal,
          mutation: false,
          body: { id: crypto.randomUUID(), operation: 'app.overview', issuedAt: Date.now(), instanceId: info.instanceId, payload: {} },
        });
        return response.result ?? response;
      },
    },
  };
}

export function clearConnectOverviewCache(hostId) {
  if (!hostId) { overviewCache.clear(); return; }
  for (const [key, value] of overviewCache) if (value.hostId === hostId || value.identityId === hostId || key.startsWith(`${hostId}|`)) overviewCache.delete(key);
}

export function useConnectOverview({ instances: instancesProp, localApi: localApiProp, apiForHost: apiForHostProp, enabled = true } = {}) {
  const context = useConnect();
  const fallbackInstances = useMemo(() => savedInstances(), []);
  const sourceInstances = instancesProp ?? context?.instances ?? fallbackInstances;
  const hostKey = useMemo(() => JSON.stringify(sourceInstances.map((instance) => ({ id: instance?.id, name: instance?.name, endpoint: instance?.endpoint, deviceId: instance?.deviceId, credentialGeneration: instance?.credentialGeneration, expiresAt: instance?.expiresAt, role: instance?.role, projectIds: instance?.projectIds }))), [sourceInstances]);
  const instances = useMemo(() => sourceInstances, [hostKey]);
  const localApi = localApiProp ?? (context?.local ? globalThis.window?.pixice : undefined);
  const instanceById = useMemo(() => new Map(instances.map((instance) => [instance.id, instance])), [instances]);
  const apiForHost = useMemo(() => apiForHostProp || ((hostId) => createRemoteOverviewApi(instanceById.get(hostId))), [apiForHostProp, instanceById]);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);
  const refresh = useCallback(() => {
    if (!enabled || !mountedRef.current) return Promise.resolve(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    return loadConnectOverview({ instances, localApi, apiForHost, signal: controller.signal }).then((value) => {
      if (mountedRef.current && requestId === requestIdRef.current) setSnapshot(value);
      return value;
    }).catch((cause) => {
      if (mountedRef.current && requestId === requestIdRef.current && cause.name !== 'AbortError') setError(cause.message);
      return null;
    }).finally(() => {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    });
  }, [apiForHost, enabled, instances, localApi]);
  useEffect(() => {
    if (!enabled) { controllerRef.current?.abort(); setLoading(false); return undefined; }
    void refresh();
    return () => { controllerRef.current?.abort(); requestIdRef.current += 1; };
  }, [enabled, refresh]);
  return { snapshot, loading, error, refresh };
}

function hostStateLabel(host) {
  if (host.state === 'ready') return 'Checked';
  if (host.state === 'stale') return 'Last known data';
  if (host.state === 'unsupported') return 'Update host';
  return 'Unavailable';
}

export function ConnectOverviewView({ snapshot, loading, error, refresh, onOpen, onOpenEnvironment } = {}) {
  const [filter, setFilter] = useState('all');
  const tasks = snapshot?.tasks?.filter((task) => filter === 'all' || task.status === filter) || [];
  const totalLabel = snapshot?.partial ? 'partial' : 'total';
  return <section className="connect-overview connect-mobile-shell" aria-label="Connect overview">
    <header className="connect-overview-header"><div><h2>Across your instances</h2><p>Combined host overview. Opening a task needs a current connection.</p>{snapshot?.lastSuccessfulCheckedAt && <small className="settings-footnote">Last successful check {new Date(snapshot.lastSuccessfulCheckedAt).toLocaleString()}</small>}</div><button type="button" className="settings-action" onClick={() => void refresh()} disabled={loading}><ArrowClockwise size={14} />{loading ? 'Checking…' : 'Refresh'}</button></header>
    {error && <p className="connect-error" role="alert">{error}</p>}
    {snapshot?.partial && <p className="settings-footnote" role="status">Some hosts could not be checked. Counts include last known data where it is available.</p>}
    <div className="connect-overview-counts" data-state={snapshot?.partial ? 'partial' : 'complete'} aria-label="Overview counts"><span><strong>{snapshot?.projects?.length ?? 0}</strong><small>{totalLabel} projects</small></span><span><strong>{snapshot?.tasks?.filter((task) => task.status === 'waiting').length ?? 0}</strong><small>{totalLabel} waiting</small></span><span><strong>{snapshot?.tasks?.filter((task) => task.status === 'running').length ?? 0}</strong><small>{totalLabel} running</small></span></div>
    <div className="connect-overview-hosts">{snapshot?.hosts?.map((host) => <div className="connect-overview-host" key={host.hostId}><span><strong>{host.hostName}</strong><small>{hostStateLabel(host)}{host.message ? ` · ${host.message}` : ''}</small></span>{host.state === 'unsupported' && <button type="button" className="settings-action" onClick={() => onOpenEnvironment?.(host.hostId)}>Open environment</button>}</div>)}</div>
    <div className="connect-overview-task-heading"><h3>Tasks</h3><label>Filter<select aria-label="Task status filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All</option><option value="waiting">Waiting</option><option value="running">Running</option><option value="failed">Failed</option><option value="completed">Completed</option></select></label></div>
    <div className="connect-overview-task-list">{tasks.map((task) => <div className="connect-overview-task" key={`${task.hostId}:${task.projectId}:${task.threadId}`}><span><strong>{task.title}</strong><small>{task.hostName} · {task.projectName} · {task.status}</small></span><button type="button" className="settings-action" disabled={snapshot?.hosts?.find((host) => host.hostId === task.hostId)?.stale} onClick={() => onOpen?.({ hostId: task.hostId, projectId: task.projectId, threadId: task.threadId })}>Open</button></div>)}{snapshot && !tasks.length && <p className="settings-footnote">No tasks match this filter.</p>}{!snapshot && !loading && <p className="settings-footnote">No host overviews yet.</p>}</div>
    <MobileAttentionPanel snapshot={snapshot} loading={loading} onOpen={onOpen} />
  </section>;
}

export function ConnectOverview({ instances, localApi, apiForHost, onOpen, onOpenEnvironment } = {}) {
  const { snapshot, loading, error, refresh } = useConnectOverview({ instances, localApi, apiForHost });
  return <ConnectOverviewView snapshot={snapshot} loading={loading} error={error} refresh={refresh} onOpen={onOpen} onOpenEnvironment={onOpenEnvironment} />;
}

export { overviewCache };
