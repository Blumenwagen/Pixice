import { describe, expect, it } from "vitest";
import { reconstructHierarchy } from "../src/state/hierarchy.js";
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
    expect(normalizeCodexEvent({ method: "item/approval/requested", params: { requestId: "a" } }).type).toBe("AttentionRequired");
    expect(normalizeCodexEvent({ method: "item/updated", params: { item: { type: "collabToolCall" } } }).type).toBe("AgentUpdated");
  });
});
