import { EventEmitter } from "node:events";
import { stageMacUpdate } from './macos-update.mjs';

const SIX_HOURS = 6 * 60 * 60 * 1000;

export class PixiceAppUpdater extends EventEmitter {
  #updater;
  #app;
  #timer = null;
  #initialTimer = null;
  #started = false;
  #stopped = false;
  #status;
  #prepareInstall;
  #beforeQuit;
  #recoverInstall;
  #assertInstallable;
  #nativeUpdater;
  #nativeReady = false;
  #platform;
  #journal;
  #ready = Promise.resolve();
  #installing = null;
  #stageController;
  #stageTimeoutMs;
  #quitTimeoutMs;

  constructor({ updater, app, prepareInstall = null, beforeQuit = null, recoverInstall = null,
    assertInstallable = null, nativeUpdater = null, platform = process.platform, journal = null,
    stageTimeoutMs = 120_000, quitTimeoutMs = 15_000 }) {
    super();
    this.#updater = updater;
    this.#app = app;
    this.#prepareInstall = prepareInstall;
    this.#beforeQuit = beforeQuit;
    this.#recoverInstall = recoverInstall;
    this.#assertInstallable = assertInstallable;
    this.#nativeUpdater = nativeUpdater;
    this.#platform = platform;
    this.#journal = journal;
    this.#stageTimeoutMs = stageTimeoutMs;
    this.#quitTimeoutMs = quitTimeoutMs;
    this.#status = {
      supported: app.isPackaged,
      state: app.isPackaged ? "idle" : "development",
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      checkedAt: null,
      message: app.isPackaged ? "Ready to check GitHub releases." : "Updates are available in packaged Pixice builds."
    };
  }

  snapshot() {
    return { ...this.#status };
  }

  start() {
    if (this.#started || !this.#status.supported) return;
    this.#started = true;
    this.#updater.autoDownload = false;
    // Every install must pass through install(), which snapshots durable data first.
    this.#updater.autoInstallOnAppQuit = false;
    this.#updater.autoRunAppAfterInstall = true;
    this.#updater.allowPrerelease = this.#app.getVersion().includes("-");

    this.#nativeUpdater?.on('update-downloaded', () => { this.#nativeReady = true; });
    this.#updater.on("checking-for-update", () => this.#update({ state: "checking", message: "Checking GitHub for a newer Pixice release." }));
    this.#updater.on("update-available", (info) => this.#update({
      state: "available",
      availableVersion: info.version,
      checkedAt: new Date().toISOString(),
      message: `Pixice ${info.version} is ready to download.`
    }));
    this.#updater.on("update-not-available", () => this.#update({
      state: "not-available",
      checkedAt: new Date().toISOString(),
      message: "Pixice is up to date."
    }));
    this.#updater.on("download-progress", (progress) => this.#update({
      state: "downloading",
      percent: Number(progress.percent) || 0,
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferred: progress.transferred || 0,
      total: progress.total || 0,
      message: `Downloading Pixice ${this.#status.availableVersion ?? "update"}.`
    }));
    this.#updater.on("update-downloaded", (info) => this.#update({
      state: "downloaded",
      availableVersion: info.version ?? this.#status.availableVersion,
      percent: 100,
      message: "Update downloaded. Restart Pixice to install it."
    }));
    this.#updater.on("error", (error) => this.#fail(error));

    this.#ready = (async () => {
      try {
        const result = await this.#journal?.reconcile(this.#status.currentVersion);
        if (result) this.#update(result);
        await this.#assertInstallable?.();
      } catch (error) {
        this.#update({ supported: false, state: 'unsupported', message: error.message || String(error) });
        return;
      }
      if (this.#stopped) return;
      this.#initialTimer = setTimeout(() => void this.check().catch(() => {}), 10_000);
      this.#initialTimer.unref?.();
      this.#timer = setInterval(() => void this.check().catch(() => {}), SIX_HOURS);
      this.#timer.unref?.();
    })();
    return this.#ready;
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#initialTimer);
    if (this.#timer) clearInterval(this.#timer);
    this.#initialTimer = null;
    this.#timer = null;
    this.#stageController?.abort(new Error('Update preparation was cancelled.'));
  }

  async check() {
    await this.#ready;
    if (!this.#status.supported) return this.snapshot();
    if (["checking", "downloading", "downloaded", "install-error", "protecting-data", "preparing-install", "restarting"].includes(this.#status.state)) return this.snapshot();
    this.#update({ state: "checking", message: "Checking GitHub for a newer Pixice release." });
    try {
      await this.#updater.checkForUpdates();
    } catch (error) {
      this.#fail(error);
    }
    return this.snapshot();
  }

  async download() {
    await this.#ready;
    if (!this.#status.supported) return this.snapshot();
    if (this.#status.state !== "available") throw new Error("No Pixice update is ready to download");
    this.#update({ state: "downloading", percent: 0, message: `Downloading Pixice ${this.#status.availableVersion}.` });
    try {
      await this.#updater.downloadUpdate();
    } catch (error) {
      this.#fail(error);
    }
    return this.snapshot();
  }

  async install() {
    if (this.#installing) return this.#installing;
    await this.#ready;
    // Another caller can arrive while the eligibility check is pending.
    if (this.#installing) return this.#installing;
    if (!this.#status.supported) throw new Error(this.#status.message);
    if (!["downloaded", "install-error"].includes(this.#status.state)) throw new Error("The Pixice update has not finished downloading");
    this.#installing = this.#install();
    try { return await this.#installing; } finally { this.#installing = null; }
  }

  async #install() {
    this.#update({ state: "protecting-data", message: "Preserving projects and threads before installing the update." });
    try {
      if (typeof this.#prepareInstall !== "function") throw new Error("Update data protection is unavailable");
      const backup = await this.#prepareInstall?.({
        currentVersion: this.#status.currentVersion,
        availableVersion: this.#status.availableVersion
      });
      this.#update({ state: 'preparing-install', message: 'Waiting for the installer to verify the update. Pixice will stay open until it is ready.' });
      if (this.#platform === 'darwin' && !this.#nativeReady) {
        if (!this.#nativeUpdater) throw new Error('The native macOS installer is unavailable');
        this.#stageController = new AbortController();
        await stageMacUpdate(this.#nativeUpdater, { signal: this.#stageController.signal, timeoutMs: this.#stageTimeoutMs });
      }
      await this.#journal?.pending(this.#status);
      this.#update({ state: 'restarting', message: `Installing Pixice ${this.#status.availableVersion} and reopening the app.` });
      await this.#requestQuit();
      return { ok: true, restarting: true, backupPath: backup?.path ?? null };
    } catch (error) {
      let message = error?.message || String(error);
      try { await this.#recoverInstall?.(); } catch (recovery) { message += ` Workspace recovery failed: ${recovery.message || String(recovery)}`; }
      await this.#journal?.failed({ ...this.#status, message }).catch(() => {});
      this.#update({ state: "install-error", message: `Update not installed: ${message} Your saved data is preserved.` });
      throw error;
    } finally {
      this.#stageController = null;
    }
  }

  #requestQuit() {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.#app.removeListener('will-quit', done); this.#updater.removeListener('error', failed); };
      const done = () => { cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(error); };
      this.#app.once('will-quit', done);
      this.#updater.once('error', failed);
      timer = setTimeout(() => failed(new Error('Pixice could not restart for the update. The app stayed open.')), this.#quitTimeoutMs);
      try {
        this.#beforeQuit?.();
        this.#updater.quitAndInstall(false, true);
      } catch (error) { failed(error); }
    });
  }

  #fail(error) {
    if (this.#installing) return; // The awaited native handoff owns recovery.
    this.#update({ state: "error", message: error?.message || String(error) });
  }

  #update(patch) {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.snapshot());
    void this.#journal?.record(this.#status);
  }
}
