import { describe, expect, it } from "vitest";
import { applyRuntimePayload, descendantsOf, parseDiff, threadStatus } from "../src/state/runtime.js";

describe("runtime state projection", () => {
  it("streams assistant deltas into the active turn", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const first = applyRuntimePayload(thread, { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "message", delta: "Hello" });
    const second = applyRuntimePayload(first, { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "message", delta: " world" });
    expect(second.turns[0].items[0]).toMatchObject({ type: "agentMessage", text: "Hello world" });
  });

  it("finds nested delegated agents without looping on malformed ancestry", () => {
    const threads = [
      { id: "lead", parentThreadId: null },
      { id: "api", parentThreadId: "lead" },
      { id: "tests", parentThreadId: "api" },
      { id: "other", parentThreadId: null }
    ];
    expect(descendantsOf(threads, "lead").map((thread) => thread.id)).toEqual(["api", "tests"]);
  });

  it("parses changed files and line totals from a unified diff", () => {
    const [file] = parseDiff("diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+line");
    expect(file).toMatchObject({ path: "src/a.js", plus: 2, minus: 1 });
  });

  it("surfaces approval-waiting threads as attention", () => {
    expect(threadStatus({ status: { type: "active", activeFlags: ["waitingOnApproval"] } })).toBe("attention");
  });
});
