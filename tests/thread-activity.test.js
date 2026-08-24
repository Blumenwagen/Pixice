import { describe, expect, it } from "vitest";
import { reconcileThreadActivity } from "../electron/runtime/thread-activity.mjs";

describe("thread activity reconciliation", () => {
  it.each([
    { type: "active", activeFlags: [] },
    { type: "active", activeFlags: ["waitingOnApproval"] },
    "running",
    "inProgress"
  ])("marks stale persisted activity as idle after restart", (status) => {
    const thread = { id: "thread-1", status };

    expect(reconcileThreadActivity(thread)).toEqual({
      id: "thread-1",
      status: { type: "idle", activeFlags: [] }
    });
  });

  it("preserves active status when this runtime owns the turn", () => {
    const thread = { id: "thread-1", status: { type: "active", activeFlags: [] } };

    expect(reconcileThreadActivity(thread, "turn-1")).toBe(thread);
  });

  it("leaves settled and unloaded statuses unchanged", () => {
    for (const status of [{ type: "idle" }, { type: "notLoaded" }, "completed", "failed"]) {
      const thread = { id: "thread-1", status };
      expect(reconcileThreadActivity(thread)).toBe(thread);
    }
  });
});
