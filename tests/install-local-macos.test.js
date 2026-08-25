import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { detachWorker, localInstallPaths, processStateIsRunning } from "../scripts/install-local-macos.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.resolve(testDirectory, "../scripts/install-local-macos.mjs");

describe("local macOS installer", () => {
  it("creates unique staging, backup, plan, and log paths", () => {
    const paths = localInstallPaths({
      source: "/tmp/build/Pixice.app",
      target: "/tmp/apps/Pixice.app",
      date: new Date("2026-08-21T12:00:00.000Z"),
      processId: 42
    });

    expect(paths).toEqual({
      source: "/tmp/build/Pixice.app",
      target: "/tmp/apps/Pixice.app",
      staging: "/tmp/apps/Pixice.app.staging-42",
      backup: "/tmp/apps/Pixice.app.backup-20260821T120000Z",
      plan: path.join(tmpdir(), "pixice-local-install-42-20260821T120000Z.json"),
      log: path.join(tmpdir(), "pixice-local-install-42-20260821T120000Z.log")
    });
  });

  it("launches exactly one detached worker without launchd", () => {
    const logPath = path.join(tmpdir(), `pixice-local-installer-test-${process.pid}.log`);
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ pid: 99, unref }));

    try {
      expect(detachWorker({ planPath: "/tmp/install-plan.json", logPath, spawn, nodePath: "/usr/bin/node" })).toBe(99);
      expect(spawn).toHaveBeenCalledWith(
        "/usr/bin/node",
        [installerPath, "--finish-install", "/tmp/install-plan.json"],
        expect.objectContaining({ detached: true })
      );
      expect(unref).toHaveBeenCalledOnce();
      expect(readFileSync(installerPath, "utf8")).not.toContain("launchctl");
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it("treats a zombie process as exited so it cannot block the bundle swap", () => {
    expect(processStateIsRunning("Z")).toBe(false);
    expect(processStateIsRunning("Z+")).toBe(false);
    expect(processStateIsRunning("S+")).toBe(true);
    expect(processStateIsRunning("")).toBe(false);
  });
});
