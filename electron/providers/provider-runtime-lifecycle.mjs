import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { constants, accessSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const OUTPUT_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export const PROVIDER_RELEASE_CHANNELS = Object.freeze({
  codex: "https://releases.openai.com/codex/channels/latest",
  claude: "https://downloads.claude.ai/claude-code-releases/latest"
});

// Pixice's Codex protocol adapter was validated against 0.149.0. The Claude
// Agent SDK dependency in package.json embeds Claude Code 2.1.234. Older
// executables stay visible for Repair or Locate, but Pixice does not start them.
export const PROVIDER_COMPATIBILITY = Object.freeze({
  codex: Object.freeze({ minimumVersion: "0.149.0", capability: "app-server" }),
  claude: Object.freeze({ minimumVersion: "2.1.234", capability: "claude-agent-sdk" })
});

const PROVIDER_DEFINITIONS = Object.freeze({
  codex: Object.freeze({
    label: "Codex",
    environmentVariable: "PIXICE_CODEX_PATH",
    executableNames: Object.freeze(["codex"]),
    versionArgs: Object.freeze(["--version"]),
    healthArgs: Object.freeze(["app-server", "--help"]),
    logoutArgs: Object.freeze(["logout"])
  }),
  claude: Object.freeze({
    label: "Claude Code",
    environmentVariable: "PIXICE_CLAUDE_PATH",
    executableNames: Object.freeze(["claude"]),
    versionArgs: Object.freeze(["--version"]),
    healthArgs: Object.freeze(["--help"]),
    logoutArgs: Object.freeze(["auth", "logout"])
  })
});

function executableFilenames(definition, platform) {
  if (platform !== "win32") return [...definition.executableNames];
  return definition.executableNames.flatMap((name) => [`${name}.exe`, `${name}.cmd`]);
}

function nodeManagerBins(homeDirectory) {
  const directories = [
    path.join(homeDirectory, ".volta", "bin"),
    path.join(homeDirectory, ".asdf", "shims"),
    path.join(homeDirectory, ".local", "share", "mise", "shims"),
    path.join(homeDirectory, ".npm-global", "bin")
  ];
  const nvmVersions = path.join(homeDirectory, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmVersions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    for (const version of versions) {
      if (version.isDirectory()) directories.push(path.join(nvmVersions, version.name, "bin"));
    }
  } catch {
    // nvm is optional.
  }
  return directories;
}

function platformInstallBins({ provider, homeDirectory, platform, environment }) {
  if (platform === "win32") {
    const appData = environment.APPDATA || path.join(homeDirectory, "AppData", "Roaming");
    const localAppData = environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local");
    return [
      path.join(homeDirectory, ".local", "bin"),
      path.join(homeDirectory, provider === "codex" ? ".codex" : ".claude", "bin"),
      path.join(appData, "npm"),
      path.join(localAppData, "Microsoft", "WinGet", "Links")
    ];
  }
  return [
    path.join(homeDirectory, ".local", "bin"),
    ...(provider === "codex"
      ? [path.join(homeDirectory, ".codex", "bin")]
      : [path.join(homeDirectory, ".claude", "local"), path.join(homeDirectory, ".claude", "bin")]),
    ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin"
  ];
}

function canExecute(candidate, platform) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueAbsolutePaths(values) {
  const seen = new Set();
  return values.flatMap((value) => {
    if (!value) return [];
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    return [resolved];
  });
}

export function providerExecutableCandidates({
  provider,
  savedPath = null,
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  pathValue = environment.PATH ?? environment.Path ?? environment.path
} = {}) {
  const definition = PROVIDER_DEFINITIONS[provider];
  if (!definition) throw new Error(`Unknown provider ${provider}`);
  const filenames = executableFilenames(definition, platform);
  const knownBins = [...platformInstallBins({ provider, homeDirectory, platform, environment }), ...nodeManagerBins(homeDirectory)];
  const inheritedBins = String(pathValue ?? "").split(path.delimiter).filter(Boolean);
  return uniqueAbsolutePaths([
    savedPath,
    environment[definition.environmentVariable],
    ...knownBins.flatMap((directory) => filenames.map((filename) => path.join(directory, filename))),
    ...inheritedBins.flatMap((directory) => filenames.map((filename) => path.join(directory, filename)))
  ]);
}

export function officialProviderInstaller(provider, platform = process.platform) {
  if (!PROVIDER_DEFINITIONS[provider]) throw new Error(`Unknown provider ${provider}`);
  if (platform === "win32") {
    const url = provider === "codex" ? "https://chatgpt.com/codex/install.ps1" : "https://claude.ai/install.ps1";
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ProgressPreference='Continue'; irm ${url} | iex`]
    };
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const command = provider === "codex"
    ? "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"
    : "curl -fsSL https://claude.ai/install.sh | bash";
  return { command: "/bin/sh", args: ["-c", command] };
}

export function providerCommandEnvironment(command, environment = process.env) {
  if (!path.isAbsolute(command)) return environment;
  const executableDirectory = path.dirname(command);
  const inheritedPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const childEnvironment = { ...environment };
  delete childEnvironment.Path;
  delete childEnvironment.path;
  childEnvironment.PATH = [executableDirectory, inheritedPath].filter(Boolean).join(path.delimiter);
  return childEnvironment;
}

export function runProviderCommand(command, args = [], {
  spawnImpl = spawn,
  timeoutMs = COMMAND_TIMEOUT_MS,
  environment = process.env,
  onOutput = null,
  platform = process.platform
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      env: providerCommandEnvironment(command, environment),
      windowsHide: true,
      shell: platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (stream, chunk) => {
      const text = chunk.toString();
      if (stream === "stdout") stdout = `${stdout}${text}`.slice(-OUTPUT_LIMIT);
      else stderr = `${stderr}${text}`.slice(-OUTPUT_LIMIT);
      onOutput?.({ stream, text });
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.("SIGKILL");
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ code, signal, stdout, stderr });
      else reject(Object.assign(new Error((stderr || stdout || `Command exited with ${code ?? signal}`).trim()), {
        code: "PROVIDER_COMMAND_FAILED",
        exitCode: code,
        signal,
        stdout,
        stderr
      }));
    });
  });
}

function firstOutputLine(output) {
  return String(output ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function parseVersion(value) {
  const match = String(value ?? "").match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareProviderVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function normalizedVersion(value) {
  return parseVersion(value)?.join(".") ?? null;
}

export async function latestProviderVersion(provider, {
  fetchImpl = globalThis.fetch,
  signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) : undefined
} = {}) {
  const url = PROVIDER_RELEASE_CHANNELS[provider];
  if (!url) throw new Error(`Unknown provider ${provider}`);
  if (typeof fetchImpl !== "function") throw new Error("Provider update checks require network access");
  const response = await fetchImpl(url, { cache: "no-store", signal });
  if (!response?.ok) throw new Error(`${PROVIDER_DEFINITIONS[provider].label} update check failed with HTTP ${response?.status ?? "unknown"}`);
  const rawVersion = provider === "codex"
    ? (await response.json())?.tag_name
    : await response.text();
  const version = normalizedVersion(rawVersion);
  if (!version) throw new Error(`${PROVIDER_DEFINITIONS[provider].label} release channel returned an invalid version`);
  return version;
}

function incompatibleVersionError(label, reportedVersion, minimumVersion) {
  const error = new Error(`${label} ${reportedVersion} is incompatible with this Pixice build. Version ${minimumVersion} or newer is required.`);
  error.code = "PROVIDER_VERSION_INCOMPATIBLE";
  error.reportedVersion = reportedVersion;
  return error;
}

function idleInstallState() {
  return { state: "idle", operation: null, message: null, progress: null, startedAt: null, completedAt: null, error: null };
}

function idleUpdateState() {
  return { state: "idle", availableVersion: null, checkedAt: null, message: null, startedAt: null, completedAt: null, error: null };
}

export class ProviderRuntimeLifecycle extends EventEmitter {
  constructor({
    provider,
    database,
    environment = process.env,
    homeDirectory = homedir(),
    platform = process.platform,
    spawnImpl = spawn,
    commandRunner = runProviderCommand,
    fetchImpl = globalThis.fetch
  }) {
    super();
    if (!PROVIDER_DEFINITIONS[provider]) throw new Error(`Unknown provider ${provider}`);
    this.provider = provider;
    this.definition = PROVIDER_DEFINITIONS[provider];
    this.database = database;
    this.environment = environment;
    this.homeDirectory = homeDirectory;
    this.platform = platform;
    this.installer = officialProviderInstaller(provider, platform);
    this.spawnImpl = spawnImpl;
    this.commandRunner = commandRunner;
    this.fetchImpl = fetchImpl;
    this.executablePath = null;
    this.version = null;
    this.compatible = false;
    this.health = { state: "missing", message: `${this.definition.label} is not installed` };
    this.installState = idleInstallState();
    this.updateState = idleUpdateState();
    this.activeOperation = null;
  }

  snapshot() {
    const installed = Boolean(this.executablePath);
    const busy = Boolean(this.activeOperation);
    const automaticInstallSupported = Boolean(this.installer);
    return {
      installed,
      automaticInstallSupported,
      installState: { ...this.installState },
      updateState: { ...this.updateState },
      executablePath: this.executablePath,
      version: this.version,
      compatible: this.compatible,
      health: { ...this.health },
      actions: {
        install: automaticInstallSupported && !installed && !busy,
        locate: !busy,
        repair: automaticInstallSupported && installed && !busy,
        checkUpdate: installed && this.compatible && typeof this.fetchImpl === "function" && !busy,
        update: installed && this.compatible && this.updateState.state === "available" && !busy,
        login: installed && this.compatible && !busy,
        logout: installed && this.compatible && !busy
      }
    };
  }

  async discover({ ignoreSaved = false } = {}) {
    const savedPath = ignoreSaved ? null : this.database?.getAppSettings?.().providerExecutablePaths?.[this.provider];
    const candidates = providerExecutableCandidates({
      provider: this.provider,
      savedPath,
      environment: this.environment,
      homeDirectory: this.homeDirectory,
      platform: this.platform
    });
    let lastError = null;
    let firstBrokenPath = savedPath && path.isAbsolute(savedPath) ? path.resolve(savedPath) : null;
    let firstIncompatible = null;
    for (const candidate of candidates) {
      if (!canExecute(candidate, this.platform)) continue;
      firstBrokenPath ??= candidate;
      try {
        const details = await this.#probe(candidate);
        this.#applyProbe(candidate, details);
        this.#persistExecutable(candidate);
        this.#emitSnapshot();
        return this.snapshot();
      } catch (error) {
        lastError = error;
        if (error.code === "PROVIDER_VERSION_INCOMPATIBLE" && !firstIncompatible) {
          firstIncompatible = { executablePath: candidate, version: error.reportedVersion, message: error.message };
        }
      }
    }
    this.executablePath = firstIncompatible?.executablePath ?? firstBrokenPath;
    this.version = firstIncompatible?.version ?? null;
    this.compatible = false;
    this.health = {
      state: firstIncompatible ? "incompatible" : firstBrokenPath ? "broken" : "missing",
      message: firstIncompatible?.message ?? lastError?.message ?? this.#missingMessage()
    };
    this.#emitSnapshot();
    return this.snapshot();
  }

  async locate(executablePath) {
    if (this.activeOperation) throw new Error(`${this.definition.label} is already ${this.activeOperation}`);
    if (!path.isAbsolute(executablePath)) throw new Error("Provider executable path must be absolute");
    if (!canExecute(executablePath, this.platform)) throw new Error(`${executablePath} is not an executable file`);
    const details = await this.#probe(executablePath);
    this.#applyProbe(path.resolve(executablePath), details);
    this.#persistExecutable(this.executablePath);
    this.#emitSnapshot();
    return this.snapshot();
  }

  install() {
    return this.#runInstaller("installing");
  }

  repair() {
    return this.#runInstaller("repairing");
  }

  async checkForUpdate() {
    if (this.activeOperation) return this.snapshot();
    if (!this.executablePath || !this.compatible) {
      this.updateState = {
        ...idleUpdateState(),
        state: "unavailable",
        message: `${this.definition.label} must be installed and healthy before checking for updates`
      };
      this.#emitSnapshot();
      return this.snapshot();
    }
    if (typeof this.fetchImpl !== "function") {
      this.updateState = {
        ...idleUpdateState(),
        state: "unsupported",
        message: `${this.definition.label} update checks are unavailable`
      };
      this.#emitSnapshot();
      return this.snapshot();
    }
    this.activeOperation = "checking-update";
    this.updateState = {
      ...this.updateState,
      state: "checking",
      message: `Checking ${this.definition.label} for updates`,
      error: null
    };
    this.#emitSnapshot();
    try {
      const availableVersion = await latestProviderVersion(this.provider, { fetchImpl: this.fetchImpl });
      const currentVersion = parseVersion(this.version);
      if (!currentVersion) throw new Error(`${this.definition.label} did not report a comparable installed version`);
      const checkedAt = new Date().toISOString();
      if (compareProviderVersions(parseVersion(availableVersion), currentVersion) > 0) {
        this.updateState = {
          ...idleUpdateState(),
          state: "available",
          availableVersion,
          checkedAt,
          message: `${this.definition.label} ${availableVersion} is available`
        };
      } else {
        this.updateState = {
          ...idleUpdateState(),
          state: "not-available",
          checkedAt,
          message: `${this.definition.label} is up to date`
        };
      }
    } catch (error) {
      this.updateState = {
        ...this.updateState,
        state: "error",
        message: error.message,
        error: error.message
      };
    } finally {
      this.activeOperation = null;
      this.#emitSnapshot();
    }
    return this.snapshot();
  }

  async update() {
    if (this.activeOperation) throw new Error(`${this.definition.label} is already ${this.activeOperation}`);
    if (this.updateState.state !== "available") await this.checkForUpdate();
    if (this.updateState.state !== "available" || !this.updateState.availableVersion) {
      throw new Error(`No ${this.definition.label} update is available`);
    }
    const targetVersion = this.updateState.availableVersion;
    this.activeOperation = "updating";
    this.updateState = {
      ...this.updateState,
      state: "updating",
      message: `Updating ${this.definition.label} to ${targetVersion}`,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };
    this.#emitSnapshot();
    try {
      if (this.provider === "codex") {
        if (!this.installer) throw new Error(`Automatic ${this.definition.label} updates are unavailable on this platform`);
        await this.commandRunner(this.installer.command, this.installer.args, {
          spawnImpl: this.spawnImpl,
          timeoutMs: INSTALL_TIMEOUT_MS,
          environment: this.environment,
          platform: this.platform
        });
      } else {
        await this.commandRunner(this.executablePath, ["update"], {
          spawnImpl: this.spawnImpl,
          timeoutMs: INSTALL_TIMEOUT_MS,
          environment: this.environment,
          platform: this.platform
        });
      }
      const discovered = await this.discover();
      const installedVersion = parseVersion(discovered.version);
      if (!discovered.installed || !discovered.compatible || !installedVersion) {
        throw new Error(`${this.definition.label} update finished, but the runtime is not healthy`);
      }
      if (compareProviderVersions(installedVersion, parseVersion(targetVersion)) < 0) {
        throw new Error(`${this.definition.label} update finished, but version ${targetVersion} was not installed`);
      }
      this.updateState = {
        ...idleUpdateState(),
        state: "succeeded",
        checkedAt: new Date().toISOString(),
        message: `${this.definition.label} ${normalizedVersion(discovered.version)} is ready`,
        completedAt: new Date().toISOString()
      };
    } catch (error) {
      this.updateState = {
        ...this.updateState,
        state: "error",
        message: error.message,
        completedAt: new Date().toISOString(),
        error: error.message
      };
      throw error;
    } finally {
      this.activeOperation = null;
      this.#emitSnapshot();
    }
    return this.snapshot();
  }

  runExecutable(args, options = {}) {
    if (!this.executablePath || !this.compatible) throw new Error(`${this.definition.label} is not available`);
    return this.commandRunner(this.executablePath, args, {
      spawnImpl: this.spawnImpl,
      environment: this.environment,
      platform: this.platform,
      ...options
    });
  }

  logoutCommand() {
    return this.runExecutable(this.definition.logoutArgs);
  }

  async #runInstaller(operation) {
    if (this.activeOperation) throw new Error(`${this.definition.label} is already ${this.activeOperation}`);
    this.activeOperation = operation;
    this.installState = {
      ...idleInstallState(),
      state: operation,
      operation,
      message: operation === "installing" ? `Installing ${this.definition.label}` : `Repairing ${this.definition.label}`,
      startedAt: new Date().toISOString()
    };
    this.#emitSnapshot();
    const installer = this.installer;
    try {
      if (!installer) {
        throw new Error(`Automatic ${this.definition.label} installation is unavailable on this platform. Install it manually, then locate the executable.`);
      }
      await this.commandRunner(installer.command, installer.args, {
        spawnImpl: this.spawnImpl,
        timeoutMs: INSTALL_TIMEOUT_MS,
        environment: this.environment,
        platform: this.platform,
        onOutput: ({ text }) => {
          const progress = firstOutputLine(text);
          if (!progress) return;
          this.installState = { ...this.installState, progress, message: progress };
          this.#emitSnapshot();
        }
      });
      const discovered = await this.discover({ ignoreSaved: true });
      if (!discovered.installed || !discovered.compatible) {
        throw new Error(`${this.definition.label} installer finished, but Pixice could not find a compatible executable`);
      }
      this.installState = {
        ...this.installState,
        state: "succeeded",
        message: `${this.definition.label} is ready`,
        completedAt: new Date().toISOString(),
        error: null
      };
    } catch (error) {
      this.installState = {
        ...this.installState,
        state: "failed",
        message: error.message,
        completedAt: new Date().toISOString(),
        error: error.message
      };
      throw error;
    } finally {
      this.activeOperation = null;
      this.#emitSnapshot();
    }
    return this.snapshot();
  }

  async #probe(executablePath) {
    const versionResult = await this.commandRunner(executablePath, this.definition.versionArgs, {
      spawnImpl: this.spawnImpl,
      environment: this.environment,
      platform: this.platform
    });
    const version = firstOutputLine(versionResult.stdout || versionResult.stderr);
    if (!version) throw new Error(`${this.definition.label} did not report a version`);
    const parsedVersion = parseVersion(version);
    const minimumVersion = PROVIDER_COMPATIBILITY[this.provider].minimumVersion;
    if (!parsedVersion) throw incompatibleVersionError(this.definition.label, version, minimumVersion);
    if (compareProviderVersions(parsedVersion, parseVersion(minimumVersion)) < 0) {
      throw incompatibleVersionError(this.definition.label, version, minimumVersion);
    }
    await this.commandRunner(executablePath, this.definition.healthArgs, {
      spawnImpl: this.spawnImpl,
      environment: this.environment,
      platform: this.platform
    });
    return { version };
  }

  #applyProbe(executablePath, { version }) {
    this.executablePath = executablePath;
    this.version = version;
    this.compatible = true;
    this.health = { state: "healthy", message: `${this.definition.label} ${version} is ready` };
  }

  #persistExecutable(executablePath) {
    if (!this.database?.saveAppSettings) return;
    const paths = this.database.getAppSettings?.().providerExecutablePaths ?? {};
    if (paths[this.provider] === executablePath) return;
    this.database.saveAppSettings({ providerExecutablePaths: { ...paths, [this.provider]: executablePath } });
  }

  #missingMessage() {
    if (this.installer) return `${this.definition.label} is not installed`;
    return `Automatic ${this.definition.label} installation is unavailable on this platform. Install it manually, then locate the executable.`;
  }

  #emitSnapshot() {
    this.emit("state", this.snapshot());
  }
}
