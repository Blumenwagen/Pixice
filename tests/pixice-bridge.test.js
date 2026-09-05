import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PixiceBridge } from "../electron/runtime/pixice-bridge.mjs";

class MemoryDatabase {
  constructor() { this.links = new Map(); }
  saveThreadLink(link) {
    const saved = { kind: "pixiceBridge", ...link };
    this.links.set(link.childThreadId, saved);
    return saved;
  }
  getThreadLink(threadId) { return this.links.get(threadId) ?? null; }
}

class FakeRuntime extends EventEmitter {
  constructor(models = null) {
    super();
    this.calls = [];
    this.models = models ?? [
      { id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", provider: "codex", displayName: "GPT 5.6 Luna" },
      { id: "codex:gpt-5.5", model: "gpt-5.5", provider: "codex", displayName: "GPT 5.5" },
      { id: "claude:claude-sonnet-4-6", model: "claude-sonnet-4-6", provider: "claude", displayName: "Claude Sonnet 4.6", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }
    ];
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: this.models };
    if (method === "thread/start") return { thread: { id: "child-1", cwd: params.cwd, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    return {};
  }
}

function createBridge(models, contextOverrides = {}) {
  const runtime = new FakeRuntime(models);
  const database = new MemoryDatabase();
  const activities = [];
  const onThreadCreated = vi.fn();
  const onCompletion = vi.fn();
  const bridge = new PixiceBridge({
    runtime,
    database,
    dynamicTools: () => [{ name: "pixice_bridge" }],
    threadContext: () => ({
      projectId: "project-1",
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace", "/shared"],
      developerInstructions: "Pixice base guidance\n\n# Verification before handoff",
      permissionSettings: (mode) => ({
        approvalPolicy: "on-request",
        approvalsReviewer: mode === "auto-approve" ? "auto_review" : "user",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite" }
      }),
      ...contextOverrides
    }),
    onThreadCreated,
    onCompletion,
    onActivity: (activity) => activities.push(activity)
  });
  return { bridge, runtime, database, activities, onThreadCreated, onCompletion };
}

describe("Pixice bridge", () => {
  it("reports only eligible models with capability ratings", async () => {
    const { bridge } = createBridge();
    const result = await bridge.handleToolCall({ threadId: "parent-1", tool: "list_models", arguments: {} });
    const payload = JSON.parse(result.contentItems[0].text);

    expect(payload.models.map((model) => model.id)).toEqual([
      "codex:gpt-5.6-luna",
      "claude:claude-sonnet-4-6"
    ]);
    expect(payload.models[1].profile.ratings).toMatchObject({ ui: 5, taste: 5 });
    expect(payload.models.every((model) => model.availability === "connected")).toBe(true);
    expect(payload.connectedFamilies).toEqual(["gpt", "claude"]);
    expect(payload.recommendation.provider).toBe("codex");
  });

  it("lists and spawns connected Astra with its advertised reasoning efforts", async () => {
    const { bridge, runtime } = createBridge([{
      id: "codex:gpt-6-astra", model: "gpt-6-astra", provider: "codex",
      supportedReasoningEfforts: [{ reasoningEffort: "ultra" }]
    }]);
    const catalog = await bridge.handleToolCall({ threadId: "parent-1", tool: "list_models", arguments: {} });
    expect(JSON.parse(catalog.contentItems[0].text).models[0]).toMatchObject({
      id: "codex:gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }]
    });
    const pending = bridge.handleToolCall({
      threadId: "parent-1", tool: "spawn_thread",
      arguments: { prompt: "Review the architecture", model: "codex:gpt-6-astra", effort: "ultra" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "thread/start", params: expect.objectContaining({ model: "codex:gpt-6-astra" }) }),
      expect.objectContaining({ method: "turn/start", params: expect.objectContaining({ model: "codex:gpt-6-astra", effort: "ultra" }) })
    ]));
    runtime.emit("event", { payload: { method: "turn/completed", threadId: "child-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    expect(JSON.parse((await pending).contentItems[0].text)).toMatchObject({ threadId: "child-1", status: "completed" });
  });

  it("recommends whichever eligible family is actually connected", async () => {
    const claudeOnly = createBridge([
      { id: "claude:claude-sonnet-4-6", model: "claude-sonnet-4-6", provider: "claude" }
    ]).bridge;
    const claudeResult = await claudeOnly.handleToolCall({ threadId: "parent-1", tool: "list_models", arguments: { task: "Implement an API" } });
    expect(JSON.parse(claudeResult.contentItems[0].text)).toMatchObject({
      connectedFamilies: ["claude"],
      recommendation: { provider: "claude" }
    });

    const gptOnly = createBridge([
      { id: "codex:gpt-5.6-terra", model: "gpt-5.6-terra", provider: "codex" }
    ]).bridge;
    const gptResult = await gptOnly.handleToolCall({ threadId: "parent-1", tool: "list_models", arguments: { task: "Polish the UI design" } });
    expect(JSON.parse(gptResult.contentItems[0].text)).toMatchObject({
      connectedFamilies: ["gpt"],
      recommendation: { provider: "codex" }
    });
  });

  it("spawns a cross-provider thread and relays its final answer", async () => {
    const { bridge, runtime, database, activities, onThreadCreated, onCompletion } = createBridge(undefined, { permissionMode: "auto-approve" });
    const resultPromise = bridge.handleToolCall({
      threadId: "parent-1",
      turnId: "parent-turn",
      tool: "spawn_thread",
      arguments: {
        prompt: "Review the interface",
        model: "claude:claude-sonnet-4-6",
        effort: "high",
        permissionMode: "workspace-write"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({
          model: "claude:claude-sonnet-4-6",
          parentThreadId: "parent-1",
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
          developerInstructions: "Pixice base guidance\n\n# Verification before handoff",
          permissionMode: "workspace-write",
          approvalsReviewer: "user"
        })
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId: "child-1",
          model: "claude:claude-sonnet-4-6",
          effort: "high",
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
          permissionMode: "workspace-write",
          approvalsReviewer: "user"
        })
      })
    ]));
    expect(database.getThreadLink("child-1")).toMatchObject({ parentThreadId: "parent-1" });
    expect(onThreadCreated).toHaveBeenCalled();

    runtime.emit("event", {
      type: "TaskUpdated",
      payload: {
        method: "turn/completed",
        threadId: "child-1",
        turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "Use more whitespace." }] }
      }
    });
    const result = await resultPromise;
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      threadId: "child-1",
      status: "completed",
      answer: "Use more whitespace."
    });
    expect(activities.at(-1).item.agentsStates["child-1"]).toMatchObject({ status: "completed", message: "Use more whitespace." });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({
      parentThreadId: "parent-1",
      parentTurnId: "parent-turn",
      childThreadId: "child-1",
      answer: "Use more whitespace."
    }));

    runtime.emit("event", {
      payload: {
        method: "turn/completed",
        threadId: "child-1",
        turn: { id: "turn-1", status: "completed", items: [] }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCompletion).toHaveBeenCalledTimes(1);
  });

  it("inherits the parent permission mode when the child does not specify one", async () => {
    const { bridge, runtime, onThreadCreated } = createBridge(undefined, { permissionMode: "auto-approve" });
    const resultPromise = bridge.handleToolCall({
      threadId: "parent-1",
      tool: "spawn_thread",
      arguments: {
        prompt: "Review the interface",
        model: "codex:gpt-5.6-luna"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({ permissionMode: "auto-approve", approvalsReviewer: "auto_review" })
      }),
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ permissionMode: "auto-approve", approvalsReviewer: "auto_review" })
      })
    ]));
    expect(onThreadCreated).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto-approve" }));

    runtime.emit("event", {
      payload: {
        method: "turn/completed",
        threadId: "child-1",
        turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "Done." }] }
      }
    });
    await resultPromise;
  });

  it("falls back to workspace access when no permission mode is available", async () => {
    const { bridge, runtime } = createBridge();
    const resultPromise = bridge.handleToolCall({
      threadId: "parent-1",
      tool: "spawn_thread",
      arguments: {
        prompt: "Review the interface",
        model: "codex:gpt-5.6-luna"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ permissionMode: "workspace-write", approvalsReviewer: "user" })
      })
    ]));

    runtime.emit("event", {
      payload: {
        method: "turn/completed",
        threadId: "child-1",
        turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "Done." }] }
      }
    });
    await resultPromise;
  });

  it("delivers child progress updates to the parent activity stream", async () => {
    const { bridge, database, activities } = createBridge();
    database.saveThreadLink({ childThreadId: "child-1", parentThreadId: "parent-1", model: "codex:gpt-5.6-luna" });

    const result = await bridge.handleToolCall({
      threadId: "child-1",
      tool: "send_update",
      arguments: { message: "Tests are passing; checking the final diff." }
    });

    expect(result.success).toBe(true);
    expect(activities[0]).toMatchObject({
      threadId: "parent-1",
      item: { receiverThreadIds: ["child-1"] }
    });
    expect(activities[0].item.agentsStates["child-1"].message).toContain("Tests are passing");
  });
});
