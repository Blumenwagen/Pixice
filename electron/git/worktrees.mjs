import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

export async function inspectRepository(folder) {
  try {
    const root = await git(folder, ["rev-parse", "--show-toplevel"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const status = await git(root, ["status", "--porcelain=v1"]);
    return { kind: "git", root, baseCommit, dirtyPaths: status ? status.split("\n").map((line) => line.slice(3)) : [] };
  } catch {
    return { kind: "folder", root: path.resolve(folder), baseCommit: null, dirtyPaths: [] };
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

export async function readDiff({ workingPath, baseCommit }) {
  const args = baseCommit ? ["diff", "--no-ext-diff", baseCommit, "--"] : ["diff", "--no-ext-diff"];
  return git(workingPath, args);
}
