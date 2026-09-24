import { randomUUID } from "node:crypto";

const DEFAULT_POLICY = Object.freeze({
  coordinatorModel: null,
  workerModel: null,
  reviewModel: null,
  permissionMode: "workspace-write",
  executionHost: "current"
});

const PERMISSION_MODES = new Set(["read-only", "workspace-write", "auto-approve", "full-access"]);
const WORK_STATUSES = new Set([
  "queued", "starting", "running", "blocked", "needs-attention", "awaiting-approval", "review", "done", "completed", "failed", "cancelled", "cancelling", "paused"
]);
const TERMINAL_WORK_STATUSES = new Set(["done", "completed", "failed", "cancelled"]);
const MAX_WORK_ITEMS = 200;
const MAX_EVENTS = 200;
const MAX_RESOURCES = 32;
const MAX_ARTIFACTS = 32;
const MAX_DEPENDENCIES = 32;
const MAX_DECISION_WORK_ITEMS = 32;

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boundedString(value, name, { max = 1_000, nullable = false, required = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (value === null) {
    if (nullable) return null;
    throw new Error(`${name} cannot be null`);
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return result;
}

function boundedArray(value, name, max) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > max) throw new Error(`${name} cannot contain more than ${max} entries`);
  return value;
}

function jsonValue(value, name, maxLength = 20_000) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be JSON serializable`);
  }
  if (encoded === undefined) throw new Error(`${name} must be JSON serializable`);
  if (encoded.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters when encoded`);
  return encoded;
}

function normalizeIdList(value, name, max) {
  return [...new Set(boundedArray(value, name, max).map((entry) => boundedString(entry, `${name} entry`, { max: 160, required: true })))];
}

function normalizeResources(value) {
  return boundedArray(value, "resources", MAX_RESOURCES)
    .map((entry) => boundedString(entry, "resource", { max: 2_048, required: true }));
}

function normalizeArtifacts(value) {
  const artifacts = boundedArray(value, "artifacts", MAX_ARTIFACTS);
  jsonValue(artifacts, "artifacts");
  return artifacts;
}
function normalizeVisuals(value) {
  return boundedArray(value, "visuals", 8).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("visual must be metadata");
    const result = {
      path: boundedString(item.path, "visual path", { max: 2000, required: true }),
      mimeType: boundedString(item.mimeType, "visual mimeType", { max: 32, required: true }),
      bytes: item.bytes,
      source: boundedString(item.source, "visual source", { max: 240, required: true }),
      label: boundedString(item.label ?? "", "visual label", { max: 120 })
    };
    if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(result.mimeType) || !Number.isInteger(result.bytes) || result.bytes < 1 || result.bytes > 8 * 1024 * 1024) throw new Error("Invalid visual metadata");
    return result;
  });
}

function normalizeLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`limit must be an integer from 1 to ${maximum}`);
  return value;
}

function mapPolicy(row) {
  return row ? {
    coordinatorModel: row.coordinator_model,
    workerModel: row.worker_model,
    reviewModel: row.review_model,
    permissionMode: row.permission_mode,
    executionHost: row.execution_host
  } : { ...DEFAULT_POLICY };
}

function mapWork(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    coordinatorThreadId: row.coordinator_thread_id,
    title: row.title,
    prompt: row.prompt,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    access: row.access,
    resources: parseJson(row.resources, []),
    artifacts: parseJson(row.artifacts, []),
    visuals: parseJson(row.visuals, []),
    dependsOn: parseJson(row.depends_on, []),
    reviewOf: row.review_of,
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
    answer: row.answer,
    error: row.error,
    verification: row.verification === null ? null : parseJson(row.verification, null),
    revision: row.revision,
    decisionRevision: row.decision_revision,
    acknowledgedDecisionRevision: row.acknowledged_decision_revision,
    completionReported: Boolean(row.completion_reported),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    ...parseJson(row.metadata, {}),
    id: row.id,
    projectId: row.project_id,
    workId: row.work_id,
    kind: row.kind,
    message: row.message,
    sequence: row.sequence,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  };
}

function mapDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    text: row.text,
    workIds: parseJson(row.work_ids, []),
    sourceThreadId: row.source_thread_id,
    createdAt: row.created_at
  };
}

