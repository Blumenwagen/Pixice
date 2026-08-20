import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoomWorkflows } from "../electron/workflows/loom-workflows.mjs";
import { WorkflowStore } from "../electron/workflows/workflow-store.mjs";

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function graph(nodes, edges) {
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function node(id, type, config = {}, x = 0) {
  return { id, type, name: id, description: "", position: { x, y: 0 }, config };
}

function capability(directory) {
  const runtime = new EventEmitter();
  runtime.connected = true;
  runtime.request = vi.fn(async () => { throw new Error("No agent request expected"); });
  const store = new WorkflowStore(directory);
  const workflows = new LoomWorkflows({
    runtime,
    store,
    database: {},
    threadContext: () => ({ projectId: "project-1", cwd: directory }),
    projectContext: () => ({ cwd: directory }),
    dynamicTools: () => [],
    onRun: vi.fn()
  });
  return { workflows, store };
}

describe("workflow subworkflows", () => {
  it("runs a child workflow with parent metadata and returns its output", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-subworkflow-"));
    temporaryDirectories.push(directory);
    const { workflows, store } = capability(directory);

    const child = workflows.create({
      projectId: "project-1",
      name: "Normalize item",
      graph: graph([
        node("child-trigger", "manualTrigger", {}, 0),
        node("child-transform", "transform", {
          mode: "json",
          template: '{"value":"{{input.value}}","source":"child"}',
          mergeInput: false
        }, 300),
        node("child-output", "output", {}, 600)
      ], [
        { id: "child-one", source: "child-trigger", target: "child-transform", sourcePort: "output", targetPort: "input" },
        { id: "child-two", source: "child-transform", target: "child-output", sourcePort: "output", targetPort: "input" }
      ])
    });

    const parent = workflows.create({
      projectId: "project-1",
      name: "Parent workflow",
      graph: graph([
        node("parent-trigger", "manualTrigger", {}, 0),
        node("execute-child", "executeWorkflow", {
          workflowId: child.id,
          input: "{{input}}",
          returnMode: "output",
          continueOnError: false,
          timeoutMs: 5_000
        }, 300),
        node("parent-output", "output", {}, 600)
      ], [
        { id: "parent-one", source: "parent-trigger", target: "execute-child", sourcePort: "output", targetPort: "input" },
        { id: "parent-two", source: "execute-child", target: "parent-output", sourcePort: "output", targetPort: "input" }
      ])
    });

    const run = workflows.startRun({ projectId: "project-1", workflowId: parent.id, input: { value: 17 } });
    const completed = await workflows.waitForRun(run.id);
    expect(completed).toMatchObject({ status: "completed", output: { value: 17, source: "child" } });

    const children = store.listChildRuns(completed.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      workflowId: child.id,
      parentRunId: completed.id,
      parentNodeId: "execute-child",
      status: "completed",
      callStack: [parent.id, child.id]
    });
    store.close();
  });

  it("rejects recursive workflow calls instead of deadlocking", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-subworkflow-cycle-"));
    temporaryDirectories.push(directory);
    const { workflows, store } = capability(directory);
    const created = workflows.create({ projectId: "project-1", name: "Recursive" });
    const trigger = created.graph.nodes.find((candidate) => candidate.type === "manualTrigger");
    const output = created.graph.nodes.find((candidate) => candidate.type === "output");
    const recursive = node("recursive", "executeWorkflow", {
      workflowId: created.id,
      input: "{{input}}",
      returnMode: "output",
      continueOnError: false,
      timeoutMs: 5_000
    }, 400);
    const saved = workflows.save({
      projectId: "project-1",
      workflowId: created.id,
      expectedUpdatedAt: created.updatedAt,
      graph: graph([trigger, recursive, output], [
        { id: "cycle-one", source: trigger.id, target: recursive.id, sourcePort: "output", targetPort: "input" },
        { id: "cycle-two", source: recursive.id, target: output.id, sourcePort: "output", targetPort: "input" }
      ])
    });

    const run = workflows.startRun({ projectId: "project-1", workflowId: saved.id, input: { value: true } });
    const completed = await workflows.waitForRun(run.id);
    expect(completed.status).toBe("failed");
    expect(completed.error).toMatch(/Subworkflow cycle detected/i);
    store.close();
  });
});
