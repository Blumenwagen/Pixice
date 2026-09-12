import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { detectGitRuntime, gitRuntimeFromError } from "./git-runtime.mjs";

const execFileAsync = promisify(execFile);
const REVIEW_FILTER_OVERRIDES = [
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.required=false"
];

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function git(cwd, args, executablePath = "git") {
  const { stdout } = await execFileAsync(executablePath, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function gitUntrackedDiff(cwd, args, executablePath = "git") {
  try {
    return await git(cwd, [...REVIEW_FILTER_OVERRIDES, ...args], executablePath);
  } catch (error) {
    if (error.code === 1 && typeof error.stdout === "string") return error.stdout.trim();
    throw error;
  }
}

async function diffScope(workingPath, scopePath) {
  const [canonicalWorkingPath, canonicalScopePath] = await Promise.all([realpath(workingPath), realpath(scopePath)]);
  const pathspec = path.relative(canonicalWorkingPath, canonicalScopePath) || ".";
  if (pathspec.startsWith("..") || path.isAbsolute(pathspec)) throw new Error("Diff scope is outside the Git repository");
  return { canonicalWorkingPath, canonicalScopePath, pathspec };
}

function parseNumstat(output) {
  const stats = new Map();
  for (const line of String(output ?? "").split("\n")) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    stats.set(filePath, {
      plus: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      minus: deleted === "-" ? 0 : Number.parseInt(deleted, 10) || 0,
      binary: added === "-" || deleted === "-"
    });
  }
  return stats;
}

function folderRepository(root, gitRuntime) {
  return { kind: "folder", root, baseCommit: null, dirtyPaths: [], git: gitRuntime };
}

export async function inspectRepository(folder, { gitRuntime = null, platform = process.platform } = {}) {
  const canonicalFolder = await realpath(folder);
  const runtime = gitRuntime ?? await detectGitRuntime({ platform });
  if (!runtime.available) return folderRepository(canonicalFolder, runtime);
  try {
    const executablePath = runtime.executablePath;
    const root = await git(canonicalFolder, ["rev-parse", "--show-toplevel"], executablePath);
    const pathspec = path.relative(root, canonicalFolder) || ".";
    if (pathspec.startsWith("..") || path.isAbsolute(pathspec)) throw new Error("Project path is outside its Git repository");
    const baseCommit = await git(root, ["rev-parse", "HEAD"], executablePath);
    const status = await git(root, ["status", "--porcelain=v1", "--", pathspec], executablePath);
    return { kind: "git", root, baseCommit, dirtyPaths: status ? status.split("\n").map((line) => line.slice(3)) : [], git: runtime };
  } catch (error) {
    const diagnostic = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/not a git repository/i.test(diagnostic)) {
      return folderRepository(canonicalFolder, runtime);
    }
    const unavailable = gitRuntimeFromError(error, { platform });
    if (unavailable) return folderRepository(canonicalFolder, unavailable);
    throw error;
  }
}

export async function createIsolatedWorktree({ root, destination, branch, baseCommit }) {
  await git(root, ["worktree", "add", "-b", branch, destination, baseCommit]);
  return { branch, worktreePath: destination, baseCommit };
}

export async function removeCleanWorktree({ root, worktreePath }) {
  const status = await git(worktreePath, ["status", "--porcelain=v1"]);
  if (status) throw new Error("Worktree has uncommitted changes and cannot be removed");
  await git(root, ["worktree", "remove", worktreePath]);
}

export async function readDiff({ workingPath, baseCommit, scopePath = workingPath, gitExecutablePath = "git" }) {
  const { pathspec } = await diffScope(workingPath, scopePath);
  const args = baseCommit
    ? ["diff", "--no-ext-diff", baseCommit, "--", pathspec]
    : ["diff", "--no-ext-diff", "--", pathspec];
  const tracked = await git(workingPath, args, gitExecutablePath);
  const untrackedOutput = await git(workingPath, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec], gitExecutablePath);
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  const additions = new Array(untracked.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, untracked.length) }, async () => {
    while (nextIndex < untracked.length) {
      const index = nextIndex;
      nextIndex += 1;
      additions[index] = await gitUntrackedDiff(workingPath, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", untracked[index]], gitExecutablePath);
    }
  }));
  return [tracked, ...additions].filter(Boolean).join("\n");
}