/** Durable, project-scoped state for Focus coordination. */
export class FocusStore {
  constructor(database) {
    if (!database?.db?.prepare || !database?.db?.exec) throw new Error("FocusStore requires a Pixice database connection");
    this.database = database;
    this.db = database.db;
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS focus_policies (
        project_id TEXT PRIMARY KEY,
        coordinator_model TEXT,
        worker_model TEXT,
        review_model TEXT,
        -- Retained for existing databases; legacy values no longer control scheduling.
        max_workers INTEGER NOT NULL DEFAULT 2,
        permission_mode TEXT NOT NULL DEFAULT 'workspace-write',
        execution_host TEXT NOT NULL DEFAULT 'current',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS focus_work (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        coordinator_thread_id TEXT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        access TEXT NOT NULL,
        resources TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        visuals TEXT NOT NULL DEFAULT '[]',
        depends_on TEXT NOT NULL DEFAULT '[]',
        review_of TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        thread_id TEXT,
        turn_id TEXT,
        answer TEXT NOT NULL DEFAULT '',
        error TEXT,
        verification TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        decision_revision INTEGER NOT NULL DEFAULT 0,
        acknowledged_decision_revision INTEGER NOT NULL DEFAULT 0,
        completion_reported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS focus_work_project_updated ON focus_work(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS focus_work_recoverable ON focus_work(status, completion_reported, updated_at ASC);
      CREATE INDEX IF NOT EXISTS focus_work_thread ON focus_work(thread_id) WHERE thread_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS focus_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        work_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(work_id) REFERENCES focus_work(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS focus_events_project_sequence ON focus_events(project_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS focus_events_pending ON focus_events(project_id, delivered_at, sequence ASC);
      CREATE TABLE IF NOT EXISTS focus_project_state (
        project_id TEXT PRIMARY KEY,
        seen_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS focus_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        work_ids TEXT NOT NULL DEFAULT '[]',
        source_thread_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, revision),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS focus_decisions_project_revision ON focus_decisions(project_id, revision DESC);
    `);
    this.#ensureColumn("focus_work", "artifacts", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("focus_work", "visuals", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("focus_work", "review_of", "TEXT");
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  #requireProject(projectId) {
    const id = boundedString(projectId, "projectId", { max: 160, required: true });
    if (!this.db.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(id)) throw new Error("Project not found");
    return id;
  }

  #transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #validatePolicyPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Policy patch must be an object");
    const allowed = new Set(["coordinatorModel", "workerModel", "reviewModel", "permissionMode", "executionHost"]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unknown policy field: ${key}`);
    const result = {};
    for (const field of ["coordinatorModel", "workerModel", "reviewModel"]) {
      if (Object.hasOwn(patch, field)) result[field] = boundedString(patch[field], field, { max: 256, nullable: true });
    }
    if (Object.hasOwn(patch, "permissionMode")) {
      if (!PERMISSION_MODES.has(patch.permissionMode)) throw new Error("Unsupported permissionMode");
      result.permissionMode = patch.permissionMode;
    }
    if (Object.hasOwn(patch, "executionHost")) {
      if (patch.executionHost !== "current") throw new Error("executionHost must be current");
      result.executionHost = "current";
    }
    return result;
  }

  getPolicy(projectId) {
    const id = this.#requireProject(projectId);
    return mapPolicy(this.db.prepare("SELECT * FROM focus_policies WHERE project_id = ?").get(id));
  }

  updatePolicy(projectId, patch) {
    const id = this.#requireProject(projectId);
    const next = { ...this.getPolicy(id), ...this.#validatePolicyPatch(patch) };
    this.db.prepare(`INSERT INTO focus_policies (
      project_id, coordinator_model, worker_model, review_model, permission_mode, execution_host, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET coordinator_model=excluded.coordinator_model,
      worker_model=excluded.worker_model, review_model=excluded.review_model,
      permission_mode=excluded.permission_mode, execution_host=excluded.execution_host, updated_at=excluded.updated_at`).run(
      id, next.coordinatorModel, next.workerModel, next.reviewModel, next.permissionMode, next.executionHost, now()
    );
    return this.getPolicy(id);
  }

  #validateDependencies(projectId, workId, dependsOn) {
    if (dependsOn.includes(workId)) throw new Error("Work cannot depend on itself");
    for (const dependencyId of dependsOn) {
      const row = this.db.prepare("SELECT project_id FROM focus_work WHERE id = ?").get(dependencyId);
      if (!row || row.project_id !== projectId) throw new Error("A dependency is outside this project");
    }
    const edges = this.db.prepare("SELECT id, depends_on FROM focus_work WHERE project_id = ?").all(projectId)
      .filter((row) => row.id !== workId)
      .map((row) => [row.id, parseJson(row.depends_on, [])]);
    edges.push([workId, dependsOn]);
    const outgoing = new Map(edges);
    const visit = (id, visiting = new Set(), visited = new Set()) => {
      if (visiting.has(id)) throw new Error("Work dependencies contain a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const next of outgoing.get(id) ?? []) visit(next, visiting, visited);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of outgoing.keys()) visit(id);
  }

  #normalizeWorkInput(projectId, input, current = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Work input must be an object");
    const allowed = new Set([
      "id",
      "coordinatorThreadId", "title", "prompt", "model", "effort", "permissionMode", "access", "resources", "dependsOn",
      "artifacts", "visuals", "reviewOf", "status", "threadId", "turnId", "answer", "error", "verification", "decisionRevision", "acknowledgedDecisionRevision", "completionReported"
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key) || (key === "id" && current)) throw new Error(`Unknown work field: ${key}`);
    }
    const policy = this.getPolicy(projectId);
    const base = current ?? {
      coordinatorThreadId: null, title: "", prompt: "", model: policy.workerModel, effort: null,
      permissionMode: policy.permissionMode, access: "write", resources: [], artifacts: [], visuals: [], dependsOn: [], reviewOf: null, status: "queued", threadId: null,
      turnId: null, answer: "", error: null, verification: null, decisionRevision: 0, acknowledgedDecisionRevision: 0, completionReported: false
    };
    const value = { ...base };
    const strings = [
      ["coordinatorThreadId", 160, true], ["title", 240, false], ["prompt", 100_000, false], ["model", 256, true], ["effort", 96, true],
      ["threadId", 160, true], ["turnId", 160, true], ["answer", 60_000, false], ["error", 8_000, true]
    ];
    for (const [field, max, nullable] of strings) {
      if (Object.hasOwn(input, field)) value[field] = boundedString(input[field], field, { max, nullable, required: field === "title" });
    }
    if (Object.hasOwn(input, "permissionMode")) {
      if (!PERMISSION_MODES.has(input.permissionMode)) throw new Error("Unsupported permissionMode");
      value.permissionMode = input.permissionMode;
    }
    if (Object.hasOwn(input, "access")) {
      if (input.access !== "read" && input.access !== "write") throw new Error("access must be read or write");
      value.access = input.access;
    }
    if (Object.hasOwn(input, "resources")) value.resources = normalizeResources(input.resources);
    if (Object.hasOwn(input, "artifacts")) value.artifacts = normalizeArtifacts(input.artifacts);
    if (Object.hasOwn(input, "visuals")) value.visuals = normalizeVisuals(input.visuals);
    if (Object.hasOwn(input, "dependsOn")) value.dependsOn = normalizeIdList(input.dependsOn, "dependsOn", MAX_DEPENDENCIES);
    if (Object.hasOwn(input, "reviewOf")) value.reviewOf = boundedString(input.reviewOf, "reviewOf", { max: 160, nullable: true });
    if (Object.hasOwn(input, "status")) {
      if (!WORK_STATUSES.has(input.status)) throw new Error("Unsupported work status");
      value.status = input.status;
    }
    if (Object.hasOwn(input, "verification")) {
      if (input.verification !== null) jsonValue(input.verification, "verification");
      value.verification = input.verification;
    }
    for (const field of ["decisionRevision", "acknowledgedDecisionRevision"]) {
      if (Object.hasOwn(input, field)) {
        if (!Number.isInteger(input[field]) || input[field] < 0) throw new Error(`${field} must be a non-negative integer`);
        value[field] = input[field];
      }
    }
    if (value.acknowledgedDecisionRevision > value.decisionRevision) throw new Error("acknowledgedDecisionRevision cannot exceed decisionRevision");
    if (Object.hasOwn(input, "completionReported")) {
      if (typeof input.completionReported !== "boolean") throw new Error("completionReported must be a boolean");
      value.completionReported = input.completionReported;
    }
    return value;
  }

  listWork(projectId, { query, limit = 40 } = {}) {
    const id = this.#requireProject(projectId);
    const count = normalizeLimit(limit, 40, MAX_WORK_ITEMS);
    const term = query === undefined ? null : boundedString(query, "query", { max: 240 });
    const rows = term
      ? this.db.prepare(`SELECT * FROM focus_work WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC, id ASC LIMIT ?`).all(id, `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, count)
      : this.db.prepare("SELECT * FROM focus_work WHERE project_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?").all(id, count);
    return rows.map(mapWork);
  }

  getWork(projectId, workId) {
    const id = this.#requireProject(projectId);
    const work = boundedString(workId, "workId", { max: 160, required: true });
    return mapWork(this.db.prepare("SELECT * FROM focus_work WHERE project_id = ? AND id = ?").get(id, work));
  }

  getWorkByThread(threadId) {
    const id = boundedString(threadId, "threadId", { max: 160, required: true });
    return mapWork(this.db.prepare("SELECT * FROM focus_work WHERE thread_id = ? ORDER BY updated_at DESC, id ASC LIMIT 1").get(id));
  }

  createWork(projectId, input = {}) {
    const id = this.#requireProject(projectId);
    const workId = input.id === undefined ? randomUUID() : boundedString(input.id, "id", { max: 160, required: true });
    const value = this.#normalizeWorkInput(id, input);
    if (!value.title) throw new Error("title is required");
    const timestamp = now();
    return this.#transaction(() => {
      this.#validateDependencies(id, workId, value.dependsOn);
      if (value.reviewOf && !this.getWork(id, value.reviewOf)) throw new Error("reviewOf belongs to another project or does not exist");
      this.db.prepare(`INSERT INTO focus_work (
        id, project_id, coordinator_thread_id, title, prompt, model, effort, permission_mode, access, resources, artifacts, visuals, depends_on, review_of,
        status, thread_id, turn_id, answer, error, verification, revision, decision_revision, acknowledged_decision_revision,
        completion_reported, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
        workId, id, value.coordinatorThreadId, value.title, value.prompt, value.model, value.effort, value.permissionMode, value.access,
        jsonValue(value.resources, "resources"), jsonValue(value.artifacts, "artifacts"), jsonValue(value.visuals, "visuals"), jsonValue(value.dependsOn, "dependsOn"), value.reviewOf,
        value.status, value.threadId, value.turnId, value.answer, value.error, value.verification === null ? null : jsonValue(value.verification, "verification"), value.decisionRevision,
        value.acknowledgedDecisionRevision, value.completionReported ? 1 : 0, timestamp, timestamp
      );
      return this.getWork(id, workId);
    });
  }

  updateWork(projectId, workId, patch) {
    const id = this.#requireProject(projectId);
    const work = boundedString(workId, "workId", { max: 160, required: true });
    return this.#transaction(() => {
      const current = this.getWork(id, work);
      if (!current) throw new Error("Work not found");
      const value = this.#normalizeWorkInput(id, patch, current);
      this.#validateDependencies(id, work, value.dependsOn);
      if (value.reviewOf && (value.reviewOf === work || !this.getWork(id, value.reviewOf))) throw new Error("reviewOf belongs to another project or does not exist");
      const timestamp = now();
      this.db.prepare(`UPDATE focus_work SET coordinator_thread_id=?, title=?, prompt=?, model=?, effort=?, permission_mode=?, access=?,
        resources=?, artifacts=?, visuals=?, depends_on=?, review_of=?, status=?, thread_id=?, turn_id=?, answer=?, error=?, verification=?, revision=revision + 1,
        decision_revision=?, acknowledged_decision_revision=?, completion_reported=?, updated_at=? WHERE project_id=? AND id=?`).run(
        value.coordinatorThreadId, value.title, value.prompt, value.model, value.effort, value.permissionMode, value.access,
        jsonValue(value.resources, "resources"), jsonValue(value.artifacts, "artifacts"), jsonValue(value.visuals, "visuals"), jsonValue(value.dependsOn, "dependsOn"), value.reviewOf,
        value.status, value.threadId, value.turnId, value.answer, value.error, value.verification === null ? null : jsonValue(value.verification, "verification"), value.decisionRevision,
        value.acknowledgedDecisionRevision, value.completionReported ? 1 : 0, timestamp, id, work
      );
      return this.getWork(id, work);
    });
  }

  listRecoverableWork() {
    return this.db.prepare(`SELECT * FROM focus_work
      WHERE status NOT IN ('done', 'completed', 'failed', 'cancelled') OR completion_reported = 0
      ORDER BY updated_at ASC, id ASC`).all().map(mapWork);
  }

  appendEvent(projectId, { workId = null, kind, message = "", ...metadata } = {}) {
    const id = this.#requireProject(projectId);
    const resolvedWorkId = workId === null ? null : boundedString(workId, "workId", { max: 160, required: true });
    if (resolvedWorkId && !this.getWork(id, resolvedWorkId)) throw new Error("Event work belongs to another project or does not exist");
    const eventKind = boundedString(kind, "kind", { max: 96, required: true });
    const eventMessage = boundedString(message, "message", { max: 8_000 }) ?? "";
    const timestamp = now();
    const eventId = randomUUID();
    const result = this.db.prepare(`INSERT INTO focus_events (id, project_id, work_id, kind, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(eventId, id, resolvedWorkId, eventKind, eventMessage, jsonValue(metadata, "event metadata"), timestamp);
    return mapEvent(this.db.prepare("SELECT * FROM focus_events WHERE sequence = ?").get(Number(result.lastInsertRowid)));
  }

  listEvents(projectId, { after = 0, limit = 50 } = {}) {
    const id = this.#requireProject(projectId);
    if (!Number.isInteger(after) || after < 0) throw new Error("after must be a non-negative integer");
    const count = normalizeLimit(limit, 50, MAX_EVENTS);
    return this.db.prepare("SELECT * FROM focus_events WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(id, after, count).map(mapEvent);
  }

  markEventsDelivered(projectId, ids) {
    const id = this.#requireProject(projectId);
    const eventIds = normalizeIdList(ids, "ids", 100);
    if (!eventIds.length) return 0;
    const placeholders = eventIds.map(() => "?").join(", ");
    return this.db.prepare(`UPDATE focus_events SET delivered_at = COALESCE(delivered_at, ?) WHERE project_id = ? AND id IN (${placeholders})`)
      .run(now(), id, ...eventIds).changes;
  }

  pendingEvents(projectId, limit = 20) {
    const id = this.#requireProject(projectId);
    const count = normalizeLimit(limit, 20, MAX_EVENTS);
    return this.db.prepare("SELECT * FROM focus_events WHERE project_id = ? AND delivered_at IS NULL ORDER BY sequence ASC LIMIT ?")
      .all(id, count).map(mapEvent);
  }

  latestSequence(projectId) {
    const id = this.#requireProject(projectId);
    return this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM focus_events WHERE project_id = ?").get(id).sequence;
  }

  getSeen(projectId) {
    const id = this.#requireProject(projectId);
    return this.db.prepare("SELECT seen_sequence FROM focus_project_state WHERE project_id = ?").get(id)?.seen_sequence ?? 0;
  }

  markSeen(projectId, sequence) {
    const id = this.#requireProject(projectId);
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
    this.db.prepare(`INSERT INTO focus_project_state (project_id, seen_sequence, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET seen_sequence = MAX(focus_project_state.seen_sequence, excluded.seen_sequence), updated_at = excluded.updated_at`)
      .run(id, sequence, now());
    return this.getSeen(id);
  }

  recordDecision(projectId, { text, workIds = [], sourceThreadId = null } = {}) {
    const id = this.#requireProject(projectId);
    const decisionText = boundedString(text, "text", { max: 12_000, required: true });
    const ids = normalizeIdList(workIds, "workIds", MAX_DECISION_WORK_ITEMS);
    const threadId = boundedString(sourceThreadId, "sourceThreadId", { max: 160, nullable: true });
    return this.#transaction(() => {
      for (const workId of ids) if (!this.getWork(id, workId)) throw new Error("Decision work belongs to another project or does not exist");
      const revision = (this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM focus_decisions WHERE project_id = ?").get(id).revision ?? 0) + 1;
      const decisionId = randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO focus_decisions (id, project_id, revision, text, work_ids, source_thread_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(decisionId, id, revision, decisionText, jsonValue(ids, "workIds"), threadId, timestamp);
      return mapDecision(this.db.prepare("SELECT * FROM focus_decisions WHERE id = ?").get(decisionId));
    });
  }

  listDecisions(projectId, { workId, limit = 20 } = {}) {
    const id = this.#requireProject(projectId);
    const count = normalizeLimit(limit, 20, 100);
    if (workId === undefined) {
      return this.db.prepare("SELECT * FROM focus_decisions WHERE project_id = ? ORDER BY revision DESC LIMIT ?").all(id, count).map(mapDecision);
    }
    const scopedWorkId = boundedString(workId, "workId", { max: 160, required: true });
    if (!this.getWork(id, scopedWorkId)) throw new Error("Work not found");
    // Filter before limiting so an older direction for this work cannot be hidden by
    // an unrelated project's recent decision history. Empty workIds are project-wide.
    return this.db.prepare("SELECT * FROM focus_decisions WHERE project_id = ? ORDER BY revision DESC").all(id)
      .map(mapDecision)
      .filter((decision) => decision.workIds.length === 0 || decision.workIds.includes(scopedWorkId))
      .slice(0, count);
  }

  latestDecisionRevision(projectId) {
    const id = this.#requireProject(projectId);
    return this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM focus_decisions WHERE project_id = ?").get(id).revision;
  }
}
