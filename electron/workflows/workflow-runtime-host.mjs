import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeAgentInstructions } from "../runtime/agent-behavior.mjs";
import { installWorkflowIntegration } from "./workflow-integration.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function permissionSettings(mode, project) {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }
  if (mode === "read-only") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly" }
    };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: mode === "auto-approve" ? "auto_review" : "user",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [project.canonicalPath],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  };
}

function eventSender(BrowserWindow) {
  return (type, payload = {}) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    window?.webContents.send("loom:event", { type, payload, at: new Date().toISOString() });
  };
}

export function controllingWorkflowWorkspace(database, threadId) {
  let current = threadId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = database.getThreadLink?.(current)?.parentThreadId;
    if (!parent || parent.startsWith("workflow:")) return current;
    current = parent;
  }
  return current ?? threadId;
}

export function projectWorkflowThread(payload) {
  if (payload.executionMode !== "background" || payload.thread.parentThreadId) return payload;
  return {
    ...payload,
    thread: {
      ...payload.thread,
      parentThreadId: `workflow:${payload.workflow.id}`
    }
  };
}

export async function installWorkflowRuntimeHost({
  runtime,
  database,
  threadContext,
  dynamicTools,
  onThreadCreated,
  onAgentActivity
}) {
  if (!process.versions.electron) return null;
  const { app, BrowserWindow, ipcMain, Notification, safeStorage } = await import("electron");
  const send = eventSender(BrowserWindow);
  const settings = () => database.getAppSettings?.() ?? {};
  const developerInstructions = () => {
    const baseInstructionsPath = app.isPackaged
      ? path.join(process.resourcesPath, "runtime/loom-developer-instructions.md")
      : path.join(__dirname, "../../resources/runtime/loom-developer-instructions.md");
    const behaviorsDirectory = app.isPackaged
      ? path.join(process.resourcesPath, "runtime/agent-behaviors")
      : path.join(__dirname, "../../resources/runtime/agent-behaviors");
    return composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: settings().agentBehaviors
    });
  };

  const projectContext = (projectId, sourceThreadId) => {
    const source = sourceThreadId ? threadContext(sourceThreadId) : null;
    if (source?.projectId === projectId) {
      return {
        ...source,
        defaultModel: settings().defaultModel ?? null,
        defaultEffort: settings().defaultEffort ?? null,
        defaultPermissionMode: settings().defaultPermissionMode ?? "workspace-write"
      };
    }
    const project = database.getProject(projectId);
    if (!project) return null;
    const defaults = settings();
    return {
      projectId,
      cwd: project.canonicalPath,
      developerInstructions: developerInstructions(),
      defaultModel: defaults.defaultModel ?? null,
      defaultEffort: defaults.defaultEffort ?? null,
      defaultPermissionMode: defaults.defaultPermissionMode ?? "workspace-write",
      permissionSettings: (mode) => permissionSettings(mode, project)
    };
  };

  const integration = installWorkflowIntegration({
    userDataPath: app.getPath("userData"),
    ipcMain,
    runtime,
    database,
    dynamicTools,
    threadContext,
    projectContext,
    assertProject: (projectId) => {
      const project = database.getProject(projectId);
      if (!project) throw new Error("Project not found");
      return project;
    },
    credentialCrypto: safeStorage,
    notify: async ({ title, body, urgency, silent }) => {
      if (!Notification.isSupported()) return false;
      new Notification({ title, body, urgency, silent }).show();
      return true;
    },
    onChange: (payload) => send("WorkflowUpdated", payload),
    onTriggersChange: (payload) => send("WorkflowTriggersUpdated", payload),
    onCredentialsChange: (payload) => send("WorkflowCredentialsUpdated", payload),
    onOpen: (payload) => send("WorkflowOpenRequested", {
      ...payload,
      workspaceId: controllingWorkflowWorkspace(database, payload.threadId)
    }),
    onRun: (payload) => send("WorkflowRunUpdated", payload),
    onForeground: (payload) => send("WorkflowForegroundRequested", payload),
    onThreadCreated: (payload) => {
      const projected = projectWorkflowThread(payload);
      onThreadCreated?.(projected);
      if (projected.executionMode === "background") {
        send("TaskUpdated", {
          method: "thread/started",
          projectId: projected.workflow.projectId,
          thread: projected.thread
        });
      }
    },
    onAgentActivity
  });
  await integration.ready;

  app.once("before-quit", () => {
    void integration.close().catch(() => null);
  });
  return integration;
}
