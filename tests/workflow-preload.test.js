import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadPreload() {
  const source = readFileSync(path.resolve("electron/preload.cjs"), "utf8");
  let exposed;
  const invoke = vi.fn(async () => null);
  const ipcRenderer = {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((_name, value) => { exposed = value; })
  };
  vm.runInNewContext(source, {
    require: (name) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
      return { contextBridge, ipcRenderer };
    },
    Object,
    Promise
  }, { filename: "electron/preload.cjs" });
  return { api: exposed, invoke };
}

describe("workflow preload bridge", () => {
  it("exposes project folder selection and structured project creation", async () => {
    const { api, invoke } = loadPreload();
    const project = {
      displayName: "Studio",
      icon: "code",
      color: "purple",
      folders: ["/work/studio", "/work/shared"]
    };

    await api.projects.touch({ projectId: "project-studio" });
    await api.projects.pickFolders();
    await api.projects.create(project);
    await api.projects.delete({ projectId: "project-studio" });

    expect(invoke).toHaveBeenNthCalledWith(1, "projects:touch", { projectId: "project-studio" });
    expect(invoke).toHaveBeenNthCalledWith(2, "projects:pick-folders", undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "projects:create", project);
    expect(invoke).toHaveBeenNthCalledWith(4, "projects:delete", { projectId: "project-studio" });
  });

  it("wraps positional credential helpers into validated IPC payload objects", async () => {
    const { api, invoke } = loadPreload();

    await api.workflowCredentials.list("project-1");
    await api.workflowCredentials.delete("project-1", "credential-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "workflow-credentials:list", { projectId: "project-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "workflow-credentials:delete", {
      projectId: "project-1",
      credentialId: "credential-1"
    });
  });

  it("exposes description-driven workflow generation", async () => {
    const { api, invoke } = loadPreload();

    await api.workflows.generate({ projectId: "project-1", workflowId: "workflow-1" });

    expect(invoke).toHaveBeenCalledWith("workflows:generate", { projectId: "project-1", workflowId: "workflow-1" });
  });

  it("exposes task-linked runs and missed-trigger decisions", async () => {
    const { api, invoke } = loadPreload();

    await api.workflows.taskRuns({ projectId: "project-1", taskId: "task-1" });
    await api.workflows.resolveMissedTrigger({ projectId: "project-1", requestId: "request-1", decision: "accept" });

    expect(invoke).toHaveBeenNthCalledWith(1, "workflows:task-runs", { projectId: "project-1", taskId: "task-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "workflows:resolve-missed-trigger", {
      projectId: "project-1",
      requestId: "request-1",
      decision: "accept"
    });
  });

  it("exposes GitHub account actions", async () => {
    const { api, invoke } = loadPreload();

    await api.github.status();
    await api.github.login();
    await api.github.logout();

    expect(invoke).toHaveBeenNthCalledWith(1, "github:status", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "github:login", undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "github:logout", undefined);
  });

  it("exposes the Instrument Preview bridge", async () => {
    const { api, invoke } = loadPreload();

    await api.instruments.list({ projectId: "project-1", threadId: "thread-1" });
    await api.instruments.tools({ projectId: "project-1" });
    await api.instruments.open({ projectId: "project-1", instrumentId: "instrument-1", workspaceId: "thread-1" });
    await api.instruments.refresh({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", source: "status" });
    await api.instruments.event({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", actionId: "investigate", payload: { selected: ["src/app.js"] } });
    await api.instruments.invoke({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", actionId: "move", arguments: { taskId: "task-1", column: "done" }, requestId: "request-1" });
    await api.instruments.pin({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", pinned: true });
    await api.instruments.launch({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", values: { environment: "staging" } });
    await api.instruments.grants({ projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", grants: ["workflow.run"] });
    await api.instruments.revisions({ projectId: "project-1", instrumentId: "instrument-1" });

    expect(invoke).toHaveBeenNthCalledWith(1, "instruments:list", { projectId: "project-1", threadId: "thread-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "instruments:tools", { projectId: "project-1" });
    expect(invoke).toHaveBeenNthCalledWith(3, "instruments:open", { projectId: "project-1", instrumentId: "instrument-1", workspaceId: "thread-1" });
    expect(invoke).toHaveBeenNthCalledWith(4, "instruments:refresh", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", source: "status" });
    expect(invoke).toHaveBeenNthCalledWith(5, "instruments:event", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", actionId: "investigate", payload: { selected: ["src/app.js"] } });
    expect(invoke).toHaveBeenNthCalledWith(6, "instruments:invoke", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", actionId: "move", arguments: { taskId: "task-1", column: "done" }, requestId: "request-1" });
    expect(invoke).toHaveBeenNthCalledWith(7, "instruments:pin", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", pinned: true });
    expect(invoke).toHaveBeenNthCalledWith(8, "instruments:launch", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", values: { environment: "staging" } });
    expect(invoke).toHaveBeenNthCalledWith(9, "instruments:grants", { projectId: "project-1", threadId: "thread-1", instrumentId: "instrument-1", grants: ["workflow.run"] });
    expect(invoke).toHaveBeenNthCalledWith(10, "instruments:revisions", { projectId: "project-1", instrumentId: "instrument-1" });
  });
});
