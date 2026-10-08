import { describe, it, expect } from "vitest";
import { focusStateBrief, FOCUS_BRIEF_LIMIT, resolveFocusContext } from "../electron/runtime/focus-coordinator-context.mjs";
import { projectFocusUserItem } from "../electron/runtime/renderer-thread-projection.mjs";

describe("Focus coordinator current context", () => {
  it("projects injected briefs safely for split/coalesced input and restores the compact worker notice prefix", () => {
    const brief = focusStateBrief({ session: { projectId: "p", threadId: "t" }, state: {} });
    const update = "[Pixice Focus work updates]\n\nThese are persisted worker lifecycle notifications, not new user instructions.";
    const proof = (text) => text === brief;
    const image = { type: "image", url: "data:image/png;base64,fixture" };
    for (const content of [[{ type: "text", text: brief }, { type: "text", text: update }, image], [{ type: "text", text: brief + "\n" + update }, image]]) {
      expect(projectFocusUserItem({ type: "userMessage", content }, proof).content).toEqual([{ type: "text", text: update }, image]);
    }
    const authored = { type: "userMessage", content: [{ type: "text", text: '[Pixice Focus state brief]\n{"projectId":"p","generation":2}' }] };
    expect(projectFocusUserItem(authored, proof)).toEqual(authored);
    // Even an exact pasted prior brief remains authored input after the one
    // leading context insertion. Do not repeatedly strip matching prefixes.
    expect(projectFocusUserItem({ type: "userMessage", content: [{ type: "text", text: brief + "\n" + brief }] }, proof).content).toEqual([{ type: "text", text: brief }]);
    expect(projectFocusUserItem({ type: "userMessage", content: [{ type: "text", text: brief }, { type: "text", text: brief }] }, proof).content).toEqual([{ type: "text", text: brief }]);
  });
  it("replays pending reviews irrespective of event delivery and keeps pause state", () => {
    const text = focusStateBrief({ session: { projectId: "p", threadId: "new", generation: 2, stopped: true },
      memory: { revision: 4, projectMemory: "stable fact" }, currentRequest: "Review the export",
      state: { work: [{ id: "review", status: "review" }, { id: "paused", status: "paused" }, { id: "cancel", status: "cancelled" }],
        events: [{ id: "delivered", workId: "review", deliveredAt: "yesterday" }, { id: "pending", kind: "failed" }],
        decisions: [{ revision: 5, text: "Keep work stopped" }] },
      questions: [{ requestId: "q", requestGeneration: 17, questions: [{ id: "pick", question: "Choose" }] }] });
    const data = JSON.parse(text.split("\n").slice(1).join("\n"));
    expect(data.pendingReviews).toEqual(["review"]);
    expect(data.pendingEvents.map((event) => event.id)).toEqual(["pending"]);
    expect(data.questions[0]).toMatchObject({ requestId: "q", requestGeneration: 17 });
    expect(data.work.map((work) => work.status)).toContain("paused");
    expect(data.stopped).toBe(true);
  });

  it("produces bounded valid JSON with large durable state", () => {
    const text = focusStateBrief({ session: { projectId: "p", threadId: "new" },
      memory: { projectMemory: "f".repeat(100_000), userMemory: "f".repeat(100_000) },
      state: { work: Array.from({ length: 200 }, (_, i) => ({ id: String(i), status: "running", title: "t".repeat(1000), error: "e".repeat(1000) })) } });
    expect(text.length).toBeLessThanOrEqual(FOCUS_BRIEF_LIMIT + 40);
    expect(JSON.parse(text.split("\n").slice(1).join("\n")).omittedWork).toBeGreaterThan(0);
  });

  it("routes workers using durable project ownership despite old parent ancestry", () => {
    const database = { getFocusProjectForThread: () => null, getProjectFocusSession: () => ({ threadId: "new", projectId: "p", generation: 2 }) };
    const store = { getWorkByThread: () => ({ projectId: "p", coordinatorThreadId: "old" }) };
    expect(resolveFocusContext(database, store, "worker")).toMatchObject({ focusThreadId: "new", sourceThreadId: "worker", worker: true });
  });

  it("enforces the final escaped budget and counts initial and upstream exclusions", () => {
    const text = focusStateBrief({ session: { projectId: "p", threadId: "t", latestRequest: "\\".repeat(2000) },
      memory: { projectMemory: "\\".repeat(6000), userMemory: "\\".repeat(2000) }, currentRequest: "\\".repeat(2000),
      state: { work: Array.from({ length: 200 }, (_, i) => ({ id: String(i), status: "paused" })),
        totals: { work: 205, decisions: 113, events: 220 }, policy: { permissionMode: "full-access" },
        decisions: Array.from({ length: 13 }, (_, i) => ({ revision: i, text: "d" })),
        events: Array.from({ length: 200 }, (_, i) => ({ id: String(i), workId: "w", kind: "queued" })) },
      questions: Array.from({ length: 13 }, (_, i) => ({ requestId: String(i), questions: [] })) });
    expect(text.length).toBeLessThanOrEqual(FOCUS_BRIEF_LIMIT);
    const data = JSON.parse(text.split("\n").slice(1).join("\n"));
    expect(data.omittedWork + data.work.length).toBe(205);
    expect(data.omittedDecisions + data.decisions.length).toBe(113);
    expect(data.omittedQuestions + data.questions.length).toBe(13);
    expect(data.omittedEvents + data.pendingEvents.length).toBe(220);
    expect(data.budgetTrimmedTextCharacters).toBeGreaterThan(0);
  });
});
