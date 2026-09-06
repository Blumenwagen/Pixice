import { z } from "zod";
import { WorkflowCredentialStore } from "./workflow-credential-store.mjs";
import { WorkflowGenerator } from "./workflow-generator.mjs";
import { workflowGraphSchema } from "./workflow-model.mjs";
import { WorkflowStore } from "./workflow-store.mjs";
import { WorkflowTriggerHost } from "./workflow-trigger-host.mjs";
import { PixiceWorkflows } from "./pixice-workflows.mjs";

const projectPayload = z.object({ projectId: z.string().trim().min(1).max(160) }).strict();
const workflowPayload = projectPayload.extend({ workflowId: z.string().trim().min(1).max(160) });
const workflowName = z.string().trim().min(1).max(240);
const workflowDescription = z.string().max(10_000);
const credentialId = z.string().trim().min(1).max(160);
const credentialType = z.enum(["bearer", "basic", "apiKey", "headers"]);
const credentialValues = z.record(z.unknown());

function credentialReferences(store, projectId, targetId) {
  const references = [];
  for (const workflow of store.listWorkflows(projectId)) {
    for (const node of workflow.graph.nodes) {
      if (node.config?.credentialId === targetId || node.config?.authCredentialId === targetId) {
        references.push(`${workflow.name} · ${node.name}`);
      }
    }
  }
  return references;
}

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
  onTriggersChange,
  onCredentialsChange,
  assertProject,
  credentialCrypto,
  notify,
  onAttention
}) {
  const store = new WorkflowStore(userDataPath);
  const credentialStore = new WorkflowCredentialStore(userDataPath, { crypto: credentialCrypto });
  const workflowGenerator = new WorkflowGenerator(runtime, {
    selection: () => database.getAppSettings().workflowGenerationModel ?? "auto"
  });
  let triggerHost = null;
  const workflows = new PixiceWorkflows({
    runtime,
    store,
    database,
    dynamicTools,
    threadContext,
    projectContext,
    onChange: (payload) => {
      onChange?.(payload);
      void triggerHost?.refresh();
    },
    onOpen,
    onRun,
    onForeground,
    onThreadCreated,
    onAgentActivity,
    credentialResolver: async (projectId, id) => { await credentialCrypto?.ready?.(); return credentialStore.resolve(projectId, id); },
    notify
  });
  triggerHost = new WorkflowTriggerHost({
    store,
    workflows,
    database,
    credentialStore,
    prepareCredentials: () => credentialCrypto?.ready?.(),
    notify,
    onAttention,
    onChange: (payload) => onTriggersChange?.(payload)
  });
  const ready = triggerHost.start();

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

  ipcMain.handle("workflows:task-runs", (_event, payload) => {
    const value = projectPayload.extend({ taskId: z.string().trim().min(1).max(160) }).parse(payload);
    assertProject(value.projectId);
    const task = database.getBoardTask(value.taskId);
    if (!task || task.projectId !== value.projectId) throw new Error("Work item not found in this project");
    const seen = new Set();
    const data = database.listBoardTaskActivity(task.id, 100).flatMap((activity) => {
      const runId = activity.metadata?.runId;
      if (!runId || seen.has(runId)) return [];
      seen.add(runId);
      const run = store.getRun(runId);
      if (!run || run.projectId !== value.projectId) return [];
      const workflow = store.getWorkflow(run.workflowId);
      return [{ ...run, workflowName: workflow?.name ?? run.workflowId, eventType: activity.metadata?.eventType ?? null }];
    });
    return { data };
  });

  ipcMain.handle("workflows:create", (_event, payload) => {
    const value = projectPayload.extend({
      name: workflowName,
      description: workflowDescription.default(""),
      enabled: z.boolean().default(false)
    }).parse(payload);
    assertProject(value.projectId);
    return workflows.create(value);
  });

  ipcMain.handle("workflows:save", (_event, payload) => {
    const value = workflowPayload.extend({
      name: workflowName,
      description: workflowDescription.default(""),
      enabled: z.boolean().default(false),
      graph: workflowGraphSchema,
      expectedUpdatedAt: z.string().datetime().optional()
    }).parse(payload);
    assertProject(value.projectId);
    return workflows.save(value);
  });

  ipcMain.handle("workflows:generate", async (_event, payload) => {
    const { projectId, workflowId } = workflowPayload.parse(payload);
    assertProject(projectId);
    const { workflow } = workflows.read(projectId, workflowId);
    const context = projectContext(projectId, null);
    if (!context?.cwd) throw new Error("The workflow project is unavailable");
    return workflowGenerator.generate({ workflow, cwd: context.cwd });
  });

  ipcMain.handle("workflows:delete", (_event, payload) => {
    const { projectId, workflowId } = workflowPayload.parse(payload);
    assertProject(projectId);
    return workflows.delete(projectId, workflowId);
  });

  ipcMain.handle("workflows:run", (_event, payload) => {
    const value = workflowPayload.extend({
      input: z.unknown().optional(),
      triggerNodeId: credentialId.optional()
    }).parse(payload);
    assertProject(value.projectId);
    return workflows.startRun({
      projectId: value.projectId,
      workflowId: value.workflowId,
      input: value.input ?? {},
      triggerNodeId: value.triggerNodeId ?? null,
      sourceThreadId: null
    });
  });

  ipcMain.handle("workflows:cancel", (_event, payload) => {
    const value = projectPayload.extend({ runId: z.string().trim().min(1).max(160) }).parse(payload);
    assertProject(value.projectId);
    return workflows.cancelRun(value.projectId, value.runId);
  });

  ipcMain.handle("workflows:triggers", (_event, payload) => {
    const { projectId } = projectPayload.parse(payload);
    assertProject(projectId);
    return { data: triggerHost.list(projectId) };
  });

  ipcMain.handle("workflows:resolve-missed-trigger", async (_event, payload) => {
    const value = projectPayload.extend({
      requestId: z.string().trim().min(1).max(500),
      decision: z.enum(["accept", "decline"])
    }).parse(payload);
    assertProject(value.projectId);
    return triggerHost.resolveMissed(value.requestId, value.decision);
  });

  ipcMain.handle("workflow-credentials:list", (_event, payload) => {
    const { projectId } = projectPayload.parse(payload);
    assertProject(projectId);
    return { data: credentialStore.list(projectId) };
  });

  ipcMain.handle("workflow-credentials:create", async (_event, payload) => {
    const value = projectPayload.extend({
      name: z.string().trim().min(1).max(160),
      type: credentialType,
      values: credentialValues
    }).parse(payload);
    assertProject(value.projectId);
    await credentialCrypto?.ready?.();
    const credential = credentialStore.create(value);
    onCredentialsChange?.({ action: "created", projectId: value.projectId, credential });
    void triggerHost.refresh();
    return credential;
  });

  ipcMain.handle("workflow-credentials:update", async (_event, payload) => {
    const value = projectPayload.extend({
      credentialId,
      name: z.string().trim().min(1).max(160).optional(),
      type: credentialType.optional(),
      values: credentialValues.optional()
    }).refine((entry) => entry.name !== undefined || entry.type !== undefined || entry.values !== undefined, "A credential change is required").parse(payload);
    assertProject(value.projectId);
    await credentialCrypto?.ready?.();
    const credential = credentialStore.update(value);
    onCredentialsChange?.({ action: "updated", projectId: value.projectId, credential });
    void triggerHost.refresh();
    return credential;
  });

  ipcMain.handle("workflow-credentials:delete", (_event, payload) => {
    const value = projectPayload.extend({ credentialId }).parse(payload);
    assertProject(value.projectId);
    const references = credentialReferences(store, value.projectId, value.credentialId);
    if (references.length) throw new Error(`This credential is still used by ${references.join(", ")}`);
    const credential = credentialStore.delete(value.projectId, value.credentialId);
    if (credential) onCredentialsChange?.({ action: "deleted", projectId: value.projectId, credential });
    void triggerHost.refresh();
    return credential;
  });

  return {
    workflows,
    store,
    credentialStore,
    triggerHost,
    ready,
    close: async () => {
      await triggerHost.close();
      await workflows.close();
      store.close();
    }
  };
}
