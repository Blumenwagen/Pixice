import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { captureTaskSnapshot, taskWorkspaceChanges } from "./task-snapshots.mjs";

const run = promisify(execFile);
const FILTERS = ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false"];
const within = (parent, target) => { const relative = path.relative(parent, target); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const inScope = (repository, file) => repository.scopes.some((rawScope) => { const scope = rawScope.split(path.sep).join("/"); return scope === "." || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`); });

async function git(repository, args, { binary = false } = {}) {
  const { stdout } = await run(repository.executable ?? "git", ["--literal-pathspecs", ...FILTERS, ...args], {
    cwd: repository.root, encoding: binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000, windowsHide: true
  });
  return binary ? stdout : stdout.trimEnd();
}

async function entries(repository, tree) {
  const output = await git(repository, ["ls-tree", "-r", "-z", tree, "--", ...repository.scopes]);
  return new Map(output.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    return [record.slice(tab + 1), { mode, type, oid }];
  }));
}

export async function workspaceSnapshotRevision(snapshot, { keepRef = false } = {}) {
  const current = await captureTaskSnapshot(snapshot.folders.map(({ repository, relative }) => path.resolve(snapshot.repositories[repository].root, relative)), { purpose: "Rewind preview", keepRef });
  const revision = createHash("sha256").update(JSON.stringify(current.repositories.map((repository) => ({
    root: repository.root, scopes: repository.scopes, head: repository.baseCommit, tree: repository.tree, index: repository.indexTree
  })))).digest("hex");
  return { revision, current };
}

export async function previewWorkspaceRestore(snapshot) {
  const { revision, current } = await workspaceSnapshotRevision(snapshot);
  const changes = await taskWorkspaceChanges(snapshot, current);
  return { revision, ...changes };
}

async function safeTarget(repository, file) {
  if (typeof file !== "string" || file.includes("\\") || path.posix.normalize(file) !== file || path.posix.isAbsolute(file) || !inScope(repository, file) || file.includes("\0") || file.split("/").includes(".git")) throw new Error("Checkpoint file is outside the task's workspace scope");
  const root = await realpath(repository.root);
  const absolute = path.resolve(root, file);
  if (!within(root, absolute) || root === absolute) throw new Error("Checkpoint file is outside the task workspace");
  // Resolve every existing ancestor. A symlink is never followed during
  // restoration, including a symlink another tool inserted after capture.
  let ancestor = path.dirname(absolute);
  while (ancestor !== root) {
    try {
      const stat = await lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Checkpoint file has an unsafe parent path");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    ancestor = path.dirname(ancestor);
  }
  try {
    const stat = await lstat(absolute);
    if (stat.isDirectory()) throw new Error("Checkpoint restoration would replace a directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return absolute;
}

async function restoreContent(repository, file, entry) {
  const absolute = await safeTarget(repository, file);
  if (!entry) { await rm(absolute, { force: true }); return; }
  if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode)) throw new Error("Checkpoint restoration does not support submodules or special files");
  const content = await git(repository, ["cat-file", "blob", entry.oid], { binary: true });
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.pixice-restore-${randomUUID()}`;
  try {
    if (entry.mode === "120000") await symlink(content.toString("utf8"), temporary);
    else await writeFile(temporary, content, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    await rename(temporary, absolute);
    if (entry.mode !== "120000") await chmod(absolute, entry.mode === "100755" ? 0o755 : 0o644);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function restoreIndex(repository, file, entry) {
  if (entry) await git(repository, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${file}`]);
  else await git(repository, ["update-index", "--force-remove", "--", file]);
}

// Scoped restore never changes HEAD or the current branch. A durable hidden
// backup ref is made before touching files and the user's original staging is
// restored for affected paths. Ignored files and out-of-scope content stay put.
export async function restoreWorkspaceSnapshot(snapshot, { expectedRevision, files = null, backup = null, beforeWrite = null } = {}) {
  if (!expectedRevision) throw new Error("Preview the checkpoint before restoring files");
  const { revision, current } = await workspaceSnapshotRevision(snapshot, { keepRef: true });
  if (revision !== expectedRevision) throw new Error("Workspace changed after the rewind preview. Review the updated files before restoring.");
  const selected = files && new Set(files.map((file) => `${path.resolve(file.root)}\0${file.path}`));
  const plans = [];
  for (const repository of snapshot.repositories) {
    const currentRepository = current.repositories.find((candidate) => candidate.root === repository.root);
    if (!currentRepository) throw new Error("Checkpoint repository is no longer available");
    const [before, after, beforeIndex, afterIndex] = await Promise.all([
      entries(repository, repository.tree), entries(repository, currentRepository.tree),
      entries(repository, repository.indexTree ?? repository.baseCommit), entries(repository, currentRepository.indexTree)
    ]);
    for (const file of new Set([...before.keys(), ...after.keys(), ...beforeIndex.keys(), ...afterIndex.keys()])) {
      if (selected && !selected.has(`${path.resolve(repository.root)}\0${file}`)) continue;
      const prior = before.get(file), actual = after.get(file);
      const priorIndex = beforeIndex.get(file), actualIndex = afterIndex.get(file);
      if (JSON.stringify(prior) === JSON.stringify(actual) && JSON.stringify(priorIndex) === JSON.stringify(actualIndex)) continue;
      await safeTarget(repository, file);
      if (prior?.type === "commit" || actual?.type === "commit") throw new Error("Checkpoint restoration cannot change submodules");
      plans.push({ repository, file, prior, priorIndex, actual, actualIndex });
    }
  }
  if (selected) {
    for (const key of selected) {
      const [root, file] = key.split("\0");
      const repository = snapshot.repositories.find((candidate) => path.resolve(candidate.root) === root);
      if (!repository) throw new Error("Selected file is outside the checkpoint repositories");
      await safeTarget(repository, file);
    }
  }
  const backupSnapshot = backup ?? current;
  const completed = [];
  if (beforeWrite) await beforeWrite();
  try {
    for (const plan of plans) {
      completed.push(plan);
      await restoreContent(plan.repository, plan.file, plan.prior);
      await restoreIndex(plan.repository, plan.file, plan.priorIndex);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const plan of completed.reverse()) {
      try {
        await restoreContent(plan.repository, plan.file, plan.actual);
        await restoreIndex(plan.repository, plan.file, plan.actualIndex);
      } catch (recoveryError) { recoveryErrors.push(recoveryError.message); }
    }
    error.backupSnapshot = backupSnapshot;
    if (recoveryErrors.length) error.message += ` Recovery needs attention: ${recoveryErrors.join("; ")}`;
    throw error;
  }
  return { restoredFiles: plans.map(({ repository, file }) => ({ root: repository.root, path: file })), backupSnapshot };
}
