import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRuntime, codexAppServerArgs } from "../electron/runtime/codex-runtime.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexRuntime lifecycle", () => {
  it("injects Loom guidance as additive developer instructions", () => {
    const instructions = "Keep the lead thread clear.\nRespect AGENTS.md.";
    expect(codexAppServerArgs(instructions)).toEqual([
      "--config",
      `developer_instructions=${JSON.stringify(instructions)}`,
      "app-server"
    ]);
  });

  it("uses the stock app-server launch when no Loom guidance is configured", () => {
    expect(codexAppServerArgs()).toEqual(["app-server"]);
  });

  it("reports missing Loom guidance instead of silently dropping it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "loom-runtime-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await writeFile(binary, "fake codex", { mode: 0o755 });
    const previous = process.env.LOOM_CODEX_PATH;
    process.env.LOOM_CODEX_PATH = binary;

    const runtime = new CodexRuntime({
      resourcesPath: directory,
      clientVersion: "test",
      allowDevelopmentRuntime: true,
      developerInstructionsPath: path.join(directory, "missing-instructions.md")
    });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    try {
      await expect(runtime.start()).resolves.toBe(false);
      expect(errors).toEqual([expect.objectContaining({ code: "developer_instructions_unavailable" })]);
    } finally {
      if (previous === undefined) delete process.env.LOOM_CODEX_PATH;
      else process.env.LOOM_CODEX_PATH = previous;
      await runtime.stop();
    }
  });

  it("rejects a packaged runtime that is missing the code-mode host", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "loom-runtime-"));
    temporaryDirectories.push(directory);
    const key = `${process.platform}-${process.arch}`;
    const filename = process.platform === "win32" ? "codex.exe" : "codex";
    const runtimeDirectory = path.join(directory, "runtime", key);
    const binary = path.join(runtimeDirectory, filename);
    const bytes = Buffer.from("fake codex");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(binary, bytes, { mode: 0o755 });
    await writeFile(path.join(directory, "runtime", "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      platforms: {
        [key]: {
          path: `${key}/${filename}`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          codeModeHostPath: `${key}/${process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host"}`,
          codeModeHostSha256: "0".repeat(64)
        }
      }
    }));

    const runtime = new CodexRuntime({ resourcesPath: directory, clientVersion: "test", allowDevelopmentRuntime: false });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    await expect(runtime.start()).resolves.toBe(false);
    expect(errors).toEqual([expect.objectContaining({ code: "runtime_missing" })]);
  });

  it("turns a spawn failure into one recoverable error and can stop cleanly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "loom-runtime-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await writeFile(binary, "not executable", { mode: 0o600 });
    const previous = process.env.LOOM_CODEX_PATH;
    process.env.LOOM_CODEX_PATH = binary;

    const runtime = new CodexRuntime({ resourcesPath: directory, clientVersion: "test", allowDevelopmentRuntime: true });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    try {
      await expect(runtime.start()).resolves.toBe(false);
      expect(errors).toEqual([expect.objectContaining({ code: "runtime_spawn_failed" })]);
      await expect(runtime.stop()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.LOOM_CODEX_PATH;
      else process.env.LOOM_CODEX_PATH = previous;
      await runtime.stop();
    }
  });
});
