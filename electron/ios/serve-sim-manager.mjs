import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_LENGTH = 64 * 1024;
export const SERVE_SIM_PACKAGE_SPEC = "serve-sim@0.1.46";

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("serve-sim port must be an integer between 1 and 65535");
  }
  return port;
}

function publicSession(record) {
  if (!record) return null;
  return {
    workspaceId: record.workspaceId,
    simulatorUdid: record.simulatorUdid,
    status: record.status,
    port: record.port,
    previewUrl: record.previewUrl,
    streamUrl: record.streamUrl,
    pid: record.pid,
    error: record.error,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt
  };
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

function localHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function reportedUdid(value) {
  if (!value || typeof value !== "object") return null;
  return value.udid
    ?? value.deviceUdid
    ?? value.simulatorUdid
    ?? (typeof value.device === "string" ? value.device : value.device?.udid)
    ?? null;
}

/** Parse the stable JSON emitted by `serve-sim --quiet`. Human-readable banners are intentionally unsupported. */
export function parseServeSimReadiness(value, { expectedUdid = null } = {}) {
  let message = value;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;

  const candidates = [message, message.data, message.result].filter((candidate) => candidate && typeof candidate === "object");
  for (const candidate of candidates) {
    const udid = reportedUdid(candidate) ?? reportedUdid(message);
    if (expectedUdid && udid && udid !== expectedUdid) continue;
    const preview = localHttpUrl(candidate.url ?? candidate.previewUrl);
    if (!preview) continue;
    const stream = localHttpUrl(candidate.streamUrl);
    const port = preview.port ? Number(preview.port) : preview.protocol === "https:" ? 443 : 80;
    return {
      previewUrl: preview.href.replace(/\/$/, ""),
      streamUrl: stream?.href.replace(/\/$/, "") ?? null,
      port,
      pid: Number.isInteger(candidate.pid) ? candidate.pid : null
    };
  }
  return null;
}

class JsonObjectDecoder {
  #buffer = "";

  push(chunk) {
    this.#buffer = `${this.#buffer}${String(chunk)}`.slice(-MAX_OUTPUT_LENGTH);
    const values = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let consumed = 0;

    for (let index = 0; index < this.#buffer.length; index += 1) {
      const character = this.#buffer[index];
      if (start < 0) {
        if (character === "{") {
          start = index;
          depth = 1;
        }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      if (depth !== 0) continue;

      const source = this.#buffer.slice(start, index + 1);
      try {
        values.push(JSON.parse(source));
      } catch {
        // Quiet mode should emit valid JSON. Discard a malformed complete object and keep scanning.
      }
      consumed = index + 1;
      start = -1;
    }

    if (start >= 0) this.#buffer = this.#buffer.slice(start);
    else if (consumed) this.#buffer = this.#buffer.slice(consumed);
    else if (this.#buffer.length === MAX_OUTPUT_LENGTH) this.#buffer = "";
    return values;
  }
}

export function allocateLoopbackPort({ host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref?.();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not allocate a local port for serve-sim"));
        else resolve(port);
      });
    });
  });
}

function commandError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function appendOutput(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_OUTPUT_LENGTH);
}

export class ServeSimManager extends EventEmitter {
  #sessions = new Map();
  #simulatorOwners = new Map();
  #spawn;
  #allocatePort;
  #command;
  #packageSpec;
  #readyTimeoutMs;
  #stopTimeoutMs;
  #cleanupTimeoutMs;
  #now;
  #environment;

  constructor({
    spawnImpl = spawn,
    allocatePort = allocateLoopbackPort,
    command = "npx",
    packageSpec = SERVE_SIM_PACKAGE_SPEC,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    now = () => new Date().toISOString(),
    environment = process.env
  } = {}) {
    super();
    this.#spawn = spawnImpl;
    this.#allocatePort = allocatePort;
    this.#command = command;
    this.#packageSpec = packageSpec;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#now = now;
    this.#environment = environment;
  }

