import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexUpdater, compareCodexVersions, installAndActivateCodexUpdate } from "../electron/updater/codex-updater.mjs";

const temporaryDirectories = [];
const platform = "darwin";
const arch = "arm64";
const key = "darwin-arm64";
const target = "aarch64-apple-darwin";
const assetName = `codex-app-server-package-${target}.tar.gz`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeRuntime(resourcesPath, version, binaryBytes = Buffer.from(`codex-${version}`), hostBytes = Buffer.from(`host-${version}`)) {
  const packageRoot = path.join(resourcesPath, "runtime", key);
  const bin = path.join(packageRoot, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "codex-app-server"), binaryBytes, { mode: 0o755 });
  await writeFile(path.join(bin, "codex-code-mode-host"), hostBytes, { mode: 0o755 });
  await writeFile(path.join(packageRoot, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version,
    target,
    variant: "codex-app-server",
    entrypoint: "bin/codex-app-server",
    resourcesDir: "codex-resources",
    pathDir: "codex-path"
  }));
  await writeFile(path.join(resourcesPath, "runtime", "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    runtimeKind: "app-server-package",
    codexVersion: version,
    protocolVersion: `${version}-app-server`,
    channel: "latest",
    platforms: {
      [key]: {
        path: `${key}/bin/codex-app-server`,
        sha256: sha256(binaryBytes),
        codeModeHostPath: `${key}/bin/codex-code-mode-host`,
        codeModeHostSha256: sha256(hostBytes)
      }
    }
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexUpdater", () => {
  it("compares Codex release versions numerically", () => {
    expect(compareCodexVersions("0.149.1", "0.149.0")).toBe(1);
    expect(compareCodexVersions("0.149.0", "0.149.1")).toBe(-1);
    expect(compareCodexVersions("0.149.0", "0.149.0")).toBe(0);
  });

  it("silently detects, verifies, and activates the official app-server package without restarting Pixice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pixice-codex-updater-"));
    temporaryDirectories.push(root);
    const bundledResourcesPath = path.join(root, "bundled");
    const userDataPath = path.join(root, "user-data");
    await writeRuntime(bundledResourcesPath, "0.149.0");

    const archive = Buffer.from("official-codex-archive");
    const release = {
      tag_name: "rust-v0.149.1",
      assets: [{
        name: assetName,
        digest: `sha256:${sha256(archive)}`,
        browser_download_url: `https://releases.openai.com/codex/releases/0.149.1/${assetName}`
      }]
    };
    const fetchImpl = vi.fn(async (url) => url.endsWith("/channels/latest")
      ? { ok: true, json: async () => release }
      : { ok: true, arrayBuffer: async () => archive });
    const extractArchive = vi.fn(async (_archivePath, destination) => {
      const binary = Buffer.from("codex-0.149.1");
      const host = Buffer.from("host-0.149.1");
      await mkdir(path.join(destination, "bin"), { recursive: true });
      await writeFile(path.join(destination, "bin", "codex-app-server"), binary, { mode: 0o755 });
      await writeFile(path.join(destination, "bin", "codex-code-mode-host"), host, { mode: 0o755 });
      await writeFile(path.join(destination, "codex-package.json"), JSON.stringify({
        layoutVersion: 1,
        version: "0.149.1",
        target,
        variant: "codex-app-server",
        entrypoint: "bin/codex-app-server",
        resourcesDir: "codex-resources",
        pathDir: "codex-path"
      }));
    });
    const updater = new CodexUpdater({ bundledResourcesPath, userDataPath, fetchImpl, extractArchive, platform, arch });
    const runtime = {
      resourcesPath: bundledResourcesPath,
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(true)
    };

    expect(await updater.check()).toMatchObject({ state: "available", currentVersion: "0.149.0", availableVersion: "0.149.1", prompt: true });
    expect(await installAndActivateCodexUpdate({ updater, runtime })).toMatchObject({ state: "ready", currentVersion: "0.149.1", installedVersion: "0.149.1", restartRequired: false, prompt: true });
    expect(extractArchive).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.resourcesPath).toBe(path.join(userDataPath, "codex-runtime", "versions", "0.149.1"));

    const pointer = JSON.parse(await readFile(path.join(userDataPath, "codex-runtime", "active.json"), "utf8"));
    expect(pointer).toMatchObject({ version: "0.149.1", directory: "versions/0.149.1" });

    const restarted = new CodexUpdater({ bundledResourcesPath, userDataPath, fetchImpl, extractArchive, platform, arch });
    expect(restarted.snapshot()).toMatchObject({ currentVersion: "0.149.1", installedVersion: "0.149.1", state: "idle" });
    expect(restarted.activeResourcesPath()).toBe(path.join(userDataPath, "codex-runtime", "versions", "0.149.1"));
  });

  it("restores the previous runtime when the new Codex process cannot connect", async () => {
    const updater = {
      install: vi.fn().mockResolvedValue({ state: "applying" }),
      pendingResourcesPath: vi.fn().mockReturnValue("/verified/codex"),
      commitPendingRuntime: vi.fn(),
      failPendingRuntime: vi.fn((error) => ({ state: "error", message: error.message }))
    };
    const runtime = {
      resourcesPath: "/bundled/codex",
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    };

    expect(await installAndActivateCodexUpdate({ updater, runtime })).toMatchObject({ state: "error" });
    expect(runtime.resourcesPath).toBe("/bundled/codex");
    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(updater.commitPendingRuntime).not.toHaveBeenCalled();
    expect(updater.failPendingRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps automatic checks off while still allowing a manual check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pixice-codex-updater-disabled-"));
    temporaryDirectories.push(root);
    const bundledResourcesPath = path.join(root, "bundled");
    const userDataPath = path.join(root, "user-data");
    await writeRuntime(bundledResourcesPath, "0.149.0");
    const archive = Buffer.from("archive");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "rust-v0.149.1",
        assets: [{ name: assetName, digest: `sha256:${sha256(archive)}`, browser_download_url: `https://releases.openai.com/codex/releases/0.149.1/${assetName}` }]
      })
    }));
    const updater = new CodexUpdater({ bundledResourcesPath, userDataPath, enabled: false, fetchImpl, platform, arch });

    expect(await updater.check()).toMatchObject({ state: "disabled", enabled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await updater.check({ manual: true })).toMatchObject({ state: "available", prompt: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
