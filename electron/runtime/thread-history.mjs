import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureTaskSnapshot } from "../git/task-snapshots.mjs";
import { previewWorkspaceRestore, restoreWorkspaceSnapshot, workspaceSnapshotRevision } from "../git/workspace-checkpoints.mjs";

const unwrapThread = (value) => value?.thread ?? value;
const conversationRevision = (thread) => createHash("sha256").update(JSON.stringify({
  id: thread.id, provider: thread.provider, native: thread.providerThreadId,
  turns: (thread.turns ?? []).map((turn) => ({ id: turn.id, status: turn.status, items: (turn.items ?? []).map((item) => ({ id: item.id, type: item.type, content: item.type === "userMessage" ? item.content : undefined })) }))
})).digest("hex");

export async function revertProviderThread(runtime, { threadId, checkpoint, numTurns }) {
  if (!checkpoint?.turnId || !Number.isInteger(numTurns) || numTurns < 1) throw new Error("Invalid provider rewind boundary");
  try {
    // The checkpoint's turn is the selected prompt being removed, so this is
    // the precise beforeTurnId boundary used by released T3 / Codex 0.156.
    return await runtime.request("thread/revert", { threadId, beforeTurnId: checkpoint.turnId });
  } catch (error) {
    const methodMissing = error?.code === -32601 || error?.data?.code === -32601 || /\bmethod (?:not found|not supported|unsupported)\b/i.test(error?.message ?? "") || /\b(?:unknown|unsupported) method\b/i.test(error?.message ?? "");
    if (!methodMissing) throw error;
    return runtime.request("thread/rollback", { threadId, numTurns });
  }
}

export function createRewindSupportProbe({ readThread, providerForThread = () => null, generation = () => 0 }) {
  const cache = new Map();
  const available = (thread) => Boolean(thread?.id) && thread.status !== "notLoaded" && thread.status?.type !== "notLoaded" && thread.historyMode !== "legacy";
  const supportsRewind = async (thread) => {
    if (!thread?.id) return false;
    const provider = thread.provider ?? providerForThread(thread.id);
    if (provider !== "codex" || !available(thread)) return false;
    if (thread.historyMode === "paginated") return true;
    const key = JSON.stringify([thread.id, thread.providerThreadId ?? null, provider, String(generation(thread.id, provider))]);
    if (cache.has(key)) {
      const existing = cache.get(key);
      cache.delete(key); cache.set(key, existing);
      return existing;
    }
    // Released T3 probes raw thread/read without turns: includeTurns can omit
    // historyMode. Missing metadata remains compatible with older app-servers
    // whose rewind endpoint is count based; explicit legacy cannot rewind.
    const pending = Promise.resolve().then(() => readThread(thread.id, { includeTurns: false })).then((response) => {
      const metadata = unwrapThread(response);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || (!metadata.id && !metadata.status && metadata.historyMode === undefined)) return false;
      return available({ ...metadata, id: metadata.id ?? thread.id });
    }).catch(() => false);
    cache.set(key, pending);
    while (cache.size > 512) cache.delete(cache.keys().next().value);
    return pending;
  };
  supportsRewind.clear = () => cache.clear();
  return supportsRewind;
}

