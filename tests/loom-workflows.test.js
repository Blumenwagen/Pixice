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

  async request(method, payload) {
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

describe("Loom workflow capability", () => {
  it("lets an agent create, inspect, edit, open, and run a workflow", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-agent-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const onOpen = vi.fn();
    const onChange = vi.fn();
    const onRun = vi.fn();
    const saveThreadLink = vi.fn();
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
      onRun
    });

    const created = resultValue(await workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "create_workflow",
      arguments: { name: "Investigate regression", description: "Use a Loom Agent" }
    })).workflow;
    expect(created.graph.nodes.some((node) => node.type === "loomAgent")).toBe(true);

    const inspected = resultValue(await workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "inspect_workflow",
      arguments: { workflowId: created.id }
    })).workflow;
    const agent = inspected.graph.nodes.find((node) => node.type === "loomAgent");
    const saved = resultValue(await workflows.handleToolCall({
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

    const completed = resultValue(await workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "run_workflow",
      arguments: { workflowId: created.id, input: { issue: 17 } }
    })).run;
    expect(completed).toMatchObject({ status: "completed", output: "workflow answer" });
    expect(saveThreadLink).toHaveBeenCalledWith(expect.objectContaining({ kind: "loomWorkflow", parentThreadId: "thread-parent" }));
    expect(onOpen).toHaveBeenCalledTimes(4);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onRun).toHaveBeenCalled();
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
