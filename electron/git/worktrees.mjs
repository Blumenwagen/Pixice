import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function gitDiff(cwd, args) {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (error.code === 1 && typeof error.stdout === "string") return error.stdout.trim();
    throw error;
  }
}

export async function inspectRepository(folder) {
  try {
    const canonicalFolder = await realpath(folder);
    const root = await git(folder, ["rev-parse", "--show-toplevel"]);
    const pathspec = path.relative(root, canonicalFolder) || ".";
    if (pathspec.startsWith("..") || path.isAbsolute(pathspec)) throw new Error("Project path is outside its Git repository");
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const status = await git(root, ["status", "--porcelain=v1", "--", pathspec]);
    return { kind: "git", root, baseCommit, dirtyPaths: status ? status.split("\n").map((line) => line.slice(3)) : [] };
  } catch (error) {
    const diagnostic = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/not a git repository/i.test(diagnostic)) {
      return { kind: "folder", root: path.resolve(folder), baseCommit: null, dirtyPaths: [] };
    }
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

export async function readDiff({ workingPath, baseCommit, scopePath = workingPath }) {
  const [canonicalWorkingPath, canonicalScopePath] = await Promise.all([realpath(workingPath), realpath(scopePath)]);
  const pathspec = path.relative(canonicalWorkingPath, canonicalScopePath) || ".";
  if (pathspec.startsWith("..") || path.isAbsolute(pathspec)) throw new Error("Diff scope is outside the Git repository");
  const args = baseCommit
    ? ["diff", "--no-ext-diff", baseCommit, "--", pathspec]
    : ["diff", "--no-ext-diff", "--", pathspec];
  const tracked = await git(workingPath, args);
  const untrackedOutput = await git(workingPath, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec]);
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  const additions = new Array(untracked.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, untracked.length) }, async () => {
    while (nextIndex < untracked.length) {
      const index = nextIndex;
      nextIndex += 1;
      additions[index] = await gitDiff(workingPath, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", untracked[index]]);
    }
  }));
  return [tracked, ...additions].filter(Boolean).join("\n");
}