  snapshot(workspaceId) {
    return publicSession(this.#sessions.get(workspaceId));
  }

  list() {
    return [...this.#sessions.values()].map(publicSession);
  }

  start({ workspaceId, simulatorUdid, port = null, signal = null }) {
    const ownerId = requiredString(workspaceId, "Preview workspace");
    const udid = requiredString(simulatorUdid, "Simulator UDID");
    if (this.#sessions.has(ownerId)) throw new Error("Preview workspace already owns a serve-sim session");
    const existingOwner = this.#simulatorOwners.get(udid);
    if (existingOwner) throw new Error(`Simulator ${udid} is already streamed by Preview workspace ${existingOwner}`);
    if (signal && typeof signal.addEventListener !== "function") throw new Error("serve-sim signal must be an AbortSignal");

    const timestamp = this.#now();
    const record = {
      workspaceId: ownerId,
      simulatorUdid: udid,
      status: "allocating",
      port: port === null ? null : validatePort(port),
      previewUrl: null,
      streamUrl: null,
      pid: null,
      error: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      stdout: "",
      stderr: "",
      child: null,
      commandChildren: new Set(),
      decoder: new JsonObjectDecoder(),
      ready: false,
      exited: false,
      stopRequested: false,
      stopPromise: null,
      exitPromise: null,
      resolveExit: null,
      rejectReady: null,
      abortSignal: signal,
      abortListener: null
    };
    this.#sessions.set(ownerId, record);
    this.#simulatorOwners.set(udid, ownerId);
    if (signal) {
      record.abortListener = () => void this.stop(ownerId, String(signal.reason ?? "serve-sim start aborted"));
      signal.addEventListener("abort", record.abortListener, { once: true });
    }
    record.startPromise = this.#startRecord(record);
    return record.startPromise;
  }

  stop(workspaceId, reason = "serve-sim stopped") {
    const record = this.#sessions.get(workspaceId);
    if (!record) return Promise.resolve(null);
    return this.#ensureStop(record, { reason });
  }

  async stopAll(reason = "Pixice is shutting down") {
    return Promise.all([...this.#sessions.keys()].map((workspaceId) => this.stop(workspaceId, reason)));
  }

  async #startRecord(record) {
    try {
      if (record.abortSignal?.aborted) throw commandError("serve-sim start was aborted", "SERVE_SIM_ABORTED");
      if (record.port === null) record.port = validatePort(await this.#allocatePort({
        workspaceId: record.workspaceId,
        simulatorUdid: record.simulatorUdid
      }));
      if (record.stopRequested) throw commandError("serve-sim start was stopped", "SERVE_SIM_ABORTED");

      this.#setStatus(record, "cleaning", { message: `Cleaning stale stream for ${record.simulatorUdid}` });
      await this.#runScopedCleanup(record, { bestEffort: true, track: true });
      if (record.stopRequested) throw commandError("serve-sim start was stopped", "SERVE_SIM_ABORTED");

      this.#setStatus(record, "starting", { message: `Starting Simulator preview on port ${record.port}` });
      const readyPromise = new Promise((resolve, reject) => {
        record.resolveReady = resolve;
        record.rejectReady = reject;
      });
      record.exitPromise = new Promise((resolve) => { record.resolveExit = resolve; });
      const args = ["--yes", this.#packageSpec, "--quiet", "--port", String(record.port), record.simulatorUdid];
      let child;
      try {
        child = this.#spawn(this.#command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: this.#environment
        });
      } catch (error) {
        throw commandError(`Could not start serve-sim: ${error.message}`, "SERVE_SIM_SPAWN_FAILED", { cause: error });
      }
      record.child = child;
      this.#wireMainProcess(record, child);

      const readiness = await this.#withTimeout(
        readyPromise,
        this.#readyTimeoutMs,
        () => commandError(`serve-sim did not become ready within ${Math.round(this.#readyTimeoutMs / 1000)} seconds`, "SERVE_SIM_READY_TIMEOUT")
      );
      if (record.stopRequested) throw commandError("serve-sim start was stopped", "SERVE_SIM_ABORTED");
      if (record.exited) throw this.#exitError(record, record.child?.exitCode, record.child?.signalCode);
      record.ready = true;
      record.previewUrl = readiness.previewUrl;
      record.streamUrl = readiness.streamUrl;
      record.port = readiness.port;
      record.pid = readiness.pid ?? child.pid ?? null;
      this.#setStatus(record, "ready", { message: `Simulator preview is ready at ${record.previewUrl}` });
      return publicSession(record);
    } catch (error) {
      const normalized = error?.code ? error : commandError(error?.message ?? String(error), "SERVE_SIM_START_FAILED", { cause: error });
      if (!record.stopPromise) await this.#ensureStop(record, { reason: "serve-sim failed to start", failure: normalized });
      else await record.stopPromise;
      throw normalized;
    }
  }

