import { EventEmitter } from "node:events";
import { constants, accessSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonlClient } from "./jsonl-client.mjs";
import { CapabilityAdapter, normalizeCodexEvent } from "./capability-adapter.mjs";
import { inspectVoiceProtocol } from "./voice-protocol.mjs";

export function codexAppServerArgs(developerInstructions = "") {
  const instructions = String(developerInstructions).trim();
  const args = instructions ? ["--config", `developer_instructions=${JSON.stringify(instructions)}`] : [];
  args.push("app-server");
  return args;
}

export class CodexRuntime extends EventEmitter {
  #client = null;
  #process = null;
  #initialized = false;
  #restartAttempt = 0;
  #restartTimer = null;
  #stopping = false;
  #capabilities = new CapabilityAdapter();
  #voiceSupport = {};
  #voiceVerification = null;
  #voicePrivate = false;
  #executableIdentity = null;

  constructor({ executablePath = null, clientVersion, developerInstructionsPath = null, environment = process.env, spawnProcess = spawn, inspectVoiceSupport = inspectVoiceProtocol }) {
    super();
    this.executablePath = executablePath;
    this.clientVersion = clientVersion;
    this.developerInstructionsPath = developerInstructionsPath;
    this.environment = environment;
    this.spawnProcess = spawnProcess;
    this.inspectVoiceSupport = inspectVoiceSupport;
  }

  get connected() { return this.#initialized; }
  get voiceCapabilities() { return this.#voiceSupport; }

  async verifyVoiceSupport() {
    if (!this.connected) throw Object.assign(new Error('The native Codex runtime is disconnected'), { code: 'voice_runtime_unavailable' });
    const client = this.#client;
    if (this.#binaryIdentity() !== this.#executableIdentity) throw Object.assign(new Error('The Codex executable changed. Restart its runtime explicitly before starting voice.'), { code: 'voice_runtime_changed' });
    if (!this.#voiceVerification) this.#voiceVerification = this.inspectVoiceSupport(this.executablePath, this.environment);
    const support = await this.#voiceVerification;
    if (!this.connected || client !== this.#client || this.#binaryIdentity() !== this.#executableIdentity) throw Object.assign(new Error('Codex changed during voice protocol verification'), { code: 'voice_runtime_changed' });
    this.#voiceSupport = support;
    return support;
  }

  setExecutablePath(executablePath) {
    if (this.#process) throw new Error("Stop Codex before changing its executable");
    this.executablePath = executablePath;
  }

  async start() {
    if (this.#process) return this.connected;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const executablePath = this.#resolveExecutable();
    if (!executablePath) {
      const error = new Error("Codex CLI is unavailable. Install Codex or locate an existing executable in Settings.");
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "runtime_missing", message: error.message });
      return false;
    }

    let args;
    try {
      args = codexAppServerArgs(
        this.developerInstructionsPath ? readFileSync(this.developerInstructionsPath, "utf8") : ""
      );
    } catch (error) {
      const message = `Pixice runtime instructions are unavailable: ${error.message}`;
      this.emit("status", { state: "error", message });
      this.emit("recoverable-error", { code: "developer_instructions_unavailable", message });
      return false;
    }

    this.#stopping = false;
    this.#initialized = false;
    this.#voiceSupport = {}; this.#voiceVerification = null; this.#voicePrivate = false;
    this.emit("status", { state: "connecting" });
    const executableDirectory = path.dirname(executablePath);
    const inheritedPath = this.environment.PATH ?? this.environment.Path ?? this.environment.path ?? "";
    const childEnvironment = { ...this.environment };
    delete childEnvironment.Path;
    delete childEnvironment.path;
    childEnvironment.PATH = [executableDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
    this.#executableIdentity = this.#binaryIdentity();
    const child = this.spawnProcess(executablePath, args, {
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.#process = child;
    this.#client = new JsonlClient({ input: child.stdin, output: child.stdout });
    this.#client.on("notification", (event) => {
      const normalized = normalizeCodexEvent(event);
      // Realtime negotiation and transcripts never enter provider snapshots,
      // project broadcasts, Connect replay, history or diagnostic listeners.
      this.emit(event.method?.startsWith('thread/realtime/') ? 'voice-event' : 'event', normalized);
    });
    this.#client.on("server-request", (event) => this.emit("server-request", event));
    this.#client.on("protocol-error", () => this.emit("recoverable-error", { code: "protocol_error", message: 'Codex returned an invalid protocol message' }));
    child.stderr.on("data", (chunk) => { if (!this.#voicePrivate) this.emit("diagnostic", chunk.toString()); });
    child.once("error", (error) => this.#handleSpawnError(child, error));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));

    try {
      const initialized = await this.#client.request("initialize", {
        clientInfo: { name: "pixice", title: "Pixice", version: this.clientVersion },
        capabilities: { experimentalApi: true, requestAttestation: false }
      });
      this.#capabilities = new CapabilityAdapter({ experimentalApi: true });
      this.#client.notify("initialized");
      this.#initialized = true;
      this.#restartAttempt = 0;
      this.emit("status", { state: "ready", ...initialized });
      this.emit("ready", initialized);
      return true;
    } catch (error) {
      if (this.#process !== child) return false;
      this.#initialized = false;
      this.emit("status", { state: "error", message: error.message });
      this.emit("recoverable-error", { code: "initialization_failed", message: error.message });
      child.kill();
      return false;
    }
  }

  request(method, params) {
    if (!this.connected || !this.#client) throw new Error("Codex runtime is not connected");
    if (method?.startsWith('thread/realtime/')) {
      if (this.#voiceSupport.experimentalApi !== true) throw new Error('Native voice protocol has not been verified');
      // Stderr may contain negotiation data. Keep it private for this process
      // after voice starts, including late output after a successful stop.
      if (method === 'thread/realtime/start') this.#voicePrivate = true;
    }
    return this.#capabilities.request(this.#client, method, params);
  }

  respond(id, result) {
    if (!this.connected || !this.#client) throw new Error("Codex runtime is not connected");
    this.#client.respond(id, result);
  }

  async stop() {
    this.#stopping = true;
    this.#initialized = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#process;
    this.#client = null;
    this.#process = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    this.emit("status", { state: "stopped" });
  }

  #resolveExecutable() {
    if (!this.executablePath || !path.isAbsolute(this.executablePath)) return null;
    try {
      accessSync(this.executablePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return this.executablePath;
    } catch {
      return null;
    }
  }

  #binaryIdentity() {
    try {
      const resolved = realpathSync(this.executablePath);
      const stat = statSync(resolved, { bigint: true });
      return [resolved, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch { return null; }
  }

  #handleSpawnError(child, error) {
    if (this.#process !== child) return;
    this.#initialized = false;
    this.#client = null;
    this.#process = null;
    this.emit("status", { state: "error", message: error.message });
    this.emit("recoverable-error", { code: "runtime_spawn_failed", message: error.message });
    this.#scheduleRestart();
  }

  #handleExit(child, code, signal) {
    if (this.#process !== child) return;
    this.#initialized = false;
    this.#client = null;
    this.#process = null;
    if (this.#stopping) return;
    this.emit("status", { state: "reconnecting", message: `Codex stopped (${code ?? signal})` });
    this.emit("recoverable-error", { code: "runtime_exited", message: `Codex stopped (${code ?? signal})` });
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#stopping || this.#restartTimer) return;
    const delay = Math.min(1000 * 2 ** this.#restartAttempt++, 15_000);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.start();
    }, delay);
  }
}
