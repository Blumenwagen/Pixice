import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectGitRuntime } from "./git-runtime.mjs";

const run = promisify(execFile);
const FILTERS = ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false"];

async function git(root, args, options = {}) {
  const { stdout } = await run(options.executable ?? "git", ["--literal-pathspecs", ...FILTERS, ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, ...options.env }, windowsHide: true
  });
  return stdout.trimEnd();
}

// An alternate index captures staged, unstaged and unignored files without
// changing the user's index, branch, working files, or stash.
async function workingTree(repository) {
  const temporary = await mkdtemp(path.join(tmpdir(), "pixice-snapshot-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
    const options = { env, executable: repository.executable };
    await git(repository.root, ["read-tree", "HEAD"], options);
    await git(repository.root, ["add", "-A", "--", ...repository.scopes], options);
    return await git(repository.root, ["write-tree"], options);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function captureTaskSnapshot(folders) {
  const repositories = [];
  const mappedFolders = [];
  const runtime = await detectGitRuntime();
  if (!runtime.available) throw new Error("Model replay requires Git to be installed.");
  for (const folder of folders) {
    const canonicalFolder = await realpath(folder);
    let root, baseCommit;
    try {
      root = await git(canonicalFolder, ["rev-parse", "--show-toplevel"], { executable: runtime.executablePath });
      baseCommit = await git(root, ["rev-parse", "HEAD"], { executable: runtime.executablePath });
    } catch { throw new Error("Model replay requires a Git repository with an initial commit."); }
    let index = repositories.findIndex((repo) => repo.root === root);
    if (index < 0) {
      index = repositories.length;
      repositories.push({ root, executable: runtime.executablePath, scopes: [], baseCommit });
    }
    const relative = path.relative(root, canonicalFolder) || ".";
    repositories[index].scopes.push(relative);
    mappedFolders.push({ repository: index, relative });
  }
  for (const repository of repositories) {
    const submodules = await git(repository.root, ["ls-files", "--stage", "--", ...repository.scopes], { executable: repository.executable });
    if (/^160000 /m.test(submodules)) throw new Error("Model replay cannot yet preserve submodule workspaces.");
    repository.tree = await workingTree(repository);
    const env = { GIT_AUTHOR_NAME: "Pixice", GIT_AUTHOR_EMAIL: "snapshots@pixice.local", GIT_COMMITTER_NAME: "Pixice", GIT_COMMITTER_EMAIL: "snapshots@pixice.local" };
    repository.commit = await git(repository.root, ["commit-tree", repository.tree, "-p", repository.baseCommit, "-m", "Pixice task starting workspace"], { env, executable: repository.executable });
    repository.ref = `refs/pixice/task-starts/${randomUUID()}`;
    await git(repository.root, ["update-ref", repository.ref, repository.commit], { executable: repository.executable });
  }
  return { repositories, folders: mappedFolders, capturedAt: new Date().toISOString() };
}

export async function createReplayWorkspace(snapshot, destination) {
  await mkdir(destination, { recursive: true });
  const roots = [];
  try {
    for (const [index, repository] of snapshot.repositories.entries()) {
      const root = path.join(destination, `workspace-${index + 1}`);
      await git(repository.root, ["worktree", "add", "--detach", root, repository.commit], { executable: repository.executable });
      roots.push(root);
    }
    return {
      folders: snapshot.folders.map(({ repository, relative }) => path.resolve(roots[repository], relative)),
      snapshot: { ...snapshot, repositories: snapshot.repositories.map((repo, index) => ({ ...repo, root: roots[index] })) }
    };
  } catch (error) {
    // These worktrees have not been exposed to an agent or user yet.
    for (const [index, root] of roots.entries()) {
      await git(snapshot.repositories[index].root, ["worktree", "remove", root]).catch(() => {});
    }
    throw error;
  }
}

export async function taskWorkspaceChanges(snapshot) {
  const files = [];
  const patches = [];
  const repositoryPatches = [];
  let truncated = false;
  for (const repository of snapshot.repositories) {
    const current = await workingTree(repository);
    const options = { executable: repository.executable };
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const stats = await git(repository.root, [...args, "--numstat", "-z", repository.tree, current, "--", ...repository.scopes], options);
    for (const record of stats.split("\0").filter(Boolean)) {
      const [added, removed, ...name] = record.split("\t");
      files.push({ path: name.join("\t"), root: repository.root, plus: Number(added) || 0, minus: Number(removed) || 0, binary: added === "-" });
    }
    const patch = await git(repository.root, [...args, repository.tree, current, "--", ...repository.scopes], options);
    const remaining = Math.max(0, 400_000 - patches.join("\n").length);
    patches.push(patch.slice(0, remaining));
    repositoryPatches.push({ root: repository.root, patch: patch.slice(0, remaining) });
    truncated ||= patch.length > remaining;
  }
  return { files: files.slice(0, 500), fileCount: files.length, patch: patches.join("\n"), repositoryPatches, truncated: truncated || files.length > 500 };
}
