import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  skills = [];
  modelProvider = "codex";

  async request(method, payload) {
    this.requests.push({ method, payload });
    if (method === "model/list") {
      return { data: [{ id: `${this.modelProvider}:gpt-test`, model: "gpt-test", provider: this.modelProvider, displayName: "GPT Test", isDefault: true }] };
    }
    if (method === "skills/list") return { data: this.skills };
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

function createCapability({
  runtime,
  store,
  projectRoot = "/workspace",
  saveThreadLink = vi.fn(),
  onForeground = vi.fn(),
  onAgentActivity = vi.fn()
}) {
  const onOpen = vi.fn();
  const onChange = vi.fn();
  const onRun = vi.fn();
  const workflows = new LoomWorkflows({
    runtime,
    store,
    database: { saveThreadLink },
    threadContext: () => ({ projectId: "project-1", cwd: projectRoot }),
    projectContext: () => ({
      cwd: projectRoot,
      runtimeWorkspaceRoots: [projectRoot, `${projectRoot}-shared`],
      defaultModel: "gpt-test",
      defaultEffort: "high",
      defaultPermissionMode: "workspace-write",
      developerInstructions: "base Loom instructions",
      permissionSettings: () => ({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [projectRoot] }
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
  it("lets an agent discover, create, inspect, edit, open, and run a background workflow agent", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-agent-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const capability = createCapability({ runtime, store });

    const catalog = resultValue(await capability.workflows.handleToolCall({
      threadId: "thread-parent",
      tool: "describe_nodes",
      arguments: {}
    }));
    expect(catalog.nodes.map((node) => node.type)).toEqual(expect.arrayContaining([
      "useSkill", "httpRequest", "transform", "condition", "switch", "merge", "delay", "file", "git", "board"
    ]));

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
    expect(runtime.requests.find((request) => request.method === "thread/start")?.payload.runtimeWorkspaceRoots)
      .toEqual(["/workspace", "/workspace-shared"]);
    expect(runtime.requests.find((request) => request.method === "turn/start")?.payload.runtimeWorkspaceRoots)
      .toEqual(["/workspace", "/workspace-shared"]);
    expect(capability.onForeground).not.toHaveBeenCalled();
    expect(capability.onAgentActivity).toHaveBeenCalled();
    expect(capability.onOpen).toHaveBeenCalledTimes(4);
    expect(capability.onChange).toHaveBeenCalledTimes(2);
    expect(capability.onRun).toHaveBeenCalled();
    store.close();
  });

  it("attaches multiple installed and Markdown Skills to one Agent without turning them into workflow data", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-skills-"));
    temporaryDirectories.push(directory);
    const userData = path.join(directory, "user-data");
    const projectRoot = path.join(directory, "project");
    const installedSkill = path.join(directory, "installed", "release-review");
    mkdirSync(userData, { recursive: true });
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    mkdirSync(installedSkill, { recursive: true });
    writeFileSync(path.join(installedSkill, "SKILL.md"), "# Release review\nAlways inspect the changelog.", "utf8");
    writeFileSync(path.join(projectRoot, "docs", "security.md"), "# Security review\nNever expose credentials.", "utf8");

    const store = new WorkflowStore(userData);
    const runtime = new FakeRuntime();
    runtime.skills = [{
      cwd: projectRoot,
      skills: [{ id: "release-review", name: "Release Review", description: "Review release readiness", path: installedSkill }]
    }];
    const capability = createCapability({ runtime, store, projectRoot });
    const graph = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: "trigger", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
        { id: "installed", type: "useSkill", name: "Release Skill", description: "", position: { x: 0, y: 180 }, config: { source: "installed", skillRef: installedSkill, skillName: "Release Review" } },
        { id: "markdown", type: "useSkill", name: "Security Skill", description: "", position: { x: 0, y: 360 }, config: { source: "markdown", path: "docs/security.md", skillName: "Security Review" } },
        { id: "agent", type: "loomAgent", name: "Review Agent", description: "", position: { x: 360, y: 120 }, config: { prompt: "Review this release.", model: null, effort: null, permissionMode: "workspace-write", executionMode: "background" } },
        { id: "output", type: "output", name: "Result", description: "", position: { x: 720, y: 120 }, config: {} }
      ],
      edges: [
        { id: "data", source: "trigger", target: "agent", sourcePort: "output", targetPort: "input" },
        { id: "installed-edge", source: "installed", target: "agent", sourcePort: "skill", targetPort: "skill" },
        { id: "markdown-edge", source: "markdown", target: "agent", sourcePort: "skill", targetPort: "skill" },
        { id: "answer", source: "agent", target: "output", sourcePort: "output", targetPort: "input" }
      ]
    };
    const workflow = capability.workflows.create({ projectId: "project-1", name: "Skilled review", graph });
    const run = capability.workflows.startRun({ projectId: "project-1", workflowId: workflow.id, input: { version: "1.2.3" } });
    const completed = await capability.workflows.waitForRun(run.id);

    expect(completed).toMatchObject({ status: "completed", output: "workflow answer" });
    const threadStart = runtime.requests.find((request) => request.method === "thread/start");
    expect(threadStart.payload.developerInstructions).toContain("base Loom instructions");
    expect(threadStart.payload.developerInstructions).toContain("Attached Skill 1: Release Review");
    expect(threadStart.payload.developerInstructions).toContain("Always inspect the changelog");
    expect(threadStart.payload.developerInstructions).toContain("Attached Skill 2: Security Review");
    expect(threadStart.payload.developerInstructions).toContain("Never expose credentials");
    const turnStart = runtime.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart.payload.input)).toContain("Review this release");
    expect(JSON.stringify(turnStart.payload.input)).not.toContain("Always inspect the changelog");

    expect(completed.nodeRuns.agent.attachedSkills).toEqual([
      expect.objectContaining({ source: "installed", name: "Release Review", bytes: expect.any(Number) }),
      expect.objectContaining({ source: "markdown", name: "Security Review", path: path.join("docs", "security.md") })
    ]);
    expect(completed.nodeRuns.agent.attachedSkills[0]).not.toHaveProperty("content");
    expect(completed.nodeRuns.installed.output).not.toHaveProperty("content");
    expect(completed.nodeRuns.markdown.output).not.toHaveProperty("content");
    expect(runtime.requests.filter((request) => request.method === "skills/list")).toHaveLength(1);
    store.close();
  });

  it("does not let an attachment activate an Agent whose data branch was skipped", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-inactive-skill-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const capability = createCapability({ runtime, store });
    const graph = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: "trigger", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
        { id: "condition", type: "condition", name: "Run?", description: "", position: { x: 260, y: 0 }, config: { left: "{{input.run}}", operator: "isTrue", right: "" } },
        { id: "skill", type: "useSkill", name: "Unused Skill", description: "", position: { x: 260, y: 240 }, config: { source: "installed", skillRef: "missing", skillName: "Missing" } },
        { id: "agent", type: "loomAgent", name: "Conditional Agent", description: "", position: { x: 560, y: 0 }, config: {} },
        { id: "output", type: "output", name: "Result", description: "", position: { x: 860, y: 0 }, config: {} }
      ],
      edges: [
        { id: "start-condition", source: "trigger", target: "condition", sourcePort: "output", targetPort: "input" },
        { id: "false-agent", source: "condition", target: "agent", sourcePort: "true", targetPort: "input" },
        { id: "skill-agent", source: "skill", target: "agent", sourcePort: "skill", targetPort: "skill" },
        { id: "agent-output", source: "agent", target: "output", sourcePort: "output", targetPort: "input" }
      ]
    };
    const workflow = capability.workflows.create({ projectId: "project-1", name: "Conditional skilled agent", graph });
    const run = capability.workflows.startRun({ projectId: "project-1", workflowId: workflow.id, input: { run: false } });
    const completed = await capability.workflows.waitForRun(run.id);

    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns.agent).toMatchObject({ status: "skipped", skipReason: "No active incoming branch" });
    expect(runtime.requests.some((request) => request.method === "skills/list")).toBe(false);
    expect(runtime.requests.some((request) => request.method === "thread/start")).toBe(false);
    store.close();
  });

  it("runs only the selected condition branch and merges it downstream", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-workflow-branch-"));
    temporaryDirectories.push(directory);
    const store = new WorkflowStore(directory);
    const runtime = new FakeRuntime();
    const capability = createCapability({ runtime, store });
    const trigger = "trigger";
    const condition = "condition";
    const success = "success";
    const failure = "failure";
    const merge = "merge";
    const output = "output";
    const graph = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: trigger, type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
        { id: condition, type: "condition", name: "Successful response?", description: "", position: { x: 300, y: 0 }, config: { left: "{{input.status}}", operator: "greaterThanOrEqual", right: "200" } },
        { id: success, type: "transform", name: "Success", description: "", position: { x: 600, y: -100 }, config: { mode: "json", template: '{"route":"success","status":"{{input.status}}"}' } },
        { id: failure, type: "transform", name: "Failure", description: "", position: { x: 600, y: 120 }, config: { mode: "json", template: '{"route":"failure","status":"{{input.status}}"}' } },
        { id: merge, type: "merge", name: "Join", description: "", position: { x: 900, y: 0 }, config: { mode: "first" } },
        { id: output, type: "output", name: "Result", description: "", position: { x: 1200, y: 0 }, config: {} }
      ],
      edges: [
        { id: "one", source: trigger, target: condition, sourcePort: "output", targetPort: "input" },
        { id: "two", source: condition, target: success, sourcePort: "true", targetPort: "input" },
        { id: "three", source: condition, target: failure, sourcePort: "false", targetPort: "input" },
        { id: "four", source: success, target: merge, sourcePort: "output", targetPort: "input" },
        { id: "five", source: failure, target: merge, sourcePort: "output", targetPort: "input" },
        { id: "six", source: merge, target: output, sourcePort: "output", targetPort: "input" }
      ]
    };
    const workflow = capability.workflows.create({ projectId: "project-1", name: "Route response", graph });
    const run = capability.workflows.startRun({ projectId: "project-1", workflowId: workflow.id, input: { status: 201 } });
    const completed = await capability.workflows.waitForRun(run.id);

    expect(completed).toMatchObject({ status: "completed", output: { route: "success", status: 201 } });
    expect(completed.nodeRuns[success]).toMatchObject({ status: "completed" });
    expect(completed.nodeRuns[failure]).toMatchObject({ status: "skipped", skipReason: "No active incoming branch" });
    expect(completed.nodeRuns[condition].activePorts).toEqual(["true"]);
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
      "describe_nodes",
      "inspect_workflow",
      "create_workflow",
      "save_workflow",
      "delete_workflow",
      "run_workflow",
      "open_workflow"
    ]);
  });
});
