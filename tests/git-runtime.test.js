import { describe, expect, it, vi } from "vitest";
import {
  detectGitRuntime,
  gitExecutableCandidates,
  gitRuntimeFromError,
  requestCommandLineToolsInstall
} from "../electron/git/git-runtime.mjs";

describe("Git runtime discovery", () => {
  it("checks standalone Git before the macOS system stub", async () => {
    const run = vi.fn(async (command) => {
      if (command === "/opt/homebrew/bin/git") return { stdout: "git version 2.50.1\n", stderr: "" };
      throw new Error(`Unexpected command ${command}`);
    });

    const result = await detectGitRuntime({
      platform: "darwin",
      environment: { PATH: "/usr/bin:/opt/homebrew/bin" },
      homeDirectory: "/Users/test",
      executableCheck: (candidate) => ["/opt/homebrew/bin/git", "/usr/bin/git"].includes(candidate),
      run
    });

    expect(result).toMatchObject({ state: "ready", available: true, executablePath: "/opt/homebrew/bin/git", version: "git version 2.50.1" });
    expect(run).not.toHaveBeenCalledWith("/usr/bin/xcode-select", expect.anything(), expect.anything());
    expect(run).not.toHaveBeenCalledWith("/usr/bin/git", expect.anything(), expect.anything());
  });

  it("does not invoke Apple's Git stub when Command Line Tools are missing", async () => {
    const run = vi.fn(async (command, args) => {
      if (command === "/usr/bin/xcode-select" && args[0] === "-p") throw new Error("Unable to get active developer directory");
      throw new Error(`Unexpected command ${command}`);
    });

    const result = await detectGitRuntime({
      platform: "darwin",
      environment: { PATH: "/usr/bin" },
      homeDirectory: "/Users/test",
      executableCheck: (candidate) => candidate === "/usr/bin/git",
      run
    });

    expect(result).toMatchObject({ state: "command-line-tools-missing", available: false, installSupported: true });
    expect(run).not.toHaveBeenCalledWith("/usr/bin/git", expect.anything(), expect.anything());
  });

  it("reports missing Git without offering Apple's installer on other platforms", async () => {
    const result = await detectGitRuntime({
      platform: "linux",
      environment: { PATH: "" },
      homeDirectory: "/home/test",
      executableCheck: () => false,
      run: vi.fn()
    });

    expect(result).toMatchObject({ state: "missing", available: false, installSupported: false });
  });

  it("classifies missing executables and Command Line Tools failures", () => {
    expect(gitRuntimeFromError(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), { platform: "linux" })).toMatchObject({ state: "missing" });
    expect(gitRuntimeFromError(new Error("xcrun: error: invalid active developer path"), { platform: "darwin" })).toMatchObject({
      state: "command-line-tools-missing",
      installSupported: true
    });
    expect(gitRuntimeFromError(new Error("repository is corrupt"), { platform: "darwin" })).toBeNull();
  });

  it("opens Apple's installer only after the explicit install action", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const missing = {
      state: "command-line-tools-missing",
      available: false,
      installSupported: true,
      executablePath: null,
      version: null,
      message: "Missing"
    };

    const result = await requestCommandLineToolsInstall({ platform: "darwin", run, detect: vi.fn().mockResolvedValue(missing) });

    expect(run).toHaveBeenCalledWith("/usr/bin/xcode-select", ["--install"], expect.objectContaining({ timeout: 10_000 }));
    expect(result).toMatchObject({ state: "install-requested", installRequested: true, available: false });
  });

  it("deduplicates inherited and known Git paths", () => {
    const candidates = gitExecutableCandidates({
      platform: "darwin",
      environment: { PATH: "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin" },
      homeDirectory: "/Users/test"
    });
    expect(candidates.filter((candidate) => candidate === "/opt/homebrew/bin/git")).toHaveLength(1);
    expect(candidates.filter((candidate) => candidate === "/usr/bin/git")).toHaveLength(1);
  });
});
