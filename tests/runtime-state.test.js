import { describe, expect, it } from "vitest";
import {
  applyRuntimePayload,
  descendantsOf,
  mergeThreadSnapshot,
  parseDiff,
  threadStatus
} from "../src/state/runtime.js";

describe("runtime state projection", () => {
  it("streams assistant deltas into the active turn", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const first = applyRuntimePayload(thread, { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "message", delta: "Hello" });
    const second = applyRuntimePayload(first, { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "message", delta: " world" });
    expect(second.turns[0].items[0]).toMatchObject({ type: "agentMessage", text: "Hello world" });
  });

  it("keeps streamed deltas when a late turn-start response has no items", () => {
    const thread = { id: "lead", turns: [] };
    const streamed = applyRuntimePayload(thread, {
      method: "item/agentMessage/delta",
      threadId: "lead",
      turnId: "turn",
      itemId: "message",
      delta: "Already live"
    });
    const started = applyRuntimePayload(streamed, {
      method: "turn/started",
      threadId: "lead",
      turn: { id: "turn", status: "inProgress", items: [] }
    });

    expect(started.turns[0].items[0]).toMatchObject({
      type: "agentMessage",
      text: "Already live"
    });
  });

  it("merges a persisted turn into the live thread without duplicating its prompt", () => {
    const live = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const persisted = {
      id: "lead",
      turns: [{
        id: "turn",
        status: "completed",
        items: [
          { id: "user-real", type: "userMessage", content: [{ type: "text", text: "Follow up" }] },
          { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" }
        ]
      }]
    };
    const merged = mergeThreadSnapshot(live, persisted);
    expect(merged.turns[0].items.filter((item) => item.type === "userMessage")).toHaveLength(1);
    expect(merged.turns[0]).toMatchObject({ status: "completed" });
  });

  it("does not let a stale refresh reopen a completed turn", () => {
    const completed = {
      id: "lead",
      turns: [{
        id: "turn",
        status: "completed",
        items: [{ id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" }]
      }]
    };
    const stale = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };

    const merged = mergeThreadSnapshot(completed, stale);
    expect(merged.turns[0]).toMatchObject({ status: "completed" });
    expect(merged.turns[0].items[0]).toMatchObject({ id: "answer", text: "Done" });
  });

  it("reconciles live and persisted IDs for the same logical turn", () => {
    const prompt = { type: "userMessage", id: "live-user", content: [{ type: "text", text: "Rundown please" }] };
    const live = {
      id: "lead",
      turns: [{
        id: "live-turn-id",
        status: "inProgress",
        items: [prompt, { id: "live-agent", type: "agentMessage", text: "I’ll inspect it.", phase: "commentary" }]
      }]
    };
    const persisted = {
      id: "lead",
      turns: [{
        id: "persisted-turn-id",
        status: "inProgress",
        items: [
          { ...prompt, id: "persisted-user" },
          { id: "persisted-agent", type: "agentMessage", text: "I’ll inspect it.", phase: "commentary" }
        ]
      }]
    };

    const merged = mergeThreadSnapshot(live, persisted);
    expect(merged.turns).toHaveLength(1);
    expect(merged.turns[0].id).toBe("persisted-turn-id");
    expect(merged.turns[0].renderId).toBe("live-turn-id");
    expect(merged.turns[0].items.filter((item) => item.type === "userMessage")).toHaveLength(1);
    expect(merged.turns[0].items.find((item) => item.type === "agentMessage").renderId).toBe("live-agent");
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
    expect(file.rows).toEqual([
      { old: null, cur: null, type: "hunk", text: "@@ -1 +1,2 @@" },
      { old: 1, cur: null, type: "del", text: "old" },
      { old: null, cur: 1, type: "add", text: "new" },
      { old: null, cur: 2, type: "add", text: "line" }
    ]);
  });

  it("surfaces approval-waiting threads as attention", () => {
    expect(threadStatus({ status: { type: "active", activeFlags: ["waitingOnApproval"] } })).toBe("attention");
  });
});
