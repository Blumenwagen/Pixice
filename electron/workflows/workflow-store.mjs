import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { normalizeWorkflowDocument, workflowDocumentSchema } from "./workflow-model.mjs";

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapWorkflow(row) {
  if (!row) return null;
  return workflowDocumentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    graph: parseJson(row.graph, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
    createdByThreadId: row.created_by_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    projectId: row.project_id,
    status: row.status,
    input: parseJson(row.input, {}),
    nodeRuns: parseJson(row.node_runs, {}),
    output: parseJson(row.output, null),
    error: row.error,
    sourceThreadId: row.source_thread_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

export class WorkflowStore {
  constructor(userDataPath) {
    this.db = new DatabaseSync(path.join(userDataPath, "loom-workflows.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        graph TEXT NOT NULL,
        created_by_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflows_project_updated
        ON workflows(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        node_runs TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        source_thread_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_workflow_created
        ON workflow_runs(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS workflow_runs_project_created
        ON workflow_runs(project_id, created_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  listWorkflows(projectId) {
    return this.db.prepare(`
      SELECT * FROM workflows
      WHERE project_id = ?
      ORDER BY updated_at DESC, name COLLATE NOCASE ASC
    `).all(projectId).map(mapWorkflow);
  }

  getWorkflow(workflowId) {
    return mapWorkflow(this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId));
  }

  createWorkflow(workflow) {
    const value = normalizeWorkflowDocument(workflow);
    this.db.prepare(`
      INSERT INTO workflows (
        id, project_id, name, description, graph,
        created_by_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.projectId,
      value.name,
      value.description,
      JSON.stringify(value.graph),
      value.createdByThreadId,
      value.createdAt,
      value.updatedAt
    );
    return this.getWorkflow(value.id);
  }

  saveWorkflow(workflow, { expectedUpdatedAt } = {}) {
    const current = this.getWorkflow(workflow.id);
    if (!current) throw new Error("Workflow not found");
    if (current.projectId !== workflow.projectId) throw new Error("Workflow belongs to another project");
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new Error("This workflow changed since it was opened. Reload it before saving.");
    }
    const value = normalizeWorkflowDocument({ ...workflow, updatedAt: new Date().toISOString() }, current);
    this.db.prepare(`
      UPDATE workflows
      SET name = ?, description = ?, graph = ?, updated_at = ?
      WHERE id = ?
    `).run(value.name, value.description, JSON.stringify(value.graph), value.updatedAt, value.id);
    return this.getWorkflow(value.id);
  }

  deleteWorkflow(workflowId) {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return null;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM workflow_runs WHERE workflow_id = ?").run(workflowId);
      this.db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
      this.db.exec("COMMIT");
      return workflow;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(run) {
    this.db.prepare(`
      INSERT INTO workflow_runs (
        id, workflow_id, project_id, status, input, node_runs, output,
        error, source_thread_id, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.workflowId,
      run.projectId,
      run.status,
      JSON.stringify(run.input ?? {}),
      JSON.stringify(run.nodeRuns ?? {}),
      run.output === undefined ? null : JSON.stringify(run.output),
      run.error ?? null,
      run.sourceThreadId ?? null,
      run.createdAt,
      run.startedAt ?? null,
      run.completedAt ?? null
    );
    return this.getRun(run.id);
  }

  getRun(runId) {
    return mapRun(this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId));
  }

  listRuns(workflowId, limit = 20) {
    return this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workflowId, limit).map(mapRun);
  }

  updateRun(runId, patch) {
    const current = this.getRun(runId);
    if (!current) throw new Error("Workflow run not found");
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE workflow_runs
      SET status = ?, node_runs = ?, output = ?, error = ?,
          started_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      next.status,
      JSON.stringify(next.nodeRuns ?? {}),
      next.output === undefined || next.output === null ? null : JSON.stringify(next.output),
      next.error ?? null,
      next.startedAt ?? null,
      next.completedAt ?? null,
      runId
    );
    return this.getRun(runId);
  }
}
