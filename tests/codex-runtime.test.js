import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRuntime } from "../electron/runtime/codex-runtime.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexRuntime lifecycle", () => {
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
