import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PixiceAppUpdater } from "../electron/updater/app-updater.mjs";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => {
    this.emit("update-available", { version: "0.2.0" });
  });
  downloadUpdate = vi.fn(async () => {
    this.emit("download-progress", { percent: 42, transferred: 42, total: 100, bytesPerSecond: 12 });
    this.emit("update-downloaded", { version: "0.2.0" });
  });
  quitAndInstall = vi.fn();
}

describe("PixiceAppUpdater", () => {
  it("checks, downloads, and installs a GitHub release", async () => {
    const nativeUpdater = new FakeUpdater();
    const updater = new PixiceAppUpdater({ updater: nativeUpdater, app: { isPackaged: true, getVersion: () => "0.1.0" } });
    updater.start();

    await updater.check();
    expect(updater.snapshot()).toMatchObject({ state: "available", currentVersion: "0.1.0", availableVersion: "0.2.0" });
    expect(nativeUpdater.autoDownload).toBe(false);
    expect(nativeUpdater.allowPrerelease).toBe(false);

    await updater.download();
    expect(updater.snapshot()).toMatchObject({ state: "downloaded", percent: 100, availableVersion: "0.2.0" });

    updater.install();
    expect(nativeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    updater.stop();
  });

  it("keeps beta installations on the prerelease channel", () => {
    const nativeUpdater = new FakeUpdater();
    const updater = new PixiceAppUpdater({ updater: nativeUpdater, app: { isPackaged: true, getVersion: () => "0.1.0-beta.1" } });
    updater.start();
    expect(nativeUpdater.allowPrerelease).toBe(true);
    updater.stop();
  });
});
