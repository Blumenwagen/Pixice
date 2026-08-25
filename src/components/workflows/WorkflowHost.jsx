import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TreeStructure } from "../icons/index.jsx";
import { WorkflowPreview, WorkflowWorkspace } from "./WorkflowWorkspace.jsx";
import styles from "./WorkflowWorkspace.module.css";

function previewPanelForWorkspace(workspaceId) {
  return [...document.querySelectorAll(".browser-panel")]
    .find((candidate) => candidate.dataset.previewWorkspaceId === workspaceId) ?? null;
}

function waitForPreviewPanel(workspaceId, timeoutMs = 1800) {
  const existing = previewPanelForWorkspace(workspaceId);
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
      const node = previewPanelForWorkspace(workspaceId);
      if (node) finish(node);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
  });
}

export function WorkflowHost({ children }) {
  const api = window.pixice;
  const [navTarget, setNavTarget] = useState(null);
  const [appTarget, setAppTarget] = useState(null);
  const [previewTarget, setPreviewTarget] = useState(null);
  const [active, setActive] = useState(false);
  const [projects, setProjects] = useState([]);
  const [models, setModels] = useState([]);
  const [projectId, setProjectId] = useState(() => localStorage.getItem("pixice.activeProjectId"));
  const [requestedWorkflowId, setRequestedWorkflowId] = useState(null);
  const [preview, setPreview] = useState(null);
  const currentThreadIdRef = useRef(null);
  const previewTargetRef = useRef(null);
  const pendingPreviewsRef = useRef(new Map());

  useEffect(() => {
    const syncTargets = () => {
      const nextNavTarget = document.querySelector("[data-workflow-nav-slot]")
        ?? document.querySelector(".sidebar .rail-group");
      const nextAppTarget = document.querySelector("[data-workflow-workspace-slot]")
        ?? document.querySelector(".pixice-app");
      setNavTarget((current) => current === nextNavTarget ? current : nextNavTarget);
      setAppTarget((current) => current === nextAppTarget ? current : nextAppTarget);
    };
    syncTargets();
    const observer = new MutationObserver(syncTargets);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!preview?.threadId) {
      if (previewTargetRef.current) {
        previewTargetRef.current = null;
        setPreviewTarget(null);
      }
      return undefined;
    }
    const nextPreviewTarget = previewPanelForWorkspace(preview.threadId);
    if (previewTargetRef.current !== nextPreviewTarget) {
      previewTargetRef.current = nextPreviewTarget;
      setPreviewTarget(nextPreviewTarget);
    }
    return undefined;
  }, [preview?.threadId]);

  const refreshCatalog = useCallback(async () => {
    if (!api) return;
    const projectRequest = api.projects?.list
      ? api.projects.list().catch(() => [])
      : Promise.resolve([]);
    const modelRequest = api.models?.list
      ? api.models.list().catch(() => [])
      : Promise.resolve([]);
    const [nextProjects, nextModels] = await Promise.all([projectRequest, modelRequest]);
    setProjects(nextProjects ?? []);
    setModels(nextModels ?? []);
  }, [api]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    const sync = (event) => {
      const nextProjectId = event?.detail ?? localStorage.getItem("pixice.activeProjectId");
      setProjectId((current) => current === nextProjectId ? current : nextProjectId);
    };
    sync();
    window.addEventListener("pixice:active-project-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("pixice:active-project-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (projectId) void refreshCatalog();
    setRequestedWorkflowId(null);
    setPreview(null);
    pendingPreviewsRef.current.clear();
  }, [projectId, refreshCatalog]);

  useEffect(() => {
    if (!appTarget) return undefined;
    const appRoot = appTarget.closest?.(".pixice-app") ?? appTarget;
    if (active) appRoot.dataset.workflowsActive = "true";
    else delete appRoot.dataset.workflowsActive;
    return () => delete appRoot.dataset.workflowsActive;
  }, [active, appTarget]);

  useEffect(() => {
    if (!appTarget || !active) return undefined;
    const appRoot = appTarget.closest?.(".pixice-app") ?? appTarget;
    const covered = [...appRoot.children].filter((node) => node !== appTarget && !node.classList?.contains("window-drag-region"));
    const previous = covered.map((node) => ({
      node,
      inert: node.inert,
      ariaHidden: node.getAttribute("aria-hidden")
    }));
    covered.forEach((node) => {
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
    });
    return () => previous.forEach(({ node, inert, ariaHidden }) => {
      node.inert = inert;
      if (ariaHidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", ariaHidden);
    });
  }, [active, appTarget]);

  useEffect(() => {
    const handleSidebarClick = (event) => {
      const workflowButton = event.target.closest?.(".workflow-nav-item");
      if (workflowButton) return;
      if (event.target.closest?.(".sidebar button")) setActive(false);
    };
    document.addEventListener("click", handleSidebarClick, true);
    return () => document.removeEventListener("click", handleSidebarClick, true);
  }, []);

  const ensurePreviewOpen = useCallback(async (workspaceId) => {
    if (!workspaceId) return null;
    setActive(false);
    let panel = previewPanelForWorkspace(workspaceId);
    if (!panel) {
      const openButton = document.querySelector('[aria-label="Open preview workspace"]');
      openButton?.click();
      panel = await waitForPreviewPanel(workspaceId);
    }
    if (panel?.dataset.previewWorkspaceId === workspaceId) {
      previewTargetRef.current = panel;
      setPreviewTarget(panel);
    }
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

  const presentPendingPreview = useCallback(async (workspaceId = null) => {
    const appRoot = document.querySelector(".pixice-app.view-task");
    const activeThreadId = appRoot?.dataset.activeThreadId || currentThreadIdRef.current;
    currentThreadIdRef.current = activeThreadId;
    const targetWorkspaceId = workspaceId ?? activeThreadId;
    if (!targetWorkspaceId || targetWorkspaceId !== activeThreadId) return false;
    if (!appRoot || appRoot.dataset.workflowsActive === "true") return false;
    const pending = pendingPreviewsRef.current.get(targetWorkspaceId);
    if (!pending) return false;
    pendingPreviewsRef.current.delete(targetWorkspaceId);
    setPreview(pending);
    await ensurePreviewOpen(targetWorkspaceId);
    return true;
  }, [ensurePreviewOpen]);

  useEffect(() => {
    const syncThread = (event) => {
      const nextThreadId = event?.detail ?? null;
      currentThreadIdRef.current = nextThreadId;
      setPreview((current) => current?.threadId === nextThreadId ? current : null);
      window.setTimeout(() => void presentPendingPreview(), 0);
    };
    window.addEventListener("pixice:active-thread-changed", syncThread);
    return () => window.removeEventListener("pixice:active-thread-changed", syncThread);
  }, [presentPendingPreview]);

  useEffect(() => {
    const appRoot = document.querySelector(".pixice-app");
    if (!appRoot) return undefined;
    const observer = new MutationObserver(() => void presentPendingPreview());
    observer.observe(appRoot, { attributes: true, attributeFilter: ["class", "data-active-thread-id", "data-workflows-active"] });
    return () => observer.disconnect();
  }, [appTarget, presentPendingPreview]);

  useEffect(() => {
    if (!api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      const payload = event.payload ?? {};
      if (event.type === "RuntimeStatus" && payload.connected) void refreshCatalog();
      if (event.type === "WorkflowOpenRequested") {
        const workspaceId = payload.workspaceId ?? payload.threadId ?? currentThreadIdRef.current;
        if (!workspaceId) return;
        pendingPreviewsRef.current.set(workspaceId, {
          projectId: payload.projectId,
          workflowId: payload.workflowId,
          workflowName: payload.workflowName,
          threadId: workspaceId,
          reason: payload.reason ?? "open"
        });
        void presentPendingPreview(workspaceId);
        return;
      }
      if (event.type === "WorkflowForegroundRequested") {
        if (!payload.threadId) return;
        pendingPreviewsRef.current.set(payload.threadId, {
          projectId: payload.projectId,
          workflowId: payload.workflowId,
          workflowName: payload.workflowName,
          threadId: payload.threadId,
          reason: "run"
        });
        void presentPendingPreview(payload.threadId);
      }
    });
  }, [api, presentPendingPreview, refreshCatalog]);

  useEffect(() => {
    if (!preview?.threadId || !api?.browser) return undefined;
    const hideNativeBrowser = () => api.browser.setViewport({ workspaceId: preview.threadId, visible: false }).catch(() => {});
    void hideNativeBrowser();
    return undefined;
  }, [api, preview?.threadId]);

  useEffect(() => {
    if (!previewTarget || !preview) return undefined;
    const previousPosition = previewTarget.style.position;
    const previousOverflow = previewTarget.style.overflow;
    const previousPreviewHost = previewTarget.getAttribute("data-workflow-preview-host");
    previewTarget.style.position = "relative";
    previewTarget.style.overflow = "hidden";
    previewTarget.dataset.workflowPreviewHost = "true";
    return () => {
      previewTarget.style.position = previousPosition;
      previewTarget.style.overflow = previousOverflow;
      if (previousPreviewHost === null) previewTarget.removeAttribute("data-workflow-preview-host");
      else previewTarget.setAttribute("data-workflow-preview-host", previousPreviewHost);
    };
  }, [preview, previewTarget]);

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
        setPreview(null);
        document.querySelector('[aria-label="Close preview workspace"]')?.click();
        setActive(true);
      }}
    >
      {active && <span className="thread-indicator"><i /></span>}
      <span className="rail-icon"><TreeStructure size={17} weight={active ? "fill" : "regular"} /></span>
      <span className="rail-label">Workflows</span>
    </button>,
    navTarget
  ) : null;

  const workspace = appTarget ? createPortal(
    active ? (
      <div className={styles.workflowTakeover}>
        <WorkflowWorkspace
          api={api}
          projectId={projectId}
          projectName={project?.displayName}
          models={models}
          requestedWorkflowId={requestedWorkflowId}
          onWorkflowSelected={setRequestedWorkflowId}
          onBack={() => setActive(false)}
        />
      </div>
    ) : null,
    appTarget
  ) : null;

  const workflowPreview = preview && previewTarget ? createPortal(
    <WorkflowPreview
      api={api}
      projectId={preview.projectId}
      workflowId={preview.workflowId}
      workflowName={preview.workflowName}
      models={models}
      reason={preview.reason}
      onClose={closePreview}
      onOpenWorkspace={(workflowId) => {
        setRequestedWorkflowId(workflowId);
        setPreview(null);
        document.querySelector('[aria-label="Close preview workspace"]')?.click();
        setActive(true);
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
      {!api && <div className={styles.notice} data-tone="error">Pixice workflows require the desktop bridge.</div>}
    </>
  );
}
