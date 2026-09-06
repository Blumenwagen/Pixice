import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../electron/providers/claude-provider.mjs";

const providers = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createProvider(queryFactory) {
  const provider = new ClaudeProvider({ database: {}, queryFactory, environment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "test" } });
  providers.push(provider);
  await provider.start();
  return provider;
}

describe("Claude discovery resource limits", () => {
  it("coalesces bursts, serializes account/models/limits, and never submits an agent prompt", async () => {
    let running = 0;
    let maximum = 0;
    const directories = [];
    const queryFactory = vi.fn(({ prompt, options }) => {
      maximum = Math.max(maximum, ++running);
      directories.push(options.cwd);
      expect(readdirSync(options.cwd)).toEqual([]);
      expect(options.cwd).not.toBe(process.cwd());
      expect(prompt.values).toEqual([]);
      expect(options).toMatchObject({ tools: [], settingSources: [], plugins: [], skills: [], mcpServers: {}, strictMcpConfig: true, persistSession: false });
      expect(options.env.ANTHROPIC_API_KEY).toBe("test");
      expect(options.systemPrompt).toEqual(expect.any(String));
      const result = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 1));
      return {
        accountInfo: () => result({ email: "test@example.com" }),
        supportedModels: () => result([{ value: "sonnet" }]),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => result({ rate_limits_available: true }),
        close: () => { running -= 1; }
      };
    });
    const provider = await createProvider(queryFactory);
    const burst = () => Promise.all(Array.from({ length: 50 }, () => Promise.all([
      provider.account(), provider.request("model/list"), provider.usageLimits()
    ])));
    await burst();
    await burst();
    expect(queryFactory).toHaveBeenCalledTimes(3);
    expect(maximum).toBe(1);
    expect(running).toBe(0);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
  });

  it("waits for real subprocess exit before starting the next metadata read", async () => {
    let live = 0;
    let maximum = 0;
    const children = [];
    const provider = await createProvider(({ options }) => {
      const child = options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: options.cwd,
        env: process.env
      });
      children.push(child);
      maximum = Math.max(maximum, ++live);
      child.once("exit", () => { live -= 1; });
      return {
        accountInfo: async () => ({ email: "test@example.com" }),
        supportedModels: async () => [{ value: "sonnet" }],
        close: () => { setTimeout(() => child.kill(), 25); }
      };
    });
    await Promise.all([provider.account(), provider.request("model/list")]);
    expect(maximum).toBe(1);
    expect(live).toBe(0);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it("backs off after discovery failures and retries after the cooldown", async () => {
    let time = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const accountInfo = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ email: "test@example.com" });
    const queryFactory = vi.fn(() => ({ accountInfo, close: vi.fn() }));
    const provider = await createProvider(queryFactory);
    for (let i = 0; i < 20; i += 1) await expect(provider.account()).rejects.toThrow("offline");
    expect(queryFactory).toHaveBeenCalledTimes(1);
    time += 30_001;
    await expect(provider.account()).resolves.toMatchObject({ authenticated: true });
    expect(queryFactory).toHaveBeenCalledTimes(2);
  });

  it("cancels a stuck read and queued discovery on stop, then supports restart", async () => {
    let options;
    const close = vi.fn();
    const queryFactory = vi.fn((args) => {
      options = args.options;
      return { accountInfo: () => new Promise(() => {}), close };
    });
    const provider = await createProvider(queryFactory);
    const account = provider.account();
    const limits = provider.usageLimits();
    const settled = Promise.allSettled([account, limits]);
    await vi.waitFor(() => expect(queryFactory).toHaveBeenCalledOnce());
    await provider.stop();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(options.abortController.signal.aborted).toBe(true);
    expect(existsSync(options.cwd)).toBe(false);
    expect(queryFactory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    queryFactory.mockImplementation(() => ({ accountInfo: async () => ({ email: "new@example.com" }), close }));
    await provider.start();
    await expect(provider.account()).resolves.toMatchObject({ account: { email: "new@example.com" } });
    expect(queryFactory).toHaveBeenCalledTimes(2);
  });

  it("releases timed-out discovery and clears its timer without respawning on refresh", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const queryFactory = vi.fn(() => ({ accountInfo: () => new Promise(() => {}), close }));
    const provider = await createProvider(queryFactory);
    const result = expect(provider.account()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    await expect(provider.account()).rejects.toThrow("timed out");
    expect(queryFactory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes account metadata after sign-in without waiting for its cache", async () => {
    let authenticated = false;
    const accountInfo = vi.fn(async () => authenticated ? { email: "new@example.com" } : {});
    const provider = await createProvider(() => ({
      accountInfo,
      claudeAuthenticate: async () => ({ authUrl: "https://claude.ai/oauth/authorize" }),
      claudeOAuthWaitForCompletion: async () => { authenticated = true; },
      close: vi.fn()
    }));
    await expect(provider.account()).resolves.toMatchObject({ authenticated: false });
    await provider.login();
    await vi.waitFor(() => expect(provider.authSession).toBeNull());
    await expect(provider.account()).resolves.toMatchObject({ authenticated: true });
    expect(accountInfo).toHaveBeenCalledTimes(2);
  });
});
