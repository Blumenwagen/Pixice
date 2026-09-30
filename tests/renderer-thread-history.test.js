import { describe, expect, it, vi } from "vitest";
import { readRendererThread } from "../electron/runtime/renderer-thread-history.mjs";
import { mergeThreadSnapshot, prependThreadHistory } from "../src/state/runtime.js";

describe("paged renderer history", () => {
  it("shares a bounded Codex read, projects output and releases completed snapshots", async () => {
    const runtime = { providerForThread: () => "codex", request: vi.fn(async (method) => method === "thread/read"
      ? { thread: { id: "focus", cwd: "/project", turns: [] } }
      : { data: [{ id: "new", items: [{ type: "commandExecution", aggregatedOutput: "x".repeat(100_000) }] }, { id: "old", items: [] }], nextCursor: "earlier" }) };
    const [first, second] = await Promise.all([readRendererThread(runtime, "focus"), readRendererThread(runtime, "focus")]);
    expect(first).toBe(second);
    expect(runtime.request).toHaveBeenCalledTimes(2);
    expect(runtime.request).toHaveBeenCalledWith("thread/read", { threadId: "focus", includeTurns: false });
    expect(runtime.request).toHaveBeenCalledWith("thread/turns/list", { threadId: "focus", cursor: null, limit: 12, sortDirection: "desc", itemsView: "full" });
    expect(first.thread.turns.map((turn) => turn.id)).toEqual(["old", "new"]);
    expect(first.thread.turns[1].items[0].aggregatedOutput.length).toBeLessThan(8300);
    await readRendererThread(runtime, "focus", { cursor: "earlier" });
    expect(runtime.request).toHaveBeenCalledTimes(4);
  });

  it("does not fall back to full history after a disconnected or timed-out read", async () => {
    const runtime = { providerForThread: () => "codex", request: vi.fn().mockRejectedValue(new Error("Timed out waiting for thread/read")) };
    await expect(readRendererThread(runtime, "focus")).rejects.toThrow("Timed out");
    expect(runtime.request).toHaveBeenCalledTimes(1);
  });

  it("retains compatibility with a CLI without pagination", async () => {
    const runtime = { providerForThread: () => "codex", request: vi.fn(async (method, params) => {
      if (method === "thread/turns/list") throw new Error("Method not found");
      return { thread: { id: "focus", turns: params.includeTurns ? [{ id: "old", items: [] }] : [] } };
    }) };
    expect((await readRendererThread(runtime, "focus")).thread.turns).toHaveLength(1);
  });

  it("keeps earlier loaded messages and their cursor when the latest page refreshes", () => {
    const turn = (id) => ({ id, status: "completed", items: [] });
    const current = { id: "focus", turns: [turn("1"), turn("2"), turn("3")], history: { paginated: true, nextCursor: "before-1" } };
    const refreshed = mergeThreadSnapshot(current, { id: "focus", turns: [turn("3"), turn("4")], history: { paginated: true, nextCursor: "before-3" } });
    expect(refreshed.turns.map((entry) => entry.id)).toEqual(["1", "2", "3", "4"]);
    expect(refreshed.history.nextCursor).toBe("before-1");
    const expanded = prependThreadHistory(refreshed, { id: "focus", turns: [turn("0"), turn("1")], history: { paginated: true, nextCursor: null } });
    expect(expanded.turns.map((entry) => entry.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(expanded.history.nextCursor).toBeNull();
  });
});