// Reference: T3's CheckpointService, CheckpointRestoreSafety and
// CheckpointRollbackService. Hidden snapshots are durable, file restore is
// isolated-worktree only, and rollback shares admission locking with sends.
export class ThreadHistoryStore {
  constructor({ directory, workspaceStore, readThread, rewindProvider, getActiveTurn = () => null, supportsRewind = (thread) => thread.provider !== "claude", onChange = () => {} }) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "checkpoints.json");
    this.workspaceStore = workspaceStore;
    this.readThread = readThread;
    this.rewindProvider = rewindProvider;
    this.getActiveTurn = getActiveTurn;
    this.supportsRewind = supportsRewind;
    this.onChange = onChange;
    this.records = new Map();
    this.locks = new Map();
    this.writes = Promise.resolve();
    this.ready = this.#load();
  }

  async #load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.checkpoints)) throw new Error("Unsupported thread checkpoint store");
      for (const record of data.checkpoints) this.records.set(record.id, record);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async #save() {
    const data = JSON.stringify({ version: 1, checkpoints: [...this.records.values()] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    await this.writes;
    this.onChange();
  }

  async withThreadLock(threadId, action) {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    this.locks.set(threadId, held);
    await previous.catch(() => {});
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(threadId) === held) this.locks.delete(threadId);
    }
  }

  // Caller holds withThreadLock from capture through provider turn/start.
  // A snapshot failure leaves conversation rewind usable on non-Git projects.
  async capture({ projectId, threadId, folders, input, thread = null }) {
    await this.ready;
    thread = unwrapThread(thread ?? await this.readThread(threadId));
    if (!thread?.id) throw new Error("Cannot checkpoint an unavailable thread");
    let snapshot = null, snapshotError = null;
    try { snapshot = await captureTaskSnapshot(folders, { purpose: "File checkpoints" }); }
    catch (error) { snapshotError = error.message; }
    const record = { id: randomUUID(), projectId, threadId, turnId: null, ordinal: thread.turns?.length ?? 0,
      provider: thread.provider ?? null, providerThreadId: thread.providerThreadId ?? null,
      input: structuredClone(input), snapshot, snapshotError, status: "pending", createdAt: new Date().toISOString() };
    this.records.set(record.id, record);
    await this.#save();
    return structuredClone(record);
  }

  async started(checkpointId, turnId) {
    await this.ready;
    const record = this.records.get(checkpointId);
    if (!record || record.status !== "pending") throw new Error("Turn checkpoint is no longer pending");
    record.turnId = turnId;
    record.status = "ready";
    await this.#save();
    return structuredClone(record);
  }

  async failed(checkpointId) {
    await this.ready;
    const record = this.records.get(checkpointId);
    if (!record) return;
    record.status = "failed";
    await this.#save();
  }

  async list(threadId, threadSnapshot = null) {
    await this.ready;
    const thread = unwrapThread(threadSnapshot ?? await this.readThread(threadId));
    const supported = await this.supportsRewind(thread);
    return [...this.records.values()].filter((record) => record.threadId === threadId && record.status === "ready")
      .map(({ snapshot, input, backups, ...record }) => ({ ...record, hasFiles: Boolean(snapshot), supportsRewind: supported }));
  }

  async #target(threadId, checkpointId) {
    await this.ready;
    const checkpoint = this.records.get(checkpointId);
    if (!checkpoint || checkpoint.threadId !== threadId || checkpoint.status !== "ready") throw new Error("This checkpoint is no longer available");
    const thread = unwrapThread(await this.readThread(threadId));
    if (!thread?.id || !Array.isArray(thread.turns)) throw new Error("Conversation history is unavailable. Reload the thread before rewinding.");
    if (!await this.supportsRewind(thread)) throw new Error("This provider does not support conversation rewind");
    if (this.getActiveTurn(threadId) || thread.status?.type === "active" || (thread.turns ?? []).some((turn) => turn.status === "inProgress")) throw new Error("Stop the running turn before rewinding this conversation");
    const turnIndex = (thread.turns ?? []).findIndex((turn) => turn.id === checkpoint.turnId);
    if (turnIndex < 0 || turnIndex !== checkpoint.ordinal) throw new Error("The provider history changed. Reload this conversation before rewinding");
    if (checkpoint.provider && thread.provider && checkpoint.provider !== thread.provider) throw new Error("This checkpoint belongs to the earlier provider");
    if (checkpoint.providerThreadId && thread.providerThreadId && checkpoint.providerThreadId !== thread.providerThreadId) throw new Error("This checkpoint belongs to an earlier provider session");
    return { checkpoint, thread };
  }

  async #restoreSafety(checkpoint) {
    if (!checkpoint.snapshot) return { allowed: false, reason: checkpoint.snapshotError ?? "This turn has no file checkpoint" };
    const workspace = await this.workspaceStore?.get(checkpoint.threadId);
    if (!workspace || workspace.status === "removed") return { allowed: false, reason: "File restore requires this thread's isolated managed worktree. You can rewind the conversation and keep files." };
    try {
      await this.workspaceStore.assertExclusive(workspace);
      const roots = new Set(workspace.repositories.map((repository) => path.resolve(repository.root)));
      if (checkpoint.snapshot.repositories.some((repository) => !roots.has(path.resolve(repository.root)))) throw new Error("This checkpoint belongs to a different task checkout");
      return { allowed: true, workspace };
    } catch (error) { return { allowed: false, reason: error.message }; }
  }

  async preview({ threadId, checkpointId }) {
    const { checkpoint, thread } = await this.#target(threadId, checkpointId);
    const safety = await this.#restoreSafety(checkpoint);
    let files = [], fileCount = 0, workspaceRevision = null, truncated = false, previewError = null;
    if (checkpoint.snapshot) {
      try {
        const preview = await previewWorkspaceRestore(checkpoint.snapshot);
        files = preview.files; fileCount = preview.fileCount; workspaceRevision = preview.revision; truncated = preview.truncated;
      } catch (error) { previewError = error.message; }
    }
    return { checkpointId, threadId, turnId: checkpoint.turnId, input: structuredClone(checkpoint.input),
      removedTurns: thread.turns.length - checkpoint.ordinal, conversationRevision: conversationRevision(thread), workspaceRevision,
      files, fileCount, truncated, restoreAllowed: safety.allowed && !previewError, restoreReason: previewError ?? safety.reason ?? null };
  }

  async rewind({ threadId, checkpointId, conversationRevision: expectedConversation, workspaceRevision, restoreFiles = false }) {
    return this.withThreadLock(threadId, async () => {
      const { checkpoint, thread } = await this.#target(threadId, checkpointId);
      if (!expectedConversation || conversationRevision(thread) !== expectedConversation) throw new Error("Conversation changed after the rewind preview. Review it again before continuing.");
      let backupSnapshot = null;
      if (restoreFiles) {
        const safety = await this.#restoreSafety(checkpoint);
        if (!safety.allowed) throw new Error(safety.reason);
        const current = await workspaceSnapshotRevision(checkpoint.snapshot, { keepRef: true });
        if (!workspaceRevision || current.revision !== workspaceRevision) throw new Error("Workspace changed after the rewind preview. Review the updated files before restoring.");
        backupSnapshot = current.current;
        checkpoint.backups ??= [];
        checkpoint.backups.push({ id: randomUUID(), snapshot: backupSnapshot, reason: "before-rewind", createdAt: new Date().toISOString() });
        await this.#save();
        // A user can open another thread during preview, so enforce ownership
        // again immediately before provider rollback, just as T3 does.
        const finalSafety = await this.#restoreSafety(checkpoint);
        if (!finalSafety.allowed) throw new Error(finalSafety.reason);
      }
      const response = await this.rewindProvider({ threadId, numTurns: thread.turns.length - checkpoint.ordinal,
        checkpoint: structuredClone(checkpoint), targetTurnId: thread.turns[checkpoint.ordinal - 1]?.id ?? null });
      for (const candidate of this.records.values()) {
        if (candidate.threadId === threadId && candidate.status === "ready" && candidate.ordinal >= checkpoint.ordinal) candidate.status = "rolled-back";
      }
      await this.#save();
      let restoration = null;
      try {
        if (restoreFiles) restoration = await restoreWorkspaceSnapshot(checkpoint.snapshot, { expectedRevision: workspaceRevision, backup: backupSnapshot,
          beforeWrite: async () => { const safety = await this.#restoreSafety(checkpoint); if (!safety.allowed) throw new Error(safety.reason); } });
      } catch (error) {
        // Provider history has already changed. Return the editable prompt
        // even when files can no longer be restored; IPC Error transport may
        // discard custom fields and otherwise strand the user without it.
        return { ...response, input: structuredClone(checkpoint.input), checkpointId, restoredFiles: [], backupSnapshot,
          filesKept: true, restoreError: `Conversation rewound; workspace files were kept. ${error.message}` };
      }
      return { ...response, input: structuredClone(checkpoint.input), checkpointId, restoredFiles: restoration?.restoredFiles ?? [], backupSnapshot };
    });
  }

  async restoreFile({ threadId, checkpointId, file, workspaceRevision }) {
    return this.withThreadLock(threadId, async () => {
      const { checkpoint } = await this.#target(threadId, checkpointId);
      const safety = await this.#restoreSafety(checkpoint);
      if (!safety.allowed) throw new Error(safety.reason);
      const result = await restoreWorkspaceSnapshot(checkpoint.snapshot, { expectedRevision: workspaceRevision, files: [file],
        beforeWrite: async () => { const finalSafety = await this.#restoreSafety(checkpoint); if (!finalSafety.allowed) throw new Error(finalSafety.reason); } });
      checkpoint.backups ??= [];
      checkpoint.backups.push({ id: randomUUID(), snapshot: result.backupSnapshot, reason: "before-file-restore", createdAt: new Date().toISOString() });
      await this.#save();
      return { restoredFiles: result.restoredFiles, checkpointId };
    });
  }
}
