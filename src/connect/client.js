import { forgetUsage } from './usage-cache.js';
import { CAPABILITIES, PROTOCOL_VERSION, normalizeEndpoint } from '../../electron/connect/protocol.mjs';
export const getPixiceApi = () => window.pixiceRemote ?? window.pixice;
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
export async function requestJson(endpoint, route, { token, body, signal } = {}) {
  const response = await fetch(`${endpoint}/api/connect/${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(120_000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('This address did not return a Pixice response. Check the endpoint and HTTPS proxy.'); }
  if (!response.ok) throw Object.assign(new Error(result.error || `Connection failed (${response.status})`), { status: response.status });
  return result;
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
  const instance = { id: result.hostId, endpoint, name: result.name, token: result.token, deviceId: result.deviceId, expiresAt: result.expiresAt };
  saveInstance(instance);
  return instance;
}

export class RemoteClient {
  constructor(instance, { onState = () => {}, onReset = () => {}, pickFolders = async () => [] } = {}) {
    this.instance = { ...instance, endpoint: normalizeEndpoint(instance.endpoint) };
    this.onState = onState;
    this.onReset = onReset;
    this.listeners = new Set();
    this.requests = new Map();
    this.attention = new Map();
    this.closed = false;
    this.online = false;
    this.cursor = 0;
    this.eventInstance = '';
    this.hasSnapshot = false;
    this.api = { remote: { hostId: instance.id, name: instance.name, endpoint: instance.endpoint } };
    for (const [group, entries] of Object.entries(CAPABILITIES)) {
      this.api[group] = Object.fromEntries(Object.keys(entries).map((name) => [name, (payload) => this.call(`${group}.${name}`, payload)]));
    }
    const readSettings = () => { try { return JSON.parse(localStorage.getItem(`pixice.connect.settings.${instance.id}`) || '{}'); } catch { return {}; } };
    this.api.app.bootstrap = async () => { const result = await this.call('app.bootstrap'); return { ...result, settings: { ...result.settings, ...readSettings() } }; };
    this.api.app.saveSettings = async (patch) => { const settings = { ...readSettings(), ...patch }; localStorage.setItem(`pixice.connect.settings.${instance.id}`, JSON.stringify(settings)); return settings; };
    this.api.projects.pickFolders = pickFolders;
    this.api.projects.directories = (payload) => this.call('projects.directories', payload);
    this.api.projects.open = async () => { throw new Error('Use New project to choose folders on the remote host.'); };
    this.api.events = { subscribe: (listener) => {
      this.listeners.add(listener);
      queueMicrotask(() => { if (this.listeners.has(listener)) for (const payload of this.attention.values()) listener({ type: 'AttentionRequired', payload }); });
      return () => this.listeners.delete(listener);
    } };
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
  emit(event) { for (const listener of this.listeners) listener(event); }
  async connect() {
    const info = await requestJson(this.instance.endpoint, 'info');
    if (info.hostId !== this.instance.id) throw new Error('This address belongs to a different Pixice host. Pair again to verify its identity.');
    if (info.protocol !== PROTOCOL_VERSION) throw new Error('Incompatible Pixice Connect version. Update the host and client.');
    this.instanceId = info.instanceId;
    this.online = true;
    try { await this.call('runtime.status'); } catch (error) { this.online = false; throw error; }
    if (this.closed) return;
    this.onState({ state: 'connected' });
    void this.poll();
  }
  async call(operation, payload) {
    if (!this.online || this.closed) throw new Error('The instance is offline. Your action was not sent.');
    if (['approvals.resolve', 'requests.respond', 'questions.respond', 'elicitations.respond'].includes(operation)) {
      payload = { ...payload, requestGeneration: this.requests.get(String(payload?.requestId)) };
    }
    try {
      const response = await requestJson(this.instance.endpoint, 'call', { token: this.instance.token, body: { operation, payload, id: crypto.randomUUID(), issuedAt: Date.now(), instanceId: this.instanceId } });
      if (operation === 'tasks.interventions') for (const request of response.result?.requests ?? []) this.requests.set(String(request.id), request.requestGeneration);
      return response.result;
    } catch (error) {
      // Never retry commands: a lost response can mean the operation already ran.
      if (error.status === 401) { this.online = false; this.onState({ state: 'unauthorized', error: error.message }); }
      if (!error.status) throw new Error('The connection was lost. This action may have reached the host; check its current state before sending again.');
      throw error;
    }
  }
  async poll() {
    let failures = 0;
    while (!this.closed) {
      this.abort = new AbortController();
      const timeout = setTimeout(() => this.abort?.abort(), 30_000);
      try {
        const batch = await requestJson(this.instance.endpoint, `poll?cursor=${this.cursor}&instanceId=${encodeURIComponent(this.eventInstance)}`, { token: this.instance.token, signal: this.abort.signal });
        clearTimeout(timeout);
        if (this.closed) return;
        for (const event of batch.events) {
          if (event.protocol !== PROTOCOL_VERSION) throw new Error('The host protocol changed. Update Pixice.');
          if (event.type === 'ConnectReset') {
            const wasConnected = this.hasSnapshot;
            this.hasSnapshot = true;
            this.instanceId = event.instanceId;
            this.eventInstance = event.instanceId;
            this.cursor = event.sequence;
            this.attention.clear();
            this.requests.clear();
            for (const payload of event.payload.attention) { this.attention.set(String(payload.id), payload); this.requests.set(String(payload.id), payload.requestGeneration); }
            if (wasConnected) this.onReset();
            this.emit({ type: 'AttentionReset', payload: {} });
            for (const payload of this.attention.values()) this.emit({ type: 'AttentionRequired', payload });
            continue;
          }
          if (event.sequence !== this.cursor + 1) { this.eventInstance = ''; throw new Error('Resynchronizing instance state'); }
          this.cursor = event.sequence;
          if (event.type === 'AttentionRequired') { this.requests.set(String(event.payload.id), event.payload.requestGeneration); this.attention.set(String(event.payload.id), event.payload); }
          if (event.type === 'AttentionResolved') { this.requests.delete(String(event.payload.requestId)); this.attention.delete(String(event.payload.requestId)); }
          if (event.type === 'AttentionReset') { this.requests.clear(); this.attention.clear(); }
          this.emit(event);
        }
        this.online = true;
        this.onState({ state: 'connected' });
        failures = 0;
      } catch (error) {
        clearTimeout(timeout);
        if (this.closed) return;
        this.online = false;
        this.onState({ state: error.status === 401 ? 'unauthorized' : 'reconnecting', error: error.status ? error.message : 'Connection lost. Reconnecting…' });
        if (error.status === 401) return;
        await new Promise((resolve) => { this.wake = resolve; this.retry = setTimeout(resolve, Math.min(15_000, 1000 * 2 ** failures++) + Math.random() * 250); });
      }
    }
  }
  close() { this.closed = true; this.online = false; this.abort?.abort(); clearTimeout(this.retry); this.wake?.(); this.listeners.clear(); }
}
