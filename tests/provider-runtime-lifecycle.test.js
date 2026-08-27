import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderRuntimeLifecycle,
  PROVIDER_COMPATIBILITY,
  PROVIDER_RELEASE_CHANNELS,
  latestProviderVersion,
  officialProviderInstaller,
  providerCommandEnvironment,
  providerExecutableCandidates
} from "../electron/providers/provider-runtime-lifecycle.mjs";

const temporaryDirectories = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

class MemorySettings {
  constructor(settings = {}) {
    this.settings = structuredClone(settings);
  }
  getAppSettings() { return structuredClone(this.settings); }
  saveAppSettings(patch) {
    this.settings = { ...this.settings, ...structuredClone(patch) };
    return this.getAppSettings();
  }
}

function executable(directory, name) {
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, name);
  writeFileSync(filename, "test");
  chmodSync(filename, 0o755);
  return filename;
}

function successfulProbe(version) {
  return vi.fn(async (_command, args, options = {}) => {
    if (options.onOutput) options.onOutput({ stream: "stdout", text: "Downloading provider runtime\n" });
    if (args.includes("--version")) return { code: 0, stdout: `${version}\n`, stderr: "" };
    return { code: 0, stdout: "ok\n", stderr: "" };
  });
}

describe("external provider runtime lifecycle", () => {
  it("orders a saved absolute path before environment, known locations, and inherited PATH", () => {
    const home = path.join(tmpdir(), "pixice-provider-home");
    const candidates = providerExecutableCandidates({
      provider: "codex",
      savedPath: "/saved/codex",
      environment: { PIXICE_CODEX_PATH: "/environment/codex", PATH: "/path-bin" },
      homeDirectory: home,
      platform: "darwin"
    });

    expect(candidates.slice(0, 4)).toEqual([
      "/saved/codex",
      "/environment/codex",
      path.join(home, ".local", "bin", "codex"),
      path.join(home, ".codex", "bin", "codex")
    ]);
    expect(candidates).toContain("/opt/homebrew/bin/codex");
    expect(candidates.at(-1)).toBe("/path-bin/codex");
  });

  it("uses the Windows-style Path environment key as the final discovery source", () => {
    const candidates = providerExecutableCandidates({
      provider: "claude",
      environment: { Path: "/windows-path" },
      homeDirectory: "/home/test",
      platform: "win32"
    });

    expect(candidates.at(-2)).toBe("/windows-path/claude.exe");
    expect(candidates.at(-1)).toBe("/windows-path/claude.cmd");
  });

  it("discovers and persists an existing compatible executable without running an installer", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-discovery-"));
    temporaryDirectories.push(home);
    const saved = executable(path.join(home, "custom"), "codex");
    const database = new MemorySettings({ providerExecutablePaths: { codex: saved } });
    const commandRunner = successfulProbe("codex-cli 1.2.3");
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database,
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner
    });

    await expect(lifecycle.discover()).resolves.toMatchObject({
      installed: true,
      executablePath: saved,
      version: "codex-cli 1.2.3",
      compatible: true,
      health: { state: "healthy" }
    });
    expect(commandRunner).toHaveBeenNthCalledWith(1, saved, ["--version"], expect.any(Object));
    expect(commandRunner).toHaveBeenNthCalledWith(2, saved, ["app-server", "--help"], expect.any(Object));
  });

  it("keeps a discovered broken executable visible so repair remains available", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-broken-"));
    temporaryDirectories.push(home);
    const broken = executable(path.join(home, "custom"), "codex");
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database: new MemorySettings({ providerExecutablePaths: { codex: broken } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner: vi.fn().mockRejectedValue(new Error("app-server is unsupported"))
    });

    await expect(lifecycle.discover()).resolves.toMatchObject({
      installed: true,
      executablePath: broken,
      compatible: false,
      health: { state: "broken" },
      actions: { install: false, locate: true, repair: true, login: false, logout: false }
    });
  });

  it("keeps a stale saved absolute path visible as broken instead of pretending no setup existed", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-stale-"));
    temporaryDirectories.push(home);
    const stale = path.join(home, "removed", "codex");
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database: new MemorySettings({ providerExecutablePaths: { codex: stale } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner: successfulProbe("codex-cli 0.149.0")
    });

    await expect(lifecycle.discover()).resolves.toMatchObject({
      installed: true,
      executablePath: stale,
      compatible: false,
      health: { state: "broken" },
      actions: { install: false, locate: true, repair: true }
    });
  });

  it("rejects provider versions older than the tested protocol and SDK baselines", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-version-"));
    temporaryDirectories.push(home);
    const codex = executable(path.join(home, "codex"), "codex");
    const claude = executable(path.join(home, "claude"), "claude");
    const codexLifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database: new MemorySettings({ providerExecutablePaths: { codex } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner: successfulProbe("codex-cli 0.148.9")
    });
    const claudeLifecycle = new ProviderRuntimeLifecycle({
      provider: "claude",
      database: new MemorySettings({ providerExecutablePaths: { claude } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner: successfulProbe("2.1.233 (Claude Code)")
    });

    await expect(codexLifecycle.discover()).resolves.toMatchObject({
      version: "codex-cli 0.148.9",
      compatible: false,
      health: { state: "incompatible", message: expect.stringContaining(PROVIDER_COMPATIBILITY.codex.minimumVersion) }
    });
    await expect(claudeLifecycle.discover()).resolves.toMatchObject({
      version: "2.1.233 (Claude Code)",
      compatible: false,
      health: { state: "incompatible", message: expect.stringContaining(PROVIDER_COMPATIBILITY.claude.minimumVersion) }
    });
  });

  it("uses provider-owned installers only from explicit install and keeps provider paths independent", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-install-"));
    temporaryDirectories.push(home);
    const codexPath = executable(path.join(home, ".local", "bin"), "codex");
    const database = new MemorySettings({ providerExecutablePaths: { claude: "/kept/claude" } });
    const commandRunner = successfulProbe("codex-cli 2.0.0");
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database,
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner
    });

    expect(commandRunner).not.toHaveBeenCalled();
    await expect(lifecycle.install()).resolves.toMatchObject({
      installed: true,
      installState: { state: "succeeded" },
      executablePath: codexPath
    });
    expect(commandRunner.mock.calls[0][0]).toBe("/bin/sh");
    expect(commandRunner.mock.calls[0][1].join(" ")).toContain("https://chatgpt.com/codex/install.sh");
    expect(database.getAppSettings().providerExecutablePaths).toEqual({
      claude: "/kept/claude",
      codex: codexPath
    });
    database.saveAppSettings({ defaultModel: "codex:gpt-5.6-terra" });
    expect(database.getAppSettings().providerExecutablePaths).toEqual({
      claude: "/kept/claude",
      codex: codexPath
    });
  });

  it("reads current versions from each provider's official release channel", async () => {
    const codexFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "rust-v0.151.2" }) });
    const claudeFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "2.1.240\n" });

    await expect(latestProviderVersion("codex", { fetchImpl: codexFetch })).resolves.toBe("0.151.2");
    await expect(latestProviderVersion("claude", { fetchImpl: claudeFetch })).resolves.toBe("2.1.240");
    expect(codexFetch).toHaveBeenCalledWith(PROVIDER_RELEASE_CHANNELS.codex, expect.objectContaining({ cache: "no-store" }));
    expect(claudeFetch).toHaveBeenCalledWith(PROVIDER_RELEASE_CHANNELS.claude, expect.objectContaining({ cache: "no-store" }));
  });

  it("checks and updates Codex through the official installer only after an explicit update", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-codex-update-"));
    temporaryDirectories.push(home);
    const codexPath = executable(path.join(home, ".local", "bin"), "codex");
    let version = "codex-cli 0.149.0";
    const commandRunner = vi.fn(async (command, args) => {
      if (command === "/bin/sh") {
        version = "codex-cli 0.151.0";
        return { code: 0, stdout: "updated\n", stderr: "" };
      }
      if (args.includes("--version")) return { code: 0, stdout: `${version}\n`, stderr: "" };
      return { code: 0, stdout: "ok\n", stderr: "" };
    });
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "codex",
      database: new MemorySettings({ providerExecutablePaths: { codex: codexPath } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "rust-v0.151.0" }) })
    });

    await lifecycle.discover();
    await expect(lifecycle.checkForUpdate()).resolves.toMatchObject({
      updateState: { state: "available", availableVersion: "0.151.0" },
      actions: { update: true }
    });
    expect(commandRunner.mock.calls.some(([command]) => command === "/bin/sh")).toBe(false);
    await expect(lifecycle.update()).resolves.toMatchObject({
      version: "codex-cli 0.151.0",
      updateState: { state: "succeeded", availableVersion: null },
      compatible: true
    });
    expect(commandRunner.mock.calls.find(([command]) => command === "/bin/sh")?.[1].join(" ")).toContain("chatgpt.com/codex/install.sh");
  });

  it("updates Claude through its CLI and reports a package-manager failure without touching Codex", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-claude-update-"));
    temporaryDirectories.push(home);
    const claudePath = executable(path.join(home, ".local", "bin"), "claude");
    const commandRunner = vi.fn(async (_command, args) => {
      if (args.includes("--version")) return { code: 0, stdout: "2.1.234\n", stderr: "" };
      if (args[0] === "update") throw new Error("Homebrew installation requires brew upgrade claude-code");
      return { code: 0, stdout: "ok\n", stderr: "" };
    });
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "claude",
      database: new MemorySettings({ providerExecutablePaths: { claude: claudePath, codex: "/kept/codex" } }),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, text: async () => "2.1.240" })
    });

    await lifecycle.discover();
    await lifecycle.checkForUpdate();
    await expect(lifecycle.update()).rejects.toThrow(/brew upgrade/);
    expect(commandRunner).toHaveBeenCalledWith(claudePath, ["update"], expect.any(Object));
    expect(lifecycle.snapshot()).toMatchObject({ updateState: { state: "error", error: expect.stringContaining("brew upgrade") } });
    expect(lifecycle.database.getAppSettings().providerExecutablePaths.codex).toBe("/kept/codex");
  });

  it("uses the external Claude auth logout command and rejects relative locate paths", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pixice-provider-claude-"));
    temporaryDirectories.push(home);
    const claudePath = executable(path.join(home, ".local", "bin"), "claude");
    const commandRunner = successfulProbe("2.1.234");
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "claude",
      database: new MemorySettings(),
      environment: { PATH: "" },
      homeDirectory: home,
      platform: "darwin",
      commandRunner
    });
    await lifecycle.discover();

    await lifecycle.logoutCommand();
    expect(commandRunner).toHaveBeenLastCalledWith(claudePath, ["auth", "logout"], expect.any(Object));
    await expect(lifecycle.locate("claude")).rejects.toThrow(/must be absolute/);
  });

  it("defines official user-level installers for both providers on Unix and Windows", () => {
    expect(officialProviderInstaller("codex", "linux").args.join(" ")).toContain("chatgpt.com/codex/install.sh");
    expect(officialProviderInstaller("claude", "darwin").args.join(" ")).toContain("claude.ai/install.sh");
    expect(officialProviderInstaller("codex", "win32").args.join(" ")).toContain("chatgpt.com/codex/install.ps1");
    expect(officialProviderInstaller("claude", "win32").args.join(" ")).toContain("claude.ai/install.ps1");
    expect(officialProviderInstaller("codex", "freebsd")).toBeNull();
  });

  it("disables guessed automatic installers on undocumented platforms", async () => {
    const lifecycle = new ProviderRuntimeLifecycle({
      provider: "claude",
      database: new MemorySettings(),
      environment: { PATH: "" },
      homeDirectory: "/home/test",
      platform: "freebsd",
      commandRunner: successfulProbe("2.1.234")
    });

    await expect(lifecycle.discover()).resolves.toMatchObject({
      automaticInstallSupported: false,
      health: { state: "missing", message: expect.stringMatching(/manually/) },
      actions: { install: false, locate: true, repair: false }
    });
    await expect(lifecycle.install()).rejects.toThrow(/unavailable on this platform/);
  });

  it("lets an absolute npm-installed CLI resolve the sibling Node executable", () => {
    expect(providerCommandEnvironment("/Users/dev/.nvm/versions/node/v22/bin/codex", { PATH: "/usr/bin:/bin" }).PATH)
      .toBe(`/Users/dev/.nvm/versions/node/v22/bin${path.delimiter}/usr/bin:/bin`);
  });

  it("keeps Codex and the Claude platform binary out of packaged resources", () => {
    const builderConfig = require("../electron-builder.config.cjs");
    const claudeSdkPackage = require("../node_modules/@anthropic-ai/claude-agent-sdk/package.json");
    const resourceSources = builderConfig.extraResources.map((entry) => typeof entry === "string" ? entry : entry.from);

    expect(resourceSources).not.toContain("resources/runtime/manifest.json");
    expect(resourceSources.some((source) => String(source).includes("runtimeTarget"))).toBe(false);
    expect(existsSync(path.resolve("electron/updater/codex-updater.mjs"))).toBe(false);
    expect(existsSync(path.resolve("resources/runtime/manifest.json"))).toBe(false);
    expect(existsSync(path.resolve("scripts/sync-codex-runtime.mjs"))).toBe(false);
    expect(existsSync(path.resolve("scripts/verify-runtime.mjs"))).toBe(false);
    expect(builderConfig.files).toContain("!node_modules/@anthropic-ai/claude-agent-sdk-*/**/*");
    expect(PROVIDER_COMPATIBILITY.claude.minimumVersion).toBe(claudeSdkPackage.claudeCodeVersion);
  });
});
