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
});
