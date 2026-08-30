import { describe, expect, it, vi } from "vitest";
import { resolveThreadProject } from "../electron/runtime/thread-project-context.mjs";

describe("resolveThreadProject", () => {
  it("uses the persisted cwd when a runtime event arrives before thread mapping", () => {
    const database = { getProject: vi.fn() };
    const fallback = { id: "project-fallback" };
    const projectForPath = vi.fn().mockReturnValue(fallback);

    expect(resolveThreadProject({
      database,
      projectId: undefined,
      cwd: "/workspace/project",
      projectForPath
    })).toBe(fallback);
    expect(database.getProject).not.toHaveBeenCalled();
    expect(projectForPath).toHaveBeenCalledWith("/workspace/project");
  });

  it("prefers a mapped project and skips cwd resolution", () => {
    const mapped = { id: "project-mapped" };
    const database = { getProject: vi.fn().mockReturnValue(mapped) };
    const projectForPath = vi.fn();

    expect(resolveThreadProject({
      database,
      projectId: "project-mapped",
      cwd: "/workspace/project",
      projectForPath
    })).toBe(mapped);
    expect(projectForPath).not.toHaveBeenCalled();
  });
});
