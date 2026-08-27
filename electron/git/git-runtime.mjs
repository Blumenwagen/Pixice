import { execFile as execFileCallback } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GIT_PROBE_TIMEOUT_MS = 10_000;

function canExecute(candidate, platform = process.platform) {
  if (!candidate || !path.isAbsolute(candidate)) return false;
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(values) {
  const seen = new Set();
  return values.flatMap((value) => {
    if (!value) return [];
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    return [resolved];
  });
}

export function gitExecutableCandidates({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform
} = {}) {
  const inheritedPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const executableName = platform === "win32" ? "git.exe" : "git";
  const inherited = String(inheritedPath).split(path.delimiter).filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  const known = platform === "darwin"
    ? ["/opt/homebrew/bin/git", "/usr/local/bin/git", path.join(homeDirectory, ".local", "bin", "git"), "/usr/bin/git"]
    : platform === "win32"
      ? [
          path.join(environment.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe"),
          path.join(environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"), "Programs", "Git", "cmd", "git.exe")
        ]
      : [path.join(homeDirectory, ".local", "bin", "git"), "/usr/local/bin/git", "/usr/bin/git"];
  return uniquePaths([...inherited, ...known]);
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export function gitUnavailableState({ platform = process.platform, commandLineToolsMissing = false, message = null } = {}) {
  const installSupported = platform === "darwin" && commandLineToolsMissing;
  return {
    state: commandLineToolsMissing ? "command-line-tools-missing" : "missing",
    available: false,
    installSupported,
    executablePath: null,
    version: null,
    message: message ?? (commandLineToolsMissing
      ? "Apple Command Line Tools are not installed. Pixice can still work with folders, but Git features are unavailable."
      : "Git is not installed. Pixice can still work with folders, but Git features are unavailable.")
  };
}

export function gitRuntimeFromError(error, { platform = process.platform } = {}) {
  const detail = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  const commandLineToolsMissing = platform === "darwin" && /invalid active developer path|command line developer tools|no developer tools were found|unable to find utility ["']?git/i.test(detail);
  if (commandLineToolsMissing) return gitUnavailableState({ platform, commandLineToolsMissing: true });
  if (error?.code === "ENOENT") return gitUnavailableState({ platform });
  return null;
}

async function commandLineToolsAvailable(run) {
  try {
    await run("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function probeGit(executablePath, run) {
  const result = await run(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: GIT_PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  return firstLine(result.stdout || result.stderr);
}

export async function detectGitRuntime({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  run = execFile,
  executableCheck = canExecute
} = {}) {
  const candidates = gitExecutableCandidates({ environment, homeDirectory, platform });
  const systemGit = platform === "darwin" ? "/usr/bin/git" : null;
  let lastUnavailable = null;

  for (const candidate of candidates.filter((value) => value !== systemGit)) {
    if (!executableCheck(candidate, platform)) continue;
    try {
      const version = await probeGit(candidate, run);
      if (!version) continue;
      return {
        state: "ready",
        available: true,
        installSupported: false,
        executablePath: candidate,
        version,
        message: `${version} is ready.`
      };
    } catch (error) {
      lastUnavailable = gitRuntimeFromError(error, { platform }) ?? lastUnavailable;
    }
  }

  if (systemGit && executableCheck(systemGit, platform)) {
    if (!await commandLineToolsAvailable(run)) {
      return gitUnavailableState({ platform, commandLineToolsMissing: true });
    }
    try {
      const version = await probeGit(systemGit, run);
      if (version) {
        return {
          state: "ready",
          available: true,
          installSupported: false,
          executablePath: systemGit,
          version,
          message: `${version} is ready.`
        };
      }
    } catch (error) {
      lastUnavailable = gitRuntimeFromError(error, { platform }) ?? lastUnavailable;
    }
  }

  return lastUnavailable ?? gitUnavailableState({ platform });
}

export async function requestCommandLineToolsInstall({
  platform = process.platform,
  run = execFile,
  detect = () => detectGitRuntime({ platform, run })
} = {}) {
  if (platform !== "darwin") throw new Error("Apple Command Line Tools installation is available only on macOS");
  const current = await detect();
  if (current.available) return current;
  if (!current.installSupported) throw new Error("Git is unavailable, but Apple Command Line Tools installation cannot repair this state automatically");
  await run("/usr/bin/xcode-select", ["--install"], { encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true });
  return {
    ...current,
    state: "install-requested",
    installRequested: true,
    message: "Finish the Apple Command Line Tools installation, then choose Check again."
  };
}
