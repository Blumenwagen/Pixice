import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonlClient } from "./jsonl-client.mjs";
import { CapabilityAdapter, normalizeCodexEvent } from "./capability-adapter.mjs";

export class CodexRuntime extends EventEmitter {
  #client = null;
  #process = null;
  #initialized = false;
  #restartAttempt = 0;
  #stopping = false;
  #capabilities = new CapabilityAdapter();

  constructor({ resourcesPath, clientVersion }) {
    super();
    this.resourcesPath = resourcesPath;
    this.clientVersion = clientVersion;
  }

  get connected() { return this.#initialized; }

  async start() {
    if (this.#process) return this.connected;
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
    this.#process = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#client = new JsonlClient({ input: this.#process.stdin, output: this.#process.stdout });
    this.#client.on("notification", (event) => this.emit("event", normalizeCodexEvent(event)));
    this.#client.on("server-request", (event) => this.emit("server-request", event));
    this.#client.on("protocol-error", (event) => this.emit("recoverable-error", { code: "protocol_error", message: event.error.message }));
    this.#process.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    this.#process.once("error", (error) => this.emit("recoverable-error", { code: "runtime_spawn_failed", message: error.message }));
    this.#process.once("exit", (code, signal) => this.#handleExit(code, signal));

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
      this.#initialized = false;
      this.emit("status", { state: "error", message: error.message });
      this.emit("recoverable-error", { code: "initialization_failed", message: error.message });
      this.#process.kill();
      return false;
    }
  }

  request(method, params) {
    if (!this.#client) throw new Error("Codex runtime is not connected");
    return this.#capabilities.request(this.#client, method, params);
  }

  respond(id, result) {
    if (!this.#client) throw new Error("Codex runtime is not connected");
    this.#client.respond(id, result);
  }

  async stop() {
    this.#stopping = true;
    this.#initialized = false;
    this.#process?.kill("SIGTERM");
    this.#client = null;
    this.#process = null;
    this.emit("status", { state: "stopped" });
  }

  #resolveBinary() {
    if (process.env.LOOM_CODEX_PATH && existsSync(process.env.LOOM_CODEX_PATH)) return process.env.LOOM_CODEX_PATH;
    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "codex.exe" : "codex";
    const candidate = path.join(this.resourcesPath, "runtime", key, filename);
    if (existsSync(candidate)) return candidate;
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      const installed = path.join(directory, filename);
      if (existsSync(installed)) return installed;
    }
    return null;
  }

  #handleExit(code, signal) {
    this.#initialized = false;
    this.#client = null;
    this.#process = null;
    if (this.#stopping) return;
    this.emit("status", { state: "reconnecting", message: `Codex stopped (${code ?? signal})` });
    this.emit("recoverable-error", { code: "runtime_exited", message: `Codex stopped (${code ?? signal})` });
    const delay = Math.min(1000 * 2 ** this.#restartAttempt++, 15_000);
    setTimeout(() => this.start(), delay);
  }
}
