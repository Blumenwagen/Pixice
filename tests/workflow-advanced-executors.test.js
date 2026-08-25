import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeBuiltInWorkflowNode,
  normalizeWorkflowNodeResult
} from "../electron/workflows/workflow-node-executors.mjs";

const temporaryDirectories = [];
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function node(type, config = {}) {
  return { id: `${type}-node`, type, name: type, description: "", position: { x: 0, y: 0 }, config };
}

function execute(type, config, options = {}) {
  return executeBuiltInWorkflowNode({
    node: node(type, config),
    inputs: options.inputs ?? [{ sourceNodeId: "source", sourcePort: "output", targetPort: "input", value: options.input ?? { items: [] } }],
    run: {
      id: "run-1",
      input: options.runInput ?? { environment: "test" },
      sourceThreadId: "thread-1",
      callStack: ["workflow-1"]
    },
    workflow: { id: "workflow-1", projectId: "project-1" },
    nodeOutputs: options.nodeOutputs ?? new Map(),
    projectRoot: options.projectRoot,
    database: options.database,
    assertActive: options.assertActive ?? (() => {}),
    fetchImpl: options.fetchImpl,
    credentialResolver: options.credentialResolver,
    notify: options.notify,
    executeWorkflow: options.executeWorkflow,
    variables: options.variables
  });
}

describe("advanced workflow node executors", () => {
  it("uses reusable credentials for HTTP requests without exposing the secret in node config", async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify({ authorization: init.headers.get("authorization") }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const credentialResolver = vi.fn(async () => ({
      id: "credential-1",
      projectId: "project-1",
      type: "bearer",
      values: { token: "encrypted-secret" }
    }));

    const result = normalizeWorkflowNodeResult(await execute("httpRequest", {
      method: "GET",
      url: "https://api.example.test/items",
      headers: "{}",
      query: "{}",
      responseType: "json",
      credentialId: "credential-1",
      timeoutMs: 1_000,
      maxBytes: 10_000
    }, { fetchImpl, credentialResolver }));

    expect(credentialResolver).toHaveBeenCalledWith("project-1", "credential-1");
    expect(fetchImpl.mock.calls[0][1].headers.get("authorization")).toBe("Bearer encrypted-secret");
    expect(result.output.body.authorization).toBe("Bearer encrypted-secret");
  });

  it("aggregates arrays deterministically", async () => {
    const input = {
      items: [
        { id: "one", group: "a", price: 2 },
        { id: "two", group: "a", price: 3 },
        { id: "one", group: "b", price: 5 }
      ]
    };

    const sum = normalizeWorkflowNodeResult(await execute("aggregate", {
      source: "{{input.items}}",
      operation: "sum",
      field: "price"
    }, { input }));
    expect(sum.output).toBe(10);

    const grouped = normalizeWorkflowNodeResult(await execute("aggregate", {
      source: "{{input.items}}",
      operation: "groupBy",
      groupBy: "group"
    }, { input }));
    expect(grouped.output.a).toHaveLength(2);
    expect(grouped.output.b[0].price).toBe(5);

    const unique = normalizeWorkflowNodeResult(await execute("aggregate", {
      source: "{{input.items}}",
      operation: "unique",
      field: "id"
    }, { input }));
    expect(unique.output).toEqual(["one", "two"]);
  });

  it("queries SQLite read-only and requires explicit permission for mutations", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflow-sqlite-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "data.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE items (name TEXT NOT NULL, score INTEGER NOT NULL)");
    database.prepare("INSERT INTO items (name, score) VALUES (?, ?)").run("one", 1);
    database.prepare("INSERT INTO items (name, score) VALUES (?, ?)").run("two", 2);
    database.close();

    const queried = normalizeWorkflowNodeResult(await execute("database", {
      operation: "query",
      databasePath: "data.sqlite",
      sql: "SELECT name, score FROM items WHERE score >= ? ORDER BY score",
      parameters: "[2]",
      maxRows: 100
    }, { projectRoot: directory }));
    expect(queried.output).toMatchObject({ path: "data.sqlite", rowCount: 1, truncated: false });
    expect(queried.output.rows).toEqual([{ name: "two", score: 2 }]);

    await expect(execute("database", {
      operation: "execute",
      databasePath: "data.sqlite",
      sql: "INSERT INTO items (name, score) VALUES (?, ?)",
      parameters: '["three", 3]',
      allowWrite: false
    }, { projectRoot: directory })).rejects.toThrow(/Allow database writes/i);

    const written = normalizeWorkflowNodeResult(await execute("database", {
      operation: "execute",
      databasePath: "data.sqlite",
      sql: "INSERT INTO items (name, score) VALUES (?, ?)",
      parameters: '["three", 3]',
      allowWrite: true
    }, { projectRoot: directory }));
    expect(written.output.changes).toBe(1);
  });

  it("executes subworkflows and returns structured errors when configured", async () => {
    const executeWorkflow = vi.fn(async ({ workflowId, input, returnMode }) => ({ workflowId, input, returnMode }));
    const completed = normalizeWorkflowNodeResult(await execute("executeWorkflow", {
      workflowId: "child-workflow",
      input: "{{input}}",
      returnMode: "run",
      continueOnError: false,
      timeoutMs: 5_000
    }, { input: { task: 17 }, executeWorkflow }));

    expect(executeWorkflow).toHaveBeenCalledWith({
      workflowId: "child-workflow",
      input: { task: 17 },
      timeoutMs: 5_000,
      returnMode: "run"
    });
    expect(completed.output.input).toEqual({ task: 17 });

    const failed = normalizeWorkflowNodeResult(await execute("executeWorkflow", {
      workflowId: "broken-workflow",
      input: "{{input}}",
      returnMode: "output",
      continueOnError: true,
      timeoutMs: 5_000
    }, {
      executeWorkflow: async () => { throw new Error("child failed"); }
    }));
    expect(failed.output).toMatchObject({ ok: false, error: "child failed", workflowId: "broken-workflow" });
  });

  it("loops through items with bounded concurrency while preserving result order", async () => {
    let active = 0;
    let maximumActive = 0;
    const executeWorkflow = vi.fn(async ({ input }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, input.delay));
      active -= 1;
      return input.value * 2;
    });

    const result = normalizeWorkflowNodeResult(await execute("loop", {
      workflowId: "item-workflow",
      source: "{{input.items}}",
      mode: "items",
      batchSize: 10,
      concurrency: 2,
      input: "{{item}}",
      continueOnError: false,
      timeoutMs: 5_000
    }, {
      input: {
        items: [
          { value: 1, delay: 20 },
          { value: 2, delay: 1 },
          { value: 3, delay: 1 }
        ]
      },
      executeWorkflow
    }));

    expect(result.output).toEqual([2, 4, 6]);
    expect(maximumActive).toBe(2);
    expect(executeWorkflow).toHaveBeenCalledTimes(3);
  });

  it("shows native desktop notifications and passes the input onward as metadata", async () => {
    const notify = vi.fn(async () => true);
    const result = normalizeWorkflowNodeResult(await execute("notification", {
      title: "Release {{input.version}}",
      body: "{{input.message}}",
      urgency: "critical",
      silent: false
    }, { input: { version: "1.2.3", message: "Ready to ship" }, notify }));

    expect(notify).toHaveBeenCalledWith({
      title: "Release 1.2.3",
      body: "Ready to ship",
      urgency: "critical",
      silent: false
    });
    expect(result.output).toMatchObject({ shown: true, title: "Release 1.2.3", urgency: "critical" });
  });
});
