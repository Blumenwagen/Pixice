import { describe, expect, it } from "vitest";
import { FocusQuestionGroups } from "../electron/runtime/focus-question-groups.mjs";

function questions(id = "approach", options = ["Build", "Plan"]) {
  return [{
    id,
    header: "Approach",
    question: "How should this be implemented?",
    options: options.map((label, index) => ({ label, description: `${label} description`, isOther: index === options.length - 1 && label === "Other" }))
  }];
}

describe("FocusQuestionGroups", () => {
  it("groups exact question batches only within one project and remaps question ids", () => {
    const groups = new FocusQuestionGroups();
    expect(groups.add({ key: "worker-a", generation: 1, projectId: "project-a", questions: questions("choice-a") })).toEqual({ leaderKey: "worker-a", leaderGeneration: 1, duplicate: false });
    expect(groups.add({ key: "worker-b", generation: 4, projectId: "project-a", questions: questions("choice-b") })).toEqual({ leaderKey: "worker-a", leaderGeneration: 1, duplicate: true });
    expect(groups.resolve("worker-a", 1, { "choice-a": "Build" })).toEqual([
      { key: "worker-a", generation: 1, answers: { "choice-a": "Build" } },
      { key: "worker-b", generation: 4, answers: { "choice-b": "Build" } }
    ]);
  });

  it("does not group questions from another project or with different options", () => {
    const groups = new FocusQuestionGroups();
    groups.add({ key: "worker-a", generation: 1, projectId: "project-a", questions: questions() });
    expect(groups.add({ key: "worker-b", generation: 1, projectId: "project-b", questions: questions("other-id") }).duplicate).toBe(false);
    expect(groups.add({ key: "worker-c", generation: 1, projectId: "project-a", questions: questions("different", ["Build", "Skip"]) }).duplicate).toBe(false);
  });

  it("promotes the next worker when the leader disconnects", () => {
    const groups = new FocusQuestionGroups();
    groups.add({ key: "worker-a", generation: 1, projectId: "project-a", questions: questions("a") });
    groups.add({ key: "worker-b", generation: 2, projectId: "project-a", questions: questions("b") });
    expect(groups.remove("worker-a", 1)).toEqual({ leaderKey: "worker-b", leaderGeneration: 2, promoted: true });
    expect(groups.members("worker-b")).toEqual([{ key: "worker-b", generation: 2 }]);
    expect(groups.resolve("worker-a", 1, { a: "Build" })).toEqual([]);
    expect(groups.resolve("worker-b", 2, { b: "Build" })).toEqual([{ key: "worker-b", generation: 2, answers: { b: "Build" } }]);
  });

  it("does not join, resolve, or remove through a stale generation", () => {
    const groups = new FocusQuestionGroups();
    groups.add({ key: "worker-a", generation: 2, projectId: "project-a", questions: questions("a") });
    expect(groups.add({ key: "worker-a", generation: 1, projectId: "project-a", questions: questions("a") })).toEqual({ leaderKey: "worker-a", leaderGeneration: 1, duplicate: false });
    expect(groups.members("worker-a", 1)).toEqual([]);
    expect(groups.resolve("worker-a", 1, { a: "Build" })).toEqual([]);
    expect(groups.remove("worker-a", 1)).toBeNull();
    expect(groups.members("worker-a", 2)).toEqual([{ key: "worker-a", generation: 2 }]);
  });
});
