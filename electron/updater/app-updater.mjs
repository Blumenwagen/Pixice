import { EventEmitter } from "node:events";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export class LoomAppUpdater extends EventEmitter {
  #updater;
  #app;
  #timer = null;
  #started = false;
  #status;

  constructor({ updater, app }) {
    super();
    this.#updater = updater;
    this.#app = app;
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
      message: app.isPackaged ? "Ready to check GitHub releases." : "Updates are available in packaged Loom builds."
    };
  }

  snapshot() {
    return { ...this.#status };
  }

  start() {
    if (this.#started || !this.#status.supported) return;
    this.#started = true;
    this.#updater.autoDownload = false;
    this.#updater.autoInstallOnAppQuit = true;
    this.#updater.allowPrerelease = false;

    this.#updater.on("checking-for-update", () => this.#update({ state: "checking", message: "Checking GitHub for a newer Loom release." }));
    this.#updater.on("update-available", (info) => this.#update({
      state: "available",
      availableVersion: info.version,
      checkedAt: new Date().toISOString(),
      message: `Loom ${info.version} is ready to download.`
    }));
    this.#updater.on("update-not-available", () => this.#update({
      state: "not-available",
      checkedAt: new Date().toISOString(),
      message: "Loom is up to date."
    }));
    this.#updater.on("download-progress", (progress) => this.#update({
      state: "downloading",
      percent: Number(progress.percent) || 0,
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferred: progress.transferred || 0,
      total: progress.total || 0,
      message: `Downloading Loom ${this.#status.availableVersion ?? "update"}.`
    }));
    this.#updater.on("update-downloaded", (info) => this.#update({
      state: "downloaded",
      availableVersion: info.version ?? this.#status.availableVersion,
      percent: 100,
      message: "Update downloaded. Restart Loom to install it."
    }));
    this.#updater.on("error", (error) => this.#fail(error));

    const initial = setTimeout(() => void this.check().catch(() => {}), 10_000);
    initial.unref?.();
    this.#timer = setInterval(() => void this.check().catch(() => {}), SIX_HOURS);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async check() {
    if (!this.#status.supported) return this.snapshot();
    if (["checking", "downloading"].includes(this.#status.state)) return this.snapshot();
    this.#update({ state: "checking", message: "Checking GitHub for a newer Loom release." });
    try {
      await this.#updater.checkForUpdates();
    } catch (error) {
      this.#fail(error);
    }
    return this.snapshot();
  }

  async download() {
    if (!this.#status.supported) return this.snapshot();
    if (this.#status.state !== "available") throw new Error("No Loom update is ready to download");
    this.#update({ state: "downloading", percent: 0, message: `Downloading Loom ${this.#status.availableVersion}.` });
    try {
      await this.#updater.downloadUpdate();
    } catch (error) {
      this.#fail(error);
    }
    return this.snapshot();
  }

  install() {
    if (this.#status.state !== "downloaded") throw new Error("The Loom update has not finished downloading");
    this.#updater.quitAndInstall(false, true);
    return { ok: true };
  }

  #fail(error) {
    this.#update({ state: "error", message: error?.message || String(error) });
  }

  #update(patch) {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.snapshot());
  }
}
