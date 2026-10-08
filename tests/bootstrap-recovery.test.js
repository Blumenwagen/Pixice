import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverWorkspaceBootstrap } from "../src/state/bootstrap-recovery.js";

afterEach(() => vi.useRealTimers());

describe("workspace bootstrap recovery", () => {
  it("recovers a temporary startup failure without a connection event", async () => {
    vi.useFakeTimers();
    const snapshot = { projects: [{ id: "saved-project" }] };
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Offline"), { code: "OFFLINE" })).mockResolvedValue(snapshot);
    const onRetry = vi.fn();
    const recovered = recoverWorkspaceBootstrap(read, { onRetry });
    await vi.advanceTimersByTimeAsync(500);
    expect(await recovered).toBe(snapshot);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying a persistent connection failure", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("Connection lost"), { code: "NETWORK_ERROR" });
    const read = vi.fn().mockRejectedValue(error);
    const recovered = recoverWorkspaceBootstrap(read);
    const rejected = expect(recovered).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(read).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    Object.assign(new Error("Sign in again"), { code: "AUTH_REQUIRED", status: 401 }),
    Object.assign(new Error("Access denied"), { code: "FORBIDDEN", status: 403 }),
    Object.assign(new Error("Invalid response"), { code: "INVALID_RESPONSE" }),
    new Error("Saved data could not be decoded")
  ])("leaves a permanent failure available for explicit recovery: %s", async error => {
    const read = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();
    await expect(recoverWorkspaceBootstrap(read, { onRetry })).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("cancels scheduled reads when the workspace changes or unmounts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new Error("The instance is offline"));
    const recovered = recoverWorkspaceBootstrap(read, { signal: controller.signal });
    const rejected = expect(recovered).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled read and ignores its late result", async () => {
    vi.useFakeTimers();
    let complete;
    const read = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const recovered = recoverWorkspaceBootstrap(read, { retryDelays: [], timeoutMs: 100 });
    const rejected = expect(recovered).rejects.toMatchObject({ code: "BOOTSTRAP_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    complete({ projects: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