  #wireMainProcess(record, child) {
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      record.stdout = appendOutput(record.stdout, text);
      this.#emitLog(record, "stdout", text);
      for (const message of record.decoder.push(text)) {
        const readiness = parseServeSimReadiness(message, { expectedUdid: record.simulatorUdid });
        if (readiness && !record.ready && record.rejectReady) {
          const resolve = record.resolveReady;
          record.resolveReady = null;
          record.rejectReady = null;
          resolve(readiness);
          break;
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      record.stderr = appendOutput(record.stderr, text);
      this.#emitLog(record, "stderr", text);
    });
    child.once("error", (error) => {
      if (record.rejectReady) {
        const reject = record.rejectReady;
        record.resolveReady = null;
        record.rejectReady = null;
        reject(commandError(`Could not start serve-sim: ${error.message}`, "SERVE_SIM_SPAWN_FAILED", { cause: error }));
      }
    });
    child.once("exit", (code, signal) => {
      record.exited = true;
      record.resolveExit?.({ code, signal });
      if (record.rejectReady) {
        const reject = record.rejectReady;
        record.resolveReady = null;
        record.rejectReady = null;
        reject(this.#exitError(record, code, signal));
      } else if (record.ready && !record.stopRequested && !record.stopPromise) {
        const failure = this.#exitError(record, code, signal);
        void this.#ensureStop(record, { reason: "serve-sim exited unexpectedly", failure });
      }
    });
  }

