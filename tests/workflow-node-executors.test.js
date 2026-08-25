import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    inputs: options.inputs ?? [{ sourceNodeId: "source", sourcePort: "output", targetPort: "input", value: options.input ?? { status: 201, title: "Ship it" } }],
    run: { id: "run-1", input: options.runInput ?? { environment: "test" }, sourceThreadId: "thread-1" },
    workflow: { id: "workflow-1", projectId: "project-1" },
    nodeOutputs: options.nodeOutputs ?? new Map(),
    projectRoot: options.projectRoot,
    database: options.database,
    assertActive: options.assertActive ?? (() => {}),
    fetchImpl: options.fetchImpl
  });
}

describe("workflow node executors", () => {
  it("transforms structured values and routes conditions and switches", async () => {
    const transformed = normalizeWorkflowNodeResult(await execute("transform", {
      mode: "json",
      template: '{"title":"{{input.title}}","environment":"{{run.environment}}"}',
      mergeInput: true
    }));
    expect(transformed.output).toEqual({ status: 201, title: "Ship it", environment: "test" });

    const condition = normalizeWorkflowNodeResult(await execute("condition", {
      left: "{{input.status}}",
      operator: "greaterThanOrEqual",
      right: "200"
    }));
    expect(condition.output.matched).toBe(true);
    expect(condition.ports).toEqual({ true: { status: 201, title: "Ship it" } });

    const switched = normalizeWorkflowNodeResult(await execute("switch", {
      value: "{{input.status}}",
      rules: [
        { id: "success", label: "Success", operator: "greaterThanOrEqual", compare: "200" },
        { id: "retry", label: "Retry", operator: "equals", compare: "429" }
      ]
    }));
    expect(switched.output.matchedPort).toBe("success");
    expect(switched.ports.success.status).toBe(201);
  });

  it("merges inputs in array, object, keyed, and concatenate modes", async () => {
    const inputs = [
      { sourceNodeId: "one", value: { first: true } },
      { sourceNodeId: "two", value: { second: true } }
    ];
    expect(normalizeWorkflowNodeResult(await execute("merge", { mode: "object" }, { inputs })).output).toEqual({ first: true, second: true });
    expect(normalizeWorkflowNodeResult(await execute("merge", { mode: "keyed" }, { inputs })).output).toEqual({ one: { first: true }, two: { second: true } });
    expect(normalizeWorkflowNodeResult(await execute("merge", { mode: "concatenate" }, {
      inputs: [{ sourceNodeId: "one", value: [1, 2] }, { sourceNodeId: "two", value: 3 }]
    })).output).toEqual([1, 2, 3]);
  });

  it("performs templated HTTP requests and returns structured responses", async () => {
    const fetchImpl = vi.fn(async (url, init) => new Response(JSON.stringify({ received: JSON.parse(init.body) }), {
      status: 201,
      headers: { "content-type": "application/json", "x-test": "yes" }
    }));
    const result = normalizeWorkflowNodeResult(await execute("httpRequest", {
      method: "POST",
      url: "https://api.example.test/issues/{{input.status}}",
      headers: '{"x-environment":"{{run.environment}}"}',
      query: '{"include":"details"}',
      bodyMode: "json",
      body: '{"title":"{{input.title}}"}',
      responseType: "auto",
      failOnHttpError: true,
      timeoutMs: 1_000,
      maxBytes: 10_000
    }, { fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.example.test/issues/201?include=details");
    expect(fetchImpl.mock.calls[0][1].headers.get("x-environment")).toBe("test");
    expect(result.output).toMatchObject({ ok: true, status: 201, body: { received: { title: "Ship it" } } });
  });

  it("reads and explicitly writes only inside the project", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflow-files-"));
    temporaryDirectories.push(directory);
    writeFileSync(path.join(directory, "README.md"), "hello", "utf8");

    const read = normalizeWorkflowNodeResult(await execute("file", {
      operation: "readText",
      path: "README.md",
      maxBytes: 1_000
    }, { projectRoot: directory }));
    expect(read.output).toMatchObject({ path: "README.md", content: "hello" });

    await expect(execute("file", {
      operation: "writeText",
      path: "generated/result.txt",
      content: "{{input.title}}",
      allowWrite: false
    }, { projectRoot: directory })).rejects.toThrow(/Allow project writes/i);

    await execute("file", {
      operation: "writeText",
      path: "generated/result.txt",
      content: "{{input.title}}",
      allowWrite: true,
      createDirectories: true,
      maxBytes: 1_000
    }, { projectRoot: directory });
    expect(readFileSync(path.join(directory, "generated/result.txt"), "utf8")).toBe("Ship it");
    await expect(execute("file", { operation: "readText", path: "../secret.txt" }, { projectRoot: directory })).rejects.toThrow(/current Pixice project/i);
  });

  it("runs explicitly enabled commands without a shell and returns structured output", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflow-command-"));
    temporaryDirectories.push(directory);
    execFileSync("git", ["init", "-q"], { cwd: directory });

    await expect(execute("command", {
      executable: "git",
      arguments: '["rev-parse", "--show-toplevel"]',
      workingDirectory: ".",
      environment: "{}",
      allowExecution: false
    }, { projectRoot: directory })).rejects.toThrow(/Allow command execution/i);

    const result = normalizeWorkflowNodeResult(await execute("command", {
      executable: "git",
      arguments: '["rev-parse", "{{input.target}}"]',
      workingDirectory: ".",
      environment: '{"PIXICE_WORKFLOW_TEST":"enabled"}',
      allowExecution: true,
      timeoutMs: 5_000,
      maxBytes: 10_000
    }, { projectRoot: directory, input: { target: "--show-toplevel" } }));
    expect(result.output).toMatchObject({
      ok: true,
      exitCode: 0,
      executable: "git",
      arguments: ["rev-parse", "--show-toplevel"],
      workingDirectory: "."
    });
    expect(result.output.stdout.trim()).toBe(realpathSync(directory));
    expect(result.output.durationMs).toBeGreaterThanOrEqual(0);

    const failed = normalizeWorkflowNodeResult(await execute("command", {
      executable: "git",
      arguments: '["rev-parse", "--verify", "missing-ref"]',
      workingDirectory: ".",
      environment: "{}",
      allowExecution: true,
      continueOnError: true
    }, { projectRoot: directory }));
    expect(failed.output).toMatchObject({ ok: false, exitCode: 128 });

    await expect(execute("command", {
      executable: "../outside-tool",
      arguments: "[]",
      allowExecution: true
    }, { projectRoot: directory })).rejects.toThrow(/current Pixice project/i);
  });

  it("inspects a real Git repository without exposing arbitrary shell arguments", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-workflow-git-"));
    temporaryDirectories.push(directory);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "pixice@example.test"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Pixice"], { cwd: directory });
    writeFileSync(path.join(directory, "file.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "file.txt"], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "Initial"], { cwd: directory });
    writeFileSync(path.join(directory, "file.txt"), "two\n", "utf8");

    const status = normalizeWorkflowNodeResult(await execute("git", { operation: "status" }, { projectRoot: directory }));
    expect(status.output.clean).toBe(false);
    expect(status.output.changes[0].path).toBe("file.txt");

    const log = normalizeWorkflowNodeResult(await execute("git", { operation: "log", target: "HEAD", maxEntries: 5 }, { projectRoot: directory }));
    expect(log.output.commits[0].subject).toBe("Initial");
  });

  it("creates and moves durable Pixice board tasks", async () => {
    const tasks = new Map();
    const database = {
      listBoardTasks: () => [...tasks.values()],
      getBoardTask: (id) => tasks.get(id) ?? null,
      createBoardTask: (value) => {
        const task = { ...value, position: 1024, createdAt: "now", updatedAt: "now" };
        tasks.set(task.id, task);
        return task;
      },
      updateBoardTask: (id, patch) => {
        const task = { ...tasks.get(id), ...patch };
        tasks.set(id, task);
        return task;
      },
      moveBoardTask: (id, column) => {
        const task = { ...tasks.get(id), column };
        tasks.set(id, task);
        return task;
      },
      deleteBoardTask: (id) => {
        const task = tasks.get(id);
        tasks.delete(id);
        return task;
      }
    };

    const created = normalizeWorkflowNodeResult(await execute("board", {
      operation: "create",
      title: "{{input.title}}",
      description: "Created by workflow",
      column: "ready",
      attachSourceThread: true
    }, { database }));
    expect(created.output.task).toMatchObject({ title: "Ship it", column: "ready", threadId: "thread-1" });

    const moved = normalizeWorkflowNodeResult(await execute("board", {
      operation: "move",
      taskId: created.output.task.id,
      column: "active"
    }, { database }));
    expect(moved.output.task.column).toBe("active");
  });
});
