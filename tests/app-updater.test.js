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

function application(version = '0.1.0') {
  return Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => version });
}

function context(options = {}) {
  const app = application();
  const nativeUpdater = new FakeUpdater();
  nativeUpdater.quitAndInstall.mockImplementation(() => app.emit('will-quit'));
  const prepareInstall = vi.fn(async () => ({ path: '/backups/update' }));
  const beforeQuit = vi.fn();
  const recoverInstall = vi.fn();
  const updater = new PixiceAppUpdater({ updater: nativeUpdater, app, platform: 'win32', prepareInstall, beforeQuit, recoverInstall, ...options });
  return { app, nativeUpdater, updater, prepareInstall, beforeQuit, recoverInstall };
}

describe("PixiceAppUpdater", () => {
  it("checks, downloads, and installs a GitHub release", async () => {
    const { nativeUpdater, prepareInstall, updater, beforeQuit } = context();
    updater.start();

    await updater.check();
    expect(updater.snapshot()).toMatchObject({ state: "available", currentVersion: "0.1.0", availableVersion: "0.2.0" });
    expect(nativeUpdater.autoDownload).toBe(false);
    expect(nativeUpdater.autoInstallOnAppQuit).toBe(false);
    expect(nativeUpdater.allowPrerelease).toBe(false);

    await updater.download();
    expect(updater.snapshot()).toMatchObject({ state: "downloaded", percent: 100, availableVersion: "0.2.0" });

    await updater.install();
    expect(prepareInstall).toHaveBeenCalledWith({ currentVersion: "0.1.0", availableVersion: "0.2.0" });
    expect(nativeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(beforeQuit).toHaveBeenCalledOnce();
    expect(updater.snapshot().state).toBe('restarting');
    updater.stop();
  });

  it("refuses to install when durable data cannot be preserved", async () => {
    const nativeUpdater = new FakeUpdater();
    const updater = new PixiceAppUpdater({
      updater: nativeUpdater,
      app: application(), platform: 'win32',
      prepareInstall: vi.fn(async () => { throw new Error("backup failed"); })
    });
    updater.start();
    await updater.check();
    await updater.download();

    await expect(updater.install()).rejects.toThrow("backup failed");
    expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.snapshot()).toMatchObject({ state: "install-error", message: expect.stringContaining("backup failed") });
    await expect(updater.install()).rejects.toThrow("backup failed");
    updater.stop();
  });

  it("keeps beta installations on the prerelease channel", () => {
    const nativeUpdater = new FakeUpdater();
    const updater = new PixiceAppUpdater({ updater: nativeUpdater, app: application('0.1.0-beta.1'), platform: 'win32' });
    updater.start();
    expect(nativeUpdater.allowPrerelease).toBe(true);
    updater.stop();
  });

  it('waits for native macOS verification before allowing windows to close', async () => {
    const squirrel = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
    const { updater, nativeUpdater, beforeQuit, prepareInstall } = context({ platform: 'darwin', nativeUpdater: squirrel });
    await updater.start(); await updater.check(); await updater.download();
    const installing = updater.install();
    await vi.waitFor(() => expect(squirrel.checkForUpdates).toHaveBeenCalledOnce());
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(updater.snapshot().state).toBe('preparing-install');
    expect(beforeQuit).not.toHaveBeenCalled();
    expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    squirrel.emit('update-downloaded');
    await expect(installing).resolves.toMatchObject({ restarting: true });
    expect(beforeQuit).toHaveBeenCalledOnce();
    updater.stop();
  });

  it('keeps the desktop open and recovers the backend after a native signature error', async () => {
    const squirrel = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
    const { updater, nativeUpdater, beforeQuit, recoverInstall } = context({ platform: 'darwin', nativeUpdater: squirrel });
    await updater.start(); await updater.check(); await updater.download();
    const installing = updater.install();
    const result = expect(installing).rejects.toThrow('signature mismatch');
    await vi.waitFor(() => expect(squirrel.checkForUpdates).toHaveBeenCalledOnce());
    squirrel.emit('error', new Error('signature mismatch'));
    await result;
    expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(beforeQuit).not.toHaveBeenCalled();
    expect(recoverInstall).toHaveBeenCalledOnce();
    expect(updater.snapshot()).toMatchObject({ state: 'install-error', message: expect.stringContaining('signature mismatch') });
    const retry = updater.install();
    await vi.waitFor(() => expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(2));
    squirrel.emit('update-downloaded'); await retry;
    updater.stop();
  });

  it('recovers when macOS never accepts the ZIP and ignores late completion', async () => {
    const squirrel = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
    const { updater, nativeUpdater, recoverInstall } = context({ platform: 'darwin', nativeUpdater: squirrel, stageTimeoutMs: 20 });
    await updater.start(); await updater.check(); await updater.download();
    await expect(updater.install()).rejects.toThrow('did not become ready');
    squirrel.emit('update-downloaded');
    expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(recoverInstall).toHaveBeenCalledOnce();
    expect(updater.snapshot().state).toBe('install-error');
    updater.stop();
  });

  it('recovers if another quit handler prevents the application from exiting', async () => {
    const { updater, nativeUpdater, recoverInstall } = context({ quitTimeoutMs: 20 });
    nativeUpdater.quitAndInstall.mockImplementation(() => {});
    await updater.start(); await updater.check(); await updater.download();
    await expect(updater.install()).rejects.toThrow('could not restart');
    expect(recoverInstall).toHaveBeenCalledOnce();
    expect(updater.snapshot().state).toBe('install-error');
    updater.stop();
  });

  it('does not erase a downloaded update during periodic checks or install it twice', async () => {
    const squirrel = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
    const { updater, nativeUpdater, prepareInstall } = context({ platform: 'darwin', nativeUpdater: squirrel });
    await updater.start(); await updater.check(); await updater.download();
    await updater.check();
    expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    const first = updater.install(); const second = updater.install();
    await vi.waitFor(() => expect(squirrel.checkForUpdates).toHaveBeenCalledOnce());
    await updater.check();
    squirrel.emit('update-downloaded');
    await Promise.all([first, second]);
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(nativeUpdater.quitAndInstall).toHaveBeenCalledOnce();
    updater.stop();
  });

  it('blocks an ineligible local copy before downloading or shutting down', async () => {
    const { updater, nativeUpdater, prepareInstall } = context({ assertInstallable: vi.fn(async () => { throw new Error('Ad-hoc build: install the signed release once.'); }) });
    await updater.start(); await updater.check(); await updater.download();
    await expect(updater.install()).rejects.toThrow('signed release');
    expect(updater.snapshot()).toMatchObject({ supported: false, state: 'unsupported' });
    expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(nativeUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(prepareInstall).not.toHaveBeenCalled();
    updater.stop();
  });
});
