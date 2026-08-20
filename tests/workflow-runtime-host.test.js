import { describe, expect, it } from "vitest";
import {
  controllingWorkflowWorkspace,
  projectWorkflowThread
} from "../electron/workflows/workflow-runtime-host.mjs";

describe("workflow runtime host", () => {
  it("keeps standalone background agents out of the root task list immediately", () => {
    const projected = projectWorkflowThread({
      executionMode: "background",
      workflow: { id: "workflow-1", projectId: "project-1" },
      thread: { id: "thread-agent", parentThreadId: null }
    });
    expect(projected.thread.parentThreadId).toBe("workflow:workflow-1");

    const foreground = projectWorkflowThread({
      executionMode: "foreground",
      workflow: { id: "workflow-1", projectId: "project-1" },
      thread: { id: "thread-visible", parentThreadId: null }
    });
    expect(foreground.thread.parentThreadId).toBeNull();
  });

  it("opens nested workflow work in the top controlling thread preview", () => {
    const links = new Map([
      ["workflow-agent", { parentThreadId: "bridge-agent" }],
      ["bridge-agent", { parentThreadId: "lead-thread" }],
      ["standalone-agent", { parentThreadId: "workflow:workflow-1" }]
    ]);
    const database = { getThreadLink: (threadId) => links.get(threadId) ?? null };

    expect(controllingWorkflowWorkspace(database, "workflow-agent")).toBe("lead-thread");
    expect(controllingWorkflowWorkspace(database, "standalone-agent")).toBe("standalone-agent");
    expect(controllingWorkflowWorkspace(database, "lead-thread")).toBe("lead-thread");
  });
});
