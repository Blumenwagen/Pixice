import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { findTranscriptionModel, resolveModelFiles, TRANSCRIPTION_MODEL_IDS } from "./catalog.mjs";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = ".pixice-model.json";
const DOWNLOAD_DIRECTORY = ".downloads";
const STAGING_DIRECTORY = ".staging";
// Roughly four progress updates a second, which is smoother than the capsule
// animation needs and cheap enough to send to every paired client.
const PROGRESS_INTERVAL_MS = 250;

async function directoryEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function directoryBytes(directory) {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else total += await stat(entryPath).then((value) => value.size).catch(() => 0);
  }
  return total;
}

// Models arrive as .tar.bz2 and Node has no bzip2. Every platform Pixice ships
// on has a `tar` that auto-detects the compression: bsdtar on macOS and on
// Windows 10 1803 and later, GNU tar on Linux.
async function extractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar", ["-xf", archivePath, "-C", destination, "--strip-components=1"], {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
}

export class TranscriptionModelLibrary {
  constructor({ directory, fetchImpl, extract = extractArchive }) {
    this.directory = directory;
    // Bound so the platform fetch is never invoked as a method of this object.
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.extract = extract;
    this.installs = new Map();
  }

  modelDirectory(id) { return path.join(this.directory, id); }

  async read(id) {
    const model = findTranscriptionModel(id);
    if (!model) return null;
    const directory = this.modelDirectory(id);
    const manifest = await readFile(path.join(directory, MANIFEST_NAME), "utf8").then(JSON.parse).catch(() => null);
    if (!manifest?.files) return null;
    return { id, directory, files: manifest.files, bytes: manifest.bytes ?? 0, installedAt: manifest.installedAt ?? null, sha256: manifest.sha256 ?? null };
  }

  async list() {
    const records = await Promise.all(TRANSCRIPTION_MODEL_IDS.map((id) => this.read(id)));
    return records.filter(Boolean);
  }

  async diskUsage() {
    return directoryBytes(this.directory);
  }

  installState(id) {
    const install = this.installs.get(id);
    return install ? { ...install.progress } : null;
  }

  cancel(id) {
    const install = this.installs.get(id);
    if (!install) return false;
    install.controller.abort(new DOMException("The download was cancelled.", "AbortError"));
    return true;
  }

  async remove(id) {
    if (!findTranscriptionModel(id)) throw new Error(`Unknown transcription model: ${id}`);
    this.cancel(id);
    await rm(this.modelDirectory(id), { recursive: true, force: true });
    await rm(path.join(this.directory, STAGING_DIRECTORY, id), { recursive: true, force: true });
    await rm(path.join(this.directory, DOWNLOAD_DIRECTORY, `${id}.part`), { force: true });
    return { id, installed: false };
  }

  // Returns the in-flight install when one is already running so a second
  // click, or a second client, joins the existing download instead of
  // starting a competing one.
  install(id, { onProgress = () => {} } = {}) {
    const existing = this.installs.get(id);
    if (existing) {
      existing.listeners.add(onProgress);
      return existing.promise;
    }
    const model = findTranscriptionModel(id);
    if (!model) return Promise.reject(new Error(`Unknown transcription model: ${id}`));

    const controller = new AbortController();
    const listeners = new Set([onProgress]);
    const install = {
      controller,
      listeners,
      // `label` rides along so progress consumers can name the model without
      // reaching into the catalog, which lives on the host side.
      progress: { id, label: model.label, phase: "starting", receivedBytes: 0, totalBytes: model.archive.bytes, error: null }
    };
    // A 500 MB download fires a chunk callback thousands of times a second.
    // Every one of those would cross the IPC bridge, and a paired client's
    // Connect tunnel, to move a progress bar by a fraction of a pixel. Byte
    // updates are throttled; a phase change always goes out immediately.
    let lastReportAt = 0;
    const report = (patch, { force = false } = {}) => {
      const next = { ...install.progress, ...patch };
      const phaseChanged = next.phase !== install.progress.phase;
      install.progress = next;
      const now = Date.now();
      if (!force && !phaseChanged && now - lastReportAt < PROGRESS_INTERVAL_MS) return;
      lastReportAt = now;
      for (const listener of listeners) {
        try { listener(install.progress); } catch { /* a listener must not break the download */ }
      }
    };
    install.promise = this.#run(model, { controller, report })
      .then((result) => { report({ phase: "installed", receivedBytes: model.archive.bytes }, { force: true }); return result; })
      .catch((error) => {
        const cancelled = error?.name === "AbortError";
        report({ phase: cancelled ? "cancelled" : "failed", error: cancelled ? null : String(error?.message ?? error).slice(0, 500) }, { force: true });
        throw error;
      })
      .finally(() => { this.installs.delete(id); });
    this.installs.set(id, install);
    return install.promise;
  }

  async #run(model, { controller, report }) {
    const { id, archive } = model;
    const downloads = path.join(this.directory, DOWNLOAD_DIRECTORY);
    const staging = path.join(this.directory, STAGING_DIRECTORY, id);
    const archivePath = path.join(downloads, `${id}.part`);
    await mkdir(downloads, { recursive: true });
    await rm(staging, { recursive: true, force: true });

    report({ phase: "downloading", receivedBytes: 0 });
    const digest = await this.#download(archive, archivePath, { controller, report });

    if (archive.sha256 && digest !== archive.sha256) {
      await rm(archivePath, { force: true });
      throw new Error("The downloaded model did not match its expected checksum and was discarded.");
    }
    const downloadedBytes = await stat(archivePath).then((value) => value.size);
    if (downloadedBytes !== archive.bytes) {
      await rm(archivePath, { force: true });
      throw new Error(`The downloaded model is ${downloadedBytes} bytes but ${archive.bytes} were expected.`);
    }

    controller.signal.throwIfAborted();
    report({ phase: "extracting" });
    await this.extract(archivePath, staging);
    await rm(archivePath, { force: true });

    const entries = await directoryEntries(staging);
    const files = resolveModelFiles(model.family, entries);
    const bytes = await directoryBytes(staging);
    await writeFile(
      path.join(staging, MANIFEST_NAME),
      JSON.stringify({ id, family: model.family, files, bytes, sha256: digest, installedAt: new Date().toISOString() }, null, 2)
    );

    const destination = this.modelDirectory(id);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(staging, destination);
    return { id, directory: destination, files, bytes, sha256: digest };
  }

  // Resumes from a partial file with a Range request so a dropped connection
  // does not cost the user another 500 MB.
  async #download(archive, archivePath, { controller, report }) {
    const resumeFrom = await stat(archivePath).then((value) => value.size).catch(() => 0);
    const headers = resumeFrom > 0 && resumeFrom < archive.bytes ? { range: `bytes=${resumeFrom}-` } : {};
    const response = await this.fetchImpl(archive.url, { headers, signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`The model download failed with HTTP ${response.status}.`);

    const resumed = response.status === 206;
    const startBytes = resumed ? resumeFrom : 0;
    if (!resumed && resumeFrom > 0) await rm(archivePath, { force: true });

    let received = startBytes;
    report({ receivedBytes: received, totalBytes: archive.bytes });
    const hash = createHash("sha256");
    // A resumed download cannot hash the bytes it never saw, so the existing
    // prefix is folded in first.
    if (resumed && startBytes > 0) hash.update(await readFile(archivePath));

    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      report({ receivedBytes: received });
    });
    await pipeline(body, createWriteStream(archivePath, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
    return hash.digest("hex");
  }
}
