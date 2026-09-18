import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { addonPresent, TranscriptionEngine } from "./engine.mjs";

// Resolved on first spawn rather than at import time. Under the test
// transform `import.meta.url` is an http URL, and this module is imported by
// the service in suites that never start a child.
const hostPath = () => fileURLToPath(new URL("./decoder-host.mjs", import.meta.url));
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

// Used by tests and by any caller that would rather pay the event-loop stall
// than manage a second process.
export class InProcessDecoder {
  constructor(options = {}) { this.engine = new TranscriptionEngine(options); }
  async available() { return this.engine.available(); }
  async transcribe(record, samples, options) { return this.engine.transcribe(record, samples, options); }
  async unload() { this.engine.unload(); }
  async close() { this.engine.unload(); }
}

export class ChildProcessDecoder {
  constructor({ hostPath = null, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, forkImpl = fork } = {}) {
    this.hostPath = hostPath;
    this.idleTimeoutMs = idleTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.forkImpl = forkImpl;
    this.child = null;
    this.pending = new Map();
    this.idleTimer = null;
    this.closed = false;
  }

  #spawn() {
    if (this.child) return this.child;
    // `advanced` serialization carries Float32Array through the IPC channel
    // without a base64 round trip.
    const child = this.forkImpl(this.hostPath ?? hostPath(), [], {
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true
    });
    child.on("message", (message) => {
      const entry = this.pending.get(message?.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      this.#scheduleIdleExit();
    });
    const fail = (reason) => {
      this.child = null;
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
      this.pending.clear();
    };
    child.on("exit", (code, signal) => {
      if (this.pending.size > 0) fail(`The transcription process stopped unexpectedly (${signal ?? `code ${code}`}).`);
      else this.child = null;
    });
    child.on("error", (error) => fail(`The transcription process could not start: ${error.message}`));
    child.unref?.();
    this.child = child;
    return child;
  }

  #scheduleIdleExit() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => { if (this.pending.size === 0) this.#stopChild(); }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #stopChild() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners("exit");
    try { child.disconnect(); } catch { /* already gone */ }
    child.kill();
  }

  #send(message) {
    if (this.closed) return Promise.reject(new Error("The transcription service is stopping."));
    const child = this.#spawn();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#stopChild();
        reject(new Error("Transcription did not finish in time."));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.send({ ...message, id }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`The transcription process is unavailable: ${error.message}`));
      });
    });
  }

  // Answered in this process. Spawning a decoder just to learn whether speech
  // recognition exists would start a child on every launch for a feature most
  // sessions never use.
  async available() {
    return addonPresent();
  }

  async transcribe(record, samples, options) {
    return this.#send({ type: "transcribe", record, samples, options });
  }

  async unload() {
    this.#stopChild();
  }

  async close() {
    this.closed = true;
    this.#stopChild();
  }
}
