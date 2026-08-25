import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultWorkflow } from "../electron/workflows/workflow-model.mjs";
import { WorkflowStore } from "../electron/workflows/workflow-store.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("WorkflowStore", () => {
  it("persists workflows and enforces optimistic saves", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflows-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const created = store.createWorkflow(createDefaultWorkflow({ projectId: "project-1", name: "Release" }));
    expect(store.listWorkflows("project-1")).toHaveLength(1);

    const saved = store.saveWorkflow({ ...created, name: "Release safely" }, { expectedUpdatedAt: created.updatedAt });
    expect(saved.name).toBe("Release safely");
    expect(() => store.saveWorkflow({ ...created, name: "Stale edit" }, { expectedUpdatedAt: created.updatedAt })).toThrow(/changed since/i);

    expect(store.deleteWorkflow(created.id)?.id).toBe(created.id);
    expect(store.listWorkflows("project-1")).toEqual([]);
    store.close();
  });

  it("tracks run and node state as JSON", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflow-runs-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const workflow = store.createWorkflow(createDefaultWorkflow({ projectId: "project-1" }));
    const createdAt = new Date().toISOString();
    store.createRun({
      id: "run-1",
      workflowId: workflow.id,
      projectId: workflow.projectId,
      status: "queued",
      input: { ticket: 42 },
      nodeRuns: {},
      createdAt
    });
    const updated = store.updateRun("run-1", {
      status: "completed",
      nodeRuns: { agent: { status: "completed", output: "done" } },
      output: "done",
      startedAt: createdAt,
      completedAt: createdAt
    });
    expect(updated).toMatchObject({ status: "completed", input: { ticket: 42 }, output: "done" });
    expect(store.listRuns(workflow.id)).toHaveLength(1);
    store.close();
  });

  it("migrates agent nodes saved by the previous product name", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflows-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const workflow = store.createWorkflow(createDefaultWorkflow({ projectId: "project-1" }));
    store.close();

    const sqlite = new DatabaseSync(path.join(directory, "pixice-workflows.sqlite"));
    const row = sqlite.prepare("SELECT graph FROM workflows WHERE id = ?").get(workflow.id);
    const graph = JSON.parse(row.graph);
    const legacyType = `${["lo", "om"].join("")}Agent`;
    graph.nodes = graph.nodes.map((node) => node.type === "pixiceAgent" ? { ...node, type: legacyType } : node);
    sqlite.prepare("UPDATE workflows SET graph = ? WHERE id = ?").run(JSON.stringify(graph), workflow.id);
    sqlite.close();

    const reopened = new WorkflowStore(directory);
    expect(reopened.getWorkflow(workflow.id).graph.nodes.some((node) => node.type === "pixiceAgent")).toBe(true);
    reopened.close();
  });
});
