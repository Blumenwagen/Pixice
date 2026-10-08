import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ManagedTaskWorkspaceStore } from "../electron/git/managed-task-workspaces.mjs";
import { revertProviderThread, ThreadHistoryStore } from "../electron/runtime/thread-history.mjs";
import { captureTaskSnapshot } from "../electron/git/task-snapshots.mjs";
import { previewWorkspaceRestore, restoreWorkspaceSnapshot } from "../electron/git/workspace-checkpoints.mjs";

const run = promisify(execFile);
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture({ nested = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pixice-worktree-history-")));
  directories.push(directory);
  const source = path.join(directory, "source");
  const folder = nested ? path.join(source, "packages", "app") : source;
  await mkdir(folder, { recursive: true });
  const git = async (...args) => (await run("git", args, { cwd: source })).stdout.trim();
  await git("init"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test");
  await writeFile(path.join(folder, "file.txt"), "original\n");
  await writeFile(path.join(source, ".gitignore"), ".env\nnode_modules/\n");
  await git("add", "."); await git("commit", "-m", "initial");
  const users = [];
  const store = new ManagedTaskWorkspaceStore({ directory: path.join(directory, "managed"), getUsers: () => users });
  await store.ready;
  return { directory, source, folder, git, users, store };
}

describe("managed ordinary-task worktrees", () => {
  it("preserves staged and unstaged source state, project scopes, and durable ownership", async () => {
    const { directory, source, folder, git, store } = await fixture({ nested: true });
    await writeFile(path.join(folder, "file.txt"), "staged\n"); await git("add", "packages/app/file.txt");
    await writeFile(path.join(folder, "file.txt"), "current draft\n");
    await writeFile(path.join(folder, "untracked.txt"), "new\n");
    await writeFile(path.join(source, "sibling.txt"), "private sibling staging\n"); await git("add", "sibling.txt");
    const beforeHead = await git("rev-parse", "HEAD");
    const beforeIndex = await readFile(path.join(source, ".git", "index"));
    const workspace = await store.create({ projectId: "project", folders: [folder], branch: "codex/isolated-test" });
    await store.attachThread(workspace.id, "thread");
    expect(workspace.cwd).toBe(path.join(workspace.repositories[0].root, "packages", "app"));
    expect(await readFile(path.join(workspace.cwd, "file.txt"), "utf8")).toBe("current draft\n");
    expect(await readFile(path.join(workspace.cwd, "untracked.txt"), "utf8")).toBe("new\n");
    const isolatedGit = async (...args) => (await run("git", args, { cwd: workspace.cwd })).stdout.trim();
    expect(await isolatedGit("show", ":packages/app/file.txt")).toBe("staged");
    await expect(isolatedGit("show", ":sibling.txt")).rejects.toThrow();
    expect(await isolatedGit("rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git("rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(path.join(source, ".git", "index"))).toEqual(beforeIndex);
    const reloaded = new ManagedTaskWorkspaceStore({ directory: path.join(directory, "managed") });
    await reloaded.ready;
    expect(reloaded.getSync("thread")).toMatchObject({ projectId: "project", cwd: workspace.cwd });
    expect(reloaded.findByPathSync(path.join(workspace.cwd, "nested"))).toMatchObject({ threadId: "thread" });
    expect(reloaded.findByPathSync(workspace.repositories[0].root)).toBeNull();
  });

  it("keeps archived changes and refuses ignored secrets or shared-root removal", async () => {
    const { store, users, folder } = await fixture();
    const workspace = await store.create({ projectId: "project", folders: [folder], startingState: { type: "ref", ref: "HEAD" } });
    await store.attachThread(workspace.id, "thread");
    await store.archive("thread");
    await writeFile(path.join(workspace.cwd, ".env"), "private\n");
    await expect(store.remove("thread", { ownerStopped: true })).rejects.toThrow("local or ignored files");
    await rm(path.join(workspace.cwd, ".env"));
    users.push({ threadId: "other", cwd: path.join(workspace.cwd, "nested") });
    await mkdir(users[0].cwd);
    await expect(store.remove("thread", { ownerStopped: true })).rejects.toThrow("shared");
    users.length = 0;
    await store.rememberThread("archived-fork", workspace.cwd);
    await expect(store.remove("thread", { ownerStopped: true })).rejects.toThrow("shared");
    await store.forgetThread("archived-fork");
    await expect(store.remove("thread", { ownerStopped: false })).rejects.toThrow("Stop");
    await store.remove("thread", { ownerStopped: true });
    expect(store.getSync("thread").status).toBe("removed");
    const restored = await store.ensure("thread");
    expect(restored.status).toBe("ready");
    expect(await readFile(path.join(restored.cwd, "file.txt"), "utf8")).toBe("original\n");
  });
});

describe("checkpoint file restoration", () => {
  it("restores scoped files and their staging while keeping outside files and HEAD", async () => {
    const { source, folder, git } = await fixture({ nested: true });
    await writeFile(path.join(source, "outside.txt"), "outside before\n"); await git("add", "outside.txt"); await git("commit", "-m", "outside");
    await writeFile(path.join(folder, "file.txt"), "staged before\n"); await git("add", "packages/app/file.txt");
    await writeFile(path.join(folder, "file.txt"), "draft before\n");
    const snapshot = await captureTaskSnapshot([folder]);
    await writeFile(path.join(folder, "file.txt"), "agent after\n"); await git("add", "packages/app/file.txt");
    await writeFile(path.join(folder, "new.txt"), "agent new\n");
    await writeFile(path.join(source, "outside.txt"), "outside user after\n");
    const preview = await previewWorkspaceRestore(snapshot);
    expect(preview.files.map((file) => file.path)).toEqual(expect.arrayContaining(["packages/app/file.txt", "packages/app/new.txt"]));
    const result = await restoreWorkspaceSnapshot(snapshot, { expectedRevision: preview.revision });
    expect(result.backupSnapshot.repositories[0].ref).toMatch(/^refs\/pixice\//);
    expect(await readFile(path.join(folder, "file.txt"), "utf8")).toBe("draft before\n");
    expect(await git("show", ":packages/app/file.txt")).toBe("staged before");
    await expect(readFile(path.join(folder, "new.txt"))).rejects.toThrow();
    expect(await readFile(path.join(source, "outside.txt"), "utf8")).toBe("outside user after\n");
    expect(await git("rev-parse", "HEAD")).toBe(snapshot.repositories[0].baseCommit);
  });

  it("rejects stale preview tokens, selected paths outside scope and symlink parents", async () => {
    const { source, folder } = await fixture({ nested: true });
    await mkdir(path.join(folder, "nested")); await writeFile(path.join(folder, "nested", "file.txt"), "before\n");
    const snapshot = await captureTaskSnapshot([folder]);
    await writeFile(path.join(folder, "file.txt"), "agent\n");
    let preview = await previewWorkspaceRestore(snapshot);
    await writeFile(path.join(folder, "file.txt"), "user newer\n");
    await expect(restoreWorkspaceSnapshot(snapshot, { expectedRevision: preview.revision })).rejects.toThrow("changed after");
    preview = await previewWorkspaceRestore(snapshot);
    await expect(restoreWorkspaceSnapshot(snapshot, { expectedRevision: preview.revision, files: [{ root: source, path: "outside.txt" }] })).rejects.toThrow("outside");
    await expect(restoreWorkspaceSnapshot(snapshot, { expectedRevision: preview.revision, files: [{ root: source, path: "packages/app/../../outside.txt" }] })).rejects.toThrow("outside");
    await rm(path.join(folder, "nested"), { recursive: true });
    await symlink(source, path.join(folder, "nested"));
    preview = await previewWorkspaceRestore(snapshot);
    await expect(restoreWorkspaceSnapshot(snapshot, { expectedRevision: preview.revision })).rejects.toThrow(/unsafe parent|directory/);
    expect(await readFile(path.join(folder, "file.txt"), "utf8")).toBe("user newer\n");
  });
});

describe("persistent conversation rewind", () => {
  it("uses modern before-turn revert and only falls back when the method is missing", async () => {
    const payload = { threadId: "thread", checkpoint: { turnId: "selected-turn" }, numTurns: 2 };
    const request = vi.fn().mockResolvedValueOnce({ thread: { id: "thread" } });
    await revertProviderThread({ request }, payload);
    expect(request).toHaveBeenCalledExactlyOnceWith("thread/revert", { threadId: "thread", beforeTurnId: "selected-turn" });
    request.mockReset().mockRejectedValueOnce(Object.assign(new Error("Method not found"), { code: -32601 })).mockResolvedValueOnce({ thread: { id: "thread" } });
    await revertProviderThread({ request }, payload);
    expect(request).toHaveBeenNthCalledWith(2, "thread/rollback", { threadId: "thread", numTurns: 2 });
    request.mockReset().mockRejectedValueOnce(new Error("Invalid legacy history boundary"));
    await expect(revertProviderThread({ request }, payload)).rejects.toThrow("Invalid legacy history boundary");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes provider turns, restores original input, and prevents rewind/send races", async () => {
    const { directory, source, store } = await fixture();
    const workspace = await store.create({ projectId: "project", folders: [source], startingState: { type: "ref", ref: "HEAD" } });
    await store.attachThread(workspace.id, "thread");
    const thread = { id: "thread", provider: "codex", providerThreadId: "native", status: { type: "idle" }, turns: [] };
    let releaseRollback;
    const rollbackGate = new Promise((resolve) => { releaseRollback = resolve; });
    const rewindProvider = vi.fn(async ({ numTurns }) => { await rollbackGate; thread.turns.splice(thread.turns.length - numTurns); return { thread }; });
    const history = new ThreadHistoryStore({ directory: path.join(directory, "history"), workspaceStore: store, readThread: async () => ({ thread }), rewindProvider });
    const checkpoint = await history.capture({ projectId: "project", threadId: "thread", folders: workspace.folders, input: { text: "Original prompt", images: [{ path: "image.png" }] } });
    thread.turns.push({ id: "turn-one", status: "completed", items: [] });
    await history.started(checkpoint.id, "turn-one");
    await writeFile(path.join(workspace.cwd, "file.txt"), "agent result\n");
    const preview = await history.preview({ threadId: "thread", checkpointId: checkpoint.id });
    expect(preview.restoreAllowed).toBe(true);
    const rewinding = history.rewind({ ...preview, restoreFiles: true });
    // Give rollback time to acquire the shared admission lock.
    await vi.waitFor(() => expect(rewindProvider).toHaveBeenCalled());
    let sent = false;
    const sending = history.withThreadLock("thread", () => { sent = true; expect(thread.turns).toHaveLength(0); });
    await Promise.resolve(); expect(sent).toBe(false);
    releaseRollback();
    const result = await rewinding; await sending;
    expect(result.input).toEqual({ text: "Original prompt", images: [{ path: "image.png" }] });
    expect(await readFile(path.join(workspace.cwd, "file.txt"), "utf8")).toBe("original\n");
    expect(await history.list("thread")).toEqual([]);
    const persisted = JSON.parse(await readFile(path.join(directory, "history", "checkpoints.json"), "utf8"));
    expect(persisted.checkpoints[0]).toMatchObject({ status: "rolled-back", backups: [{ reason: "before-rewind" }] });
  });

  it("offers conversation-only rewind for the project checkout and rejects shared restore", async () => {
    const { directory, source, store, users } = await fixture();
    const thread = { id: "thread", provider: "codex", status: { type: "idle" }, turns: [] };
    const rewindProvider = vi.fn(async ({ numTurns }) => { thread.turns.splice(-numTurns); return { thread }; });
    const history = new ThreadHistoryStore({ directory: path.join(directory, "history"), workspaceStore: store, readThread: async () => thread, rewindProvider });
    const checkpoint = await history.capture({ projectId: "project", threadId: "thread", folders: [source], input: { text: "prompt" } });
    thread.turns.push({ id: "turn", status: "completed", items: [] }); await history.started(checkpoint.id, "turn");
    const preview = await history.preview({ threadId: "thread", checkpointId: checkpoint.id });
    expect(preview.restoreAllowed).toBe(false);
    await expect(history.rewind({ ...preview, restoreFiles: true })).rejects.toThrow("isolated managed worktree");
    expect(rewindProvider).not.toHaveBeenCalled();
    await history.rewind({ ...preview, restoreFiles: false });
    expect(thread.turns).toEqual([]);
    const workspace = await store.create({ projectId: "project", folders: [source], startingState: { type: "ref", ref: "HEAD" } });
    await store.attachThread(workspace.id, "thread");
    const second = await history.capture({ projectId: "project", threadId: "thread", folders: workspace.folders, input: { text: "another" } });
    thread.turns.push({ id: "second", status: "completed", items: [] }); await history.started(second.id, "second");
    users.push({ threadId: "fork", cwd: workspace.cwd });
    expect((await history.preview({ threadId: "thread", checkpointId: second.id })).restoreAllowed).toBe(false);
  });

  it("keeps newer shared files and still returns the edit prompt if sharing starts during provider rollback", async () => {
    const { directory, source, store } = await fixture();
    const workspace = await store.create({ projectId: "project", folders: [source], startingState: { type: "ref", ref: "HEAD" } });
    await store.attachThread(workspace.id, "thread");
    const thread = { id: "thread", provider: "codex", status: { type: "idle" }, turns: [] };
    const history = new ThreadHistoryStore({ directory: path.join(directory, "history"), workspaceStore: store, readThread: async () => thread,
      rewindProvider: async ({ numTurns }) => { thread.turns.splice(-numTurns); await store.rememberThread("fork", workspace.cwd); return { thread }; } });
    const checkpoint = await history.capture({ projectId: "project", threadId: "thread", folders: workspace.folders, input: { text: "editable prompt" } });
    thread.turns.push({ id: "turn", status: "completed", items: [] }); await history.started(checkpoint.id, "turn");
    await writeFile(path.join(workspace.cwd, "file.txt"), "new shared content\n");
    const preview = await history.preview({ threadId: "thread", checkpointId: checkpoint.id });
    const result = await history.rewind({ ...preview, restoreFiles: true });
    expect(result).toMatchObject({ filesKept: true, input: { text: "editable prompt" } });
    expect(result.restoreError).toContain("shared");
    expect(thread.turns).toEqual([]);
    expect(await readFile(path.join(workspace.cwd, "file.txt"), "utf8")).toBe("new shared content\n");
  });
});
