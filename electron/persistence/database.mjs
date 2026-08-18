import { DatabaseSync } from "node:sqlite";
import path from "node:path";

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalPath: row.canonical_path,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class LoomDatabase {
  constructor(userDataPath) {
    this.db = new DatabaseSync(path.join(userDataPath, "loom.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS thread_names (
        thread_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_provider_bindings (
        thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_thread_id TEXT,
        resume_cursor TEXT, cwd TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_thread_snapshots (
        thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES thread_provider_bindings(thread_id)
      );
    `);
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all().map(mapProject);
  }

  getProject(id) {
    return mapProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
  }

  upsertProject(project) {
    const existing = this.db.prepare("SELECT * FROM projects WHERE canonical_path = ?").get(project.canonicalPath);
    const id = existing?.id ?? project.id;
    const createdAt = existing?.created_at ?? project.createdAt;
    this.db.prepare(`
      INSERT INTO projects (id, canonical_path, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(canonical_path) DO UPDATE SET
        display_name=excluded.display_name,
        updated_at=excluded.updated_at
    `).run(id, project.canonicalPath, project.displayName, createdAt, project.updatedAt);
    return this.getProject(id);
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

  deleteThreadRuntimeState(threadId) {
    this.db.prepare("DELETE FROM thread_runtime_state WHERE thread_id = ?").run(threadId);
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
}
