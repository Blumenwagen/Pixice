import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { captureTaskSnapshot } from "./task-snapshots.mjs";
import { createIsolatedWorktree, inspectRepository, removeCleanWorktree } from "./worktrees.mjs";

const run = promisify(execFile);
const FILTERS = ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false"];
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const overlaps = (a, b) => within(a, b) || within(b, a);

async function git(repository, args) {
  const { stdout } = await run(repository.executable ?? "git", [...FILTERS, ...args], {
    cwd: repository.sourceRoot ?? repository.root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000, windowsHide: true
  });
  return stdout.trimEnd();
}

// T3 reference: managed worktrees keep the project identity while execution,
// sandbox roots and file scope follow the selected checkout. Removal is opt-in
// and only considers application-owned, unshared, clean worktrees.
export class ManagedTaskWorkspaceStore {
  constructor({ directory, getUsers = () => [], onChange = () => {} }) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "workspaces.json");
    this.records = new Map();
    this.getUsers = getUsers;
    this.onChange = onChange;
    this.ready = this.#load();
    this.writes = Promise.resolve();
    this.locks = new Map();
  }

  async #load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.workspaces)) throw new Error("Unsupported task workspace store");
      for (const record of data.workspaces) this.records.set(record.id, record);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async #save() {
    const data = JSON.stringify({ version: 1, workspaces: [...this.records.values()] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    await this.writes;
    this.onChange();
  }

  async get(threadId) {
    await this.ready;
    return this.getSync(threadId);
  }

  getSync(threadId) {
    return structuredClone([...this.records.values()].find((record) => record.threadId === threadId) ?? null);
  }

  findByPathSync(cwd) {
    if (!cwd) return null;
    const target = path.resolve(cwd);
    return structuredClone([...this.records.values()].find((record) => record.status !== "removed" && record.folders.some((folder) => within(path.resolve(folder), target))) ?? null);
  }

  async ensure(threadId) {
    await this.ready;
    const record = [...this.records.values()].find((candidate) => candidate.threadId === threadId);
    if (!record) return null;
    if (record.status !== "removed") return structuredClone(record);
    // Clean removal retains the branch and provider history. Recreate from
    // that same branch before the next turn rather than changing locations.
    await mkdir(record.destination, { recursive: true, mode: 0o700 });
    const created = [];
    try {
      for (const repository of record.repositories) {
        await git(repository, ["worktree", "add", repository.root, repository.branch]);
        created.push(repository);
        await git({ ...repository, sourceRoot: repository.root }, ["submodule", "update", "--init", "--recursive"]);
      }
    } catch (error) {
      for (const repository of created.reverse()) await git(repository, ["worktree", "remove", repository.root]).catch(() => {});
      throw error;
    }
    record.status = "ready";
    record.updatedAt = new Date().toISOString();
    await this.#save();
    return structuredClone(record);
  }

  async list(projectId = null) {
    await this.ready;
    return structuredClone([...this.records.values()].filter((record) => !projectId || record.projectId === projectId));
  }

  async create({ projectId, threadId = null, folders, startingState = { type: "working-tree" }, branch = null, initializeSubmodules = true }) {
    await this.ready;
    if (!projectId || !Array.isArray(folders) || !folders.length) throw new Error("A task worktree needs a project and its folders");
    if (!["working-tree", "ref"].includes(startingState.type)) throw new Error("Unsupported task worktree starting state");
    if (startingState.type === "ref" && (typeof startingState.ref !== "string" || !startingState.ref.trim() || startingState.ref.startsWith("-"))) throw new Error("Choose a Git branch, tag, or commit");
    const id = randomUUID();
    const destination = path.join(this.directory, "checkouts", id);
    const canonicalFolders = await Promise.all(folders.map((folder) => realpath(folder)));
    let snapshot = null;
    if (startingState.type === "working-tree") snapshot = await captureTaskSnapshot(canonicalFolders, { purpose: "Task worktrees" });
    const repositories = [];
    const mappedFolders = [];
    for (const [index, folder] of canonicalFolders.entries()) {
      const repository = await inspectRepository(folder);
      if (repository.kind !== "git" || !repository.baseCommit) throw new Error("Task worktrees need Git repositories with an initial commit");
      let repositoryIndex = repositories.findIndex((candidate) => candidate.sourceRoot === repository.root);
      if (repositoryIndex < 0) {
        repositoryIndex = repositories.length;
        const sourceSnapshot = snapshot?.repositories.find((candidate) => candidate.root === repository.root);
        const baseCommit = startingState.type === "ref" ? startingState.ref : repository.baseCommit;
        repositories.push({ sourceRoot: repository.root, root: path.join(destination, `repository-${repositoryIndex + 1}`),
          executable: repository.git.executablePath, baseCommit, branch: branch ? (repositoryIndex ? `${branch}-${repositoryIndex + 1}` : branch) : `codex/task-${id.slice(0, 8)}${repositoryIndex ? `-${repositoryIndex + 1}` : ""}`,
          sourceSnapshot, scopes: [] });
      }
      const relative = path.relative(repository.root, folder) || ".";
      repositories[repositoryIndex].scopes.push(relative);
      mappedFolders.push({ repository: repositoryIndex, relative, original: canonicalFolders[index] });
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const created = [];
    try {
      for (const repository of repositories) {
        const result = await createIsolatedWorktree({ root: repository.sourceRoot, destination: repository.root, branch: repository.branch,
          baseCommit: repository.baseCommit, gitExecutablePath: repository.executable });
        repository.baseCommit = result.baseCommit;
        created.push(repository);
        if (repository.sourceSnapshot) {
          // Start the real branch at HEAD, then reproduce the user's staged and
          // unstaged state. Hidden snapshot commits never enter branch history.
          await git({ ...repository, sourceRoot: repository.root }, ["read-tree", "--reset", "-u", repository.sourceSnapshot.tree]);
          await git({ ...repository, sourceRoot: repository.root }, ["read-tree", repository.sourceSnapshot.indexTree ?? repository.baseCommit]);
        }
        if (initializeSubmodules) await git({ ...repository, sourceRoot: repository.root }, ["submodule", "update", "--init", "--recursive"]);
        delete repository.sourceSnapshot;
      }
      const workspaceFolders = mappedFolders.map(({ repository, relative }) => path.resolve(repositories[repository].root, relative));
      await Promise.all(workspaceFolders.map((folder) => realpath(folder)));
      const record = { id, projectId, threadId, kind: "worktree", status: "ready", destination, folders: workspaceFolders,
        cwd: workspaceFolders[0], runtimeRoots: workspaceFolders, sourceFolders: canonicalFolders, mappedFolders, repositories,
        users: threadId ? [{ threadId, cwd: workspaceFolders[0] }] : [],
        startingState: { ...startingState }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.records.set(id, record);
      await this.#save();
      return structuredClone(record);
    } catch (error) {
      this.records.delete(id);
      // No thread has received these paths yet. This is the only forced
      // removal path and applies solely to a failed, unpublished creation.
      for (const repository of created.reverse()) {
        await git(repository, ["worktree", "remove", "--force", repository.root]).catch(() => {});
        await git(repository, ["branch", "-D", repository.branch]).catch(() => {});
      }
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async attachThread(workspaceId, threadId) {
    await this.ready;
    const record = this.records.get(workspaceId);
    if (!record || record.status !== "ready") throw new Error("Task workspace is unavailable");
    if (record.threadId && record.threadId !== threadId) throw new Error("Task workspace already belongs to another thread");
    if ([...this.records.values()].some((candidate) => candidate.id !== workspaceId && candidate.threadId === threadId)) throw new Error("Thread already owns a task workspace");
    record.threadId = threadId;
    record.users ??= [];
    if (!record.users.some((user) => user.threadId === threadId)) record.users.push({ threadId, cwd: record.cwd });
    record.updatedAt = new Date().toISOString();
    await this.#save();
    return structuredClone(record);
  }

  async rememberThread(threadId, cwd) {
    await this.ready;
    return this.rememberThreadSync(threadId, cwd);
  }

  rememberThreadSync(threadId, cwd) {
    // The mutation precedes the persistence await, so source-list/event
    // observers can call this without leaving a file-restore admission gap.
    const target = cwd && path.resolve(cwd);
    let changed = false;
    for (const record of this.records.values()) {
      record.users ??= [];
      const existing = record.users.find((user) => user.threadId === threadId);
      const belongs = target && record.status !== "removed" && record.repositories.some((repository) => within(path.resolve(repository.root), target));
      if (belongs && !record.threadId) {
        // A timed-out thread/start can have succeeded in the provider. Adopt
        // its later authoritative discovery instead of leaking an orphaned
        // checkout that cannot be continued or managed from the task UI.
        record.threadId = threadId;
        record.status = "ready";
        changed = true;
      }
      if (belongs && (!existing || existing.cwd !== target)) {
        record.users = [...record.users.filter((user) => user.threadId !== threadId), { threadId, cwd: target }]; changed = true;
      } else if (!belongs && existing) { record.users = record.users.filter((user) => user.threadId !== threadId); changed = true; }
    }
    return changed ? this.#save() : Promise.resolve();
  }

  async forgetThread(threadId) {
    await this.ready;
    for (const record of this.records.values()) record.users = (record.users ?? []).filter((user) => user.threadId !== threadId);
    await this.#save();
  }

  async discardUnattached(workspaceId) {
    await this.ready;
    const record = this.records.get(workspaceId);
    if (!record || record.threadId) throw new Error("Only an unattached task workspace can be discarded");
    // Even a failed provider start may have touched files. Keep anything that
    // is not provably clean; the retryable record remains visible to callers.
    await this.assertExclusive(record, { allowOwner: false });
    for (const repository of record.repositories) {
      const status = await git({ ...repository, sourceRoot: repository.root }, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const ignored = (await git({ ...repository, sourceRoot: repository.root }, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      if (status || ignored.length) {
        record.status = "failed";
        record.updatedAt = new Date().toISOString();
        await this.#save();
        return { removed: false, workspace: structuredClone(record), reason: "The checkout contains local files and has been retained." };
      }
    }
    for (const repository of record.repositories) {
      await removeCleanWorktree({ root: repository.sourceRoot, worktreePath: repository.root, gitExecutablePath: repository.executable });
      // Delete only the fresh branch at exactly its original commit; if the
      // provider committed before failing, that branch is recoverable.
      const tip = await git(repository, ["rev-parse", repository.branch]);
      if (tip === repository.baseCommit) await git(repository, ["branch", "-D", repository.branch]);
    }
    await rm(record.destination, { recursive: true, force: true });
    this.records.delete(workspaceId);
    await this.#save();
    return { removed: true };
  }

  async assertExclusive(record, { allowOwner = true } = {}) {
    const roots = await Promise.all(record.repositories.map((repository) => realpath(repository.root)));
    const users = [...(record.users ?? []), ...await this.getUsers()];
    for (const user of users) {
      if (allowOwner && user.threadId === record.threadId) continue;
      for (const candidate of user.folders ?? [user.cwd].filter(Boolean)) {
        let canonical;
        try { canonical = await realpath(candidate); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (roots.some((root) => overlaps(root, canonical))) throw new Error("This worktree is shared by another thread or agent. Keep the checkout or rewind without restoring files.");
      }
    }
  }

  async archive(threadId) {
    await this.ready;
    const record = [...this.records.values()].find((candidate) => candidate.threadId === threadId);
    if (!record) return null;
    record.status = "archived";
    record.updatedAt = new Date().toISOString();
    await this.#save();
    return structuredClone(record);
  }

  async remove(threadId, { ownerStopped = false } = {}) {
    await this.ready;
    const record = [...this.records.values()].find((candidate) => candidate.threadId === threadId);
    if (!record) throw new Error("This thread has no managed worktree");
    if (!ownerStopped) throw new Error("Stop this thread's agent and terminals before removing its worktree");
    if (this.locks.has(record.id)) throw new Error("Worktree cleanup is already running");
    this.locks.set(record.id, true);
    try {
      const managedRoot = await realpath(path.join(this.directory, "checkouts"));
      for (const repository of record.repositories) {
        const root = await realpath(repository.root);
        if (!within(managedRoot, root) || root === managedRoot) throw new Error("Refusing to remove a checkout outside Pixice's managed worktrees");
      }
      await this.assertExclusive(record);
      // Preflight every root before any removal so multi-root tasks remain
      // intact when one checkout has new work or private ignored content.
      for (const repository of record.repositories) {
        const status = await git({ ...repository, sourceRoot: repository.root }, ["status", "--porcelain=v1", "--untracked-files=all"]);
        const ignored = (await git({ ...repository, sourceRoot: repository.root }, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
        if (status || ignored.some((file) => !file.split("/").includes("node_modules"))) throw new Error("Worktree has local or ignored files. Commit or move them before removing it.");
      }
      for (const repository of record.repositories) await removeCleanWorktree({ root: repository.sourceRoot, worktreePath: repository.root, gitExecutablePath: repository.executable });
      await rm(record.destination, { recursive: true, force: true });
      record.status = "removed";
      record.updatedAt = new Date().toISOString();
      await this.#save();
      return structuredClone(record);
    } finally { this.locks.delete(record.id); }
  }
}
