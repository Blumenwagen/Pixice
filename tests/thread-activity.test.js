import { describe, expect, it } from "vitest";
import { reconcileThreadActivity, withStableCompletionRevision } from "../electron/runtime/thread-activity.mjs";

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

  it("restores the same completion identity on compact thread lists", () => {
    const thread = { id: "thread-1", status: { type: "idle" }, updatedAt: "2026-08-25T14:00:00.000Z" };
    const timings = [
      { threadId: thread.id, turnId: "turn-1", completedAt: "2026-08-25T12:00:00.000Z" },
      { threadId: thread.id, turnId: "turn-2", completedAt: "2026-08-25T14:00:00.000Z" }
    ];

    expect(withStableCompletionRevision(thread, timings)).toEqual({
      ...thread,
      completionRevision: "turn:turn-2"
    });
  });

  it("does not replace a completion identity supplied by the provider", () => {
    const thread = { id: "thread-1", completionRevision: "provider:revision-4" };
    expect(withStableCompletionRevision(thread, [{ turnId: "turn-2", completedAt: "2026-08-25T14:00:00.000Z" }])).toBe(thread);
  });
});
