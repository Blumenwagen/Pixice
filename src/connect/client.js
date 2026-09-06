import { ApplicationClient, requestJson } from '../../electron/connect/application-client.mjs';
export { requestJson } from '../../electron/connect/application-client.mjs';
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

export class RemoteClient extends ApplicationClient {
  constructor(instance, { onState = () => {}, onReset = () => {}, pickFolders = async () => [] } = {}) {
    super(instance, { onState, onReset });
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
}
