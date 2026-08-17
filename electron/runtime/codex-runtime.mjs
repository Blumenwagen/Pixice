import { EventEmitter } from "node:events";
import { constants, existsSync, readFileSync, accessSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonlClient } from "./jsonl-client.mjs";
import { CapabilityAdapter, normalizeCodexEvent } from "./capability-adapter.mjs";

export class CodexRuntime extends EventEmitter {
  #client = null;
  #process = null;
  #initialized = false;
  #restartAttempt = 0;
  #restartTimer = null;
  #stopping = false;
  #capabilities = new CapabilityAdapter();

  constructor({ resourcesPath, clientVersion, allowDevelopmentRuntime = true }) {
    super();
    this.resourcesPath = resourcesPath;
    this.clientVersion = clientVersion;
    this.allowDevelopmentRuntime = allowDevelopmentRuntime;
  }

  get connected() { return this.#initialized; }

  async start() {
    if (this.#process) return this.connected;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const binary = this.#resolveBinary();
    if (!binary) {
      const error = new Error("Bundled Codex runtime is unavailable. Set LOOM_CODEX_PATH for development.");
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "runtime_missing", message: error.message });
      return false;
    }

    this.#stopping = false;
    this.#initialized = false;
    this.emit("status", { state: "connecting" });
    const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#process = child;
    this.#client = new JsonlClient({ input: child.stdin, output: child.stdout });
    this.#client.on("notification", (event) => this.emit("event", normalizeCodexEvent(event)));
    this.#client.on("server-request", (event) => this.emit("server-request", event));
    this.#client.on("protocol-error", (event) => this.emit("recoverable-error", { code: "protocol_error", message: event.error.message }));
    child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    child.once("error", (error) => this.#handleSpawnError(child, error));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));

    try {
      const initialized = await this.#client.request("initialize", {
        clientInfo: { name: "loom", title: "Loom", version: this.clientVersion },
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

  #resolveBinary() {
    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "codex.exe" : "codex";
    const runtimeRoot = path.join(this.resourcesPath, "runtime");
    const manifestPath = path.join(runtimeRoot, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const entry = manifest.platforms?.[key];
        const expectedPath = `${key}/${filename}`;
        if (entry?.path === expectedPath && /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
          const candidate = path.join(runtimeRoot, entry.path);
          if (existsSync(candidate)) {
            if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
            const actual = createHash("sha256").update(readFileSync(candidate)).digest("hex");
            if (actual === entry.sha256) return candidate;
          }
        }
      } catch (error) {
        this.emit("diagnostic", `Bundled runtime validation failed: ${error.message}`);
      }
    }
    if (!this.allowDevelopmentRuntime) return null;
    if (process.env.LOOM_CODEX_PATH && existsSync(process.env.LOOM_CODEX_PATH)) return process.env.LOOM_CODEX_PATH;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      const installed = path.join(directory, filename);
      if (existsSync(installed)) return installed;
    }
    return null;
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
