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
});
