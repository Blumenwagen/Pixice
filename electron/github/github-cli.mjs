import { EventEmitter } from "node:events";
import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function executableName(platform = process.platform) {
  return platform === "win32" ? "gh.exe" : "gh";
}

function executableWorks(candidate, platform = process.platform) {
  if (!candidate || !existsSync(candidate)) return false;
  try {
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveGitHubCli({
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  pathValue = process.env.PATH
} = {}) {
  const name = executableName(platform);
  const bundled = resourcesPath
    ? path.join(resourcesPath, "runtime", `${platform}-${arch}`, "bin", name)
    : null;
  if (executableWorks(bundled, platform)) return { path: bundled, source: "bundled" };
  for (const directory of String(pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (executableWorks(candidate, platform)) return { path: candidate, source: "system" };
  }
  return null;
}

export function prependGitHubCliToPath(environment, resolved, platform = process.platform) {
  if (!resolved?.path) return environment;
  const key = platform === "win32"
    ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === "path") ?? "Path"
    : "PATH";
  const directory = path.dirname(resolved.path);
  const current = String(environment[key] ?? "");
  const entries = current.split(path.delimiter).filter(Boolean);
  if (!entries.includes(directory)) environment[key] = [directory, ...entries].join(path.delimiter);
  return environment;
}

function versionFromOutput(output) {
  return String(output ?? "").match(/gh version\s+([^\s]+)/i)?.[1] ?? null;
}

function loginProgress(text) {
  const normalized = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const code = normalized.match(/(?:one-time code|code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] ?? null;
  if (code) return { state: "waiting", code: code.toUpperCase(), message: `Enter ${code.toUpperCase()} in the GitHub window.` };
  if (/opening.*browser|authenticate.*browser|login\/device/i.test(normalized)) {
    return { state: "waiting", code: null, message: "Complete sign-in in the GitHub window." };
  }
  return null;
}

export class GitHubCli extends EventEmitter {
  constructor({ resourcesPath, resolved = null, run = execFile, spawn = spawnCallback } = {}) {
    super();
    this.resolved = resolved ?? resolveGitHubCli({ resourcesPath });
    this.run = run;
    this.spawn = spawn;
  }

  async status() {
    if (!this.resolved) {
      return {
        available: false,
        authenticated: false,
        source: null,
        version: null,
        account: null,
        message: "GitHub CLI is not available in this build."
      };
    }
    let version = null;
    try {
      const result = await this.run(this.resolved.path, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      version = versionFromOutput(result.stdout);
    } catch {
      // Authentication status below gives the actionable failure.
    }
    try {
      const result = await this.run(this.resolved.path, [
        "api", "user", "--jq", "{login: .login, name: .name, avatarUrl: .avatar_url}"
      ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
      const account = JSON.parse(result.stdout);
      return {
        available: true,
        authenticated: true,
        source: this.resolved.source,
        version,
        account,
        message: `Signed in as ${account.login}.`
      };
    } catch (error) {
      const detail = String(error.stderr ?? error.stdout ?? "").trim();
      return {
        available: true,
        authenticated: false,
        source: this.resolved.source,
        version,
        account: null,
        message: /not logged|authenticate|auth login/i.test(detail) ? "Sign in to use GitHub from agents." : "GitHub authentication could not be verified."
      };
    }
  }

  async login() {
    if (!this.resolved) throw new Error("GitHub CLI is not available in this build");
    this.emit("progress", { state: "starting", code: null, message: "Opening GitHub sign-in…" });
    await this.#spawn([
      "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"
    ], { progress: true });
    const status = await this.status();
    if (!status.authenticated) throw new Error("GitHub sign-in finished without an authenticated account");
    this.emit("progress", { state: "complete", code: null, message: status.message });
    return status;
  }

  async logout() {
    const current = await this.status();
    if (!current.available || !current.authenticated) return current;
    await this.#spawn([
      "auth", "logout", "--hostname", "github.com", "--user", current.account.login
    ], { input: "y\n" });
    return this.status();
  }

  #spawn(args, { input = null, progress = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.resolved.path, args, {
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      const receive = (kind) => (chunk) => {
        const text = chunk.toString();
        if (kind === "stdout") stdout += text;
        else stderr += text;
        const update = progress ? loginProgress(text) : null;
        if (update) this.emit("progress", update);
      };
      child.stdout?.on("data", receive("stdout"));
      child.stderr?.on("data", receive("stderr"));
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`GitHub CLI exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      });
      if (input) child.stdin?.end(input);
    });
  }
}