export async function readDiffManifest({ workingPath, baseCommit, scopePath = workingPath, gitExecutablePath = "git" }) {
  const { pathspec } = await diffScope(workingPath, scopePath);
  const trackedArgs = baseCommit
    ? ["diff", "--no-ext-diff", "--no-renames", "--numstat", baseCommit, "--", pathspec]
    : ["diff", "--no-ext-diff", "--no-renames", "--numstat", "--", pathspec];
  const [trackedOutput, untrackedOutput] = await Promise.all([
    git(workingPath, trackedArgs, gitExecutablePath),
    git(workingPath, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec], gitExecutablePath)
  ]);
  const stats = parseNumstat(trackedOutput);
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, untracked.length) }, async () => {
    while (nextIndex < untracked.length) {
      const index = nextIndex;
      nextIndex += 1;
      const filePath = untracked[index];
      const output = await gitUntrackedDiff(workingPath, ["diff", "--no-ext-diff", "--no-index", "--numstat", "--", "/dev/null", filePath], gitExecutablePath);
      const candidate = [...parseNumstat(output).values()][0] ?? { plus: 0, minus: 0, binary: false };
      stats.set(filePath, candidate);
    }
  }));
  const scopePrefix = pathspec === "." ? "" : `${pathspec.replace(/\/$/, "")}/`;
  return [...stats.entries()].flatMap(([filePath, stat]) => {
    if (scopePrefix && !filePath.startsWith(scopePrefix)) return [];
    return [{ path: scopePrefix ? filePath.slice(scopePrefix.length) : filePath, ...stat }];
  });
}

export async function readFileDiff({ workingPath, baseCommit, scopePath = workingPath, filePath, gitExecutablePath = "git" }) {
  const { canonicalWorkingPath, canonicalScopePath } = await diffScope(workingPath, scopePath);
  const absoluteFilePath = path.resolve(canonicalScopePath, filePath);
  const relativeToScope = path.relative(canonicalScopePath, absoluteFilePath);
  if (relativeToScope.startsWith("..") || path.isAbsolute(relativeToScope)) throw new Error("Diff file is outside the project scope");
  const pathspec = path.relative(canonicalWorkingPath, absoluteFilePath);
  const relativeScope = path.relative(canonicalWorkingPath, canonicalScopePath);
  const relativeArgs = relativeScope ? [`--relative=${relativeScope}`] : [];
  const args = baseCommit
    ? ["diff", "--no-ext-diff", ...relativeArgs, baseCommit, "--", pathspec]
    : ["diff", "--no-ext-diff", ...relativeArgs, "--", pathspec];
  const tracked = await git(workingPath, args, gitExecutablePath);
  if (tracked) return tracked;
  let canonicalParentPath;
  let canonicalTargetPath;
  try {
    canonicalParentPath = await realpath(path.dirname(absoluteFilePath));
    canonicalTargetPath = await realpath(absoluteFilePath);
  } catch {
    return "";
  }
  if (!isWithin(canonicalScopePath, canonicalParentPath) || !isWithin(canonicalScopePath, canonicalTargetPath)) {
    throw new Error("Diff file is outside the project scope");
  }
  try {
    const metadata = await lstat(absoluteFilePath);
    if (!metadata.isFile()) return "";
  } catch {
    return "";
  }
  const canonicalRelativePath = path.relative(canonicalScopePath, canonicalTargetPath);
  return gitUntrackedDiff(canonicalScopePath, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", canonicalRelativePath], gitExecutablePath);
}
