import { describe, expect, it, vi } from "vitest";
import { ThreadSessionRegistry } from "../electron/runtime/thread-session-registry.mjs";

describe("ThreadSessionRegistry", () => {
  it("resumes a persisted thread even after its metadata was read", async () => {
    const registry = new ThreadSessionRegistry();
    const resume = vi.fn().mockResolvedValue("/project");

    registry.remember("thread-1", "/project");

    await expect(registry.ensure("thread-1", resume)).resolves.toBe("/project");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not resume a thread that started in the current runtime session", async () => {
    const registry = new ThreadSessionRegistry();
    const resume = vi.fn().mockResolvedValue("/project");

    registry.remember("thread-1", "/project", { loaded: true });

    await expect(registry.ensure("thread-1", resume)).resolves.toBe("/project");
    expect(resume).not.toHaveBeenCalled();
  });

  it("coalesces concurrent resume requests", async () => {
    const registry = new ThreadSessionRegistry();
    const resume = vi.fn().mockResolvedValue("/project");

    await Promise.all([
      registry.ensure("thread-1", resume),
      registry.ensure("thread-1", resume)
    ]);

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not mark an in-flight resume as loaded after its provider session is invalidated", async () => {
    const registry = new ThreadSessionRegistry();
    let finishResume;
    const firstResume = registry.ensure("thread-1", () => new Promise((resolve) => { finishResume = resolve; }));
    await Promise.resolve();

    registry.delete("thread-1");
    finishResume("/project");

    await expect(firstResume).rejects.toThrow("provider restarted");
    const secondResume = vi.fn().mockResolvedValue("/project");
    await expect(registry.ensure("thread-1", secondResume)).resolves.toBe("/project");
    expect(secondResume).toHaveBeenCalledOnce();
  });

  it("invalidates a first in-flight resume when every provider session is cleared", async () => {
    const registry = new ThreadSessionRegistry();
    let finishResume;
    const firstResume = registry.ensure("thread-new", () => new Promise((resolve) => { finishResume = resolve; }));
    await Promise.resolve();

    registry.clear();
    finishResume("/project");

    await expect(firstResume).rejects.toThrow("provider restarted");
    const secondResume = vi.fn().mockResolvedValue("/project");
    await registry.ensure("thread-new", secondResume);
    expect(secondResume).toHaveBeenCalledOnce();
  });
});