  #exitError(record, code, signal) {
    const output = `${record.stderr}\n${record.stdout}`.trim();
    if (/EADDRINUSE|address already in use|port[^\n]*in use/i.test(output)) {
      return commandError(`serve-sim could not bind preview port ${record.port}`, "SERVE_SIM_PORT_IN_USE", {
        port: record.port,
        exitCode: code,
        signal
      });
    }
    const detail = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    return commandError(detail || `serve-sim exited before it was ready (${code ?? signal ?? "unknown"})`, "SERVE_SIM_EXITED", {
      exitCode: code,
      signal
    });
  }

  #ensureStop(record, options) {
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = this.#stopRecord(record, options);
    return record.stopPromise;
  }

  async #stopRecord(record, { reason, failure = null }) {
    record.stopRequested = true;
    this.#setStatus(record, "stopping", { message: reason });
    if (record.rejectReady) {
      const reject = record.rejectReady;
      record.resolveReady = null;
      record.rejectReady = null;
      reject(failure ?? commandError(reason, "SERVE_SIM_ABORTED"));
    }

    const failures = failure ? [failure.message] : [];
    for (const child of record.commandChildren) {
      try {
        await this.#terminateChild(child, this.#stopTimeoutMs);
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (record.child && !record.exited && !exited(record.child)) {
      try {
        await this.#terminateChild(record.child, this.#stopTimeoutMs, record.exitPromise);
      } catch (error) {
        failures.push(error.message);
      }
    }
    try {
      await this.#runScopedCleanup(record, { bestEffort: false, track: false });
    } catch (error) {
      failures.push(error.message);
    }

    if (record.abortSignal && record.abortListener) {
      record.abortSignal.removeEventListener("abort", record.abortListener);
    }
    this.#sessions.delete(record.workspaceId);
    if (this.#simulatorOwners.get(record.simulatorUdid) === record.workspaceId) {
      this.#simulatorOwners.delete(record.simulatorUdid);
    }
    record.error = failures.length ? [...new Set(failures)].join("\n") : null;
    this.#setStatus(record, failures.length ? "failed" : "stopped", { message: record.error ?? reason });
    return publicSession(record);
  }

  async #runScopedCleanup(record, { bestEffort, track }) {
    const args = ["--yes", this.#packageSpec, "--kill", record.simulatorUdid, "--quiet"];
    let child;
    try {
      child = this.#spawn(this.#command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: this.#environment
      });
    } catch (error) {
      if (bestEffort) {
        this.#emitLog(record, "stderr", `Scoped serve-sim cleanup could not start: ${error.message}\n`);
        return;
      }
      throw commandError(`Scoped serve-sim cleanup could not start: ${error.message}`, "SERVE_SIM_CLEANUP_FAILED", { cause: error });
    }
    if (track) record.commandChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendOutput(stdout, text);
      this.#emitLog(record, "stdout", text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendOutput(stderr, text);
      this.#emitLog(record, "stderr", text);
    });
    try {
      const result = await this.#waitForCommand(child, this.#cleanupTimeoutMs);
      if (result.code !== 0 && !bestEffort) {
        throw commandError((stderr || stdout || `Scoped serve-sim cleanup exited with ${result.code ?? result.signal}`).trim(), "SERVE_SIM_CLEANUP_FAILED", {
          exitCode: result.code,
          signal: result.signal
        });
      }
    } catch (error) {
      if (!bestEffort) throw error;
      this.#emitLog(record, "stderr", `Scoped serve-sim cleanup warning: ${error.message}\n`);
    } finally {
      record.commandChildren.delete(child);
    }
  }

  async #waitForCommand(child, timeoutMs) {
    if (exited(child)) return { code: child.exitCode, signal: child.signalCode };
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    const errorPromise = new Promise((_, reject) => {
      child.once("error", (error) => reject(commandError(error.message, "SERVE_SIM_COMMAND_FAILED", { cause: error })));
    });
    try {
      return await this.#withTimeout(Promise.race([exitPromise, errorPromise]), timeoutMs, () => commandError(
        `serve-sim command timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        "SERVE_SIM_COMMAND_TIMEOUT"
      ));
    } catch (error) {
      if (!exited(child)) child.kill?.("SIGKILL");
      throw error;
    }
  }

  async #terminateChild(child, timeoutMs, knownExitPromise = null) {
    if (exited(child)) return;
    const exitPromise = knownExitPromise ?? new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill?.("SIGTERM");
    const graceful = await this.#raceTimeout(exitPromise, timeoutMs);
    if (graceful.completed) return;
    child.kill?.("SIGKILL");
    const forced = await this.#raceTimeout(exitPromise, timeoutMs);
    if (!forced.completed) throw commandError("serve-sim did not exit after SIGKILL", "SERVE_SIM_STOP_TIMEOUT");
  }

  #setStatus(record, status, extra = {}) {
    record.status = status;
    record.updatedAt = this.#now();
    this.emit("status", { ...publicSession(record), ...extra });
  }

  #emitLog(record, stream, text) {
    this.emit("log", {
      workspaceId: record.workspaceId,
      simulatorUdid: record.simulatorUdid,
      stream,
      text,
      at: this.#now()
    });
  }

  async #withTimeout(promise, timeoutMs, createError) {
    const result = await this.#raceTimeout(promise, timeoutMs);
    if (!result.completed) throw createError();
    return result.value;
  }

  #raceTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve({ completed: false }), timeoutMs);
      timeout.unref?.();
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timeout);
          resolve({ completed: true, value });
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }
}
