import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonlClient } from "./jsonl-client.mjs";
import { CapabilityAdapter, normalizeCodexEvent } from "./capability-adapter.mjs";

export class CodexRuntime extends EventEmitter {
  #client = null;
  #process = null;
  #restartAttempt = 0;
  #stopping = false;
  #capabilities = new CapabilityAdapter();

  constructor({ resourcesPath, clientVersion }) {
    super();
    this.resourcesPath = resourcesPath;
    this.clientVersion = clientVersion;
  }

  get connected() { return Boolean(this.#client); }

  async start() {
    const binary = this.#resolveBinary();
    if (!binary) {
      const error = new Error("Bundled Codex runtime is unavailable. Set LOOM_CODEX_PATH for development.");
      this.emit("recoverable-error", { code: "runtime_missing", message: error.message });
      return false;
    }

    this.#stopping = false;
    this.#process = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#client = new JsonlClient({ input: this.#process.stdin, output: this.#process.stdout });
    this.#client.on("notification", (event) => this.emit("event", normalizeCodexEvent(event)));
    this.#client.on("server-request", (event) => this.emit("server-request", event));
    this.#client.on("protocol-error", (event) => this.emit("recoverable-error", { code: "protocol_error", message: event.error.message }));
    this.#process.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString()));
    this.#process.once("exit", (code, signal) => this.#handleExit(code, signal));

    try {
      const initialized = await this.#client.request("initialize", {
        clientInfo: { name: "loom", title: "Loom", version: this.clientVersion },
        capabilities: { experimentalApi: true }
      });
      this.#capabilities = new CapabilityAdapter(initialized?.capabilities ?? {});
      this.#client.notify("initialized");
      this.#restartAttempt = 0;
      this.emit("ready");
      return true;
    } catch (error) {
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
    this.#process?.kill("SIGTERM");
    this.#client = null;
    this.#process = null;
  }

  #resolveBinary() {
    if (process.env.LOOM_CODEX_PATH && existsSync(process.env.LOOM_CODEX_PATH)) return process.env.LOOM_CODEX_PATH;
    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "codex.exe" : "codex";
    const candidate = path.join(this.resourcesPath, "runtime", key, filename);
    return existsSync(candidate) ? candidate : null;
  }

  #handleExit(code, signal) {
    this.#client = null;
    this.#process = null;
    if (this.#stopping) return;
    this.emit("recoverable-error", { code: "runtime_exited", message: `Codex stopped (${code ?? signal})` });
    const delay = Math.min(1000 * 2 ** this.#restartAttempt++, 15_000);
    setTimeout(() => this.start(), delay);
  }
}
