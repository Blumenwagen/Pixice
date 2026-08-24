import { EventEmitter } from "node:events";
import { constants, existsSync, readFileSync, accessSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { JsonlClient } from "./jsonl-client.mjs";
import { CapabilityAdapter, normalizeCodexEvent } from "./capability-adapter.mjs";

export function codexAppServerArgs(developerInstructions = "", { direct = false } = {}) {
  const instructions = String(developerInstructions).trim();
  const args = instructions ? ["--config", `developer_instructions=${JSON.stringify(instructions)}`] : [];
  if (!direct) args.push("app-server");
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

  constructor({ resourcesPath, clientVersion, allowDevelopmentRuntime = true, developerInstructionsPath = null }) {
    super();
    this.resourcesPath = resourcesPath;
    this.clientVersion = clientVersion;
    this.allowDevelopmentRuntime = allowDevelopmentRuntime;
    this.developerInstructionsPath = developerInstructionsPath;
  }

  get connected() { return this.#initialized; }

  async start() {
    if (this.#process) return this.connected;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const resolvedRuntime = this.#resolveRuntime();
    if (!resolvedRuntime) {
      const error = new Error("Bundled Codex runtime is unavailable. Set LOOM_CODEX_PATH for development.");
      this.emit("status", { state: "unavailable", message: error.message });
      this.emit("recoverable-error", { code: "runtime_missing", message: error.message });
      return false;
    }

    let args;
    try {
      args = codexAppServerArgs(
        this.developerInstructionsPath ? readFileSync(this.developerInstructionsPath, "utf8") : "",
        { direct: resolvedRuntime.directAppServer }
      );
    } catch (error) {
      const message = `Pixice runtime instructions are unavailable: ${error.message}`;
      this.emit("status", { state: "error", message });
      this.emit("recoverable-error", { code: "developer_instructions_unavailable", message });
      return false;
    }

    this.#stopping = false;
    this.#initialized = false;
    this.emit("status", { state: "connecting" });
    const child = spawn(resolvedRuntime.binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

  #resolveRuntime() {
    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "codex-app-server.exe" : "codex-app-server";
    const codeModeHostFilename = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
    const runtimeRoot = path.join(this.resourcesPath, "runtime");
    const manifestPath = path.join(runtimeRoot, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const entry = manifest.platforms?.[key];
        const expectedPath = `${key}/bin/${filename}`;
        const expectedCodeModeHostPath = `${key}/bin/${codeModeHostFilename}`;
        if (
          manifest.schemaVersion === 2
          && manifest.runtimeKind === "app-server-package"
          && entry?.path === expectedPath
          && entry?.codeModeHostPath === expectedCodeModeHostPath
          && /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
          && /^[a-f0-9]{64}$/.test(entry.codeModeHostSha256 ?? "")
        ) {
          const candidate = path.join(runtimeRoot, entry.path);
          const codeModeHost = path.join(runtimeRoot, entry.codeModeHostPath);
          if (existsSync(candidate) && existsSync(codeModeHost)) {
            if (process.platform !== "win32") {
              accessSync(candidate, constants.X_OK);
              accessSync(codeModeHost, constants.X_OK);
            }
            const actual = createHash("sha256").update(readFileSync(candidate)).digest("hex");
            const actualCodeModeHost = createHash("sha256").update(readFileSync(codeModeHost)).digest("hex");
            if (actual === entry.sha256 && actualCodeModeHost === entry.codeModeHostSha256) {
              return { binary: candidate, directAppServer: true };
            }
          }
        }
      } catch (error) {
        this.emit("diagnostic", `Bundled runtime validation failed: ${error.message}`);
      }
    }
    if (!this.allowDevelopmentRuntime) return null;
    const developmentFilename = process.platform === "win32" ? "codex.exe" : "codex";
    if (process.env.LOOM_CODEX_PATH && existsSync(process.env.LOOM_CODEX_PATH)) {
      return { binary: process.env.LOOM_CODEX_PATH, directAppServer: false };
    }
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!directory) continue;
      const installed = path.join(directory, developmentFilename);
      if (existsSync(installed)) return { binary: installed, directAppServer: false };
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
