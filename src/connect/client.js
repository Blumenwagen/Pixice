import { ApplicationClient, requestJson } from '../../electron/connect/application-client.mjs';
export { requestJson } from '../../electron/connect/application-client.mjs';
import { forgetUsage } from './usage-cache.js';
import { CAPABILITIES, CONNECT_RECOVERY_EVENTS, PROTOCOL_VERSION, normalizeEndpoint } from '../../electron/connect/protocol.mjs';
export const LOCAL_HOST_ID = 'local';
export const getPixiceApi = (hostId = null, registry = null) => {
  if (hostId === LOCAL_HOST_ID || hostId === null && !window.pixiceRemote) return window.pixice;
  if (hostId && registry?.get(hostId)) {
    const entry = registry.get(hostId);
    return entry.api ?? entry.client?.api;
  }
  return hostId === null ? window.pixiceRemote ?? window.pixice : undefined;
};
const CONNECTIONS_KEY = 'pixice.connect.instances';
export function savedInstances() {
  try { return JSON.parse(localStorage.getItem(CONNECTIONS_KEY) || '[]').filter((item) => item.id && item.endpoint && item.token); } catch { return []; }
}
export function saveInstance(instance) {
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify([...savedInstances().filter((item) => item.id !== instance.id), instance]));
}
export function forgetInstance(id) {
  forgetUsage(id);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(savedInstances().filter((item) => item.id !== id)));
}
export function parsePairingLink(value) {
  const url = new URL(value.trim());
  const token = new URLSearchParams(url.hash.slice(1)).get('pair');
  url.hash = '';
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Paste the complete, one-time pairing link from the host’s Connections settings.');
  return { endpoint: normalizeEndpoint(url.href), token };
}
export async function pairInstance(link, name) {
  const { endpoint, token } = parsePairingLink(link);
  const info = await requestJson(endpoint, 'info');
  if (info.protocol !== PROTOCOL_VERSION) throw new Error('This host uses an incompatible Pixice Connect version. Update both clients.');
  const result = await requestJson(endpoint, 'pair', { body: { token, name } });
  if (info.hostId !== result.hostId) throw new Error('The host identity changed during pairing. Create a new pairing link.');
  const instance = {
    id: result.hostId,
    endpoint,
    name: result.name,
    token: result.token,
    deviceId: result.deviceId,
    expiresAt: result.expiresAt,
    ...(result.role ? { role: result.role } : {}),
    ...(Array.isArray(result.projectIds) ? { projectIds: result.projectIds } : {}),
    ...(result.expiresAt ? { credentialGeneration: `${result.deviceId}:${result.expiresAt}` } : {})
  };
  saveInstance(instance);
  return instance;
}

export function createRemoteClientRegistry({ getInstance, getOrigin = () => null, onState = () => {}, onReset = () => {}, onCommandIssued = () => {}, onCommandSettled = () => {}, onCommandUncertain = () => {}, pickFolders = async () => [] } = {}) {
  const entries = new Map();
  let generation = 0;
  const instanceFingerprint = (instance) => JSON.stringify([
    instance?.id ?? '',
    normalizeEndpoint(instance?.endpoint ?? ''),
    instance?.token ?? '',
    instance?.deviceId ?? ''
  ]);
  const retire = (entry) => {
    if (!entry || entry.retired) return;
    entry.retired = true;
    entry.unsubscribe?.();
    entry.client.close();
  };
  const ensure = (id, { force = false } = {}) => {
    const instance = getInstance?.(id);
    if (!instance) throw new Error('That saved environment is no longer available.');
    const existing = entries.get(id);
    const fingerprint = instanceFingerprint(instance);
    if (existing && !force && !existing.failed && !existing.retired && !existing.client.closed && existing.fingerprint === fingerprint) return existing;
    if (existing) {
      retire(existing);
      if (entries.get(id) === existing) entries.delete(id);
    }
    let entry;
    const active = () => entries.get(id) === entry && !entry.retired && !entry.client.closed;
    const guarded = (callback) => (value) => { if (active()) callback(id, value); };
    const client = new RemoteClient(instance, {
      onState: guarded(onState),
      onReset: guarded(onReset),
      pickFolders
    });
    entry = { id, client, api: client.api, fingerprint, failed: false, retired: false, generation: ++generation, origin: getOrigin?.(id) ?? null, connecting: null, unsubscribe: null };
    entry.unsubscribe = client.subscribe((event) => {
      if (!active()) return;
      const origin = entry.origin ?? getOrigin?.(id) ?? null;
      const descriptor = {
        ...(event?.payload ?? {}),
        hostId: id,
        ...(instance.deviceId ? { deviceId: instance.deviceId } : {}),
        ...(origin?.hostId ? { originHostId: origin.hostId } : {}),
        ...(origin?.projectId ? { originProjectId: origin.projectId } : {})
      };
      if (event.type === CONNECT_RECOVERY_EVENTS.issued) onCommandIssued(id, descriptor);
      if (event.type === CONNECT_RECOVERY_EVENTS.settled) onCommandSettled(id, descriptor);
      if (event.type === CONNECT_RECOVERY_EVENTS.uncertain) onCommandUncertain(id, descriptor);
    });
    entries.set(id, entry);
    entry.connecting = client.connect().catch((cause) => {
      if (active()) entry.failed = true;
      throw cause;
    });
    return entry;
  };
  return {
    get: (id) => entries.get(id),
    ensure,
    setOrigin: (id, origin) => { const entry = entries.get(id); if (entry && !entry.retired && !entry.client.closed) entry.origin = origin ? { hostId: origin.hostId, projectId: origin.projectId, hostLabel: origin.hostLabel } : null; },
    forget: (id) => { const entry = entries.get(id); retire(entry); if (entries.get(id) === entry) entries.delete(id); },
    close: () => { for (const entry of entries.values()) retire(entry); entries.clear(); },
    entries
  };
}

