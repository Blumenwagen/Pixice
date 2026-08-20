import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoomWorkflows, loomWorkflowDynamicTools } from "../electron/workflows/loom-workflows.mjs";
import { WorkflowStore } from "../electron/workflows/workflow-store.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function resultValue(result) {
  return JSON.parse(result.contentItems[0].text);
}

class FakeRuntime extends EventEmitter {
  connected = true;
  sequence = 0;
  requests = [];

  async request(method, payload) {
    this.requests.push({ method, payload });
    if (method === "model/list") {
      return { data: [{ id: "codex:gpt-test", model: "gpt-test", provider: "codex", displayName: "GPT Test", isDefault: true }] };
    }
    if (method === "thread/start") {
      this.sequence += 1;
      return { thread: { id: `workflow-thread-${this.sequence}`, cwd: payload.cwd } };
    }
    if (method === "turn/start") {
      const turnId = `turn-${this.sequence}`;
      queueMicrotask(() => this.emit("event", {
        payload: {
          method: "turn/completed",
          threadId: payload.threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", text: "workflow answer", phase: "final_answer" }]
          }
        }
      }));
      return { turn: { id: turnId } };
    }
    if (method === "thread/read") return { thread: { turns: [] } };
    throw new Error(`Unexpected runtime request: ${method}`);
  }
}

function createCapability({ runtime, store, saveThreadLink = vi.fn(), onForeground = vi.fn(), onAgentActivity = vi.fn() }) {
  const onOpen = vi.fn();
  const onChange = vi.fn();
  const onRun = vi.fn();
  const workflows = new LoomWorkflows({
    runtime,
    store,
    database: { saveThreadLink },
    threadContext: () => ({ projectId: "project-1", cwd: "/workspace" }),
    projectContext: () => ({
      cwd: "/workspace",
      defaultModel: "gpt-test",
      defaultEffort: "high",
      defaultPermissionMode: "workspace-write",
      developerInstructions: "test",
      permissionSettings: () => ({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"] }
      })
    }),
    dynamicTools: () => [],
    onOpen,
    onChange,
    onRun,
    onForeground,
    onAgentActivity
  });
  return { workflows, onOpen, onChange, onRun, onForeground, onAgentActivity, saveThreadLink };
}

describe("Loom workflow capability", () => {
  it("lets an agent create, inspect, edit, open, and run a background workflow agent", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-agent-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const capability = createCapability({ runtime, store });

    const created = resultValue(await capability.workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "create_workflow",
      arguments: { name: "Investigate regression", description: "Use a Loom Agent" }
    })).workflow;
    const createdAgent = created.graph.nodes.find((node) => node.type === "loomAgent");
    expect(createdAgent.config.executionMode).toBe("background");

    const inspected = resultValue(await capability.workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "inspect_workflow",
      arguments: { workflowId: created.id }
    })).workflow;
    const agent = inspected.graph.nodes.find((node) => node.type === "loomAgent");
    const saved = resultValue(await capability.workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "save_workflow",
      arguments: {
        workflowId: created.id,
        expectedUpdatedAt: inspected.updatedAt,
        nodes: inspected.graph.nodes.map((node) => node.id === agent.id
          ? { ...node, config: { ...node.config, prompt: "Diagnose the regression." } }
          : node),
        edges: inspected.graph.edges,
        viewport: inspected.graph.viewport
      }
    })).workflow;
    expect(saved.graph.nodes.find((node) => node.id === agent.id).config.prompt).toBe("Diagnose the regression.");

    const completed = resultValue(await capability.workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "run_workflow",
      arguments: { workflowId: created.id, input: { issue: 17 } }
    })).run;
    expect(completed).toMatchObject({ status: "completed", output: "workflow answer" });
    expect(completed.nodeRuns[agent.id]).toMatchObject({ executionMode: "background", threadId: "workflow-thread-1" });
    expect(capability.saveThreadLink).toHaveBeenCalledWith(expect.objectContaining({
      kind: "loomWorkflowBackground",
      parentThreadId: "thread-parent"
    }));
    expect(runtime.requests.find((request) => request.method === "thread/start")?.payload.parentThreadId).toBe("thread-parent");
    expect(capability.onForeground).not.toHaveBeenCalled();
    expect(capability.onAgentActivity).toHaveBeenCalled();
    expect(capability.onOpen).toHaveBeenCalledTimes(4);
    expect(capability.onChange).toHaveBeenCalledTimes(2);
    expect(capability.onRun).toHaveBeenCalled();
    store.close();
  });

  it("promotes foreground agent nodes to normal root Loom threads", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-foreground-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const capability = createCapability({ runtime, store });
    const created = capability.workflows.create({ projectId: "project-1", name: "Foreground review" });
    const agent = created.graph.nodes.find((node) => node.type === "loomAgent");
    const saved = capability.workflows.save({
      projectId: "project-1",
      workflowId: created.id,
      graph: {
        ...created.graph,
        nodes: created.graph.nodes.map((node) => node.id === agent.id
          ? { ...node, config: { ...node.config, executionMode: "foreground" } }
          : node)
      },
      expectedUpdatedAt: created.updatedAt
    });

    const run = capability.workflows.startRun({
      projectId: "project-1",
      workflowId: saved.id,
      input: { review: true },
      sourceThreadId: "thread-parent"
    });
    const completed = await capability.workflows.waitForRun(run.id);

    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns[agent.id]).toMatchObject({ executionMode: "foreground", threadId: "workflow-thread-1" });
    const threadRequest = runtime.requests.find((request) => request.method === "thread/start");
    expect(threadRequest.payload).not.toHaveProperty("parentThreadId");
    expect(capability.saveThreadLink).not.toHaveBeenCalled();
    expect(capability.onAgentActivity).not.toHaveBeenCalled();
    expect(capability.onForeground).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      workflowId: saved.id,
      nodeId: agent.id,
      threadId: "workflow-thread-1",
      sourceThreadId: "thread-parent"
    }));
    store.close();
  });

  it("advertises the Loom workflow namespace", () => {
    expect(loomWorkflowDynamicTools[0]).toMatchObject({ type: "namespace", name: "loom_workflows" });
    expect(loomWorkflowDynamicTools[0].tools.map((tool) => tool.name)).toEqual([
      "list_workflows",
      "inspect_workflow",
      "create_workflow",
      "save_workflow",
      "delete_workflow",
      "run_workflow",
      "open_workflow"
    ]);
  });
});
