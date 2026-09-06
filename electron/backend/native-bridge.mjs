import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const NATIVE_METHODS = new Set([
  'browser.snapshot', 'browser.createTab', 'browser.closeTab', 'browser.activateTab', 'browser.navigate', 'browser.history', 'browser.setViewport', 'browser.adoptWorkspace', 'browser.destroyWorkspace', 'browser.remoteFrame', 'browser.remoteInput', 'browser.handleToolCall',
  'desktop.notify', 'desktop.openExternal', 'desktop.openDialog', 'desktop.reveal', 'desktop.openTerminal', 'desktop.setKeepAwake', 'desktop.confirmAction', 'desktop.serviceStopped', 'desktop.shutdown',
  'crypto.encrypt', 'crypto.decrypt'
]);
const leaseSchema = z.object({ leaseId: z.string().uuid() });
export class NativeBridge extends EventEmitter {
  constructor({ launch, commandTimeoutMs = 120_000, leaseTimeoutMs = 45_000 } = {}) {
    super(); this.launch = launch; this.commandTimeoutMs = commandTimeoutMs; this.leaseTimeoutMs = leaseTimeoutMs;
    this.pending = new Map(); this.queue = []; this.waiters = new Set(); this.closed = false;
    this.maintenance = setInterval(() => { if (this.client && Date.now() - this.client.lastSeen > this.leaseTimeoutMs) this.detach('The native helper disconnected. The action may have completed; check before retrying.'); }, 5000);
    this.maintenance.unref();
  }
  status() { return { connected: Boolean(this.client), clientId: this.client?.clientId ?? null, capabilities: this.client?.capabilities ?? [], pending: this.pending.size, error: this.error ?? null }; }
  register(payload) {
    const value = z.object({ clientId: z.string().uuid(), capabilities: z.array(z.string().max(100)).max(40) }).strict().parse(payload);
    if (this.closed) throw new Error('The native bridge is stopping');
    if (this.client && this.client.clientId !== value.clientId && Date.now() - this.client.lastSeen < this.leaseTimeoutMs) throw new Error('Another native helper already owns this host');
    if (!this.client || this.client.clientId !== value.clientId) {
      if (this.client) this.detach('The native helper was replaced. Check the action before retrying.');
      this.client = { ...value, leaseId: randomUUID(), lastSeen: Date.now() };
    }
    this.client.lastSeen = Date.now(); this.error = null; this.emit('status', this.status());
    return { leaseId: this.client.leaseId };
  }
  authorize(payload) {
    const { leaseId } = leaseSchema.parse(payload);
    if (!this.client || leaseId !== this.client.leaseId) throw new Error('The native helper lease expired. Register again.');
    this.client.lastSeen = Date.now();
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
    const value = leaseSchema.extend({ id: z.string().uuid(), result: z.unknown().optional(), error: z.string().max(2000).optional() }).strict().parse(payload);
    const pending = this.pending.get(value.id);
    if (!pending) return { accepted: false };
    this.pending.delete(value.id); clearTimeout(pending.timer);
    value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
    return { accepted: true };
  }
  event(payload) {
    this.authorize(payload);
    const value = leaseSchema.extend({ event: z.object({ type: z.enum(['BrowserState', 'BrowserOpenRequested', 'NativeError']), payload: z.unknown().optional() }).strict() }).strict().parse(payload);
    this.emit('event', { ...value.event, at: new Date().toISOString() }); return { accepted: true };
  }
  disconnect(payload) { this.authorize(payload); this.detach('The native helper closed. The action may have completed; check before retrying.'); return { disconnected: true }; }
  detach(message) {
    this.client = null; this.error = message;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear(); this.queue = [];
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve({ commands: [] }); }
    this.waiters.clear(); this.emit('status', this.status());
  }
  close() { this.closed = true; clearInterval(this.maintenance); this.detach('The Pixice service stopped.'); }
}
