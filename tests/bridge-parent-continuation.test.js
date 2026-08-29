import { describe, expect, it, vi } from "vitest";
import { BridgeParentContinuation, bridgeContinuationPrompt } from "../electron/runtime/bridge-parent-continuation.mjs";

const completion = {
  parentThreadId: "parent-1",
  parentTurnId: "parent-turn-1",
  childThreadId: "child-1",
  status: "completed",
  answer: "The focused tests pass."
};

function createCoordinator(active = null) {
  let activeTurn = active;
  const startTurn = vi.fn(async () => {
    activeTurn = "continuation-turn";
    return { id: activeTurn };
  });
  const steerTurn = vi.fn(async () => ({}));
  const onError = vi.fn();
  const coordinator = new BridgeParentContinuation({
    activeTurnId: () => activeTurn,
    startTurn,
    steerTurn,
    onError
  });
  return { coordinator, startTurn, steerTurn, onError };
}

describe("bridge parent continuation", () => {
  it("starts a continuation turn when the parent is idle", async () => {
    const { coordinator, startTurn, steerTurn } = createCoordinator();

    await expect(coordinator.notify(completion)).resolves.toMatchObject({ action: "started", turnId: "continuation-turn" });
    expect(startTurn).toHaveBeenCalledWith("parent-1", [expect.objectContaining({
      type: "text",
      text: expect.stringContaining("The focused tests pass.")
    })]);
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("leaves a completion on the original active turn", async () => {
    const { coordinator, startTurn, steerTurn } = createCoordinator("parent-turn-1");

    await expect(coordinator.notify(completion)).resolves.toEqual({ action: "same-turn", turnId: "parent-turn-1" });
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("assumes an unlabelled active turn owns the pending tool call", async () => {
    const { coordinator, startTurn, steerTurn } = createCoordinator("parent-turn-1");

    await expect(coordinator.notify({ ...completion, parentTurnId: null })).resolves.toEqual({
      action: "same-turn",
      turnId: "parent-turn-1"
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("steers a late completion into a newer active turn", async () => {
    const { coordinator, startTurn, steerTurn } = createCoordinator("parent-turn-2");

    await expect(coordinator.notify(completion)).resolves.toEqual({ action: "steered", turnId: "parent-turn-2" });
    expect(steerTurn).toHaveBeenCalledWith("parent-1", "parent-turn-2", [expect.objectContaining({ type: "text" })]);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("deduplicates repeated completion delivery", async () => {
    const { coordinator, startTurn } = createCoordinator();

    await coordinator.notify(completion);
    await expect(coordinator.notify(completion)).resolves.toEqual({ action: "duplicate" });
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("steers after another turn wins the idle-parent race", async () => {
    let activeTurn = null;
    const startTurn = vi.fn(async () => {
      activeTurn = "user-turn";
      throw new Error("Parent is active");
    });
    const steerTurn = vi.fn(async () => ({}));
    const coordinator = new BridgeParentContinuation({
      activeTurnId: () => activeTurn,
      startTurn,
      steerTurn
    });

    await expect(coordinator.notify(completion)).resolves.toEqual({ action: "steered", turnId: "user-turn" });
    expect(steerTurn).toHaveBeenCalledWith("parent-1", "user-turn", [expect.objectContaining({ type: "text" })]);
  });

  it("labels the continuation with the child and failure details", () => {
    expect(bridgeContinuationPrompt({ ...completion, status: "failed", answer: "", error: "Build failed" }))
      .toContain("Child thread: child-1\nStatus: failed");
  });
});
