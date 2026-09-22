import { describe, expect, it, vi } from "vitest";
import { PixiceFocusMemory } from "../electron/runtime/pixice-focus.mjs";

function memoryFixture() {
  let memory = { projectId: "project-1", projectMemory: "Initial decision", userMemory: "", revision: 1, updatedAt: "2026-09-22T10:00:00.000Z" };
  const database = {
    getProjectFocusMemory: () => ({ ...memory }),
    getProjectFocusSession: () => ({ projectId: "project-1", threadId: "focus-1", userTurnCount: 10, lastMemoryReviewTurn: 0 }),
    replaceProjectFocusMemory: (_projectId, next, expectedRevision) => {
      if (expectedRevision !== null && expectedRevision !== memory.revision) throw new Error("Focus memory changed. Read it again before editing.");
      memory = { ...memory, ...next, revision: memory.revision + 1, updatedAt: "2026-09-22T10:01:00.000Z" };
      return { ...memory };
    },
    markProjectFocusMemoryReviewed: vi.fn()
  };
  return { database, memory: new PixiceFocusMemory({ database }) };
}

describe("Pixice Focus memory", () => {
  it("protects a curated edit from a stale background maintenance write", () => {
    const fixture = memoryFixture();
    fixture.memory.replaceCurated("project-1", { projectMemory: "New curated decision", userMemory: "" }, 1);

    expect(() => fixture.memory.replaceFromMaintenance(
      "project-1",
      { projectMemory: "Stale generated summary", userMemory: "" },
      10,
      1
    )).toThrow("Focus memory changed");
    expect(fixture.memory.read("project-1").projectMemory).toBe("New curated decision");
    expect(fixture.database.markProjectFocusMemoryReviewed).not.toHaveBeenCalled();
  });

  it("rejects stale manual revisions while leaving the latest memory inspectable", () => {
    const fixture = memoryFixture();
    const saved = fixture.memory.replaceCurated("project-1", { projectMemory: "Current", userMemory: "Prefers concise updates" }, 1);
    expect(saved).toMatchObject({ revision: 2, projectMemory: "Current", userMemory: "Prefers concise updates" });
    expect(() => fixture.memory.replaceCurated("project-1", { projectMemory: "Stale", userMemory: "" }, 1)).toThrow("Focus memory changed");
    expect(fixture.memory.read("project-1")).toMatchObject({ revision: 2, projectMemory: "Current" });
  });
});
