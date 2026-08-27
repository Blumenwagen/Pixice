import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../electron/providers/codex-provider.mjs";

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.request = vi.fn();
    this.setExecutablePath = vi.fn((value) => { this.executablePath = value; });
  }
  async start() { this.connected = true; return true; }
  async stop() { this.connected = false; }
  respond() {}
}

class FakeLifecycle extends EventEmitter {
  constructor() {
    super();
    this.state = {
      installed: true,
      executablePath: "/tools/codex",
      compatible: true,
      health: { state: "healthy" },
      actions: { install: false, locate: true, repair: true, login: true, logout: true }
    };
    this.logoutCommand = vi.fn().mockResolvedValue({ code: 0 });
  }
  async discover() { return this.state; }
  snapshot() { return this.state; }
}

describe("Codex provider lifecycle", () => {
  it("starts the external CLI selected by provider discovery", async () => {
    const runtime = new FakeRuntime();
    const provider = new CodexProvider(runtime, { runtimeLifecycle: new FakeLifecycle(), environment: {} });

    await expect(provider.start()).resolves.toBe(true);
    expect(runtime.setExecutablePath).toHaveBeenCalledWith("/tools/codex");
    expect(provider.connected).toBe(true);
  });

  it("does not claim it can clear environment-managed Codex credentials", async () => {
    const runtime = new FakeRuntime();
    runtime.connected = true;
    runtime.request.mockResolvedValue({ account: { type: "apiKey" }, authenticated: true });
    const provider = new CodexProvider(runtime, {
      runtimeLifecycle: new FakeLifecycle(),
      environment: { CODEX_ACCESS_TOKEN: "present" }
    });

    await expect(provider.logout()).resolves.toMatchObject({ loggedOut: false, externallyManagedAuth: true });
    expect(runtime.request).toHaveBeenCalledTimes(1);
  });

  it("does not confuse a shell API key with Codex's selected stored account", async () => {
    const runtime = new FakeRuntime();
    runtime.connected = true;
    runtime.request
      .mockResolvedValueOnce({ account: { type: "chatgpt" }, authenticated: true, authMode: "chatgpt" })
      .mockResolvedValueOnce({});
    const provider = new CodexProvider(runtime, {
      runtimeLifecycle: new FakeLifecycle(),
      environment: { OPENAI_API_KEY: "available-to-shell" }
    });

    await expect(provider.logout()).resolves.toEqual({ loggedOut: true, externallyManagedAuth: false });
    expect(runtime.request).toHaveBeenNthCalledWith(2, "account/logout", {});
  });

  it("does not claim an environment API key was cleared when Codex selected it", async () => {
    const runtime = new FakeRuntime();
    runtime.connected = true;
    runtime.request.mockResolvedValue({ account: { type: "apiKey" }, authenticated: true });
    const provider = new CodexProvider(runtime, {
      runtimeLifecycle: new FakeLifecycle(),
      environment: { OPENAI_API_KEY: "available-to-shell" }
    });

    await expect(provider.logout()).resolves.toMatchObject({ loggedOut: false, externallyManagedAuth: true });
    expect(runtime.request).toHaveBeenCalledTimes(1);
  });

  it("logs out stored Codex credentials through app-server and falls back to the external CLI", async () => {
    const runtime = new FakeRuntime();
    runtime.connected = true;
    runtime.request
      .mockResolvedValueOnce({ account: { type: "chatgpt" }, authenticated: true })
      .mockRejectedValueOnce(new Error("Older app-server"));
    const lifecycle = new FakeLifecycle();
    const provider = new CodexProvider(runtime, { runtimeLifecycle: lifecycle, environment: {} });

    await expect(provider.logout()).resolves.toEqual({ loggedOut: true, externallyManagedAuth: false });
    expect(runtime.request).toHaveBeenNthCalledWith(2, "account/logout", {});
    expect(lifecycle.logoutCommand).toHaveBeenCalledOnce();
  });
});
