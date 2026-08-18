import { EventEmitter } from "node:events";

/**
 * Keeps the Codex app-server behind the same provider boundary used by Claude.
 * The adapter is intentionally thin: Codex remains the canonical implementation
 * while Loom migrates its callers to provider-neutral operations.
 */
export class CodexProvider extends EventEmitter {
  constructor(runtime) {
    super();
    this.id = "codex";
    this.runtime = runtime;
    this.forwarders = new Map();
    for (const eventName of ["status", "event", "server-request", "recoverable-error", "diagnostic", "ready"]) {
      const forward = (payload) => this.emit(eventName, payload);
      this.forwarders.set(eventName, forward);
      runtime.on(eventName, forward);
    }
  }

  get connected() {
    return this.runtime.connected;
  }

  start() {
    return this.runtime.start();
  }

  stop() {
    return this.runtime.stop();
  }

  request(method, params) {
    return this.runtime.request(method, params);
  }

  respond(id, result) {
    return this.runtime.respond(id, result);
  }
}
