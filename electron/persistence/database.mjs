import { DatabaseSync } from "node:sqlite";
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
    column: row.column_id,
    position: row.position,
    threadId: row.thread_id,
    createdByThreadId: row.created_by_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PixiceDatabase {
  constructor(userDataPath) {
    this.db = new DatabaseSync(path.join(userDataPath, "pixice.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
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
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS board_tasks_project ON board_tasks(project_id, column_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS board_tasks_thread ON board_tasks(thread_id) WHERE thread_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS thread_provider_bindings (
        thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_thread_id TEXT,
        resume_cursor TEXT, cwd TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_thread_snapshots (
        thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL,
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
    `);

      const projectColumns = new Set(this.db.prepare("PRAGMA table_info(projects)").all().map((column) => column.name));
      if (!projectColumns.has("icon")) this.db.exec("ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'");
      if (!projectColumns.has("color")) this.db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'");
      if (!projectColumns.has("last_used_at")) this.db.exec("ALTER TABLE projects ADD COLUMN last_used_at TEXT");
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
      SELECT * FROM board_tasks
      WHERE project_id = ?
      ORDER BY CASE column_id
        WHEN 'backlog' THEN 0
        WHEN 'ready' THEN 1
        WHEN 'active' THEN 2
        WHEN 'done' THEN 3
        ELSE 4
      END, position ASC, created_at ASC
    `).all(projectId).map(mapBoardTask);
  }

  getBoardTask(taskId) {
    return mapBoardTask(this.db.prepare("SELECT * FROM board_tasks WHERE id = ?").get(taskId));
  }

  createBoardTask({ id, projectId, title, description = "", column = "backlog", threadId = null, createdByThreadId = null }) {
    const now = new Date().toISOString();
    const position = (this.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1024 AS position
      FROM board_tasks WHERE project_id = ? AND column_id = ?
    `).get(projectId, column)?.position) ?? 1024;
    this.db.prepare(`
      INSERT INTO board_tasks (
        id, project_id, title, description, column_id, position,
        thread_id, created_by_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, description, column, position, threadId, createdByThreadId, now, now);
    return this.getBoardTask(id);
  }

  updateBoardTask(taskId, patch) {
    const current = this.getBoardTask(taskId);
    if (!current) return null;
    const title = patch.title ?? current.title;
    const description = patch.description ?? current.description;
    const threadId = Object.hasOwn(patch, "threadId") ? patch.threadId : current.threadId;
    this.db.prepare(`
      UPDATE board_tasks
      SET title = ?, description = ?, thread_id = ?, updated_at = ?
      WHERE id = ?
    `).run(title, description, threadId, new Date().toISOString(), taskId);
    return this.getBoardTask(taskId);
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
      UPDATE board_tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?
    `);
    this.db.exec("BEGIN");
    try {
      destination.forEach((candidate, candidateIndex) => {
        statement.run(column, (candidateIndex + 1) * 1024, candidate.id === taskId ? now : candidate.updatedAt, candidate.id);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getBoardTask(taskId);
  }

  deleteBoardTask(taskId) {
    const task = this.getBoardTask(taskId);
    if (!task) return null;
    this.db.prepare("DELETE FROM board_tasks WHERE id = ?").run(taskId);
    return task;
  }

  detachBoardTasksForThread(threadId) {
    this.db.prepare(`
      UPDATE board_tasks SET thread_id = NULL, updated_at = ? WHERE thread_id = ?
    `).run(new Date().toISOString(), threadId);
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
        thread_id, provider, provider_thread_id, resume_cursor, cwd, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        provider=excluded.provider,
        provider_thread_id=COALESCE(excluded.provider_thread_id, thread_provider_bindings.provider_thread_id),
        resume_cursor=COALESCE(excluded.resume_cursor, thread_provider_bindings.resume_cursor),
        cwd=CASE WHEN excluded.cwd = '' THEN thread_provider_bindings.cwd ELSE excluded.cwd END,
        updated_at=excluded.updated_at
    `).run(
      binding.threadId,
      binding.provider,
      binding.providerThreadId ?? null,
      binding.resumeCursor ?? null,
      binding.cwd ?? "",
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

  saveProviderThreadSnapshot(threadId, snapshot) {
    this.db.prepare(`
      INSERT INTO provider_thread_snapshots (thread_id, snapshot, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=excluded.updated_at
    `).run(threadId, JSON.stringify(snapshot), new Date().toISOString());
  }

  getProviderThreadSnapshot(threadId) {
    const row = this.db.prepare("SELECT snapshot FROM provider_thread_snapshots WHERE thread_id = ?").get(threadId);
    if (!row) return null;
    try {
      return JSON.parse(row.snapshot);
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

    return {
      rangeDays,
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
