import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
export const NATIVE_METHODS = new Set([
  'browser.snapshot', 'browser.createTab', 'browser.closeTab', 'browser.activateTab', 'browser.navigate', 'browser.history', 'browser.setViewport', 'browser.adoptWorkspace', 'browser.destroyWorkspace', 'browser.remoteFrame', 'browser.remoteInput', 'browser.handleToolCall',
  'desktop.notify', 'desktop.openExternal', 'desktop.openDialog', 'desktop.reveal', 'desktop.openTerminal', 'desktop.setKeepAwake', 'desktop.confirmAction', 'desktop.serviceStopped', 'desktop.shutdown',
  'crypto.encrypt', 'crypto.decrypt'
]);
const leaseSchema = z.object({ leaseId: z.string().uuid() });
export class NativeBridge extends EventEmitter {
  constructor({ launch, desktopAuthority, commandTimeoutMs = 120_000, leaseTimeoutMs = 45_000 } = {}) {
    super(); this.launch = launch; this.commandTimeoutMs = commandTimeoutMs; this.leaseTimeoutMs = leaseTimeoutMs;
    this.desktopAuthority = desktopAuthority;
    this.pending = new Map(); this.queue = []; this.waiters = new Set(); this.closed = false;
    this.maintenance = setInterval(() => {
      if (this.voiceOwner && Date.now() - this.voiceOwner.lastSeen > this.leaseTimeoutMs) this.detachVoice();
      if (this.client && Date.now() - this.client.lastSeen > this.leaseTimeoutMs) this.detach('The native helper disconnected. The action may have completed; check before retrying.');
    }, 5000);
    this.maintenance.unref();
  }
  status() { return { connected: Boolean(this.client), clientId: this.client?.clientId ?? null, capabilities: this.client?.capabilities ?? [], pending: this.pending.size, error: this.error ?? null }; }
  attachVoice(payload) {
    this.authorize(payload);
    if (!this.client.trustedDesktop) throw new Error('Voice requires the private desktop bootstrap authority.');
    if (this.voiceOwner) throw new Error('A local renderer already owns voice');
    this.voiceOwner = { id: randomUUID(), leaseId: this.client.leaseId, lastSeen: Date.now(), events: [], eventBytes: 0, waiters: new Set() };
    return { ownerHandle: this.voiceOwner.id };
  }
  authorizeVoice(payload) {
    this.authorize(payload);
    if (this.voiceOwner && Date.now() - this.voiceOwner.lastSeen >= this.leaseTimeoutMs) this.detachVoice();
    const owner = this.voiceOwner;
    if (!owner || owner.id !== payload.ownerHandle || owner.leaseId !== this.client.leaseId) throw new Error('The local voice renderer owner expired');
    owner.lastSeen = Date.now();
    return owner;
  }
  isVoiceOwner(owner) { return Boolean(owner && owner === this.voiceOwner && owner.leaseId === this.client?.leaseId); }
  publishVoice(owner, event) {
    if (!this.isVoiceOwner(owner)) return false;
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { this.detachVoice(); return false; }
    if (owner.events.length >= 200 || owner.eventBytes + bytes > 2 * 1024 * 1024) { this.detachVoice(); return false; }
    const waiter = owner.waiters.values().next().value;
    if (waiter) { clearTimeout(waiter.timer); owner.waiters.delete(waiter); waiter.resolve({ events: [event] }); }
    else { owner.events.push(event); owner.eventBytes += bytes; }
    return true;
  }
  pollVoice(payload) {
    const owner = this.authorizeVoice(payload);
    if (owner.events.length) { owner.eventBytes = 0; return Promise.resolve({ events: owner.events.splice(0, 200) }); }
    if (owner.waiters.size) throw new Error('A voice event poll is already active');
    return new Promise((resolve) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => { owner.waiters.delete(waiter); resolve({ events: [] }); }, 20000);
      owner.waiters.add(waiter);
    });
  }
  detachVoice() {
    const owner = this.voiceOwner;
    if (!owner) return;
    this.voiceOwner = null;
    owner.events = [];
    owner.eventBytes = 0;
    for (const waiter of owner.waiters) { clearTimeout(waiter.timer); waiter.resolve({ events: [] }); }
    owner.waiters.clear(); this.emit('voice-owner-disconnected', owner);
  }
  register(payload) {
    const value = z.object({ clientId: z.string().uuid(), capabilities: z.array(z.string().max(100)).max(40), desktopAuthority: z.string().max(100).optional() }).strict().parse(payload);
    const trustedDesktop = this.hasDesktopAuthority(value.desktopAuthority);
    if (value.desktopAuthority !== undefined && !trustedDesktop) throw new Error('The private desktop bootstrap authority expired.');
    if (this.closed) throw new Error('The native bridge is stopping');
    if (this.client && Date.now() - this.client.lastSeen >= this.leaseTimeoutMs) this.detach('The native helper lease expired.');
    if (this.client?.trustedDesktop && !trustedDesktop) throw new Error('The registered desktop requires its private bootstrap authority.');
    if (this.client && this.client.clientId !== value.clientId && Date.now() - this.client.lastSeen < this.leaseTimeoutMs) throw new Error('Another native helper already owns this host');
    if (!this.client || this.client.clientId !== value.clientId) {
      if (this.client) this.detach('The native helper was replaced. Check the action before retrying.');
      this.client = { clientId: value.clientId, capabilities: value.capabilities, trustedDesktop, leaseId: randomUUID(), lastSeen: Date.now() };
    }
    // Legacy registration cannot upgrade an existing lease by public ID alone.
    if (this.client.trustedDesktop !== trustedDesktop) throw new Error('Register a new helper identity for the private desktop bootstrap.');
    this.client.lastSeen = Date.now(); this.error = null; this.emit('status', this.status());
    return { leaseId: this.client.leaseId };
  }
  authorize(payload) {
    const { leaseId } = leaseSchema.parse(payload);
    if (this.client && Date.now() - this.client.lastSeen >= this.leaseTimeoutMs) this.detach('The native helper lease expired.');
    if (!this.client || leaseId !== this.client.leaseId) throw new Error('The native helper lease expired. Register again.');
    if (this.client.trustedDesktop && !this.hasDesktopAuthority(payload.desktopAuthority)) throw new Error('The private desktop bootstrap authority expired.');
    this.client.lastSeen = Date.now();
  }
  hasDesktopAuthority(value) {
    return typeof value === 'string' && typeof this.desktopAuthority === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(value) && value.length === this.desktopAuthority.length
      && timingSafeEqual(Buffer.from(value), Buffer.from(this.desktopAuthority));
  }
  poll(payload) {
    this.authorize(payload);
    if (this.queue.length) return Promise.resolve({ commands: this.queue.splice(0, 20) });
    if (this.waiters.size >= 2) throw new Error('Too many native helper polls');
    return new Promise((resolve) => {
      const waiter = { resolve }; waiter.timer = setTimeout(() => { this.waiters.delete(waiter); resolve({ commands: [] }); }, 20_000);
      this.waiters.add(waiter);
    });
  }
  flush() {
    for (const waiter of this.waiters) {
      if (!this.queue.length) break;
      clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve({ commands: this.queue.splice(0, 20) });
    }
  }
  async ensure() {
    if (this.client) return;
    if (!this.launch) throw new Error('This feature needs the Pixice native helper. Open Pixice on the host or configure --native-executable.');
    if (!this.launching) this.launching = Promise.resolve().then(() => this.launch()).finally(() => { this.launching = null; });
    await this.launching;
  }
  async invoke(method, argumentsValue = [], { timeoutMs = this.commandTimeoutMs } = {}) {
    if (this.closed) throw new Error('The native helper is stopping');
    if (!NATIVE_METHODS.has(method)) throw new Error('Unsupported native capability');
    if (this.pending.size >= 64) throw new Error('The native helper is busy. Try again later.');
    if (JSON.stringify(argumentsValue).length > 2 * 1024 * 1024) throw new Error('Native request is too large');
    await this.ensure();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.queue = this.queue.filter((command) => command.id !== id);
        reject(new Error('The native helper did not finish in time. Check the action before retrying.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.queue.push({ id, method, arguments: argumentsValue }); this.flush();
    });
  }
  respond(payload) {
    this.authorize(payload);
    const value = leaseSchema.extend({ desktopAuthority: z.string().optional(), id: z.string().uuid(), result: z.unknown().optional(), error: z.string().max(2000).optional() }).strict().parse(payload);
    const pending = this.pending.get(value.id);
    if (!pending) return { accepted: false };
    this.pending.delete(value.id); clearTimeout(pending.timer);
    value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
    return { accepted: true };
  }
  event(payload) {
    this.authorize(payload);
    const value = leaseSchema.extend({ desktopAuthority: z.string().optional(), event: z.object({ type: z.enum(['BrowserState', 'BrowserOpenRequested', 'NativeError']), payload: z.unknown().optional() }).strict() }).strict().parse(payload);
    this.emit('event', { ...value.event, at: new Date().toISOString() }); return { accepted: true };
  }
  disconnect(payload) { this.authorize(payload); this.detach('The native helper closed. The action may have completed; check before retrying.'); return { disconnected: true }; }
  detach(message) {
    this.detachVoice();
    this.client = null; this.error = message;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear(); this.queue = [];
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve({ commands: [] }); }
    this.waiters.clear(); this.emit('status', this.status());
  }
  close() { this.closed = true; this.desktopAuthority = null; clearInterval(this.maintenance); this.detach('The Pixice service stopped.'); }
}
