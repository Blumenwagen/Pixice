import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

function localDayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function usageTotals(rows) {
  return rows.reduce((totals, row) => {
    totals.inputTokens += row.input_tokens;
    totals.cachedInputTokens += row.cached_input_tokens;
    totals.cacheWriteInputTokens += row.cache_write_input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.reasoningOutputTokens += row.reasoning_output_tokens;
    totals.totalTokens += row.input_tokens + row.cached_input_tokens + row.cache_write_input_tokens + row.output_tokens;
    if (row.cost_usd !== null) totals.costUsd += row.cost_usd;
    totals.events += 1;
    if (row.cost_usd === null) {
      totals.unpricedEvents += 1;
      totals.unpricedTokens += row.input_tokens + row.cached_input_tokens + row.cache_write_input_tokens + row.output_tokens;
    }
    return totals;
  }, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    events: 0,
    unpricedEvents: 0,
    unpricedTokens: 0
  });
}

const DEFAULT_PROJECT_ICON = "folder";
const DEFAULT_PROJECT_COLOR = "blue";
const LEGACY_BRIDGE_KIND = `${["lo", "om"].join("")}Bridge`;

function mapProject(row, folders = []) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalPath: row.canonical_path,
    displayName: row.display_name,
    icon: row.icon || DEFAULT_PROJECT_ICON,
    color: row.color || DEFAULT_PROJECT_COLOR,
    folders: folders.length ? folders : [row.canonical_path],
    lastUsedAt: row.last_used_at || row.updated_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBoardTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    kind: row.kind ?? "task",
    priority: row.priority ?? "normal",
    estimateMinutes: row.estimate_minutes ?? null,
    owner: row.owner ?? "",
    revision: row.revision ?? 1,
    column: row.column_id,
    position: row.position,
    threadId: row.thread_id,
    createdByThreadId: row.created_by_thread_id,
    latestActivity: row.activity_id ? {
      id: row.activity_id,
      kind: row.activity_kind,
      summary: row.activity_summary,
      threadId: row.activity_thread_id,
      turnId: row.activity_turn_id,
      actorKind: row.activity_actor_kind ?? null,
      actorId: row.activity_actor_id ?? null,
      metadata: parsedJson(row.activity_metadata, {}),
      createdAt: row.activity_created_at
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parsedJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function providerThreadSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return {};
  const latestTurn = snapshot.turns?.at?.(-1);
  const completionRevision = latestTurn?.status === "completed"
    ? `turn:${latestTurn.id ?? snapshot.updatedAt ?? "completed"}`
    : snapshot.completionRevision ?? null;
  return {
    id: snapshot.id,
    providerThreadId: snapshot.providerThreadId ?? null,
    cwd: snapshot.cwd ?? "",
    ephemeral: snapshot.ephemeral === true,
    name: snapshot.name ?? null,
    preview: snapshot.preview ?? "",
    source: snapshot.source ?? "appServer",
    createdAt: snapshot.createdAt ?? null,
    updatedAt: snapshot.updatedAt ?? null,
    parentThreadId: snapshot.parentThreadId ?? null,
    forkedFromId: snapshot.forkedFromId ?? null,
    status: snapshot.status ?? { type: "notLoaded" },
    ...(completionRevision ? { completionRevision } : {})
  };
}

function providerThreadIsActive(snapshot) {
  return snapshot?.status === "active" || snapshot?.status?.type === "active";
}

function mapProactiveSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    type: row.type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    title: row.title,
    message: row.message,
    payload: parsedJson(row.payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PixiceDatabase {
  constructor(userDataPath) {
    this.boardListeners = new Set();
    this.db = new DatabaseSync(path.join(userDataPath, "pixice.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'folder', color TEXT NOT NULL DEFAULT 'blue',
        last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_folders (
        project_id TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, canonical_path),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS project_folders_project ON project_folders(project_id, position);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root_thread_id TEXT,
        execution_mode TEXT NOT NULL, working_path TEXT NOT NULL, base_commit TEXT,
        branch_name TEXT, worktree_path TEXT, lifecycle_state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS task_view_state (
        task_id TEXT PRIMARY KEY, unread_count INTEGER NOT NULL DEFAULT 0,
        selected_agent_id TEXT, panel_state TEXT, last_seen_event TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS thread_runtime_state (
        thread_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_turn_timings (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS thread_turn_timings_thread ON thread_turn_timings(thread_id, started_at);
      CREATE TABLE IF NOT EXISTS thread_names (
        thread_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_board_state (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, column_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS thread_board_state_project ON thread_board_state(project_id, column_id, updated_at);
      CREATE TABLE IF NOT EXISTS board_tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', column_id TEXT NOT NULL,
        position INTEGER NOT NULL, thread_id TEXT, created_by_thread_id TEXT,
        kind TEXT NOT NULL DEFAULT 'task', priority TEXT NOT NULL DEFAULT 'normal',
        estimate_minutes INTEGER, owner TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS board_tasks_project ON board_tasks(project_id, column_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS board_tasks_thread ON board_tasks(thread_id) WHERE thread_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS board_phases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        created_by_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS board_phases_project ON board_phases(project_id, created_at);
      CREATE TABLE IF NOT EXISTS board_phase_tasks (
        phase_id TEXT NOT NULL, task_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(phase_id, task_id),
        FOREIGN KEY(phase_id) REFERENCES board_phases(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES board_tasks(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS board_phase_tasks_task ON board_phase_tasks(task_id);
      CREATE TABLE IF NOT EXISTS board_task_activity (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        thread_id TEXT, turn_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL,
        dedupe_key TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
        actor_kind TEXT, actor_id TEXT, created_at TEXT NOT NULL,
        UNIQUE(task_id, dedupe_key),
        FOREIGN KEY(task_id) REFERENCES board_tasks(id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS board_task_activity_task ON board_task_activity(task_id, created_at);
      CREATE TABLE IF NOT EXISTS board_task_schedules (
        task_id TEXT PRIMARY KEY, planned_start TEXT, planned_end TEXT, hard_deadline TEXT,
        all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'UTC',
        constraint_type TEXT NOT NULL DEFAULT 'flexible', locked_fields TEXT NOT NULL DEFAULT '[]',
        auto_schedule INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        updated_by_kind TEXT, updated_by_id TEXT, explanation TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES board_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS board_task_dependencies (
        task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL,
        dependency_type TEXT NOT NULL DEFAULT 'finish-to-start', lag_minutes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, depends_on_task_id),
        FOREIGN KEY(task_id) REFERENCES board_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(depends_on_task_id) REFERENCES board_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS board_task_dependencies_target ON board_task_dependencies(depends_on_task_id);
      CREATE TABLE IF NOT EXISTS board_task_workflow_bindings (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, workflow_id TEXT NOT NULL, trigger_node_id TEXT,
        trigger_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        missed_trigger_policy TEXT NOT NULL DEFAULT 'ask', expected_task_revision INTEGER,
        expected_schedule_revision INTEGER, created_by_thread_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES board_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS board_task_workflow_bindings_task ON board_task_workflow_bindings(task_id, enabled);
      CREATE TABLE IF NOT EXISTS board_task_trigger_receipts (
        idempotency_key TEXT PRIMARY KEY, binding_id TEXT NOT NULL, task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL, event_type TEXT NOT NULL, effective_at TEXT NOT NULL,
        run_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_plan_proposals (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed', proposal TEXT NOT NULL,
        base_revisions TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS board_plan_proposals_project ON board_plan_proposals(project_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS work_pattern_occurrences (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, signature TEXT NOT NULL, steps TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE(project_id, thread_id, turn_id, signature),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS work_pattern_occurrences_pattern
        ON work_pattern_occurrences(project_id, signature, created_at);
      CREATE TABLE IF NOT EXISTS proactive_suggestions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT,
        type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        dedupe_key TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, dedupe_key),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS proactive_suggestions_project
        ON proactive_suggestions(project_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS thread_provider_bindings (
        thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_thread_id TEXT,
        resume_cursor TEXT, cwd TEXT NOT NULL DEFAULT '', forked_from_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_thread_snapshots (
        thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES thread_provider_bindings(thread_id)
      );
      CREATE TABLE IF NOT EXISTS provider_thread_active_turns (
        thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, turn TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES thread_provider_bindings(thread_id)
      );
      CREATE TABLE IF NOT EXISTS thread_links (
        child_thread_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL,
        kind TEXT NOT NULL, model TEXT, effort TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_links_parent ON thread_links(parent_thread_id);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, provider TEXT NOT NULL,
        model TEXT, service_tier TEXT, recorded_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, cost_source TEXT NOT NULL,
        pricing_model TEXT, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS usage_events_recorded_at ON usage_events(recorded_at);
      CREATE INDEX IF NOT EXISTS usage_events_model ON usage_events(provider, model);
      CREATE TABLE IF NOT EXISTS task_results (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL,
        updated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_results_project ON task_results(project_id);
    `);

      const projectColumns = new Set(this.db.prepare("PRAGMA table_info(projects)").all().map((column) => column.name));
      if (!projectColumns.has("icon")) this.db.exec("ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'");
      if (!projectColumns.has("color")) this.db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'");
      if (!projectColumns.has("last_used_at")) this.db.exec("ALTER TABLE projects ADD COLUMN last_used_at TEXT");
      const boardColumns = new Set(this.db.prepare("PRAGMA table_info(board_tasks)").all().map((column) => column.name));
      if (!boardColumns.has("kind")) this.db.exec("ALTER TABLE board_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
      if (!boardColumns.has("priority")) this.db.exec("ALTER TABLE board_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
      if (!boardColumns.has("estimate_minutes")) this.db.exec("ALTER TABLE board_tasks ADD COLUMN estimate_minutes INTEGER");
      if (!boardColumns.has("owner")) this.db.exec("ALTER TABLE board_tasks ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
      if (!boardColumns.has("revision")) this.db.exec("ALTER TABLE board_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
      const activityColumns = new Set(this.db.prepare("PRAGMA table_info(board_task_activity)").all().map((column) => column.name));
      if (!activityColumns.has("actor_kind")) this.db.exec("ALTER TABLE board_task_activity ADD COLUMN actor_kind TEXT");
      if (!activityColumns.has("actor_id")) this.db.exec("ALTER TABLE board_task_activity ADD COLUMN actor_id TEXT");
      const providerBindingColumns = new Set(this.db.prepare("PRAGMA table_info(thread_provider_bindings)").all().map((column) => column.name));
      if (!providerBindingColumns.has("forked_from_id")) this.db.exec("ALTER TABLE thread_provider_bindings ADD COLUMN forked_from_id TEXT");
      const snapshotColumns = new Set(this.db.prepare("PRAGMA table_info(provider_thread_snapshots)").all().map((column) => column.name));
      if (!snapshotColumns.has("summary")) this.db.exec("ALTER TABLE provider_thread_snapshots ADD COLUMN summary TEXT NOT NULL DEFAULT '{}'");
      const updateSnapshotSummary = this.db.prepare("UPDATE provider_thread_snapshots SET summary = ? WHERE thread_id = ?");
      for (const row of this.db.prepare("SELECT thread_id, snapshot FROM provider_thread_snapshots WHERE summary = '{}'").all()) {
        updateSnapshotSummary.run(JSON.stringify(providerThreadSummary(parsedJson(row.snapshot, {}))), row.thread_id);
      }
      const backfillForkAncestry = this.db.prepare("UPDATE thread_provider_bindings SET forked_from_id = ? WHERE thread_id = ? AND forked_from_id IS NULL");
      for (const row of this.db.prepare(`
        SELECT bindings.thread_id, snapshots.snapshot, snapshots.summary
        FROM thread_provider_bindings AS bindings
        JOIN provider_thread_snapshots AS snapshots ON snapshots.thread_id = bindings.thread_id
        WHERE bindings.forked_from_id IS NULL
          AND (snapshots.snapshot LIKE '%"forkedFromId"%' OR snapshots.summary LIKE '%"forkedFromId"%')
      `).all()) {
        const snapshot = parsedJson(row.snapshot, {});
        const summary = parsedJson(row.summary, {});
        const forkedFromId = snapshot.forkedFromId ?? summary.forkedFromId;
        if (typeof forkedFromId === "string" && forkedFromId.trim()) {
          backfillForkAncestry.run(forkedFromId, row.thread_id);
        }
      }
      this.db.exec(`
        INSERT OR IGNORE INTO project_folders (project_id, canonical_path, position, created_at)
        SELECT id, canonical_path, 0, created_at FROM projects
      `);
      this.db.prepare("UPDATE thread_links SET kind = ? WHERE kind = ?").run("pixiceBridge", LEGACY_BRIDGE_KIND);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.db.close();
      throw error;
    }
  }

  listProjects() {
    return this.db.prepare(`
      SELECT * FROM projects
      ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC, updated_at DESC, id ASC
    `).all().map((row) => this.#mapProject(row));
  }

  getAppSettings() {
    const settings = {};
    for (const row of this.db.prepare("SELECT key, value FROM app_settings").all()) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        // Ignore malformed values so one old preference cannot block startup.
      }
    }
    return settings;
  }

  saveAppSettings(patch) {
    const updatedAt = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(patch)) {
        statement.run(key, JSON.stringify(value), updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAppSettings();
  }

  getProject(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    return this.#mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
  }

  getProjectByFolder(canonicalPath) {
    const row = this.db.prepare(`
      SELECT projects.* FROM projects
      JOIN project_folders ON project_folders.project_id = projects.id
      WHERE project_folders.canonical_path = ?
    `).get(canonicalPath);
    return this.#mapProject(row);
  }

  listProjectFolders(projectId) {
    return this.db.prepare(`
      SELECT canonical_path FROM project_folders
      WHERE project_id = ? ORDER BY position ASC, canonical_path ASC
    `).all(projectId).map((row) => row.canonical_path);
  }

  touchProject(projectId, lastUsedAt = new Date().toISOString()) {
    const result = this.db.prepare("UPDATE projects SET last_used_at = ? WHERE id = ?").run(lastUsedAt, projectId);
    if (!result.changes) return null;
    return this.getProject(projectId);
  }

  createProject(project) {
    const folders = [...new Set(project.folders?.length ? project.folders : [project.canonicalPath])];
    if (!folders.length) throw new Error("A project needs at least one folder");
    const canonicalPath = folders[0];
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO projects (id, canonical_path, display_name, icon, color, last_used_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        canonicalPath,
        project.displayName,
        project.icon ?? DEFAULT_PROJECT_ICON,
        project.color ?? DEFAULT_PROJECT_COLOR,
        project.lastUsedAt ?? project.updatedAt,
        project.createdAt,
        project.updatedAt
      );
      const insertFolder = this.db.prepare(`
        INSERT INTO project_folders (project_id, canonical_path, position, created_at)
        VALUES (?, ?, ?, ?)
      `);
      folders.forEach((folder, position) => insertFolder.run(project.id, folder, position, project.createdAt));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(project.id);
  }

  deleteProject(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM board_task_trigger_receipts WHERE task_id IN (SELECT id FROM board_tasks WHERE project_id = ?)").run(projectId);
      this.db.prepare("DELETE FROM board_task_activity WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM board_phases WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM board_tasks WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM board_plan_proposals WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM work_pattern_occurrences WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM proactive_suggestions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM thread_board_state WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM task_view_state WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(projectId);
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_folders WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM task_results WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      this.db.exec("COMMIT");
      return project;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProject(project) {
    const existingProject = this.getProjectByFolder(project.canonicalPath);
    const existing = existingProject ? this.db.prepare("SELECT * FROM projects WHERE id = ?").get(existingProject.id) : null;
    const id = existing?.id ?? project.id;
    const createdAt = existing?.created_at ?? project.createdAt;
    if (existing) {
      this.db.prepare(`
        UPDATE projects SET display_name = ?, icon = ?, color = ?, last_used_at = ?, updated_at = ? WHERE id = ?
      `).run(
        project.displayName,
        project.icon ?? existing.icon ?? DEFAULT_PROJECT_ICON,
        project.color ?? existing.color ?? DEFAULT_PROJECT_COLOR,
        project.lastUsedAt ?? existing.last_used_at ?? project.updatedAt,
        project.updatedAt,
        id
      );
      return this.getProject(id);
    }
    this.db.prepare(`
      INSERT INTO projects (id, canonical_path, display_name, icon, color, last_used_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_path) DO UPDATE SET
        display_name=excluded.display_name,
        icon=excluded.icon,
        color=excluded.color,
        last_used_at=excluded.last_used_at,
        updated_at=excluded.updated_at
    `).run(
      id,
      project.canonicalPath,
      project.displayName,
      project.icon ?? existing?.icon ?? DEFAULT_PROJECT_ICON,
      project.color ?? existing?.color ?? DEFAULT_PROJECT_COLOR,
      project.lastUsedAt ?? project.updatedAt,
      createdAt,
      project.updatedAt
    );
    this.db.prepare(`INSERT INTO project_folders (project_id, canonical_path, position, created_at) VALUES (?, ?, 0, ?)`)
      .run(id, project.canonicalPath, createdAt);
    return this.getProject(id);
  }

  #mapProject(row) {
    return mapProject(row, row ? this.listProjectFolders(row.id) : []);
  }

  saveViewState(taskId, state) {
    this.db.prepare(`
      INSERT INTO task_view_state (task_id, unread_count, selected_agent_id, panel_state, last_seen_event)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET unread_count=excluded.unread_count,
        selected_agent_id=excluded.selected_agent_id, panel_state=excluded.panel_state,
        last_seen_event=excluded.last_seen_event
    `).run(taskId, state.unreadCount ?? 0, state.selectedAgentId ?? null, JSON.stringify(state.panelState ?? {}), state.lastSeenEvent ?? null);
  }

  getThreadPlan(threadId) {
    const row = this.db.prepare("SELECT plan FROM thread_runtime_state WHERE thread_id = ?").get(threadId);
    if (!row) return null;
    try {
      return JSON.parse(row.plan);
    } catch {
      return null;
    }
  }

  saveThreadPlan(threadId, plan) {
    this.db.prepare(`
      INSERT INTO thread_runtime_state (thread_id, plan, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at
    `).run(threadId, JSON.stringify(plan ?? []), new Date().toISOString());
  }

  getThreadName(threadId) {
    return this.db.prepare("SELECT name FROM thread_names WHERE thread_id = ?").get(threadId)?.name ?? null;
  }

  saveThreadName(threadId, name) {
    const value = String(name ?? "").trim();
    if (!value) return;
    this.db.prepare(`
      INSERT INTO thread_names (thread_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).run(threadId, value, new Date().toISOString());
  }

  deleteThreadName(threadId) {
    this.db.prepare("DELETE FROM thread_names WHERE thread_id = ?").run(threadId);
  }

  listThreadBoardState(projectId) {
    return this.db.prepare(`
      SELECT thread_id, project_id, column_id, updated_at
      FROM thread_board_state
      WHERE project_id = ?
      ORDER BY updated_at ASC, thread_id ASC
    `).all(projectId).map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      column: row.column_id,
      updatedAt: row.updated_at
    }));
  }

  saveThreadBoardState({ threadId, projectId, column }) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO thread_board_state (thread_id, project_id, column_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        project_id=excluded.project_id,
        column_id=excluded.column_id,
        updated_at=excluded.updated_at
    `).run(threadId, projectId, column, updatedAt);
    return { threadId, projectId, column, updatedAt };
  }

  deleteThreadBoardState(threadId) {
    this.db.prepare("DELETE FROM thread_board_state WHERE thread_id = ?").run(threadId);
  }

  listBoardTasks(projectId) {
    return this.db.prepare(`
      SELECT b.*,
        activity.id AS activity_id, activity.kind AS activity_kind,
        activity.summary AS activity_summary, activity.thread_id AS activity_thread_id,
        activity.turn_id AS activity_turn_id, activity.actor_kind AS activity_actor_kind,
        activity.actor_id AS activity_actor_id, activity.metadata AS activity_metadata,
        activity.created_at AS activity_created_at
      FROM board_tasks b
      LEFT JOIN board_task_activity activity ON activity.id = (
        SELECT candidate.id FROM board_task_activity candidate
        WHERE candidate.task_id = b.id ORDER BY candidate.created_at DESC LIMIT 1
      )
      WHERE b.project_id = ?
      ORDER BY CASE b.column_id
        WHEN 'backlog' THEN 0
        WHEN 'ready' THEN 1
        WHEN 'active' THEN 2
        WHEN 'done' THEN 3
        ELSE 4
      END, b.position ASC, b.created_at ASC
    `).all(projectId).map(mapBoardTask).map((task) => this.#enrichBoardTask(task));
  }

  getBoardTask(taskId) {
    const task = mapBoardTask(this.db.prepare(`
      SELECT b.*,
        activity.id AS activity_id, activity.kind AS activity_kind,
        activity.summary AS activity_summary, activity.thread_id AS activity_thread_id,
        activity.turn_id AS activity_turn_id, activity.actor_kind AS activity_actor_kind,
        activity.actor_id AS activity_actor_id, activity.metadata AS activity_metadata,
        activity.created_at AS activity_created_at
      FROM board_tasks b
      LEFT JOIN board_task_activity activity ON activity.id = (
        SELECT candidate.id FROM board_task_activity candidate
        WHERE candidate.task_id = b.id ORDER BY candidate.created_at DESC LIMIT 1
      )
      WHERE b.id = ?
    `).get(taskId));
    return this.#enrichBoardTask(task);
  }

  listBoardPhases(projectId) {
    const tasksById = new Map(this.listBoardTasks(projectId).map((task) => [task.id, task]));
    return this.db.prepare("SELECT * FROM board_phases WHERE project_id = ? ORDER BY created_at ASC").all(projectId).map((row) => {
      const taskIds = this.db.prepare("SELECT task_id FROM board_phase_tasks WHERE phase_id = ? ORDER BY position ASC").all(row.id).map((entry) => entry.task_id);
      const tasks = taskIds.map((taskId) => tasksById.get(taskId)).filter(Boolean);
      const starts = tasks.map((task) => Date.parse(task.schedule?.plannedStart)).filter(Number.isFinite);
      const ends = tasks.map((task) => Date.parse(task.schedule?.plannedEnd ?? task.schedule?.plannedStart)).filter(Number.isFinite);
      return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        taskIds,
        tasks: tasks.map((task) => ({ id: task.id, title: task.title, column: task.column })),
        plannedStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
        plannedEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
        completedCount: tasks.filter((task) => task.column === "done").length,
        createdByThreadId: row.created_by_thread_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  createBoardPhase({ id, projectId, title, taskIds, createdByThreadId = null, actorKind = "user", actorId = null }) {
    const normalizedTaskIds = [...new Set(taskIds ?? [])];
    if (normalizedTaskIds.length < 2) throw new Error("A phase needs at least two work items");
    const tasks = normalizedTaskIds.map((taskId) => this.getBoardTask(taskId));
    if (tasks.some((task) => !task || task.projectId !== projectId)) throw new Error("A phase cannot include work from another project");
    const occupied = this.db.prepare(`SELECT task_id FROM board_phase_tasks WHERE task_id IN (${normalizedTaskIds.map(() => "?").join(",")})`).all(...normalizedTaskIds);
    if (occupied.length) throw new Error("One or more work items already belong to a phase");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO board_phases (id, project_id, title, created_by_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, projectId, title, createdByThreadId, now, now);
      const membership = this.db.prepare("INSERT INTO board_phase_tasks (phase_id, task_id, position) VALUES (?, ?, ?)");
      normalizedTaskIds.forEach((taskId, index) => membership.run(id, taskId, (index + 1) * 1024));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const task of tasks) this.recordBoardTaskActivity({
      id: randomUUID(), taskId: task.id, projectId, threadId: actorKind === "agent" ? actorId : null,
      kind: "phase-assigned", summary: `Added to phase "${title}".`, dedupeKey: `phase:${id}:${task.id}`,
      actorKind, actorId
    });
    const phase = this.listBoardPhases(projectId).find((candidate) => candidate.id === id);
    this.#emitBoardEvent({ action: "phase-created", projectId, phase, sourceActor: { kind: actorKind, id: actorId } });
    return phase;
  }

  createBoardTask({
    id, projectId, title, description = "", column = "backlog", threadId = null,
    createdByThreadId = null, kind = "task", priority = "normal", estimateMinutes = null,
    owner = "", schedule = null, dependencies = [], actorKind = "user", actorId = null
  }) {
    const now = new Date().toISOString();
    const position = (this.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1024 AS position
      FROM board_tasks WHERE project_id = ? AND column_id = ?
    `).get(projectId, column)?.position) ?? 1024;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO board_tasks (
          id, project_id, title, description, column_id, position,
          thread_id, created_by_thread_id, kind, priority, estimate_minutes, owner,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, projectId, title, description, column, position, threadId, createdByThreadId, kind, priority, estimateMinutes, owner, now, now);
      if (schedule) this.#writeBoardTaskSchedule(id, schedule, { actorKind, actorId, now });
      if (dependencies.length) this.#replaceBoardTaskDependencies(id, projectId, dependencies, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordBoardTaskActivity({ id: randomUUID(), taskId: id, projectId, threadId: actorKind === "agent" ? actorId : null, kind: "created", summary: schedule ? "Created and scheduled this work item." : "Created this work item.", dedupeKey: `created:${id}`, actorKind, actorId });
    const task = this.getBoardTask(id);
    this.#emitBoardEvent({ action: "created", projectId, task, sourceActor: { kind: actorKind, id: actorId } });
    return task;
  }

  updateBoardTask(taskId, patch) {
    const current = this.getBoardTask(taskId);
    if (!current) return null;
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw Object.assign(new Error("This work item changed after it was opened. Reload or merge the newer revision."), { code: "STALE_BOARD_TASK", current });
    }
    const title = patch.title ?? current.title;
    const description = patch.description ?? current.description;
    const threadId = Object.hasOwn(patch, "threadId") ? patch.threadId : current.threadId;
    const kind = patch.kind ?? current.kind;
    const priority = patch.priority ?? current.priority;
    const estimateMinutes = Object.hasOwn(patch, "estimateMinutes") ? patch.estimateMinutes : current.estimateMinutes;
    const owner = patch.owner ?? current.owner;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
      UPDATE board_tasks
      SET title = ?, description = ?, thread_id = ?, kind = ?, priority = ?,
          estimate_minutes = ?, owner = ?, revision = revision + 1, updated_at = ?
      WHERE id = ?
      `).run(title, description, threadId, kind, priority, estimateMinutes, owner, now, taskId);
      if (Object.hasOwn(patch, "schedule")) {
        if (patch.schedule === null) this.db.prepare("DELETE FROM board_task_schedules WHERE task_id = ?").run(taskId);
        else this.#writeBoardTaskSchedule(taskId, patch.schedule, { actorKind: patch.actorKind, actorId: patch.actorId, now, expectedRevision: patch.expectedScheduleRevision });
      }
      if (Object.hasOwn(patch, "dependencies")) this.#replaceBoardTaskDependencies(taskId, current.projectId, patch.dependencies ?? [], now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordBoardTaskActivity({ id: randomUUID(), taskId, projectId: current.projectId, threadId: patch.actorKind === "agent" ? patch.actorId : null, kind: Object.hasOwn(patch, "schedule") ? "schedule-changed" : "updated", summary: Object.hasOwn(patch, "schedule") ? "Updated the schedule." : "Updated the work item.", dedupeKey: `updated:${taskId}:${now}`, actorKind: patch.actorKind ?? "user", actorId: patch.actorId ?? null });
    const updated = this.getBoardTask(taskId);
    this.#emitBoardEvent({ action: "updated", projectId: updated.projectId, task: updated, previous: current, sourceActor: { kind: patch.actorKind ?? "user", id: patch.actorId ?? null } });
    return updated;
  }

  moveBoardTask(taskId, column, beforeTaskId = null) {
    const task = this.getBoardTask(taskId);
    if (!task) return null;
    const destination = this.listBoardTasks(task.projectId)
      .filter((candidate) => candidate.column === column && candidate.id !== taskId);
    let index = beforeTaskId ? destination.findIndex((candidate) => candidate.id === beforeTaskId) : destination.length;
    if (index < 0) index = destination.length;
    destination.splice(index, 0, { ...task, column });
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      UPDATE board_tasks
      SET column_id = ?, position = ?,
          revision = CASE WHEN id = ? THEN revision + 1 ELSE revision END,
          updated_at = CASE WHEN id = ? THEN ? ELSE updated_at END
      WHERE id = ?
    `);
    this.db.exec("BEGIN");
    try {
      destination.forEach((candidate, candidateIndex) => {
        statement.run(column, (candidateIndex + 1) * 1024, taskId, taskId, now, candidate.id);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.recordBoardTaskActivity({ id: randomUUID(), taskId, projectId: task.projectId, kind: "moved", summary: `Moved from ${task.column} to ${column}.`, dedupeKey: `moved:${taskId}:${now}`, actorKind: "user" });
    const moved = this.getBoardTask(taskId);
    this.#emitBoardEvent({ action: "moved", projectId: moved.projectId, task: moved, previous: task, sourceActor: { kind: "user", id: null } });
    return moved;
  }

  deleteBoardTask(taskId) {
    const task = this.getBoardTask(taskId);
    if (!task) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM board_task_trigger_receipts WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM board_task_activity WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM board_tasks WHERE id = ?").run(taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.#emitBoardEvent({ action: "deleted", projectId: task.projectId, task, sourceActor: { kind: "user", id: null } });
    return task;
  }

  detachBoardTasksForThread(threadId) {
    this.db.prepare(`
      UPDATE board_tasks SET thread_id = NULL, updated_at = ? WHERE thread_id = ?
    `).run(new Date().toISOString(), threadId);
  }

  recordBoardTaskActivity({ id, taskId, projectId, threadId = null, turnId = null, kind, summary, dedupeKey, metadata = {}, actorKind = null, actorId = null }) {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO board_task_activity (
        id, task_id, project_id, thread_id, turn_id, kind,
        summary, dedupe_key, metadata, actor_kind, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, projectId, threadId, turnId, kind, summary, dedupeKey, JSON.stringify(metadata), actorKind, actorId, createdAt);
    return this.getBoardTask(taskId)?.latestActivity ?? null;
  }

  subscribeBoardEvents(listener) {
    this.boardListeners.add(listener);
    return () => this.boardListeners.delete(listener);
  }

  listBoardTaskActivity(taskId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM board_task_activity WHERE task_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(taskId, Math.max(1, Math.min(200, limit))).map((row) => ({
      id: row.id, taskId: row.task_id, projectId: row.project_id, threadId: row.thread_id,
      turnId: row.turn_id, kind: row.kind, summary: row.summary,
      metadata: parsedJson(row.metadata, {}), actorKind: row.actor_kind, actorId: row.actor_id,
      createdAt: row.created_at
    }));
  }

  upsertBoardTaskWorkflowBinding({ id, taskId, workflowId, triggerNodeId = null, triggerType, enabled = false, missedTriggerPolicy = "ask", createdByThreadId = null }) {
    const task = this.getBoardTask(taskId);
    if (!task) throw new Error("Board task not found");
    const existing = this.db.prepare("SELECT task_id FROM board_task_workflow_bindings WHERE id = ?").get(id);
    if (existing && existing.task_id !== taskId) throw new Error("Workflow binding belongs to another work item");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO board_task_workflow_bindings (
        id, task_id, workflow_id, trigger_node_id, trigger_type, enabled, missed_trigger_policy,
        expected_task_revision, expected_schedule_revision, created_by_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET workflow_id=excluded.workflow_id, trigger_node_id=excluded.trigger_node_id,
        trigger_type=excluded.trigger_type, enabled=excluded.enabled, missed_trigger_policy=excluded.missed_trigger_policy,
        expected_task_revision=excluded.expected_task_revision, expected_schedule_revision=excluded.expected_schedule_revision,
        updated_at=excluded.updated_at
    `).run(id, taskId, workflowId, triggerNodeId, triggerType, enabled ? 1 : 0, missedTriggerPolicy, task.revision, task.schedule?.revision ?? null, createdByThreadId, now, now);
    const binding = this.listBoardTaskWorkflowBindings(taskId).find((candidate) => candidate.id === id);
    this.recordBoardTaskActivity({ id: randomUUID(), taskId, projectId: task.projectId, threadId: createdByThreadId, kind: "workflow-binding", summary: `${enabled ? "Enabled" : "Added"} a ${triggerType} Workflow binding.`, dedupeKey: `binding:${id}:${now}`, actorKind: createdByThreadId ? "agent" : "user", actorId: createdByThreadId });
    this.#emitBoardEvent({ action: "binding-updated", projectId: task.projectId, task: this.getBoardTask(taskId), binding, sourceActor: { kind: createdByThreadId ? "agent" : "user", id: createdByThreadId } });
    return binding;
  }

  deleteBoardTaskWorkflowBinding(taskId, bindingId) {
    const task = this.getBoardTask(taskId);
    const binding = this.listBoardTaskWorkflowBindings(taskId).find((candidate) => candidate.id === bindingId) ?? null;
    if (!task || !binding) return null;
    this.db.prepare("DELETE FROM board_task_workflow_bindings WHERE id = ? AND task_id = ?").run(bindingId, taskId);
    this.recordBoardTaskActivity({ id: randomUUID(), taskId, projectId: task.projectId, kind: "workflow-binding", summary: "Removed a Workflow binding.", dedupeKey: `binding-deleted:${bindingId}:${new Date().toISOString()}`, actorKind: "user" });
    this.#emitBoardEvent({ action: "binding-deleted", projectId: task.projectId, task: this.getBoardTask(taskId), binding, sourceActor: { kind: "user", id: null } });
    return binding;
  }

  listBoardTaskWorkflowBindings(taskId = null, projectId = null) {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM board_task_workflow_bindings WHERE task_id = ? ORDER BY created_at ASC").all(taskId)
      : this.db.prepare(`SELECT bindings.* FROM board_task_workflow_bindings bindings JOIN board_tasks tasks ON tasks.id = bindings.task_id WHERE tasks.project_id = ? ORDER BY bindings.created_at ASC`).all(projectId);
    return rows.map((row) => ({
      id: row.id, taskId: row.task_id, workflowId: row.workflow_id, triggerNodeId: row.trigger_node_id,
      triggerType: row.trigger_type, enabled: Boolean(row.enabled), missedTriggerPolicy: row.missed_trigger_policy,
      expectedTaskRevision: row.expected_task_revision, expectedScheduleRevision: row.expected_schedule_revision,
      createdByThreadId: row.created_by_thread_id, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  claimBoardTaskTrigger({ idempotencyKey, bindingId, taskId, workflowId, eventType, effectiveAt }) {
    return this.db.prepare(`INSERT OR IGNORE INTO board_task_trigger_receipts (
      idempotency_key, binding_id, task_id, workflow_id, event_type, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idempotencyKey, bindingId, taskId, workflowId, eventType, effectiveAt, new Date().toISOString()).changes > 0;
  }

  completeBoardTaskTrigger(idempotencyKey, runId) {
    this.db.prepare("UPDATE board_task_trigger_receipts SET run_id = ? WHERE idempotency_key = ?").run(runId, idempotencyKey);
  }

  createBoardPlanProposal({ id, projectId, threadId = null, title, proposal, baseRevisions = {} }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO board_plan_proposals (
      id, project_id, thread_id, title, status, proposal, base_revisions, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`).run(id, projectId, threadId, title, JSON.stringify(proposal), JSON.stringify(baseRevisions), now, now);
    return this.getBoardPlanProposal(id);
  }

  getBoardPlanProposal(id) {
    const row = this.db.prepare("SELECT * FROM board_plan_proposals WHERE id = ?").get(id);
    return row ? { id: row.id, projectId: row.project_id, threadId: row.thread_id, title: row.title, status: row.status, proposal: parsedJson(row.proposal, {}), baseRevisions: parsedJson(row.base_revisions, {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  setBoardPlanProposalStatus(id, status) {
    this.db.prepare("UPDATE board_plan_proposals SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
    return this.getBoardPlanProposal(id);
  }

  applyBoardPlanProposal(id, { actorKind = "user", actorId = null } = {}) {
    const proposal = this.getBoardPlanProposal(id);
    if (!proposal || proposal.status !== "proposed") throw new Error("Plan proposal is no longer available");
    for (const [taskId, revision] of Object.entries(proposal.baseRevisions)) {
      const task = this.getBoardTask(taskId);
      if (!task || task.revision !== revision) throw new Error(`Task ${taskId} changed after this plan was proposed`);
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of proposal.proposal.items ?? []) {
        const existing = this.getBoardTask(item.id);
        if (!existing) {
          const position = this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1024 AS position FROM board_tasks WHERE project_id = ? AND column_id = ?").get(proposal.projectId, item.column ?? "backlog")?.position ?? 1024;
          this.db.prepare(`INSERT INTO board_tasks (
            id, project_id, title, description, column_id, position, thread_id, created_by_thread_id,
            kind, priority, estimate_minutes, owner, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
            item.id, proposal.projectId, item.title, item.description ?? "", item.column ?? "backlog", position,
            proposal.threadId, item.kind ?? "task", item.priority ?? "normal", item.estimateMinutes ?? null,
            item.owner ?? "", now, now
          );
        } else {
          this.db.prepare(`UPDATE board_tasks SET title = ?, description = ?, column_id = ?, kind = ?, priority = ?,
            estimate_minutes = ?, owner = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
            item.title, item.description ?? existing.description, item.column ?? existing.column, item.kind ?? existing.kind,
            item.priority ?? existing.priority, item.estimateMinutes ?? existing.estimateMinutes, item.owner ?? existing.owner, now, item.id
          );
        }
        if (item.schedule) this.#writeBoardTaskSchedule(item.id, item.schedule, { actorKind, actorId, now });
      }
      for (const item of proposal.proposal.items ?? []) this.#replaceBoardTaskDependencies(item.id, proposal.projectId, item.dependencies ?? [], now);
      this.db.prepare("UPDATE board_plan_proposals SET status = 'applied', updated_at = ? WHERE id = ?").run(now, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const tasks = (proposal.proposal.items ?? []).map((item) => this.getBoardTask(item.id));
    tasks.forEach((task) => this.recordBoardTaskActivity({ id: randomUUID(), taskId: task.id, projectId: proposal.projectId, threadId: actorKind === "agent" ? actorId : null, kind: "plan-applied", summary: `Applied plan “${proposal.title}”.`, dedupeKey: `plan:${id}:${task.id}`, actorKind, actorId }));
    const refreshedTasks = tasks.map((task) => this.getBoardTask(task.id));
    refreshedTasks.forEach((task) => this.#emitBoardEvent({ action: "plan-applied", projectId: proposal.projectId, task, proposalId: id, sourceActor: { kind: actorKind, id: actorId } }));
    return { proposal: this.getBoardPlanProposal(id), tasks: refreshedTasks };
  }

  #enrichBoardTask(task) {
    if (!task) return null;
    const scheduleRow = this.db.prepare("SELECT * FROM board_task_schedules WHERE task_id = ?").get(task.id);
    const schedule = scheduleRow ? {
      taskId: scheduleRow.task_id, plannedStart: scheduleRow.planned_start, plannedEnd: scheduleRow.planned_end,
      hardDeadline: scheduleRow.hard_deadline, allDay: Boolean(scheduleRow.all_day), timezone: scheduleRow.timezone,
      constraintType: scheduleRow.constraint_type, lockedFields: parsedJson(scheduleRow.locked_fields, []),
      autoSchedule: Boolean(scheduleRow.auto_schedule), revision: scheduleRow.revision,
      updatedByKind: scheduleRow.updated_by_kind, updatedById: scheduleRow.updated_by_id,
      explanation: scheduleRow.explanation, createdAt: scheduleRow.created_at, updatedAt: scheduleRow.updated_at
    } : null;
    const dependencies = this.db.prepare("SELECT * FROM board_task_dependencies WHERE task_id = ? ORDER BY created_at ASC").all(task.id).map((row) => ({
      taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id, type: row.dependency_type,
      lagMinutes: row.lag_minutes, createdAt: row.created_at
    }));
    const dependents = this.db.prepare("SELECT task_id FROM board_task_dependencies WHERE depends_on_task_id = ? ORDER BY created_at ASC").all(task.id).map((row) => row.task_id);
    const phaseId = this.db.prepare("SELECT phase_id FROM board_phase_tasks WHERE task_id = ?").get(task.id)?.phase_id ?? null;
    return { ...task, phaseId, schedule, dependencies, dependents, workflowBindings: this.listBoardTaskWorkflowBindings(task.id) };
  }

  #writeBoardTaskSchedule(taskId, patch, { actorKind = "user", actorId = null, now = new Date().toISOString(), expectedRevision } = {}) {
    const current = this.db.prepare("SELECT * FROM board_task_schedules WHERE task_id = ?").get(taskId);
    if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw new Error("The schedule changed after it was opened");
    const value = {
      plannedStart: Object.hasOwn(patch, "plannedStart") ? patch.plannedStart : current?.planned_start ?? null,
      plannedEnd: Object.hasOwn(patch, "plannedEnd") ? patch.plannedEnd : current?.planned_end ?? null,
      hardDeadline: Object.hasOwn(patch, "hardDeadline") ? patch.hardDeadline : current?.hard_deadline ?? null,
      allDay: patch.allDay ?? Boolean(current?.all_day), timezone: patch.timezone ?? current?.timezone ?? "UTC",
      constraintType: patch.constraintType ?? current?.constraint_type ?? "flexible",
      lockedFields: patch.lockedFields ?? parsedJson(current?.locked_fields, []),
      autoSchedule: patch.autoSchedule ?? Boolean(current?.auto_schedule),
      explanation: patch.explanation ?? current?.explanation ?? ""
    };
    this.db.prepare(`INSERT INTO board_task_schedules (
      task_id, planned_start, planned_end, hard_deadline, all_day, timezone, constraint_type,
      locked_fields, auto_schedule, revision, updated_by_kind, updated_by_id, explanation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET planned_start=excluded.planned_start, planned_end=excluded.planned_end,
      hard_deadline=excluded.hard_deadline, all_day=excluded.all_day, timezone=excluded.timezone,
      constraint_type=excluded.constraint_type, locked_fields=excluded.locked_fields,
      auto_schedule=excluded.auto_schedule, revision=board_task_schedules.revision + 1,
      updated_by_kind=excluded.updated_by_kind, updated_by_id=excluded.updated_by_id,
      explanation=excluded.explanation, updated_at=excluded.updated_at`).run(
      taskId, value.plannedStart, value.plannedEnd, value.hardDeadline, value.allDay ? 1 : 0,
      value.timezone, value.constraintType, JSON.stringify(value.lockedFields), value.autoSchedule ? 1 : 0,
      actorKind, actorId, value.explanation, current?.created_at ?? now, now
    );
  }

  #replaceBoardTaskDependencies(taskId, projectId, dependencies, now) {
    const normalized = [...new Set((dependencies ?? []).map((entry) => typeof entry === "string" ? entry : entry.dependsOnTaskId).filter(Boolean))];
    if (normalized.includes(taskId)) throw new Error("A task cannot depend on itself");
    for (const dependencyId of normalized) {
      const dependency = this.getBoardTask(dependencyId);
      if (!dependency || dependency.projectId !== projectId) throw new Error("A dependency is outside this project");
    }
    const edges = this.db.prepare(`SELECT task_id, depends_on_task_id FROM board_task_dependencies
      WHERE task_id IN (SELECT id FROM board_tasks WHERE project_id = ?)`).all(projectId)
      .filter((edge) => edge.task_id !== taskId);
    normalized.forEach((dependencyId) => edges.push({ task_id: taskId, depends_on_task_id: dependencyId }));
    const outgoing = new Map();
    for (const edge of edges) {
      const values = outgoing.get(edge.task_id) ?? [];
      values.push(edge.depends_on_task_id);
      outgoing.set(edge.task_id, values);
    }
    const visit = (node, visiting = new Set(), visited = new Set()) => {
      if (visiting.has(node)) throw new Error("Task dependencies contain a cycle");
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of outgoing.get(node) ?? []) visit(next, visiting, visited);
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of outgoing.keys()) visit(node);
    this.db.prepare("DELETE FROM board_task_dependencies WHERE task_id = ?").run(taskId);
    const insert = this.db.prepare(`INSERT INTO board_task_dependencies (
      task_id, depends_on_task_id, dependency_type, lag_minutes, created_at
    ) VALUES (?, ?, ?, ?, ?)`);
    for (const entry of dependencies ?? []) {
      const dependencyId = typeof entry === "string" ? entry : entry.dependsOnTaskId;
      if (!dependencyId || !normalized.includes(dependencyId)) continue;
      insert.run(taskId, dependencyId, typeof entry === "string" ? "finish-to-start" : entry.type ?? "finish-to-start", typeof entry === "string" ? 0 : entry.lagMinutes ?? 0, now);
    }
  }

  #emitBoardEvent(payload) {
    for (const listener of this.boardListeners) {
      try { listener(payload); } catch {}
    }
  }

  recordWorkPatternOccurrence({ id, projectId, threadId, turnId, signature, steps, prompt = "" }) {
    const createdAt = new Date().toISOString();
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO work_pattern_occurrences (
        id, project_id, thread_id, turn_id, signature, steps, prompt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, threadId, turnId, signature, JSON.stringify(steps), prompt, createdAt).changes > 0;
    const count = this.db.prepare(`
      SELECT COUNT(*) AS count FROM work_pattern_occurrences
      WHERE project_id = ? AND signature = ?
    `).get(projectId, signature)?.count ?? 0;
    return { inserted, count, signature, createdAt };
  }

  listWorkPatternOccurrences(projectId, signature = null) {
    const rows = signature
      ? this.db.prepare(`SELECT * FROM work_pattern_occurrences WHERE project_id = ? AND signature = ? ORDER BY created_at ASC`).all(projectId, signature)
      : this.db.prepare(`SELECT * FROM work_pattern_occurrences WHERE project_id = ? ORDER BY created_at ASC`).all(projectId);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      signature: row.signature,
      steps: parsedJson(row.steps, []),
      prompt: row.prompt,
      createdAt: row.created_at
    }));
  }

  createProactiveSuggestion({ id, projectId, threadId = null, type, dedupeKey, title, message, payload = {} }) {
    const now = new Date().toISOString();
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO proactive_suggestions (
        id, project_id, thread_id, type, status, dedupe_key,
        title, message, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, threadId, type, dedupeKey, title, message, JSON.stringify(payload), now, now).changes > 0;
    const value = inserted
      ? this.getProactiveSuggestion(id)
      : mapProactiveSuggestion(this.db.prepare(`SELECT * FROM proactive_suggestions WHERE project_id = ? AND dedupe_key = ?`).get(projectId, dedupeKey));
    return { created: inserted, value };
  }

  getProactiveSuggestion(suggestionId) {
    return mapProactiveSuggestion(this.db.prepare("SELECT * FROM proactive_suggestions WHERE id = ?").get(suggestionId));
  }

  listProactiveSuggestions(projectId, threadId = null) {
    const rows = threadId
      ? this.db.prepare(`
          SELECT * FROM proactive_suggestions
          WHERE project_id = ? AND status = 'open' AND (thread_id = ? OR thread_id IS NULL)
          ORDER BY created_at ASC
        `).all(projectId, threadId)
      : this.db.prepare(`
          SELECT * FROM proactive_suggestions
          WHERE project_id = ? AND status = 'open'
          ORDER BY created_at ASC
        `).all(projectId);
    return rows.map(mapProactiveSuggestion);
  }

  resolveProactiveSuggestion(suggestionId, status, payloadPatch = {}) {
    const current = this.getProactiveSuggestion(suggestionId);
    if (!current) return null;
    const payload = { ...current.payload, ...payloadPatch };
    this.db.prepare(`
      UPDATE proactive_suggestions SET status = ?, payload = ?, updated_at = ? WHERE id = ?
    `).run(status, JSON.stringify(payload), new Date().toISOString(), suggestionId);
    return this.getProactiveSuggestion(suggestionId);
  }

  deleteThreadRuntimeState(threadId) {
    this.db.prepare("DELETE FROM thread_runtime_state WHERE thread_id = ?").run(threadId);
  }

  deleteThreadTurnTimings(threadId) {
    this.db.prepare("DELETE FROM thread_turn_timings WHERE thread_id = ?").run(threadId);
  }

  saveThreadTurnTiming({ threadId, turnId, startedAt, completedAt = null }) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO thread_turn_timings (thread_id, turn_id, started_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        started_at=COALESCE(thread_turn_timings.started_at, excluded.started_at),
        completed_at=COALESCE(excluded.completed_at, thread_turn_timings.completed_at),
        updated_at=excluded.updated_at
    `).run(threadId, turnId, startedAt, completedAt, updatedAt);
    return { threadId, turnId, startedAt, completedAt, updatedAt };
  }

  listThreadTurnTimings(threadId) {
    return this.db.prepare(`
      SELECT thread_id, turn_id, started_at, completed_at, updated_at
      FROM thread_turn_timings WHERE thread_id = ? ORDER BY started_at ASC
    `).all(threadId).map((row) => ({
      threadId: row.thread_id,
      turnId: row.turn_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at
    }));
  }

  getThreadTurnTiming(threadId, turnId) {
    return this.listThreadTurnTimings(threadId).find((timing) => timing.turnId === turnId) ?? null;
  }

  saveThreadProviderBinding(binding) {
    const now = new Date().toISOString();
    const existing = this.getThreadProviderBinding(binding.threadId);
    this.db.prepare(`
      INSERT INTO thread_provider_bindings (
        thread_id, provider, provider_thread_id, resume_cursor, cwd, forked_from_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        provider=excluded.provider,
        provider_thread_id=COALESCE(excluded.provider_thread_id, thread_provider_bindings.provider_thread_id),
        resume_cursor=COALESCE(excluded.resume_cursor, thread_provider_bindings.resume_cursor),
        cwd=CASE WHEN excluded.cwd = '' THEN thread_provider_bindings.cwd ELSE excluded.cwd END,
        forked_from_id=COALESCE(excluded.forked_from_id, thread_provider_bindings.forked_from_id),
        updated_at=excluded.updated_at
    `).run(
      binding.threadId,
      binding.provider,
      binding.providerThreadId ?? null,
      binding.resumeCursor ?? null,
      binding.cwd ?? "",
      binding.forkedFromId ?? null,
      existing?.createdAt ?? now,
      now
    );
    return this.getThreadProviderBinding(binding.threadId);
  }

  getThreadProviderBinding(threadId) {
    const row = this.db.prepare("SELECT * FROM thread_provider_bindings WHERE thread_id = ?").get(threadId);
    if (!row) return null;
    return {
      threadId: row.thread_id,
      provider: row.provider,
      providerThreadId: row.provider_thread_id,
      resumeCursor: row.resume_cursor,
      cwd: row.cwd,
      forkedFromId: row.forked_from_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listThreadProviderBindings({ provider, cwd } = {}) {
    const clauses = [];
    const values = [];
    if (provider) {
      clauses.push("provider = ?");
      values.push(provider);
    }
    if (cwd) {
      clauses.push("cwd = ?");
      values.push(cwd);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT thread_id FROM thread_provider_bindings ${where} ORDER BY updated_at DESC`)
      .all(...values)
      .map((row) => this.getThreadProviderBinding(row.thread_id));
  }

  deleteThreadProviderBinding(threadId) {
    this.db.prepare("DELETE FROM provider_thread_active_turns WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM provider_thread_snapshots WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM thread_provider_bindings WHERE thread_id = ?").run(threadId);
  }

  saveThreadLink({ childThreadId, parentThreadId, kind = "pixiceBridge", model = null, effort = null }) {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO thread_links (child_thread_id, parent_thread_id, kind, model, effort, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(child_thread_id) DO UPDATE SET
        parent_thread_id=excluded.parent_thread_id,
        kind=excluded.kind,
        model=excluded.model,
        effort=excluded.effort
    `).run(childThreadId, parentThreadId, kind, model, effort, createdAt);
    return this.getThreadLink(childThreadId);
  }

  getThreadLink(childThreadId) {
    const row = this.db.prepare("SELECT * FROM thread_links WHERE child_thread_id = ?").get(childThreadId);
    if (!row) return null;
    return {
      childThreadId: row.child_thread_id,
      parentThreadId: row.parent_thread_id,
      kind: row.kind,
      model: row.model,
      effort: row.effort,
      createdAt: row.created_at
    };
  }

  listThreadLinks(parentThreadId) {
    return this.db.prepare("SELECT child_thread_id FROM thread_links WHERE parent_thread_id = ? ORDER BY created_at ASC")
      .all(parentThreadId)
      .map((row) => this.getThreadLink(row.child_thread_id));
  }

  deleteThreadLink(threadId) {
    this.db.prepare("DELETE FROM thread_links WHERE child_thread_id = ? OR parent_thread_id = ?").run(threadId, threadId);
  }

  #nextProviderWriteTimestamp(threadId) {
    const row = this.db.prepare(`
      SELECT MAX(updated_at) AS updated_at FROM (
        SELECT updated_at FROM provider_thread_snapshots WHERE thread_id = ?
        UNION ALL
        SELECT updated_at FROM provider_thread_active_turns WHERE thread_id = ?
      )
    `).get(threadId, threadId);
    const previous = Date.parse(row?.updated_at ?? "");
    const timestamp = Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0);
    return new Date(timestamp).toISOString();
  }

  saveProviderThreadSnapshot(threadId, snapshot) {
    const updatedAt = this.#nextProviderWriteTimestamp(threadId);
    this.db.prepare(`
      INSERT INTO provider_thread_snapshots (thread_id, snapshot, summary, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        snapshot=excluded.snapshot, summary=excluded.summary, updated_at=excluded.updated_at
    `).run(threadId, JSON.stringify(snapshot), JSON.stringify(providerThreadSummary(snapshot)), updatedAt);
    this.db.prepare("DELETE FROM provider_thread_active_turns WHERE thread_id = ? AND updated_at <= ?").run(threadId, updatedAt);
  }

  saveProviderActiveTurn(threadId, turn) {
    if (!turn?.id) return;
    this.db.prepare(`
      INSERT INTO provider_thread_active_turns (thread_id, turn_id, turn, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        turn_id=excluded.turn_id, turn=excluded.turn, updated_at=excluded.updated_at
    `).run(threadId, turn.id, JSON.stringify(turn), this.#nextProviderWriteTimestamp(threadId));
  }

  deleteProviderActiveTurn(threadId) {
    this.db.prepare("DELETE FROM provider_thread_active_turns WHERE thread_id = ?").run(threadId);
  }

  listProviderThreadSummaries({ provider, cwd } = {}) {
    const clauses = [];
    const values = [];
    if (provider) {
      clauses.push("bindings.provider = ?");
      values.push(provider);
    }
    if (cwd) {
      clauses.push("bindings.cwd = ?");
      values.push(cwd);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT bindings.*, snapshots.summary
      FROM thread_provider_bindings AS bindings
      JOIN provider_thread_snapshots AS snapshots ON snapshots.thread_id = bindings.thread_id
      ${where}
      ORDER BY bindings.updated_at DESC
    `).all(...values).map((row) => {
      const summary = providerThreadSummary(parsedJson(row.summary, {}));
      return {
        ...summary,
        id: row.thread_id,
        providerThreadId: row.provider_thread_id,
        cwd: row.cwd,
        provider: row.provider,
        forkedFromId: summary.forkedFromId ?? row.forked_from_id ?? null,
        createdAt: summary.createdAt ?? row.created_at,
        updatedAt: summary.updatedAt ?? row.updated_at
      };
    });
  }

  listConnectOverview({ limit = 200, threadIds = [] } = {}) {
    const boundedLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 200)));
    const pinned = [...new Set((Array.isArray(threadIds) ? threadIds : [])
      .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256))].slice(0, 200);
    const mapThread = (row) => {
      const summary = providerThreadSummary(parsedJson(row.summary, {}));
      return {
        ...summary,
        id: row.thread_id,
        providerThreadId: row.provider_thread_id,
        cwd: row.cwd,
        provider: row.provider,
        forkedFromId: summary.forkedFromId ?? row.forked_from_id ?? null,
        createdAt: summary.createdAt ?? row.created_at,
        updatedAt: summary.updatedAt ?? row.updated_at
      };
    };
    const recentThreads = this.db.prepare(`
      SELECT bindings.*, snapshots.summary
      FROM thread_provider_bindings AS bindings
      JOIN provider_thread_snapshots AS snapshots ON snapshots.thread_id = bindings.thread_id
      ORDER BY bindings.updated_at DESC LIMIT ?
    `).all(boundedLimit).map(mapThread);
    const pinnedThreads = pinned.length ? this.db.prepare(`
      SELECT bindings.*, snapshots.summary
      FROM thread_provider_bindings AS bindings
      JOIN provider_thread_snapshots AS snapshots ON snapshots.thread_id = bindings.thread_id
      WHERE bindings.thread_id IN (${pinned.map(() => "?").join(",")})
    `).all(...pinned).map(mapThread) : [];
    const recentResults = this.db.prepare("SELECT thread_id, data, updated_at FROM task_results ORDER BY updated_at DESC LIMIT ?").all(boundedLimit);
    const pinnedResults = pinned.length ? this.db.prepare(`
      SELECT thread_id, data, updated_at FROM task_results
      WHERE thread_id IN (${pinned.map(() => "?").join(",")})
    `).all(...pinned) : [];
    const taskResults = [...new Map([...recentResults, ...pinnedResults].map((row) => [row.thread_id, row])).values()]
      .map((row) => ({ threadId: row.thread_id, updatedAt: row.updated_at, data: parsedJson(row.data, null) }))
      .filter((row) => row.data && typeof row.data === "object");
    return { providerThreads: [...new Map([...recentThreads, ...pinnedThreads].map((thread) => [thread.id, thread])).values()], taskResults };
  }

  getProviderThreadSummary(threadId) {
    const row = this.db.prepare(`
      SELECT snapshots.summary, bindings.forked_from_id
      FROM provider_thread_snapshots AS snapshots
      JOIN thread_provider_bindings AS bindings ON bindings.thread_id = snapshots.thread_id
      WHERE snapshots.thread_id = ?
    `).get(threadId);
    if (!row) return null;
    const summary = providerThreadSummary(parsedJson(row.summary, {}));
    return { ...summary, id: threadId, forkedFromId: summary.forkedFromId ?? row.forked_from_id ?? null };
  }

  getProviderThreadSnapshot(threadId) {
    const row = this.db.prepare(`
      SELECT snapshots.snapshot, snapshots.updated_at AS snapshot_updated_at, bindings.forked_from_id,
        active.turn, active.updated_at AS active_updated_at
      FROM provider_thread_snapshots AS snapshots
      JOIN thread_provider_bindings AS bindings ON bindings.thread_id = snapshots.thread_id
      LEFT JOIN provider_thread_active_turns AS active ON active.thread_id = snapshots.thread_id
      WHERE snapshots.thread_id = ?
    `).get(threadId);
    if (!row) return null;
    try {
      const snapshot = JSON.parse(row.snapshot);
      const persistedSnapshot = {
        ...snapshot,
        forkedFromId: snapshot.forkedFromId ?? row.forked_from_id ?? null
      };
      if (!row.turn) return persistedSnapshot;
      const activeTurn = JSON.parse(row.turn);
      const activeIsOlder = row.active_updated_at < row.snapshot_updated_at;
      const activeTiesSettledSnapshot = row.active_updated_at === row.snapshot_updated_at && !providerThreadIsActive(persistedSnapshot);
      if (activeIsOlder || activeTiesSettledSnapshot) return persistedSnapshot;
      const turns = [...(persistedSnapshot.turns ?? [])];
      const index = turns.findIndex((turn) => turn.id === activeTurn.id);
      if (index === -1) turns.push(activeTurn);
      else turns[index] = activeTurn;
      return { ...persistedSnapshot, status: { type: "active", activeFlags: [] }, updatedAt: row.active_updated_at, turns };
    } catch {
      return null;
    }
  }

  recordUsageEvent(event) {
    const numeric = (value) => Math.max(0, Math.round(Number(value) || 0));
    const costUsd = Number.isFinite(event.costUsd) ? Math.max(0, event.costUsd) : null;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        id, thread_id, turn_id, provider, model, service_tier, recorded_at,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, cost_usd, cost_source,
        pricing_model, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.threadId ?? null,
      event.turnId ?? null,
      event.provider,
      event.model ?? null,
      event.serviceTier ?? null,
      event.recordedAt ?? new Date().toISOString(),
      numeric(event.inputTokens),
      numeric(event.cachedInputTokens),
      numeric(event.cacheWriteInputTokens),
      numeric(event.outputTokens),
      numeric(event.reasoningOutputTokens),
      costUsd,
      event.costSource ?? (costUsd === null ? "unpriced" : "calculated"),
      event.pricingModel ?? null,
      JSON.stringify(event.metadata ?? {})
    );
    return result.changes > 0;
  }

  getUsageSummary({ days = 30 } = {}) {
    const rangeDays = Math.max(7, Math.min(365, Math.round(Number(days) || 30)));
    const rows = this.db.prepare("SELECT * FROM usage_events ORDER BY recorded_at ASC").all();
    const today = startOfLocalDay();
    const selectedStart = new Date(today);
    selectedStart.setDate(selectedStart.getDate() - rangeDays + 1);
    const selectedRows = rows.filter((row) => new Date(row.recorded_at) >= selectedStart);
    const todayKey = localDayKey(today);
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const currentWeekRows = rows.filter((row) => new Date(row.recorded_at) >= weekStart);
    const currentMonthRows = rows.filter((row) => new Date(row.recorded_at) >= monthStart);
    const todayRows = rows.filter((row) => localDayKey(row.recorded_at) === todayKey);
    const all = usageTotals(rows);
    const selected = usageTotals(selectedRows);
    const currentWeek = usageTotals(currentWeekRows);
    const currentMonth = usageTotals(currentMonthRows);
    const todayTotals = usageTotals(todayRows);
    const firstDate = rows.length ? startOfLocalDay(rows[0].recorded_at) : today;
    const elapsedDays = Math.max(1, Math.round((today - firstDate) / 86_400_000) + 1);
    const dailyAverage = all.costUsd / elapsedDays;
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

    const byDay = new Map();
    for (const row of rows) {
      const key = localDayKey(row.recorded_at);
      const aggregate = byDay.get(key) ?? [];
      aggregate.push(row);
      byDay.set(key, aggregate);
    }
    const dailySeries = (start, count) => Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const dateKey = localDayKey(date);
      return { date: dateKey, ...usageTotals(byDay.get(dateKey) ?? []) };
    });
    const daily = dailySeries(selectedStart, rangeDays);
    const heatmapStart = new Date(today);
    heatmapStart.setDate(heatmapStart.getDate() - 364);
    const heatmapDaily = dailySeries(heatmapStart, 365);

    const groupRows = (keyOf) => {
      const groups = new Map();
      for (const row of selectedRows) {
        const key = keyOf(row);
        const group = groups.get(key) ?? { rows: [], provider: row.provider, model: row.model };
        group.rows.push(row);
        groups.set(key, group);
      }
      return [...groups.values()].map((group) => ({
        provider: group.provider,
        model: group.model,
        ...usageTotals(group.rows)
      })).sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens);
    };

    const historyGroups = new Map();
    for (const row of rows) {
      if (new Date(row.recorded_at) < heatmapStart) continue;
      const date = localDayKey(row.recorded_at);
      const key = JSON.stringify([date, row.provider, row.model]);
      const group = historyGroups.get(key) ?? { date, provider: row.provider, model: row.model, rows: [] };
      group.rows.push(row);
      historyGroups.set(key, group);
    }

    return {
      rangeDays,
      trackingDays: elapsedDays,
      calendarDate: todayKey,
      calendarTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      recordingStartDate: rows.length ? localDayKey(firstDate) : null,
      historyDailyModels: [...historyGroups.values()].map(({ rows: historyRows, ...identity }) => ({ ...identity, ...usageTotals(historyRows) })),
      recordingStartedAt: rows[0]?.recorded_at ?? null,
      updatedAt: rows.at(-1)?.recorded_at ?? null,
      stats: {
        todayCostUsd: todayTotals.costUsd,
        currentWeekCostUsd: currentWeek.costUsd,
        currentMonthCostUsd: currentMonth.costUsd,
        projectedMonthCostUsd: today.getDate() ? (currentMonth.costUsd / today.getDate()) * daysInMonth : 0,
        dailyAverageCostUsd: dailyAverage,
        weeklyAverageCostUsd: dailyAverage * 7,
        monthlyAverageCostUsd: dailyAverage * (365.25 / 12),
        allTimeCostUsd: all.costUsd,
        allTimeTokens: all.totalTokens
      },
      selected,
      daily,
      heatmapDaily,
      models: groupRows((row) => `${row.provider}:${row.model ?? "unknown"}`),
      providers: groupRows((row) => row.provider)
    };
  }
}
