import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubCli, prependGitHubCliToPath, resolveGitHubCli } from "../electron/github/github-cli.mjs";

const directories = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function executable(directory, name = "gh") {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, "#!/bin/sh\n", "utf8");
  chmodSync(file, 0o755);
  return file;
}

function childProcess({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("exit", code, null);
  });
  return child;
}

describe("GitHub CLI integration", () => {
  it("prefers the bundled executable and places it on the agent PATH", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pixice-github-"));
    directories.push(root);
    const bundled = executable(path.join(root, "runtime", "darwin-arm64", "bin"));
    const resolved = resolveGitHubCli({ resourcesPath: root, platform: "darwin", arch: "arm64", pathValue: "" });
    const environment = { PATH: "/usr/bin" };

    expect(resolved).toEqual({ path: bundled, source: "bundled" });
    expect(prependGitHubCliToPath(environment, resolved).PATH).toBe(`${path.dirname(bundled)}${path.delimiter}/usr/bin`);
  });

  it("reports the active GitHub account without returning its token", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "--version"
      ? { stdout: "gh version 2.80.0 (2026-07-01)\n", stderr: "" }
      : { stdout: JSON.stringify({ login: "octocat", name: "The Octocat", avatarUrl: "https://example.test/octocat.png" }), stderr: "" });
    const github = new GitHubCli({ resolved: { path: "/runtime/bin/gh", source: "bundled" }, run });

    await expect(github.status()).resolves.toEqual({
      available: true,
      authenticated: true,
      source: "bundled",
      version: "2.80.0",
      account: { login: "octocat", name: "The Octocat", avatarUrl: "https://example.test/octocat.png" },
      message: "Signed in as octocat."
    });
  });

  it("runs browser login, surfaces the device code, and verifies the account", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "--version"
      ? { stdout: "gh version 2.80.0\n", stderr: "" }
      : { stdout: JSON.stringify({ login: "octocat", name: null, avatarUrl: null }), stderr: "" });
    const spawn = vi.fn(() => childProcess({ stderr: "First copy your one-time code: ABCD-EFGH\nOpening github.com in your browser.\n" }));
    const github = new GitHubCli({ resolved: { path: "/runtime/bin/gh", source: "bundled" }, run, spawn });
    const updates = [];
    github.on("progress", (event) => updates.push(event));

    const status = await github.login();

    expect(spawn).toHaveBeenCalledWith("/runtime/bin/gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"], expect.any(Object));
    expect(updates).toContainEqual({ state: "waiting", code: "ABCD-EFGH", message: "Enter ABCD-EFGH in the GitHub window." });
    expect(status.authenticated).toBe(true);
  });
});
