import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRuntime, codexAppServerArgs } from "../electron/runtime/codex-runtime.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexRuntime lifecycle", () => {
  it("injects Pixice guidance as additive developer instructions", () => {
    const instructions = "Keep the lead thread clear.\nRespect AGENTS.md.";
    expect(codexAppServerArgs(instructions)).toEqual([
      "--config",
      `developer_instructions=${JSON.stringify(instructions)}`,
      "app-server"
    ]);
  });

  it("uses the stock app-server launch when no Pixice guidance is configured", () => {
    expect(codexAppServerArgs()).toEqual(["app-server"]);
  });

  it("always launches the external Codex CLI through its app-server subcommand", () => {
    expect(codexAppServerArgs("Stay focused.")).toEqual([
      "--config",
      `developer_instructions=${JSON.stringify("Stay focused.")}`,
      "app-server"
    ]);
  });

  it("reports missing Pixice guidance instead of silently dropping it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pixice-runtime-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await writeFile(binary, "fake codex", { mode: 0o755 });
    const runtime = new CodexRuntime({
      executablePath: binary,
      clientVersion: "test",
      developerInstructionsPath: path.join(directory, "missing-instructions.md")
    });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    try {
      await expect(runtime.start()).resolves.toBe(false);
      expect(errors).toEqual([expect.objectContaining({ code: "developer_instructions_unavailable" })]);
    } finally {
      await runtime.stop();
    }
  });

  it("does not resolve a bundled runtime or a relative executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pixice-runtime-"));
    temporaryDirectories.push(directory);
    const runtime = new CodexRuntime({ executablePath: "codex", clientVersion: "test" });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    await expect(runtime.start()).resolves.toBe(false);
    expect(errors).toEqual([expect.objectContaining({ code: "runtime_missing" })]);
  });

  it("turns a spawn failure into one recoverable error and can stop cleanly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pixice-runtime-"));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await writeFile(binary, "#!/definitely/missing/interpreter\n", { mode: 0o755 });
    const runtime = new CodexRuntime({ executablePath: binary, clientVersion: "test" });
    const errors = [];
    runtime.on("recoverable-error", (error) => errors.push(error));
    try {
      await expect(runtime.start()).resolves.toBe(false);
      expect(errors).toEqual([expect.objectContaining({ code: "runtime_spawn_failed" })]);
      await expect(runtime.stop()).resolves.toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});
