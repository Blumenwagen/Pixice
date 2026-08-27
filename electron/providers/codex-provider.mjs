import { EventEmitter } from "node:events";

/**
 * Keeps the Codex app-server behind the same provider boundary used by Claude.
 * The adapter is intentionally thin: Codex remains the canonical implementation
 * while Pixice migrates its callers to provider-neutral operations.
 */
export class CodexProvider extends EventEmitter {
  constructor(runtime, { runtimeLifecycle = null, environment = process.env } = {}) {
    super();
    this.id = "codex";
    this.runtime = runtime;
    this.runtimeLifecycle = runtimeLifecycle;
    this.environment = environment;
    this.forwarders = new Map();
    for (const eventName of ["status", "event", "server-request", "recoverable-error", "diagnostic", "ready"]) {
      const forward = (payload) => this.emit(eventName, payload);
      this.forwarders.set(eventName, forward);
      runtime.on(eventName, forward);
    }
    this.runtimeLifecycle?.on("state", (state) => this.emit("lifecycle", state));
  }

  get connected() {
    return this.runtime.connected;
  }

  async start() {
    if (this.runtimeLifecycle) {
      const lifecycle = await this.runtimeLifecycle.discover();
      this.runtime.setExecutablePath(lifecycle.executablePath);
      if (!lifecycle.installed || !lifecycle.compatible) {
        this.emit("status", { state: "unavailable", message: lifecycle.health.message });
        return false;
      }
    }
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

  async account() {
    const result = await this.runtime.request("account/read", { refreshToken: false });
    return { ...result, externallyManagedAuth: this.#externallyManagedAuth(result) };
  }

  login() {
    return this.runtime.request("account/login/start", {
      type: "chatgpt",
      appBrand: "codex",
      useHostedLoginSuccessPage: true
    });
  }

  async logout() {
    const account = await this.account();
    if (account.externallyManagedAuth) {
      return {
        loggedOut: false,
        externallyManagedAuth: true,
        message: "Codex credentials come from the process environment or workload identity and must be cleared there."
      };
    }
    try {
      await this.runtime.request("account/logout", {});
    } catch (error) {
      if (!this.runtimeLifecycle) throw error;
      await this.runtimeLifecycle.logoutCommand();
    }
    return { loggedOut: true, externallyManagedAuth: false };
  }

  lifecycle() {
    return this.runtimeLifecycle?.snapshot() ?? {};
  }

  externallyManagedAuth() {
    return this.#externallyManagedAuth(null);
  }

  install() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.install());
  }

  locate(executablePath) {
    return this.#replaceRuntime(() => this.runtimeLifecycle.locate(executablePath));
  }

  repair() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.repair());
  }

  checkForUpdate() {
    if (!this.runtimeLifecycle) throw new Error("Codex update checks are unavailable");
    return this.runtimeLifecycle.checkForUpdate();
  }

  update() {
    return this.#replaceRuntime(() => this.runtimeLifecycle.update());
  }

  async refreshLifecycle() {
    const lifecycle = await this.runtimeLifecycle.discover();
    return { ...lifecycle, connected: this.connected };
  }

  async #replaceRuntime(operation) {
    if (!this.runtimeLifecycle) throw new Error("Codex runtime management is unavailable");
    const previousExecutablePath = this.runtime.executablePath;
    const wasConnected = this.connected;
    await this.runtime.stop();
    try {
      const lifecycle = await operation();
      this.runtime.setExecutablePath(lifecycle.executablePath);
      const connected = await this.runtime.start();
      return { ...this.runtimeLifecycle.snapshot(), connected };
    } catch (error) {
      this.runtime.setExecutablePath(previousExecutablePath);
      if (wasConnected && previousExecutablePath) await this.runtime.start();
      throw error;
    }
  }

  #externallyManagedAuth(result) {
    if (this.environment.CODEX_ACCESS_TOKEN) return true;
    const authMode = String(result?.authMode ?? result?.account?.authMode ?? "").toLowerCase();
    if (authMode.includes("workload") || authMode.includes("environment")) return true;
    const accountType = String(result?.account?.type ?? "").toLowerCase();
    return accountType === "apikey" && Boolean(this.environment.OPENAI_API_KEY);
  }
}
