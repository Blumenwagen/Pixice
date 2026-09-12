import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeCodexEvent } from '../../electron/runtime/capability-adapter.mjs';
export class BackendFixtureProvider extends EventEmitter {
  constructor(id = 'codex') { super(); this.id = id; this.connected = false; this.threads = new Map(); this.starts = 0; this.listNested = false; }
  async start() { this.connected = true; this.emit('status', { state: 'connected' }); return true; }
  async stop() { this.connected = false; this.emit('status', { state: 'stopped' }); }
  account() { return Promise.resolve({ authenticated: true, requiresAuth: false }); }
  lifecycle() { return { installed: true, compatible: true, actions: {} }; }
  event(payload) { this.emit('event', normalizeCodexEvent({ method: payload.method, params: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'method')) })); }
  async request(method, params = {}) {
    if (method === 'model/list') return { data: this.id === 'codex' ? [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', isDefault: true }] : [] };
    if (method === 'thread/list') {
      const data = [...this.threads.values()].filter((thread) => {
        if (!params.cwd || thread.cwd === params.cwd) return true;
        if (!this.listNested) return false;
        const relative = path.relative(params.cwd, thread.cwd);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });
      return { data, nextCursor: null };
    }
    if (method === 'account/rateLimits/read') return { rateLimits: null };
    if (method === 'thread/start') {
      const thread = { id: randomUUID(), cwd: params.cwd, createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000), turns: [], status: { type: 'idle' } };
      this.threads.set(thread.id, thread); return { thread };
    }
    const thread = this.threads.get(params.threadId);
    if (['thread/read', 'thread/resume'].includes(method)) { if (!thread) throw new Error('Fixture thread unavailable'); return { thread: structuredClone(thread) }; }
    if (method === 'turn/start') {
      this.starts++;
      const turn = { id: randomUUID(), status: 'inProgress', items: [] }; thread.turns.push(turn);
      this.event({ method: 'turn/started', threadId: thread.id, turn }); return { turn };
    }
    if (method === 'turn/interrupt') {
      const turn = thread.turns.find(t => t.id === params.turnId); turn.status = 'interrupted';
      this.event({ method: 'turn/completed', threadId: thread.id, turn }); return { ok: true };
    }
    throw new Error(`Unsupported fixture request: ${method}`);
  }
  respond() {}
}
