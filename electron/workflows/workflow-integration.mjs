import { z } from "zod";
import { workflowGraphSchema } from "./workflow-model.mjs";
import { WorkflowStore } from "./workflow-store.mjs";
import { LoomWorkflows } from "./loom-workflows.mjs";

const projectPayload = z.object({ projectId: z.string().trim().min(1).max(160) }).strict();
const workflowPayload = projectPayload.extend({ workflowId: z.string().trim().min(1).max(160) });
const workflowName = z.string().trim().min(1).max(240);
const workflowDescription = z.string().max(10_000);

export function installWorkflowIntegration({
  userDataPath,
  ipcMain,
  runtime,
  database,
  dynamicTools,
  threadContext,
  projectContext,
  onChange,
  onOpen,
  onRun,
  onForeground,
  onThreadCreated,
  onAgentActivity,
  assertProject
}) {
  const store = new WorkflowStore(userDataPath);
  const workflows = new LoomWorkflows({
    runtime,
    store,
    database,
    dynamicTools,
    threadContext,
    projectContext,
    onChange,
    onOpen,
    onRun,
    onForeground,
    onThreadCreated,
    onAgentActivity
  });

  ipcMain.handle("workflows:list", (_event, payload) => {
    const { projectId } = projectPayload.parse(payload);
    assertProject(projectId);
    return { data: workflows.list(projectId) };
  });

  ipcMain.handle("workflows:read", (_event, payload) => {
    const { projectId, workflowId } = workflowPayload.parse(payload);
    assertProject(projectId);
    return workflows.read(projectId, workflowId);
  });

  ipcMain.handle("workflows:create", (_event, payload) => {
    const value = projectPayload.extend({
      name: workflowName,
      description: workflowDescription.default("")
    }).parse(payload);
    assertProject(value.projectId);
    return workflows.create(value);
  });

  ipcMain.handle("workflows:save", (_event, payload) => {
    const value = workflowPayload.extend({
      name: workflowName,
      description: workflowDescription.default(""),
      graph: workflowGraphSchema,
      expectedUpdatedAt: z.string().datetime().optional()
    }).parse(payload);
    assertProject(value.projectId);
    return workflows.save(value);
  });

  ipcMain.handle("workflows:delete", (_event, payload) => {
    const { projectId, workflowId } = workflowPayload.parse(payload);
    assertProject(projectId);
    return workflows.delete(projectId, workflowId);
  });

  ipcMain.handle("workflows:run", (_event, payload) => {
    const value = workflowPayload.extend({ input: z.unknown().optional() }).parse(payload);
    assertProject(value.projectId);
    return workflows.startRun({
      projectId: value.projectId,
      workflowId: value.workflowId,
      input: value.input ?? {},
      sourceThreadId: null
    });
  });

  ipcMain.handle("workflows:cancel", (_event, payload) => {
    const value = projectPayload.extend({ runId: z.string().trim().min(1).max(160) }).parse(payload);
    assertProject(value.projectId);
    return workflows.cancelRun(value.projectId, value.runId);
  });

  return {
    workflows,
    store,
    close: () => store.close()
  };
}
