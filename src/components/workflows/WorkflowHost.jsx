import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TreeStructure } from "../icons/index.jsx";
import { WorkflowPreview, WorkflowWorkspace } from "./WorkflowWorkspace.jsx";
import styles from "./WorkflowWorkspace.module.css";

function sidebarThread(thread) {
  return !thread?.parentThreadId || thread?.bridge?.kind === "loomBridge" || Boolean(thread?.bridgeModel);
}

function threadTitle(thread) {
  return thread?.name?.trim() || thread?.preview?.trim() || "Untitled task";
}

function waitForElement(selector, timeoutMs = 1800) {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const node = document.querySelector(selector);
      if (node) finish(node);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
  });
}

export function WorkflowHost({ children }) {
  const api = window.loom;
  const [navTarget, setNavTarget] = useState(null);
  const [appTarget, setAppTarget] = useState(null);
  const [previewTarget, setPreviewTarget] = useState(null);
  const [active, setActive] = useState(false);
  const [projects, setProjects] = useState([]);
  const [models, setModels] = useState([]);
  const [projectId, setProjectId] = useState(() => localStorage.getItem("loom.activeProjectId"));
  const [requestedWorkflowId, setRequestedWorkflowId] = useState(null);
  const [preview, setPreview] = useState(null);
  const currentThreadIdRef = useRef(null);
  const projectIdRef = useRef(projectId);

  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  useEffect(() => {
    const locate = () => {
      setNavTarget(document.querySelector(".sidebar .rail-group"));
      setAppTarget(document.querySelector(".loom-app"));
      setPreviewTarget(document.querySelector(".browser-panel"));
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (!api) return;
    const [nextProjects, nextModels] = await Promise.all([
      api.projects?.list?.().catch(() => []),
      api.models?.list?.().catch(() => [])
    ]);
    setProjects(nextProjects ?? []);
    setModels(nextModels ?? []);
  }, [api]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    const sync = () => {
      const nextProjectId = localStorage.getItem("loom.activeProjectId");
      setProjectId((current) => current === nextProjectId ? current : nextProjectId);
    };
    sync();
    const timer = window.setInterval(sync, 300);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (projectId) void refreshCatalog();
    setRequestedWorkflowId(null);
    setPreview(null);
  }, [projectId, refreshCatalog]);

  useEffect(() => {
    if (!appTarget) return undefined;
    if (active) appTarget.dataset.workflowsActive = "true";
    else delete appTarget.dataset.workflowsActive;
    return () => delete appTarget.dataset.workflowsActive;
  }, [active, appTarget]);

  const resolveSelectedThread = useCallback(async (clickedButton = null) => {
    const selectedProjectId = projectIdRef.current;
    if (!api?.threads || !selectedProjectId) return null;
    try {
      const response = await api.threads.list({ projectId: selectedProjectId });
      const candidates = (response.data ?? []).filter(sidebarThread);
      const buttons = [...document.querySelectorAll(".task-tree .task-select")];
      const button = clickedButton ?? document.querySelector(".task-row.active .task-select");
      const index = button ? buttons.indexOf(button) : -1;
      const visibleTitle = button?.querySelector(".task-title")?.textContent?.trim();
      const titleMatches = visibleTitle ? candidates.filter((thread) => threadTitle(thread) === visibleTitle) : [];
      const selected = titleMatches.length === 1 ? titleMatches[0] : candidates[index] ?? null;
      currentThreadIdRef.current = selected?.id ?? null;
      return selected?.id ?? null;
    } catch {
      return null;
    }
  }, [api]);

  useEffect(() => {
    const handleSidebarClick = (event) => {
      const workflowButton = event.target.closest?.(".workflow-nav-item");
      if (workflowButton) return;
      if (event.target.closest?.(".sidebar button")) setActive(false);
      const taskButton = event.target.closest?.(".task-select");
      if (taskButton) window.setTimeout(() => void resolveSelectedThread(taskButton), 30);
      if (event.target.closest?.(".new-task")) currentThreadIdRef.current = null;
    };
    document.addEventListener("click", handleSidebarClick, true);
    window.setTimeout(() => void resolveSelectedThread(), 120);
    return () => document.removeEventListener("click", handleSidebarClick, true);
  }, [resolveSelectedThread]);

  const ensurePreviewOpen = useCallback(async (workspaceId) => {
    if (!workspaceId) return null;
    setActive(false);
    let panel = document.querySelector(".browser-panel");
    if (!panel) {
      const openButton = document.querySelector('[aria-label="Open preview workspace"]');
      openButton?.click();
      panel = await waitForElement(".browser-panel");
    }
    if (panel) setPreviewTarget(panel);
    try {
      await api?.browser?.setViewport?.({ workspaceId, visible: false });
    } catch {
      // The workflow surface does not require a browser tab to be active.
    }
    return panel;
  }, [api]);

  const closePreview = useCallback(() => {
    const workspaceId = preview?.threadId;
    setPreview(null);
    if (workspaceId) void api?.browser?.setViewport?.({ workspaceId, visible: false }).catch(() => {});
    window.setTimeout(() => document.querySelector('[aria-label="Close preview workspace"]')?.click(), 0);
  }, [api, preview?.threadId]);

  const selectForegroundThread = useCallback(async (payload) => {
    if (!api?.threads || !payload?.threadId || !payload.projectId) return false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await api.threads.list({ projectId: payload.projectId });
        const candidates = (response.data ?? []).filter(sidebarThread);
        const targetIndex = candidates.findIndex((thread) => thread.id === payload.threadId);
        const buttons = [...document.querySelectorAll(".task-tree .task-select")];
        if (targetIndex >= 0 && buttons[targetIndex]) {
          buttons[targetIndex].click();
          currentThreadIdRef.current = payload.threadId;
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          return true;
        }
      } catch {
        // The thread list may still be reconciling the creation event.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    }
    return false;
  }, [api]);

  useEffect(() => {
    if (!api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      const payload = event.payload ?? {};
      if (event.type === "RuntimeStatus" && payload.connected) void refreshCatalog();
      if (event.type === "WorkflowOpenRequested") {
        const workspaceId = payload.threadId ?? currentThreadIdRef.current;
        setPreview({
          projectId: payload.projectId,
          workflowId: payload.workflowId,
          threadId: workspaceId,
          reason: payload.reason ?? "open"
        });
        void ensurePreviewOpen(workspaceId);
        return;
      }
      if (event.type === "WorkflowForegroundRequested") {
        void (async () => {
          await selectForegroundThread(payload);
          setPreview({
            projectId: payload.projectId,
            workflowId: payload.workflowId,
            threadId: payload.threadId,
            reason: "run"
          });
          await ensurePreviewOpen(payload.threadId);
        })();
      }
    });
  }, [api, ensurePreviewOpen, refreshCatalog, selectForegroundThread]);

  useEffect(() => {
    if (!preview?.threadId || !api?.browser) return undefined;
    const hideNativeBrowser = () => api.browser.setViewport({ workspaceId: preview.threadId, visible: false }).catch(() => {});
    void hideNativeBrowser();
    const timer = window.setInterval(hideNativeBrowser, 280);
    return () => window.clearInterval(timer);
  }, [api, preview?.threadId]);

  useEffect(() => {
    if (!previewTarget) return undefined;
    const previousPosition = previewTarget.style.position;
    const previousOverflow = previewTarget.style.overflow;
    previewTarget.style.position = "relative";
    previewTarget.style.overflow = "hidden";
    return () => {
      previewTarget.style.position = previousPosition;
      previewTarget.style.overflow = previousOverflow;
    };
  }, [previewTarget]);

  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const nav = navTarget ? createPortal(
    <button
      type="button"
      className={`rail-nav-item workflow-nav-item ${active ? "active" : ""}`}
      disabled={!projectId}
      aria-current={active ? "page" : undefined}
      aria-label="Workflows"
      title="Workflows"
      onClick={() => {
        setActive(true);
        setPreview(null);
      }}
    >
      {active && <span className="thread-indicator"><i /></span>}
      <span className="rail-icon"><TreeStructure size={17} weight={active ? "fill" : "regular"} /></span>
      <span className="rail-label">Workflows</span>
    </button>,
    navTarget
  ) : null;

  const workspace = active && appTarget ? createPortal(
    <WorkflowWorkspace
      api={api}
      projectId={projectId}
      projectName={project?.displayName}
      models={models}
      requestedWorkflowId={requestedWorkflowId}
      onWorkflowSelected={setRequestedWorkflowId}
    />,
    appTarget
  ) : null;

  const workflowPreview = preview && previewTarget ? createPortal(
    <WorkflowPreview
      api={api}
      projectId={preview.projectId}
      workflowId={preview.workflowId}
      models={models}
      reason={preview.reason}
      onClose={closePreview}
      onOpenWorkspace={(workflowId) => {
        setRequestedWorkflowId(workflowId);
        setPreview(null);
        setActive(true);
        window.setTimeout(() => document.querySelector('[aria-label="Close preview workspace"]')?.click(), 0);
      }}
    />,
    previewTarget
  ) : null;

  return (
    <>
      {children}
      {nav}
      {workspace}
      {workflowPreview}
      {!api && <div className={styles.notice} data-tone="error">Loom workflows require the desktop bridge.</div>}
    </>
  );
}
