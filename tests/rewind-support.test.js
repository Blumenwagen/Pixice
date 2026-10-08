// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createRewindSupportProbe } from "../electron/runtime/thread-history.mjs";

describe("released T3 rewind metadata compatibility", () => {
  it("uses explicit native metadata without probing and excludes unsupported providers or unloaded history", async () => {
    const readThread = vi.fn();
    const supports = createRewindSupportProbe({ readThread, providerForThread: () => "codex" });
    expect(await supports({ id: "legacy", historyMode: "legacy", status: { type: "idle" } })).toBe(false);
    expect(await supports({ id: "modern", historyMode: "paginated", status: { type: "idle" } })).toBe(true);
    expect(await supports({ id: "unloaded", historyMode: "paginated", status: { type: "notLoaded" } })).toBe(false);
    expect(await supports({ id: "claude", provider: "claude" })).toBe(false);
    expect(readThread).not.toHaveBeenCalled();
  });

  it("probes raw metadata when include-turns omitted historyMode and caches concurrent requests per generation", async () => {
    let providerGeneration = 1;
    const readThread = vi.fn(async (id) => ({ thread: { id, historyMode: "legacy", status: { type: "idle" } } }));
    const supports = createRewindSupportProbe({ readThread, providerForThread: () => "codex", generation: () => providerGeneration });
    const snapshot = { id: "thread", status: { type: "idle" } };
    expect(await Promise.all([supports(snapshot), supports(snapshot)])).toEqual([false, false]);
    expect(readThread).toHaveBeenCalledExactlyOnceWith("thread", { includeTurns: false });
    expect(await supports(snapshot)).toBe(false);
    expect(readThread).toHaveBeenCalledTimes(1);
    providerGeneration = 2;
    readThread.mockResolvedValue({ thread: { historyMode: "paginated", status: { type: "idle" } } });
    expect(await supports(snapshot)).toBe(true);
    expect(readThread).toHaveBeenCalledTimes(2);
  });

  it("keeps older successful RPCs compatible but treats unavailable metadata as unsupported", async () => {
    const readThread = vi.fn(async (id) => {
      if (id === "offline") throw new Error("Provider unavailable");
      return { thread: { id, status: { type: id === "unloaded" ? "notLoaded" : "idle" } } };
    });
    const supports = createRewindSupportProbe({ readThread, providerForThread: () => "codex" });
    expect(await supports({ id: "older" })).toBe(true);
    expect(await supports({ id: "unloaded" })).toBe(false);
    expect(await supports({ id: "offline" })).toBe(false);
    supports.clear();
    expect(await supports({ id: "older" })).toBe(true);
    expect(readThread).toHaveBeenCalledTimes(4);
  });

  it("bounds cached probes to 512 threads and reprobes an evicted entry", async () => {
    const readThread = vi.fn(async (id) => ({ thread: { id, status: { type: "idle" } } }));
    const supports = createRewindSupportProbe({ readThread, providerForThread: () => "codex" });
    for (let index = 0; index < 513; index++) await supports({ id: `thread-${index}` });
    expect(readThread).toHaveBeenCalledTimes(513);
    await supports({ id: "thread-512" });
    expect(readThread).toHaveBeenCalledTimes(513);
    await supports({ id: "thread-0" });
    expect(readThread).toHaveBeenCalledTimes(514);
  });
});
