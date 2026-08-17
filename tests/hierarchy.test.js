import { describe, expect, it } from "vitest";
import { reconstructHierarchy } from "../src/state/hierarchy.js";
import { projectCollabAgents } from "../src/state/runtime.js";
import { normalizeCodexEvent } from "../electron/runtime/capability-adapter.mjs";

describe("agent hierarchy projection", () => {
  it("rebuilds descendants from thread ancestry", () => {
    const [root] = reconstructHierarchy([
      { id: "lead", createdAt: "1" },
      { id: "tests", parentThreadId: "lead", createdAt: "3" },
      { id: "api", parentThreadId: "lead", createdAt: "2" },
      { id: "integration", parentThreadId: "tests", createdAt: "4" }
    ]);
    expect(root.children.map((node) => node.id)).toEqual(["api", "tests"]);
    expect(root.children[1].children[0].id).toBe("integration");
  });

  it("normalizes approvals and collaboration events", () => {
    expect(normalizeCodexEvent({ method: "item/approval/requested", params: { requestId: "a" } }).type).toBe("ActivityReceived");
    expect(normalizeCodexEvent({ method: "item/updated", params: { item: { type: "collabAgentToolCall" } } }).type).toBe("AgentUpdated");
  });

  it("projects live receiver threads before the descendant list refreshes", () => {
    const threads = projectCollabAgents([{ id: "lead", parentThreadId: null }], {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "lead",
      receiverThreadIds: ["child"],
      prompt: "Audit the runtime",
      agentsStates: { child: { status: "running", message: null } }
    });
    expect(threads[1]).toMatchObject({ id: "child", parentThreadId: "lead", preview: "Audit the runtime", status: "running" });

    const completed = projectCollabAgents(threads, {
      type: "collabAgentToolCall",
      tool: "wait",
      senderThreadId: "lead",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "completed", message: "Audit complete" } }
    });
    expect(completed[1]).toMatchObject({ status: "completed", agentStatusMessage: "Audit complete" });
  });
});
