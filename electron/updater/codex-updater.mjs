import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SIX_HOURS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY = 8_000;
const CHANNEL_URL = "https://releases.openai.com/codex/channels/latest";
const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-musl"
};

function platformPackage(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const target = TARGETS[key];
  if (!target) return null;
  const executableSuffix = platform === "win32" ? ".exe" : "";
  return {
    key,
    target,
    assetName: `codex-app-server-package-${target}.tar.gz`,
    binaryName: `codex-app-server${executableSuffix}`,
    codeModeHostName: `codex-code-mode-host${executableSuffix}`
  };
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeVersion(value) {
  const version = String(value ?? "").replace(/^rust-v/, "").trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : "";
}

export function compareCodexVersions(left, right) {
  const parse = (value) => String(value ?? "").split("-", 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function validateRuntimeResources(resourcesPath, platform = process.platform, arch = process.arch) {
  const packageInfo = platformPackage(platform, arch);
  if (!packageInfo) throw new Error(`Codex updates do not support ${platform}-${arch}`);
  const runtimeRoot = path.join(resourcesPath, "runtime");
  const manifest = JSON.parse(readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
  const entry = manifest.platforms?.[packageInfo.key];
  const expectedPath = `${packageInfo.key}/bin/${packageInfo.binaryName}`;
  const expectedCodeModeHostPath = `${packageInfo.key}/bin/${packageInfo.codeModeHostName}`;
  if (
    manifest.schemaVersion !== 2
    || manifest.runtimeKind !== "app-server-package"
    || !normalizeVersion(manifest.codexVersion)
    || entry?.path !== expectedPath
    || entry?.codeModeHostPath !== expectedCodeModeHostPath
    || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(entry.codeModeHostSha256 ?? "")
  ) throw new Error("Codex runtime manifest is invalid");

  const binary = path.join(runtimeRoot, entry.path);
  const codeModeHost = path.join(runtimeRoot, entry.codeModeHostPath);
  if (!existsSync(binary) || !existsSync(codeModeHost)) throw new Error("Codex runtime files are missing");
  if (platform !== "win32") {
    accessSync(binary, constants.X_OK);
    accessSync(codeModeHost, constants.X_OK);
  }
  if (hashBytes(readFileSync(binary)) !== entry.sha256 || hashBytes(readFileSync(codeModeHost)) !== entry.codeModeHostSha256) {
    throw new Error("Codex runtime checksum validation failed");
  }
  return { resourcesPath, version: manifest.codexVersion, manifest, entry };
}

async function extractTarGz(archivePath, destination) {
  await execFile("tar", ["-xzf", archivePath, "-C", destination]);
}

export class CodexUpdater extends EventEmitter {
  #bundledResourcesPath;
  #userDataPath;
  #fetch;
  #extractArchive;
  #platform;
  #arch;
  #packageInfo;
  #storeRoot;
  #activeResourcesPath;
  #pendingRuntime = null;
  #availableRelease = null;
  #status;
  #initialTimer = null;
  #intervalTimer = null;
  #started = false;

  constructor({
    bundledResourcesPath,
    userDataPath,
    enabled = true,
    fetchImpl = globalThis.fetch,
    extractArchive = extractTarGz,
    platform = process.platform,
    arch = process.arch
  }) {
    super();
    this.#bundledResourcesPath = bundledResourcesPath;
    this.#userDataPath = userDataPath;
    this.#fetch = fetchImpl;
    this.#extractArchive = extractArchive;
    this.#platform = platform;
    this.#arch = arch;
    this.#packageInfo = platformPackage(platform, arch);
    this.#storeRoot = path.join(userDataPath, "codex-runtime");
    const active = this.#resolveActiveRuntime();
    this.#activeResourcesPath = active?.resourcesPath ?? bundledResourcesPath;
    const bundled = active ?? this.#tryRuntime(bundledResourcesPath);
    const supported = Boolean(this.#packageInfo && bundled && typeof fetchImpl === "function");
    this.#status = {
      supported,
      enabled: Boolean(enabled),
      state: supported ? enabled ? "idle" : "disabled" : "unsupported",
      currentVersion: bundled?.version ?? "unknown",
      availableVersion: null,
      installedVersion: active?.version ?? null,
      checkedAt: null,
      restartRequired: false,
      prompt: false,
      message: supported
        ? enabled ? "Codex update checks are enabled." : "Automatic Codex update checks are off."
        : "Codex updates are unavailable for this runtime."
    };
  }

  activeResourcesPath() {
    return this.#activeResourcesPath;
  }

  snapshot() {
    return { ...this.#status };
  }

  start() {
    if (this.#started || !this.#status.supported) return;
    this.#started = true;
    if (this.#status.enabled) this.#schedule();
  }

  stop() {
    if (this.#initialTimer) clearTimeout(this.#initialTimer);
    if (this.#intervalTimer) clearInterval(this.#intervalTimer);
    this.#initialTimer = null;
    this.#intervalTimer = null;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.#status.enabled === next) return this.snapshot();
    this.#update({
      enabled: next,
      state: next ? "idle" : "disabled",
      prompt: false,
      message: next ? "Codex update checks are enabled." : "Automatic Codex update checks are off."
    });
    this.stop();
    if (next && this.#started) this.#schedule(1_000);
    return this.snapshot();
  }

  async check({ manual = false } = {}) {
    if (!this.#status.supported || !manual && !this.#status.enabled) return this.snapshot();
    if (this.#status.state === "updating") return this.snapshot();
    this.#update({ state: "checking", prompt: false, message: "Checking the official Codex release channel." });
    try {
      const response = await this.#fetch(CHANNEL_URL, { cache: "no-store" });
      if (!response?.ok) throw new Error(`Codex update check failed with HTTP ${response?.status ?? "unknown"}`);
      const release = await response.json();
      const version = normalizeVersion(release.tag_name);
      if (!version) throw new Error("The Codex release channel did not include a valid version");
      const asset = release.assets?.find((candidate) => candidate.name === this.#packageInfo.assetName);
      const expectedPrefix = `https://releases.openai.com/codex/releases/${version}/`;
      if (
        !asset?.browser_download_url?.startsWith(expectedPrefix)
        || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
      ) throw new Error(`The official Codex package for ${this.#packageInfo.target} is unavailable`);

      const checkedAt = new Date().toISOString();
      if (compareCodexVersions(version, this.#status.currentVersion) > 0) {
        this.#availableRelease = { version, asset };
        this.#update({
          state: "available",
          availableVersion: version,
          checkedAt,
          prompt: !manual && this.#status.enabled,
          message: `Codex ${version} is available.`
        });
      } else {
        this.#availableRelease = null;
        this.#update({ state: "not-available", availableVersion: null, checkedAt, prompt: false, message: "Codex is up to date." });
      }
    } catch (error) {
      this.#update({ state: "error", prompt: false, message: error?.message || String(error) });
    }
    return this.snapshot();
  }

  async install() {
    if (!this.#status.supported) return this.snapshot();
    if (!this.#availableRelease) await this.check({ manual: true });
    if (!this.#availableRelease || this.#status.state !== "available") throw new Error("No Codex update is ready to install");
    const { version, asset } = this.#availableRelease;
    this.#update({ state: "updating", prompt: true, message: `Downloading Codex ${version}.` });
    let stagingRoot = null;
    try {
      await mkdir(this.#storeRoot, { recursive: true });
      stagingRoot = await mkdtemp(path.join(this.#storeRoot, ".staging-"));
      const archivePath = path.join(stagingRoot, this.#packageInfo.assetName);
      const packageRoot = path.join(stagingRoot, "runtime", this.#packageInfo.key);
      await mkdir(packageRoot, { recursive: true });

      const response = await this.#fetch(asset.browser_download_url, { cache: "no-store" });
      if (!response?.ok) throw new Error(`Codex download failed with HTTP ${response?.status ?? "unknown"}`);
      const archive = Buffer.from(await response.arrayBuffer());
      if (hashBytes(archive) !== asset.digest.slice(7)) throw new Error("Codex download checksum validation failed");
      await writeFile(archivePath, archive);
      await this.#extractArchive(archivePath, packageRoot);
      await rm(archivePath, { force: true });

      const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, "codex-package.json"), "utf8"));
      if (
        packageMetadata.version !== version
        || packageMetadata.target !== this.#packageInfo.target
        || packageMetadata.entrypoint !== `bin/${this.#packageInfo.binaryName}`
      ) throw new Error("The downloaded Codex package metadata is invalid");
      const binary = path.join(packageRoot, packageMetadata.entrypoint);
      const codeModeHost = path.join(packageRoot, "bin", this.#packageInfo.codeModeHostName);
      if (this.#platform !== "win32") {
        await chmod(binary, 0o755);
        await chmod(codeModeHost, 0o755);
      }
      const binaryHash = hashBytes(await readFile(binary));
      const codeModeHostHash = hashBytes(await readFile(codeModeHost));
      const manifest = {
        schemaVersion: 2,
        runtimeKind: "app-server-package",
        codexVersion: version,
        protocolVersion: `${version}-app-server`,
        channel: "latest",
        platforms: {
          [this.#packageInfo.key]: {
            path: `${this.#packageInfo.key}/${packageMetadata.entrypoint}`,
            sha256: binaryHash,
            codeModeHostPath: `${this.#packageInfo.key}/bin/${this.#packageInfo.codeModeHostName}`,
            codeModeHostSha256: codeModeHostHash,
            sourceUrl: asset.browser_download_url,
            sourceSha256: asset.digest.slice(7)
          }
        }
      };
      await writeFile(path.join(stagingRoot, "runtime", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      validateRuntimeResources(stagingRoot, this.#platform, this.#arch);

      const versionsRoot = path.join(this.#storeRoot, "versions");
      const destination = path.join(versionsRoot, version);
      await mkdir(versionsRoot, { recursive: true });
      const existing = this.#tryRuntime(destination);
      if (existing?.version === version) {
        await rm(stagingRoot, { recursive: true, force: true });
        stagingRoot = null;
      } else {
        await rm(destination, { recursive: true, force: true });
        await rename(stagingRoot, destination);
        stagingRoot = null;
      }
      this.#availableRelease = null;
      this.#pendingRuntime = { version, resourcesPath: destination };
      this.#update({
        state: "applying",
        installedVersion: version,
        availableVersion: version,
        restartRequired: false,
        prompt: true,
        message: `Codex ${version} is verified. Restarting the Codex runtime.`
      });
    } catch (error) {
      this.#update({ state: "error", prompt: true, message: error?.message || String(error) });
    } finally {
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
    return this.snapshot();
  }

  pendingResourcesPath() {
    return this.#pendingRuntime?.resourcesPath ?? null;
  }

  async commitPendingRuntime() {
    if (!this.#pendingRuntime) throw new Error("No verified Codex runtime is ready to activate");
    const { version, resourcesPath } = this.#pendingRuntime;
    await writeFile(path.join(this.#storeRoot, "active.json"), `${JSON.stringify({ version, directory: `versions/${version}`, updatedAt: new Date().toISOString(), nonce: randomUUID() }, null, 2)}\n`);
    this.#activeResourcesPath = resourcesPath;
    this.#pendingRuntime = null;
    this.#update({
      state: "ready",
      currentVersion: version,
      installedVersion: version,
      availableVersion: null,
      restartRequired: false,
      prompt: true,
      message: `Codex ${version} is now active. Pixice stayed open.`
    });
    return this.snapshot();
  }

  failPendingRuntime(error) {
    const version = this.#pendingRuntime?.version ?? this.#status.availableVersion;
    this.#pendingRuntime = null;
    this.#update({
      state: "error",
      installedVersion: null,
      availableVersion: version ?? null,
      restartRequired: false,
      prompt: true,
      message: `Codex ${version ?? "update"} could not start. Pixice restored the previous runtime. ${error?.message || String(error)}`
    });
    return this.snapshot();
  }

  #schedule(delay = STARTUP_DELAY) {
    this.#initialTimer = setTimeout(() => void this.check().catch(() => {}), delay);
    this.#initialTimer.unref?.();
    this.#intervalTimer = setInterval(() => void this.check().catch(() => {}), SIX_HOURS);
    this.#intervalTimer.unref?.();
  }

  #resolveActiveRuntime() {
    try {
      const pointer = JSON.parse(readFileSync(path.join(this.#storeRoot, "active.json"), "utf8"));
      const version = normalizeVersion(pointer.version);
      if (!version || pointer.directory !== `versions/${version}`) return null;
      const candidate = path.join(this.#storeRoot, pointer.directory);
      if (!candidate.startsWith(`${this.#storeRoot}${path.sep}`)) return null;
      return validateRuntimeResources(candidate, this.#platform, this.#arch);
    } catch {
      return null;
    }
  }

  #tryRuntime(resourcesPath) {
    try {
      return validateRuntimeResources(resourcesPath, this.#platform, this.#arch);
    } catch {
      return null;
    }
  }

  #update(patch) {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.snapshot());
  }
}

export async function installAndActivateCodexUpdate({ updater, runtime }) {
  const staged = await updater.install();
  if (staged.state !== "applying") return staged;
  const nextResourcesPath = updater.pendingResourcesPath();
  if (!nextResourcesPath) return updater.failPendingRuntime(new Error("The verified Codex runtime path is missing"));

  const previousResourcesPath = runtime.resourcesPath;
  try {
    await runtime.stop();
    runtime.resourcesPath = nextResourcesPath;
    if (!await runtime.start()) throw new Error("The new Codex runtime did not connect");
    return await updater.commitPendingRuntime();
  } catch (error) {
    await runtime.stop().catch(() => {});
    runtime.resourcesPath = previousResourcesPath;
    const restored = await runtime.start().catch(() => false);
    const detail = restored ? error : new Error(`${error.message}. The previous Codex runtime also failed to reconnect`);
    return updater.failPendingRuntime(detail);
  }
}
