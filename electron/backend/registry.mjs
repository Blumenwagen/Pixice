// One application dispatch table is shared by local and remote transports.
export class ApplicationRegistry {
  constructor() { this.entries = new Map(); this.pending = new Set(); this.closed = false; }
  handle(name, handler) {
    if (this.entries.has(name)) throw new Error(`Application handler already registered: ${name}`);
    this.entries.set(name, handler);
  }
  removeHandler(name) { this.entries.delete(name); }
  async invoke(name, payload, context = {}) {
    if (this.closed) throw new Error('The Pixice service is stopping. Reconnect after it restarts.');
    const handler = this.entries.get(name);
    if (!handler) throw new Error(`This Pixice service does not support ${name}`);
    const result = Promise.resolve().then(() => handler(context, payload));
    this.pending.add(result);
    try { return await result; } finally { this.pending.delete(result); }
  }
  async drain() { this.closed = true; await Promise.allSettled([...this.pending]); }
}