export class RemoteClient extends ApplicationClient {
  constructor(instance, { onState = () => {}, onReset = () => {}, onCommandIssued = () => {}, onCommandSettled = () => {}, onCommandUncertain = () => {}, pickFolders = async () => [] } = {}) {
    super(instance, { onState, onReset, onCommandIssued, onCommandSettled, onCommandUncertain });
    this.hostId = instance.id;
    this.instanceName = instance.name;
    this.api = { remote: { hostId: instance.id, name: instance.name, endpoint: instance.endpoint, token: instance.token, deviceId: instance.deviceId ?? null, capabilities: null, identityVerified: false } };
    for (const [group, entries] of Object.entries(CAPABILITIES)) {
      this.api[group] = Object.fromEntries(Object.keys(entries).map((name) => [name, (payload) => this.call(`${group}.${name}`, payload)]));
    }
    const readSettings = () => { try { return JSON.parse(localStorage.getItem(`pixice.connect.settings.${instance.id}`) || '{}'); } catch { return {}; } };
    this.api.app.bootstrap = async () => { const result = await this.call('app.bootstrap'); return { ...result, settings: { ...result.settings, ...readSettings() } }; };
    this.api.app.saveSettings = async (patch) => { const settings = { ...readSettings(), ...patch }; localStorage.setItem(`pixice.connect.settings.${instance.id}`, JSON.stringify(settings)); return settings; };
    this.api.projects.pickFolders = pickFolders;
    this.api.projects.directories = (payload) => this.call('projects.directories', payload);
    this.api.projects.open = async () => { throw new Error('Use New project to choose folders on the remote host.'); };
    this.api.events = { subscribe: (listener) => this.subscribe(listener) };
    const localOnly = async () => { throw new Error('This action needs the Pixice desktop on the host.'); };
    this.api.preview = { setContext: async () => ({ ok: true }) };
    // Remote view sizes and visibility belong to the receiving client, never the host window.
    this.api.browser.setViewport = async () => undefined;
    this.api.external = { openEditor: localOnly, openTerminal: localOnly, reveal: localOnly };
    this.api.extensions = { list: async () => ({ skills: [], apps: [], mcp: [], errors: ['Manage capabilities on the host desktop.'] }) };
    this.api.github = { status: async () => ({ available: false, authenticated: false, message: 'Manage GitHub sign-in on the host desktop.' }), login: localOnly, logout: localOnly };
    this.api.updates = { status: async () => ({ supported: false, state: 'remote', message: 'Install Pixice updates on the host desktop.' }), check: localOnly, download: localOnly, install: localOnly };
    for (const name of ['login', 'logout', 'install', 'locate', 'repair', 'checkUpdates', 'update']) this.api.providers[name] = localOnly;
    this.api.git.installCommandLineTools = localOnly;
    this.api.workflowCredentials = { list: async () => [], create: localOnly, update: localOnly, delete: localOnly };
    this.api.ios = { environment: async () => ({ available: false, supported: false, message: 'Simulator previews are available on the host desktop.' }), discover: localOnly, createStarter: localOnly, start: localOnly, state: async () => null, stop: localOnly, action: localOnly, adopt: localOnly };
  }

  async connect() {
    const result = await super.connect();
    this.api.remote.capabilities = this.capabilities;
    this.api.remote.instanceId = this.instanceId;
    this.api.remote.identityVerified = true;
    this.api.remote.transfers = this.capabilities?.transfers ?? null;
    this.api.remote.readiness = this.capabilities?.readiness ?? null;
    this.api.remote.role = this.capabilities?.role ?? this.instance.role ?? 'operator';
    this.api.remote.projectIds = this.capabilities?.projectIds ?? this.instance.projectIds ?? null;
    const nextInstance = {
      ...this.instance,
      ...(this.capabilities?.role ? { role: this.capabilities.role } : {}),
      ...(Array.isArray(this.capabilities?.projectIds) ? { projectIds: this.capabilities.projectIds } : {}),
      ...(this.capabilities?.expiresAt ? { expiresAt: this.capabilities.expiresAt } : {}),
      ...(this.instance.deviceId && this.capabilities?.expiresAt ? { credentialGeneration: `${this.instance.deviceId}:${this.capabilities.expiresAt}` } : {})
    };
    if (JSON.stringify(nextInstance) !== JSON.stringify(this.instance)) saveInstance(nextInstance);
    this.instance = nextInstance;
    this.onState({ state: 'connected', role: this.api.remote.role, projectIds: this.api.remote.projectIds, readiness: this.api.remote.readiness });
    return result;
  }
}
