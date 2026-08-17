import { DatabaseSync } from "node:sqlite";
import path from "node:path";

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
    `);
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all();
  }

  upsertProject(project) {
    this.db.prepare(`
      INSERT INTO projects (id, canonical_path, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET canonical_path=excluded.canonical_path,
        display_name=excluded.display_name, updated_at=excluded.updated_at
    `).run(project.id, project.canonicalPath, project.displayName, project.createdAt, project.updatedAt);
    return project;
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
}
