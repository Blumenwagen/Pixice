import { describe, expect, it } from "vitest";
import {
  appendLocalUserMessage,
  applyRuntimePayload,
  coalesceRuntimeDeltas,
  descendantsOf,
  mergeThreadSnapshot,
  parseDiff,
  removeLocalUserMessage,
  reviewFiles,
  stripPreviewContext,
  threadStatus,
  turnIsCompacting
} from "../src/state/runtime.js";

describe("runtime state projection", () => {
  it("coalesces streamed text by item while preserving item order", () => {
    expect(coalesceRuntimeDeltas([
      { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "a", delta: "one" },
      { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "b", delta: "other" },
      { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "a", delta: " two", receivedAt: "later" }
    ])).toEqual([
      { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "a", delta: "one two", receivedAt: "later" },
      { method: "item/agentMessage/delta", threadId: "lead", turnId: "turn", itemId: "b", delta: "other" }
    ]);
  });

  it("hides Preview hints and reconciles them with the visible local prompt", () => {
    const tagged = "look at this\n\n<pixice-preview-context>Pixice Preview is open with a browser tab selected.</pixice-preview-context>";
    expect(stripPreviewContext(tagged)).toBe("look at this");

    const local = appendLocalUserMessage({ id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] }, {
      turnId: "turn",
      text: "look at this"
    });
    const persisted = applyRuntimePayload(local, {
      method: "item/completed",
      threadId: "lead",
      turnId: "turn",
      item: { id: "persisted-user", type: "userMessage", content: [{ type: "text", text: tagged }] }
    });

    expect(persisted.turns[0].items).toHaveLength(1);
  });

  it("keeps a local prompt visible and reconciles its persisted event in place", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const optimistic = appendLocalUserMessage(thread, {
      turnId: "turn",
      text: "Keep this prompt visible",
      createdAt: "2026-08-26T18:00:00.000Z"
    });

    expect(optimistic.turns[0].items).toHaveLength(1);
    expect(optimistic.turns[0].items[0]).toMatchObject({
      id: expect.stringMatching(/^local-user:/),
      type: "userMessage",
      content: [{ type: "text", text: "Keep this prompt visible" }]
    });

    const persisted = applyRuntimePayload(optimistic, {
      method: "item/completed",
      threadId: "lead",
      turnId: "turn",
      item: { id: "persisted-user", type: "userMessage", content: [{ type: "text", text: "Keep this prompt visible" }] }
    });

    expect(persisted.turns[0].items).toHaveLength(1);
    expect(persisted.turns[0].items[0]).toMatchObject({ id: "persisted-user", renderId: expect.stringMatching(/^local-user:/) });
  });

  it("removes a failed local prompt and its temporary turn", () => {
    const optimistic = appendLocalUserMessage({ id: "lead", turns: [] }, {
      turnId: "local-turn:one",
      text: "This request failed",
      messageId: "local-user:one"
    });
    const rolledBack = removeLocalUserMessage(optimistic, {
      turnId: "local-turn:one",
      messageId: "local-user:one",
      removeEmptyTurn: true
    });

    expect(rolledBack.turns).toEqual([]);
  });

  it("keeps a pending steering prompt when a refresh only contains older user messages", () => {
    const current = appendLocalUserMessage({
      id: "lead",
      turns: [{
        id: "turn",
        status: "inProgress",
        items: [{ id: "older-user", type: "userMessage", content: [{ type: "text", text: "Start the run" }] }]
      }]
    }, {
      turnId: "turn",
      text: "Keep the steering prompt",
      messageId: "local-user:steer"
    });
    const refreshed = mergeThreadSnapshot(current, {
      id: "lead",
      turns: [{
        id: "turn",
        status: "inProgress",
        items: [{ id: "older-user", type: "userMessage", content: [{ type: "text", text: "Start the run" }] }]
      }]
    });

    expect(refreshed.turns[0].items).toHaveLength(2);
    expect(refreshed.turns[0].items[1]).toMatchObject({ id: "local-user:steer" });
  });

  it("keeps repeated prompts as separate user messages", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const first = appendLocalUserMessage(thread, {
      turnId: "turn",
      text: "Run that again",
      messageId: "local-user:first"
    });
    const second = appendLocalUserMessage(first, {
      turnId: "turn",
      text: "Run that again",
      messageId: "local-user:second"
    });

    expect(second.turns[0].items.map((item) => item.id)).toEqual(["local-user:first", "local-user:second"]);
  });

  it("records turn boundaries and stamps the prompt and final answer", () => {
    const thread = { id: "lead", turns: [] };
    const started = applyRuntimePayload(thread, {
      method: "turn/started",
      threadId: "lead",
      receivedAt: "2026-08-24T09:00:00.000Z",
      turn: { id: "turn", status: "inProgress", items: [{ id: "prompt", type: "userMessage", content: [{ type: "text", text: "Time this" }] }] }
    });
    const completed = applyRuntimePayload(started, {
      method: "turn/completed",
      threadId: "lead",
      receivedAt: "2026-08-24T10:48:00.000Z",
      turn: { id: "turn", status: "completed", items: [
        { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Time this" }] },
        { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" }
      ] }
    });

    expect(completed.turns[0]).toMatchObject({
      startedAt: "2026-08-24T09:00:00.000Z",
      completedAt: "2026-08-24T10:48:00.000Z"
    });
    expect(completed.turns[0].items[0].createdAt).toBe("2026-08-24T09:00:00.000Z");
    expect(completed.turns[0].items[1].createdAt).toBe("2026-08-24T10:48:00.000Z");
  });

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

  it("projects image generation from its live preview into the completed result", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const started = applyRuntimePayload(thread, {
      method: "item/started",
      threadId: "lead",
      turnId: "turn",
      item: { id: "image", type: "imageGeneration", status: "inProgress", result: "", revisedPrompt: null, savedPath: null, failure: null }
    });
    const completed = applyRuntimePayload(started, {
      method: "item/completed",
      threadId: "lead",
      turnId: "turn",
      item: { id: "image", type: "imageGeneration", status: "completed", result: "data:image/png;base64,AA==", revisedPrompt: "A finished image", savedPath: "/tmp/image.png", failure: null }
    });

    expect(started.turns[0].items[0]).toMatchObject({ type: "imageGeneration", status: "inProgress" });
    expect(completed.turns[0].items[0]).toMatchObject({
      type: "imageGeneration",
      status: "completed",
      result: "data:image/png;base64,AA==",
      revisedPrompt: "A finished image"
    });
  });

  it("tracks context compaction across its item lifecycle", () => {
    const thread = { id: "lead", turns: [{ id: "turn", status: "inProgress", items: [] }] };
    const started = applyRuntimePayload(thread, {
      method: "item/started",
      threadId: "lead",
      turnId: "turn",
      receivedAt: "2026-08-26T09:00:00.000Z",
      item: { id: "compact", type: "contextCompaction" }
    });
    const completed = applyRuntimePayload(started, {
      method: "item/completed",
      threadId: "lead",
      turnId: "turn",
      receivedAt: "2026-08-26T09:00:04.000Z",
      item: { id: "compact", type: "contextCompaction" }
    });

    expect(turnIsCompacting(started.turns[0])).toBe(true);
    expect(turnIsCompacting(completed.turns[0])).toBe(false);
    expect(completed.turns[0].items[0]).toMatchObject({
      startedAt: "2026-08-26T09:00:00.000Z",
      completedAt: "2026-08-26T09:00:04.000Z"
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

  it("reuses an unchanged thread snapshot and its derived row identities", () => {
    const current = {
      id: "lead",
      name: "Stable thread",
      updatedAt: "2026-08-27T12:00:00.000Z",
      status: { type: "idle" },
      turns: [{
        id: "turn",
        status: "completed",
        completedAt: "2026-08-27T12:00:00.000Z",
        items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Done" }]
      }]
    };
    const incoming = JSON.parse(JSON.stringify(current));

    const merged = mergeThreadSnapshot(current, incoming);

    expect(merged).toBe(current);
    expect(merged.turns[0]).toBe(current.turns[0]);
    expect(merged.turns[0].items[0]).toBe(current.turns[0].items[0]);

    const changed = JSON.parse(JSON.stringify(current));
    changed.turns[0].items[0].text = "Nope";
    const changedMerge = mergeThreadSnapshot(current, changed);
    expect(changedMerge).not.toBe(current);
    expect(changedMerge.turns[0].items[0].text).toBe("Nope");
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

  it("keeps changed paths that do not have a textual diff", () => {
    expect(reviewFiles("", ["blog/"])).toEqual([
      { path: "blog/", plus: 0, minus: 0, lines: [], rows: [] }
    ]);

    const files = reviewFiles(
      "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new",
      ["src/a.js", "assets/logo.png"]
    );
    expect(files.map((file) => file.path)).toEqual(["src/a.js", "assets/logo.png"]);
  });

  it("surfaces approval-waiting threads as attention", () => {
    expect(threadStatus({ status: { type: "active", activeFlags: ["waitingOnApproval"] } })).toBe("attention");
  });
});
