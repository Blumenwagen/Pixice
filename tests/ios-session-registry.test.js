import { describe, expect, it, vi } from "vitest";
import { IosSessionRegistry } from "../electron/ios/ios-session-registry.mjs";

function createRegistry() {
  let sequence = 0;
  return new IosSessionRegistry({
    id: () => `session-${++sequence}`,
    now: () => `2026-08-29T12:00:0${sequence}.000Z`
  });
}

describe("iOS session registry", () => {
  it("isolates sessions by Preview workspace and Simulator", () => {
    const registry = createRegistry();
    const session = registry.claim({ workspaceId: "thread-1", projectId: "project-1", simulatorUdid: "sim-1" });

    expect(session).toMatchObject({
      id: "session-1",
      workspaceId: "thread-1",
      projectId: "project-1",
      simulatorUdid: "sim-1",
      status: "preparing"
    });
    expect(session).not.toHaveProperty("abortController");
    expect(() => registry.claim({ workspaceId: "thread-2", projectId: "project-1", simulatorUdid: "sim-1" }))
      .toThrow("already owned by Preview workspace thread-1");
    expect(registry.claim({ workspaceId: "thread-2", projectId: "project-1", simulatorUdid: "sim-2" }).id)
      .toBe("session-2");
  });

  it("updates public state without allowing identity changes", () => {
    const registry = createRegistry();
    registry.claim({ workspaceId: "thread-1", projectId: "project-1", simulatorUdid: "sim-1" });

    expect(registry.update("thread-1", { status: "building", scheme: "PixiceDemo" })).toMatchObject({
      status: "building",
      scheme: "PixiceDemo"
    });
    expect(() => registry.update("thread-1", { status: "invented" })).toThrow("Unknown iOS session status");
    expect(() => registry.update("thread-1", { simulatorUdid: "sim-2" })).toThrow("identity cannot be changed");
  });

  it("adopts draft sessions when a real thread is created", () => {
    const registry = createRegistry();
    registry.claim({ workspaceId: "draft:project-1", projectId: "project-1", simulatorUdid: "sim-1" });

    const adopted = registry.adopt("draft:project-1", "thread-1");

    expect(adopted.workspaceId).toBe("thread-1");
    expect(registry.snapshot("draft:project-1")).toBeNull();
    expect(() => registry.claim({ workspaceId: "thread-2", projectId: "project-1", simulatorUdid: "sim-1" }))
      .toThrow("already owned by Preview workspace thread-1");
  });

  it("aborts work and runs scoped cleanup in reverse order", async () => {
    const registry = createRegistry();
    const order = [];
    registry.claim({ workspaceId: "thread-1", projectId: "project-1", simulatorUdid: "sim-1" });
    const signal = registry.signal("thread-1");
    registry.addCleanup("thread-1", async () => order.push("first"));
    registry.addCleanup("thread-1", async () => order.push("second"));

    const firstStop = registry.stop("thread-1", "Preview closed");
    const secondStop = registry.stop("thread-1", "Duplicate close");
    const stopped = await firstStop;

    expect(secondStop).toBe(firstStop);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("Preview closed");
    expect(order).toEqual(["second", "first"]);
    expect(stopped.status).toBe("stopped");
    expect(registry.snapshot("thread-1")).toBeNull();
  });

  it("reports cleanup failures and releases Simulator ownership", async () => {
    const registry = createRegistry();
    registry.claim({ workspaceId: "thread-1", projectId: "project-1", simulatorUdid: "sim-1" });
    registry.addCleanup("thread-1", vi.fn(async () => { throw new Error("serve-sim did not exit"); }));

    const stopped = await registry.stop("thread-1");

    expect(stopped).toMatchObject({ status: "failed", error: "serve-sim did not exit" });
    expect(() => registry.claim({ workspaceId: "thread-2", projectId: "project-1", simulatorUdid: "sim-1" }))
      .not.toThrow();
  });
});
