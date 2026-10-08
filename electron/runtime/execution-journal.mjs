import { randomUUID } from "node:crypto";

// Reference: T3 Orchestrator V2 EventSink/EffectOutbox at nightly 30cc788.
// A receipt and its lifecycle event commit together; external provider calls
// happen only after beforeDispatch commits. Unknown dispatches are never replayed.
export const EXECUTION_TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const RECOVERABLE = ["accepted", "dispatching", "running", "uncertain"];
const MAX_RECOVERY_CANDIDATES = 128;
const MAX_METADATA_BYTES = 16_384;
const now = () => new Date().toISOString();
const identity = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new TypeError(`${label} must be a nonempty identity of at most 512 characters.`);
  return value;
};
const errorText = (error) => String(error?.message ?? error ?? "Provider execution failed.").slice(0, 4_096);
export function executionTurnStatus(turn) {
  if (turn?.status === "inProgress" || turn?.status === "running" || turn?.status === "waiting") return "running";
  return EXECUTION_TERMINAL_STATUSES.has(turn?.status) ? turn.status : null;
}

let transactionOrdinal = 0;
/** Synchronous savepoints compose with the application's existing SQLite transactions. */
export function executionTransaction(db, operation) {
  const name = `execution_journal_${++transactionOrdinal}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function decode(row) {
  return row ? {
    id: row.command_id, commandId: row.command_id, threadId: row.thread_id,
    kind: row.kind, status: row.status, turnId: row.turn_id,
    metadata: JSON.parse(row.metadata_json), createdAt: row.created_at,
    updatedAt: row.updated_at, dispatchedAt: row.dispatched_at,
    ownerId: row.owner_id, error: row.error, revision: row.revision,
    acceptanceSequence: row.acceptance_sequence, sequence: row.last_sequence
  } : null;
}

export class ExecutionJournal {
  constructor({ database }) {
    this.database = database;
    this.db = database?.db ?? database;
    if (!this.db?.prepare || !this.db?.exec) throw new TypeError("ExecutionJournal requires a SQLite database.");
    this.ownerId = randomUUID();
    this.unboundTerminal = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_commands (
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','dispatching','running','completed','failed','interrupted','cancelled','uncertain')),
      turn_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, dispatched_at TEXT, owner_id TEXT NOT NULL,
      error TEXT, revision INTEGER NOT NULL, acceptance_sequence INTEGER NOT NULL DEFAULT 0,
      last_sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS execution_commands_recovery ON execution_commands(status, updated_at);
    CREATE INDEX IF NOT EXISTS execution_commands_thread ON execution_commands(thread_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_commands_turn ON execution_commands(thread_id, turn_id) WHERE turn_id IS NOT NULL AND kind='turn-start';
    CREATE TABLE IF NOT EXISTS execution_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL,
      revision INTEGER NOT NULL, type TEXT NOT NULL, previous_status TEXT,
      status TEXT NOT NULL, turn_id TEXT, recorded_at TEXT NOT NULL, detail_json TEXT NOT NULL,
      UNIQUE(command_id, revision)
    );`);
    // Constructor recovery records uncertainty, rather than inventing a stopped
    // provider turn. A stored exact turn can subsequently prove its real state.
    executionTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM execution_commands WHERE status IN ('accepted','dispatching','running') AND owner_id != ?").all(this.ownerId);
      for (const row of rows) {
        const record = decode(row);
        const detail = record.status === "accepted"
          ? "The backend stopped before the accepted request was dispatched. It is held for explicit recovery."
          : record.turnId
            ? "The backend stopped while this turn was active. Its provider state must be reconciled."
            : "The backend stopped during provider dispatch before a turn identity was confirmed. The outcome is uncertain; the prompt was not repeated.";
        this.transition(record, "uncertain", { error: detail }, "process-loss", { previousOwnerId: record.ownerId });
      }
    });
  }

  get(commandId) {
    return decode(this.db.prepare("SELECT * FROM execution_commands WHERE command_id = ?").get(identity(commandId, "commandId")));
  }

  getActive(threadId) {
    return decode(this.db.prepare("SELECT * FROM execution_commands WHERE thread_id = ? AND kind='turn-start' AND status IN ('accepted','dispatching','running','uncertain') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'dispatching' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END, created_at, rowid LIMIT 1").get(identity(threadId, "threadId")));
  }

  forTurn(threadId, turnId) {
    return decode(this.db.prepare("SELECT * FROM execution_commands WHERE thread_id=? AND kind='turn-start' AND turn_id=?").get(identity(threadId, "threadId"), identity(turnId, "turnId")));
  }

  listRecoverable(limit = MAX_RECOVERY_CANDIDATES, { includeDeliveries = false } = {}) {
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_RECOVERY_CANDIDATES, Math.floor(limit))) : MAX_RECOVERY_CANDIDATES;
    return this.db.prepare(`SELECT * FROM execution_commands WHERE status IN ('accepted','dispatching','running','uncertain') ${includeDeliveries ? "" : "AND kind='turn-start'"} ORDER BY updated_at, rowid LIMIT ?`).all(bounded).map(decode);
  }

  events(commandId) {
    return this.db.prepare("SELECT * FROM execution_events WHERE command_id = ? ORDER BY sequence").all(identity(commandId, "commandId")).map((row) => ({
      sequence: row.sequence, commandId: row.command_id, revision: row.revision,
      type: row.type, previousStatus: row.previous_status, status: row.status,
      turnId: row.turn_id, recordedAt: row.recorded_at, detail: JSON.parse(row.detail_json)
    }));
  }

  accept({ commandId, threadId, kind = "turn-start", metadata = {}, turnId = null }) {
    identity(commandId, "commandId"); identity(threadId, "threadId"); identity(kind, "kind");
    if (turnId !== null) identity(turnId, "turnId");
    const encoded = JSON.stringify(metadata);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_METADATA_BYTES) throw new TypeError("Execution metadata exceeds its 16 KiB budget.");
    return executionTransaction(this.db, () => {
      const previous = this.get(commandId);
      if (previous) {
        if (previous.threadId !== threadId || previous.kind !== kind || (turnId && previous.turnId && turnId !== previous.turnId)) throw new Error(`Command ${commandId} was already accepted for another thread, turn or operation.`);
        return { ...previous, record: previous, duplicate: true };
      }
      const at = now();
      this.db.prepare("INSERT INTO execution_commands(command_id,thread_id,kind,status,turn_id,metadata_json,created_at,updated_at,owner_id,revision) VALUES(?,?,?,'accepted',?,?,?,?,?,1)").run(commandId, threadId, kind, turnId, encoded, at, at, this.ownerId);
      const sequence = Number(this.db.prepare("INSERT INTO execution_events(command_id,revision,type,status,turn_id,recorded_at,detail_json) VALUES(?,1,'accepted','accepted',?,?,'{}')").run(commandId, turnId, at).lastInsertRowid);
      this.db.prepare("UPDATE execution_commands SET acceptance_sequence=?,last_sequence=? WHERE command_id=?").run(sequence, sequence, commandId);
      const record = this.get(commandId);
      return { ...record, record, duplicate: false };
    });
  }

  transition(record, status, patch = {}, type = status, detail = {}) {
    return executionTransaction(this.db, () => {
      const current = this.get(record.commandId);
      if (!current || current.revision !== record.revision) return null;
      const at = now();
      const turnId = Object.hasOwn(patch, "turnId") ? patch.turnId : current.turnId;
      const error = Object.hasOwn(patch, "error") ? patch.error : current.error;
      const revision = current.revision + 1;
      const event = this.db.prepare("INSERT INTO execution_events(command_id,revision,type,previous_status,status,turn_id,recorded_at,detail_json) VALUES(?,?,?,?,?,?,?,?)").run(current.commandId, revision, type, current.status, status, turnId, at, JSON.stringify(detail));
      this.db.prepare("UPDATE execution_commands SET status=?,turn_id=?,updated_at=?,dispatched_at=?,owner_id=?,error=?,revision=?,last_sequence=? WHERE command_id=? AND revision=?").run(status, turnId, at, Object.hasOwn(patch, "dispatchedAt") ? patch.dispatchedAt : current.dispatchedAt, patch.ownerId ?? current.ownerId, error, revision, Number(event.lastInsertRowid), current.commandId, current.revision);
      return this.get(current.commandId);
    });
  }

  beforeDispatch(commandId) {
    return executionTransaction(this.db, () => {
      const record = this.get(commandId);
      if (!record || record.status !== "accepted" || record.ownerId !== this.ownerId) return null;
      const other = record.kind === "turn-start" && this.db.prepare("SELECT command_id FROM execution_commands WHERE thread_id=? AND kind='turn-start' AND command_id!=? AND status IN ('dispatching','running','uncertain') LIMIT 1").get(record.threadId, commandId);
      if (other) return null;
      return this.transition(record, "dispatching", { dispatchedAt: now(), error: null });
    });
  }

  started(commandId, turnId) {
    identity(turnId, "turnId");
    const record = this.get(commandId);
    if (!record) return null;
    if (record.turnId && record.turnId !== turnId) throw new Error(`Command ${commandId} already belongs to turn ${record.turnId}.`);
    if (record.kind !== "turn-start") return this.acknowledge(commandId, { turnId });
    if (EXECUTION_TERMINAL_STATUSES.has(record.status) || record.status === "running") return record.turnId === turnId ? record : null;
    if (record.status !== "dispatching" && !(record.status === "uncertain" && record.dispatchedAt && record.ownerId === this.ownerId)) return null;
    const started = this.transition(record, "running", { turnId, error: null }, "provider-started");
    const key = JSON.stringify([record.threadId, turnId]);
    const terminal = this.unboundTerminal.get(key);
    this.unboundTerminal.delete(key);
    return terminal && started ? this.observeCompleted(record.threadId, terminal) : started;
  }

  acknowledge(commandId, { turnId } = {}) {
    const record = this.get(commandId);
    if (!record || EXECUTION_TERMINAL_STATUSES.has(record.status)) return record;
    if (record.kind === "turn-start") throw new Error("Provider turn starts require an exact started/terminal observation.");
    if (turnId) identity(turnId, "turnId");
    if (record.turnId && turnId && record.turnId !== turnId) throw new Error(`Command ${commandId} belongs to another turn.`);
    if (record.ownerId !== this.ownerId || !record.dispatchedAt) return null;
    return this.transition(record, "completed", { turnId, error: null }, "provider-delivery-accepted");
  }

  failed(commandId, error, { uncertain = true } = {}) {
    const record = this.get(commandId);
    if (!record || EXECUTION_TERMINAL_STATUSES.has(record.status)) return record;
    return this.transition(record, uncertain ? "uncertain" : "failed", { error: errorText(error) }, uncertain ? "dispatch-uncertain" : "dispatch-rejected");
  }

  /** Explicit redrive for a proved rejection; never retry a lost response or executed turn. */
  retryRejected(commandId) {
    return executionTransaction(this.db, () => {
      const record = this.get(commandId);
      if (!record || record.status !== "failed") return null;
      const last = this.db.prepare("SELECT type FROM execution_events WHERE command_id=? ORDER BY sequence DESC LIMIT 1").get(commandId);
      const executed = this.db.prepare("SELECT 1 FROM execution_events WHERE command_id=? AND type IN ('provider-started','provider-terminal','provider-delivery-accepted') LIMIT 1").get(commandId);
      if (last?.type !== "dispatch-rejected" || executed) return null;
      return this.transition(record, "accepted", { error: null, dispatchedAt: null, ownerId: this.ownerId,
        ...(record.kind === "turn-start" ? { turnId: null } : {}) }, "rejection-retry-accepted", { previousRevision: record.revision });
    });
  }

  observeStarted(threadId, turnId, { commandId } = {}) {
    identity(threadId, "threadId"); identity(turnId, "turnId");
    const exact = decode(this.db.prepare("SELECT * FROM execution_commands WHERE thread_id=? AND kind='turn-start' AND turn_id=?").get(threadId, turnId));
    if (exact) {
      if (exact.status === "uncertain") return this.transition(exact, "running", { error: null }, "provider-started");
      return exact;
    }
    // A notification does not prove which request created its turn. Only an
    // explicitly correlated RPC result can bind a previously unknown identity.
    const candidate = commandId ? this.get(commandId) : null;
    return candidate?.threadId === threadId && candidate.kind === "turn-start" && candidate.ownerId === this.ownerId
      ? this.started(candidate.commandId, turnId) : null;
  }

  observeCompleted(threadId, turn) {
    if (typeof threadId !== "string" || !turn?.id) return null;
    const status = executionTurnStatus(turn);
    if (!EXECUTION_TERMINAL_STATUSES.has(status)) return null;
    const record = decode(this.db.prepare("SELECT * FROM execution_commands WHERE thread_id=? AND kind='turn-start' AND turn_id=?").get(threadId, turn.id));
    if (!record) {
      // Providers can emit terminal before their turn/start RPC response. Retain
      // only compact terminal facts, bounded in memory, until that response
      // supplies authoritative command→turn identity. Never infer from latest.
      if (typeof turn.id === "string" && turn.id.length <= 512) {
        this.unboundTerminal.set(JSON.stringify([threadId, turn.id]), { id: turn.id, status: turn.status, ...(turn.error ? { error: errorText(turn.error) } : {}) });
        while (this.unboundTerminal.size > MAX_RECOVERY_CANDIDATES) this.unboundTerminal.delete(this.unboundTerminal.keys().next().value);
      }
      return null;
    }
    if (EXECUTION_TERMINAL_STATUSES.has(record.status)) return record;
    return this.transition(record, status, { error: turn.error ? errorText(turn.error) : null }, "provider-terminal", { providerStatus: turn.status });
  }

  async reconcile({ readThread, onRunning = () => {}, onTerminal = () => {}, onUncertain = () => {}, limit = MAX_RECOVERY_CANDIDATES, concurrency = 4 }) {
    if (typeof readThread !== "function") throw new TypeError("Reconciliation requires a provider thread reader.");
    const candidates = this.listRecoverable(limit);
    const results = new Array(candidates.length);
    const slots = Number.isFinite(concurrency) ? Math.max(1, Math.min(4, Math.floor(concurrency))) : 4;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(slots, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++;
        const candidate = candidates[index];
        try {
          let record = this.get(candidate.commandId);
          if (!record || !RECOVERABLE.includes(record.status) || record.revision !== candidate.revision) { results[index] = { commandId: candidate.commandId, skipped: true }; continue; }
          // Provider-ready can race a new dispatch. Its live RPC still owns the
          // identity handshake; background recovery must not announce it lost.
          if (record.ownerId === this.ownerId && (record.status === "accepted" || record.status === "dispatching")) { results[index] = { commandId: candidate.commandId, skipped: true }; continue; }
          if (!record.turnId) {
            if (record.status !== "uncertain") record = this.transition(record, "uncertain", { error: "No confirmed provider turn identity is available. The accepted request is held; its prompt was not repeated." }, "recovery-uncertain");
            await onUncertain(record);
          } else {
            const response = await readThread(record.threadId);
            const thread = response?.thread ?? response;
            const turn = thread?.id === record.threadId ? thread.turns?.find((item) => item.id === record.turnId) : null;
            const current = this.get(record.commandId);
            if (!current || current.revision !== record.revision || !RECOVERABLE.includes(current.status)) { results[index] = { commandId: candidate.commandId, skipped: true }; continue; }
            const status = executionTurnStatus(turn);
            if (EXECUTION_TERMINAL_STATUSES.has(status)) {
              record = this.observeCompleted(record.threadId, turn);
              await onTerminal(record, turn);
            } else if (status === "running") {
              record = record.status === "running" ? record : this.transition(record, "running", { error: null }, "recovery-running");
              await onRunning(record, turn);
            } else {
              record = this.transition(record, "uncertain", { error: `The provider did not establish the state of turn ${record.turnId}. It remains reserved for recovery.` }, "recovery-uncertain");
              await onUncertain(record);
            }
          }
          results[index] = { commandId: candidate.commandId, status: record?.status, record };
        } catch (error) {
          // Reader/transport failure provides no evidence that the turn stopped.
          const current = this.get(candidate.commandId);
          const record = current && RECOVERABLE.includes(current.status) && current.revision === candidate.revision
            ? this.transition(current, "uncertain", { error: errorText(error) }, "recovery-read-failed") : current;
          results[index] = { commandId: candidate.commandId, status: record?.status, error: errorText(error), record };
          try { if (record?.status === "uncertain") await onUncertain(record); } catch (callbackError) { results[index].callbackError = errorText(callbackError); }
        }
      }
    }));
    return results;
  }
}
