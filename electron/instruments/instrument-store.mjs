import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { normalizeInstrumentDocument } from "./instrument-model.mjs";

function parseDocument(value) {
  return normalizeInstrumentDocument(JSON.parse(value));
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function mapInstrument(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    lifecycle: row.lifecycle,
    documentVersion: row.document_version,
    document: parseDocument(row.document_json),
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    grants: parseJson(row.grants_json, []),
    usageCount: row.usage_count ?? 0,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    threadId: row.thread_id,
    event: row.event_name,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    turnId: row.turn_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    version: row.document_version,
    document: parseDocument(row.document_json),
    createdAt: row.created_at
  };
}

function mapReceipt(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    instrumentId: row.instrument_id,
    threadId: row.thread_id,
    actionId: row.action_id,
    capability: row.capability,
    argumentsHash: row.arguments_hash,
    targetVersion: row.target_version,
    effectSummary: row.effect_summary,
    status: row.status,
    result: parseJson(row.result_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class InstrumentStore {
  constructor(userDataPath) {
    this.db = new DatabaseSync(path.join(userDataPath, "pixice-instruments.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS instruments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'ephemeral',
        document_version INTEGER NOT NULL DEFAULT 1,
        document_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        grants_json TEXT NOT NULL DEFAULT '[]',
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      );
      CREATE INDEX IF NOT EXISTS instruments_project_updated
        ON instruments(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS instruments_thread_updated
        ON instruments(thread_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS instrument_events (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        turn_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS instrument_events_instrument_created
        ON instrument_events(instrument_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS instrument_revisions (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL,
        document_version INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(instrument_id, document_version)
      );
      CREATE INDEX IF NOT EXISTS instrument_revisions_instrument_version
        ON instrument_revisions(instrument_id, document_version DESC);
      CREATE TABLE IF NOT EXISTS instrument_action_receipts (
        request_id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        target_version TEXT,
        effect_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS instrument_receipts_instrument_created
        ON instrument_action_receipts(instrument_id, created_at DESC);
    `);
    ensureColumn(this.db, "instruments", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn(this.db, "instruments", "grants_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.db, "instruments", "usage_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "instruments", "last_error", "TEXT");
    this.db.prepare(`
      INSERT OR IGNORE INTO instrument_revisions (id, instrument_id, document_version, document_json, created_at)
      SELECT id || ':' || document_version, id, document_version, document_json, updated_at FROM instruments
    `).run();
  }

  close() {
    this.db.close();
  }

  list(projectId, { threadId, includePinned = false } = {}) {
    const rows = threadId
      ? includePinned
        ? this.db.prepare("SELECT * FROM instruments WHERE project_id = ? AND (thread_id = ? OR lifecycle = 'pinned') ORDER BY lifecycle = 'pinned' DESC, updated_at DESC").all(projectId, threadId)
        : this.db.prepare("SELECT * FROM instruments WHERE project_id = ? AND thread_id = ? ORDER BY updated_at DESC").all(projectId, threadId)
      : this.db.prepare("SELECT * FROM instruments WHERE project_id = ? ORDER BY updated_at DESC").all(projectId);
    return rows.map(mapInstrument);
  }

  listPinned(projectId) {
    return this.db.prepare("SELECT * FROM instruments WHERE project_id = ? AND lifecycle = 'pinned' ORDER BY last_opened_at DESC, updated_at DESC").all(projectId).map(mapInstrument);
  }

  get(id) {
    return mapInstrument(this.db.prepare("SELECT * FROM instruments WHERE id = ?").get(id));
  }

  create({ id, projectId, threadId, document, lifecycle = "ephemeral", status = "ready", metadata = {}, grants = [] }) {
    const normalized = normalizeInstrumentDocument(document);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO instruments (
        id, project_id, thread_id, lifecycle, document_version,
        document_json, status, metadata_json, grants_json, usage_count,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, projectId, threadId, lifecycle, JSON.stringify(normalized), status, JSON.stringify(metadata), JSON.stringify(grants), now, now, now);
    this.db.prepare("INSERT INTO instrument_revisions (id, instrument_id, document_version, document_json, created_at) VALUES (?, ?, 1, ?, ?)").run(`${id}:1`, id, JSON.stringify(normalized), now);
    return this.get(id);
  }

  update(id, document, { expectedVersion, recordRevision = true } = {}) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    if (expectedVersion !== undefined && current.documentVersion !== expectedVersion) {
      throw new Error(`Instrument version conflict. Expected ${expectedVersion}, found ${current.documentVersion}`);
    }
    const normalized = normalizeInstrumentDocument(document);
    const updatedAt = new Date().toISOString();
    const nextVersion = current.documentVersion + 1;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE instruments
        SET document_version = ?, document_json = ?, updated_at = ?
        WHERE id = ?
      `).run(nextVersion, JSON.stringify(normalized), updatedAt, id);
      if (recordRevision) {
        this.db.prepare("INSERT INTO instrument_revisions (id, instrument_id, document_version, document_json, created_at) VALUES (?, ?, ?, ?, ?)").run(`${id}:${nextVersion}`, id, nextVersion, JSON.stringify(normalized), updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  open(id) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    this.db.prepare("UPDATE instruments SET last_opened_at = ?, usage_count = usage_count + 1 WHERE id = ?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  setLifecycle(id, lifecycle, threadId) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    this.db.prepare("UPDATE instruments SET lifecycle = ?, thread_id = ?, updated_at = ? WHERE id = ?").run(lifecycle, threadId ?? current.threadId, new Date().toISOString(), id);
    return this.get(id);
  }

  setMetadata(id, metadata) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    const next = { ...current.metadata, ...metadata };
    this.db.prepare("UPDATE instruments SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), new Date().toISOString(), id);
    return this.get(id);
  }

  setGrants(id, grants) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    this.db.prepare("UPDATE instruments SET grants_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...new Set(grants)].sort()), new Date().toISOString(), id);
    return this.get(id);
  }

  setLastError(id, error) {
    this.db.prepare("UPDATE instruments SET last_error = ?, updated_at = ? WHERE id = ?").run(error ? String(error).slice(0, 1_000) : null, new Date().toISOString(), id);
    return this.get(id);
  }

  listRevisions(id, limit = 50) {
    return this.db.prepare("SELECT * FROM instrument_revisions WHERE instrument_id = ? ORDER BY document_version DESC LIMIT ?").all(id, limit).map(mapRevision);
  }

  restoreRevision(id, version) {
    const current = this.get(id);
    if (!current) throw new Error("Instrument not found");
    const revision = this.db.prepare("SELECT * FROM instrument_revisions WHERE instrument_id = ? AND document_version = ?").get(id, version);
    if (!revision) throw new Error("Instrument revision not found");
    return this.update(id, parseDocument(revision.document_json), { expectedVersion: current.documentVersion });
  }

  delete(id) {
    const current = this.get(id);
    if (!current) return null;
    this.db.prepare("DELETE FROM instrument_events WHERE instrument_id = ?").run(id);
    this.db.prepare("DELETE FROM instrument_revisions WHERE instrument_id = ?").run(id);
    this.db.prepare("DELETE FROM instrument_action_receipts WHERE instrument_id = ?").run(id);
    this.db.prepare("DELETE FROM instruments WHERE id = ?").run(id);
    return current;
  }

  deleteEphemeralForThread(threadId) {
    const instruments = this.db.prepare("SELECT * FROM instruments WHERE thread_id = ? AND lifecycle = 'ephemeral'").all(threadId).map(mapInstrument);
    if (!instruments.length) return [];
    this.db.prepare("DELETE FROM instrument_events WHERE instrument_id IN (SELECT id FROM instruments WHERE thread_id = ? AND lifecycle = 'ephemeral')").run(threadId);
    this.db.prepare("DELETE FROM instrument_revisions WHERE instrument_id IN (SELECT id FROM instruments WHERE thread_id = ? AND lifecycle = 'ephemeral')").run(threadId);
    this.db.prepare("DELETE FROM instrument_action_receipts WHERE instrument_id IN (SELECT id FROM instruments WHERE thread_id = ? AND lifecycle = 'ephemeral')").run(threadId);
    this.db.prepare("DELETE FROM instruments WHERE thread_id = ? AND lifecycle = 'ephemeral'").run(threadId);
    return instruments;
  }

  createEvent({ id, instrumentId, threadId, event, payload }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO instrument_events (
        id, instrument_id, thread_id, event_name, payload_json,
        status, turn_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'sending', NULL, NULL, ?, ?)
    `).run(id, instrumentId, threadId, event, JSON.stringify(payload), now, now);
    this.db.prepare(`
      DELETE FROM instrument_events
      WHERE instrument_id = ? AND id NOT IN (
        SELECT id FROM instrument_events WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 200
      )
    `).run(instrumentId, instrumentId);
    return this.getEvent(id);
  }

  getEvent(id) {
    return mapEvent(this.db.prepare("SELECT * FROM instrument_events WHERE id = ?").get(id));
  }

  updateEvent(id, { status, turnId = null, error = null }) {
    this.db.prepare(`
      UPDATE instrument_events
      SET status = ?, turn_id = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, turnId, error, new Date().toISOString(), id);
    return this.getEvent(id);
  }

  listEvents(instrumentId, limit = 50) {
    return this.db.prepare("SELECT * FROM instrument_events WHERE instrument_id = ? ORDER BY created_at DESC LIMIT ?").all(instrumentId, limit).map(mapEvent);
  }

  createReceipt({ requestId, instrumentId, threadId, actionId, capability, argumentsHash, targetVersion = null, effectSummary }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO instrument_action_receipts (
        request_id, instrument_id, thread_id, action_id, capability,
        arguments_hash, target_version, effect_summary, status,
        result_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
    `).run(requestId, instrumentId, threadId, actionId, capability, argumentsHash, targetVersion, effectSummary, now, now);
    this.db.prepare(`
      DELETE FROM instrument_action_receipts
      WHERE instrument_id = ? AND request_id NOT IN (
        SELECT request_id FROM instrument_action_receipts WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 200
      )
    `).run(instrumentId, instrumentId);
    return this.getReceipt(requestId);
  }

  getReceipt(requestId) {
    return mapReceipt(this.db.prepare("SELECT * FROM instrument_action_receipts WHERE request_id = ?").get(requestId));
  }

  updateReceipt(requestId, { status, result = null, error = null }) {
    this.db.prepare("UPDATE instrument_action_receipts SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE request_id = ?").run(status, result === null ? null : JSON.stringify(result), error, new Date().toISOString(), requestId);
    return this.getReceipt(requestId);
  }

  listReceipts(instrumentId, limit = 50) {
    return this.db.prepare("SELECT * FROM instrument_action_receipts WHERE instrument_id = ? ORDER BY created_at DESC LIMIT ?").all(instrumentId, limit).map(mapReceipt);
  }
}
