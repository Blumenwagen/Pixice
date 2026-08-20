import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WorkflowTriggerHost } from "../electron/workflows/workflow-trigger-host.mjs";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function workflowWithNode(node, enabled = true) {
  return {
    id: "workflow-1",
    projectId: "project-1",
    name: "Automatic workflow",
    description: "",
    enabled,
    graph: { nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    createdByThreadId: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
}

describe("workflow trigger host", () => {
  it("fires run-on-startup schedules and advertises the next run", async () => {
    const timers = [];
    const startRun = vi.fn(() => ({ id: "run-1" }));
    const host = new WorkflowTriggerHost({
      store: {
        listAllWorkflows: () => [workflowWithNode({
          id: "schedule",
          type: "scheduleTrigger",
          name: "Every hour",
          description: "",
          position: { x: 0, y: 0 },
          config: { mode: "cron", cron: "0 * * * *", runOnStartup: true, overlapPolicy: "skip" }
        })]
      },
      workflows: { startRun, isWorkflowActive: () => false },
      credentialStore: { resolve: () => null },
      now: () => new Date(2026, 7, 20, 12, 34, 0),
      setTimer: (callback, delay) => {
        const timer = { callback, delay, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      clearTimer: vi.fn()
    });

    await host.start();
    expect(host.list("project-1")[0]).toMatchObject({ status: "active", nextRunAt: new Date(2026, 7, 20, 13, 0, 0).toISOString() });
    const startup = timers.find((timer) => timer.delay === 0);
    await startup.callback();
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      workflowId: "workflow-1",
      triggerNodeId: "schedule"
    }));
    await host.close();
  });

  it("hosts authenticated local webhooks and can return workflow output", async () => {
    const port = await availablePort();
    const startRun = vi.fn(({ input }) => ({ id: "run-webhook", input }));
    const waitForRun = vi.fn(async () => ({ id: "run-webhook", status: "completed", output: { accepted: true } }));
    const credential = { type: "bearer", values: { token: "local-secret" } };
    const host = new WorkflowTriggerHost({
      store: {
        listAllWorkflows: () => [workflowWithNode({
          id: "webhook",
          type: "webhookTrigger",
          name: "Release hook",
          description: "",
          position: { x: 0, y: 0 },
          config: {
            method: "POST",
            port,
            path: "/release",
            responseMode: "workflow",
            timeoutMs: 5000,
            authCredentialId: "credential-1",
            maxBytes: 10000
          }
        })]
      },
      workflows: { startRun, waitForRun, isWorkflowActive: () => false },
      credentialStore: { resolve: () => credential }
    });

    await host.start();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/release`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${port}/release?environment=test`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-secret" },
      body: JSON.stringify({ version: "1.2.3" })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ triggerNodeId: "webhook" }));
    expect(startRun.mock.calls.at(-1)[0].input).toMatchObject({
      trigger: { type: "webhook", nodeId: "webhook" },
      request: { method: "POST", path: "/release", query: { environment: "test" }, body: { version: "1.2.3" } }
    });
    expect(waitForRun).toHaveBeenCalledWith("run-webhook");
    await host.close();
  });

  it("does not host automatic triggers for disabled workflows", async () => {
    const host = new WorkflowTriggerHost({
      store: { listAllWorkflows: () => [workflowWithNode({ id: "schedule", type: "scheduleTrigger", name: "Schedule", description: "", position: { x: 0, y: 0 }, config: {} }, false)] },
      workflows: { startRun: vi.fn(), isWorkflowActive: () => false },
      credentialStore: { resolve: () => null }
    });
    await host.start();
    expect(host.list()).toEqual([]);
    await host.close();
  });
});
