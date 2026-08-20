import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  Eye,
  MagnifyingGlass,
  Plus,
  SpinnerGap,
  Trash,
  TreeStructure,
  Warning,
  X
} from "../icons/index.jsx";
import { WorkflowCanvas } from "./WorkflowCanvas.jsx";
import { cloneWorkflow, workflowStatusLabel } from "./workflow-utils.js";
import styles from "./WorkflowWorkspace.module.css";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancelling"]);

function workflowRevision(workflow) {
  if (!workflow) return "";
  return JSON.stringify([workflow.name, workflow.description, workflow.graph]);
}

function relativeTimestamp(value) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function callWithBridgeRetry(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!/no handler|was not handled|workflows are unavailable/i.test(error?.message ?? "")) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return operation();
  }
}

function useWorkflowDocument({ api, projectId, workflowId, onSaved, onDeleted }) {
  const [workflow, setWorkflow] = useState(null);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(Boolean(workflowId));
  const [savingState, setSavingState] = useState("saved");
  const [error, setError] = useState(null);
  const persistedRef = useRef(null);
  const draftRef = useRef(null);
  const saveTimerRef = useRef(null);
  const generationRef = useRef(0);
  const savingPromiseRef = useRef(null);

  const load = useCallback(async () => {
    if (!api?.workflows || !projectId || !workflowId) {
      setWorkflow(null);
      setRun(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const result = await callWithBridgeRetry(() => api.workflows.read({ projectId, workflowId }));
      const next = cloneWorkflow(result.workflow);
      const latest = (result.runs ?? []).find((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status)) ?? result.runs?.[0] ?? null;
      persistedRef.current = next;
      draftRef.current = next;
      setWorkflow(next);
      setRun(latest);
      setSavingState("saved");
      setError(null);
      return next;
    } catch (cause) {
      setError(cause.message);
      setWorkflow(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [api, projectId, workflowId]);

  useEffect(() => {
    window.clearTimeout(saveTimerRef.current);
    generationRef.current += 1;
    void load();
    return () => window.clearTimeout(saveTimerRef.current);
  }, [load]);

  const saveNow = useCallback(async (candidate = draftRef.current) => {
    if (!candidate || !api?.workflows || !projectId || candidate.id !== workflowId) return candidate;
    if (savingPromiseRef.current) await savingPromiseRef.current.catch(() => null);
    const submitted = cloneWorkflow(candidate);
    const submittedRevision = workflowRevision(submitted);
    const submittedGeneration = generationRef.current;
    setSavingState("saving");
    const promise = callWithBridgeRetry(() => api.workflows.save({
      projectId,
      workflowId: submitted.id,
      name: submitted.name.trim() || "Untitled workflow",
      description: submitted.description ?? "",
      graph: submitted.graph,
      expectedUpdatedAt: persistedRef.current?.updatedAt
    }));
    savingPromiseRef.current = promise;
    try {
      const saved = cloneWorkflow(await promise);
      persistedRef.current = saved;
      setWorkflow((current) => {
        if (!current || current.id !== saved.id) return current;
        if (workflowRevision(current) === submittedRevision) {
          draftRef.current = saved;
          return saved;
        }
        const next = { ...current, updatedAt: saved.updatedAt };
        draftRef.current = next;
        return next;
      });
      onSaved?.(saved);
      setError(null);
      if (generationRef.current === submittedGeneration) {
        setSavingState("saved");
      } else {
        setSavingState("saving");
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => void saveNow(draftRef.current), 120);
      }
      return saved;
    } catch (cause) {
      setSavingState("error");
      setError(cause.message);
      throw cause;
    } finally {
      if (savingPromiseRef.current === promise) savingPromiseRef.current = null;
    }
  }, [api, onSaved, projectId, workflowId]);

  const change = useCallback((next) => {
    const normalized = cloneWorkflow(next);
    generationRef.current += 1;
    draftRef.current = normalized;
    setWorkflow(normalized);
    setSavingState("saving");
    setError(null);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void saveNow(normalized).catch(() => null), 520);
  }, [saveNow]);

  const runWorkflow = useCallback(async (input) => {
    if (!api?.workflows || !projectId || !workflowId) return null;
    window.clearTimeout(saveTimerRef.current);
    try {
      await saveNow(draftRef.current);
      const started = await callWithBridgeRetry(() => api.workflows.run({ projectId, workflowId, input }));
      setRun(started);
      setError(null);
      return started;
    } catch (cause) {
      setError(cause.message);
      return null;
    }
  }, [api, projectId, saveNow, workflowId]);

  const cancelRun = useCallback(async (runId) => {
    if (!api?.workflows || !projectId || !runId) return;
    try {
      const next = await api.workflows.cancel({ projectId, runId });
      setRun(next);
      setError(null);
    } catch (cause) {
      setError(cause.message);
    }
  }, [api, projectId]);

  useEffect(() => {
    if (!api?.events?.subscribe || !projectId || !workflowId) return undefined;
    return api.events.subscribe((event) => {
      const payload = event.payload ?? {};
      if (payload.projectId && payload.projectId !== projectId) return;
      if (event.type === "WorkflowRunUpdated" && payload.workflowId === workflowId) {
        setRun(payload.run);
        return;
      }
      if (event.type !== "WorkflowUpdated" || payload.workflow?.id !== workflowId) return;
      if (payload.action === "deleted") {
        onDeleted?.(workflowId);
        return;
      }
      const incoming = payload.workflow;
      if (!incoming || incoming.updatedAt === persistedRef.current?.updatedAt) return;
      if (savingState === "saved" && workflowRevision(draftRef.current) === workflowRevision(persistedRef.current)) {
        persistedRef.current = cloneWorkflow(incoming);
        draftRef.current = cloneWorkflow(incoming);
        setWorkflow(cloneWorkflow(incoming));
      } else {
        setSavingState("error");
        setError("This workflow was changed by another agent. Reload before saving over its changes.");
      }
    });
  }, [api, onDeleted, projectId, savingState, workflowId]);

  return {
    workflow,
    run,
    loading,
    savingState,
    error,
    change,
    runWorkflow,
    cancelRun,
    reload: load,
    saveNow
  };
}

function WorkflowEditor({ api, projectId, workflowId, models, compact = false, onSaved, onDeleted }) {
  const editor = useWorkflowDocument({ api, projectId, workflowId, onSaved, onDeleted });
  if (editor.loading) return <div className={styles.loadingState}><SpinnerGap className={styles.spin} size={20} />Loading workflow…</div>;
  if (!editor.workflow) {
    return (
      <div className={styles.emptyWorkspace}>
        <span><Warning size={22} /></span>
        <strong>Workflow unavailable</strong>
        <small>{editor.error ?? "The workflow could not be opened."}</small>
        <button type="button" className={styles.secondaryButton} onClick={() => void editor.reload()}><ArrowClockwise size={14} />Try again</button>
      </div>
    );
  }
  return (
    <>
      <WorkflowCanvas
        workflow={editor.workflow}
        models={models}
        run={editor.run}
        savingState={editor.savingState}
        compact={compact}
        onChange={editor.change}
        onRun={editor.runWorkflow}
        onCancel={editor.cancelRun}
      />
      {editor.error && <div className={styles.notice} data-tone="error"><Warning size={14} /><span>{editor.error}</span></div>}
    </>
  );
}

export function WorkflowWorkspace({ api = window.loom, projectId, projectName, models = [], requestedWorkflowId = null, onWorkflowSelected }) {
  const [workflows, setWorkflows] = useState([]);
  const [selectedId, setSelectedId] = useState(requestedWorkflowId);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(null);

  const loadList = useCallback(async (preferredId = null) => {
    if (!api?.workflows || !projectId) {
      setWorkflows([]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await callWithBridgeRetry(() => api.workflows.list({ projectId }));
      const next = result.data ?? [];
      setWorkflows(next);
      setSelectedId((current) => {
        const requested = preferredId ?? requestedWorkflowId;
        const selected = next.some((workflow) => workflow.id === requested)
          ? requested
          : next.some((workflow) => workflow.id === current)
            ? current
            : next[0]?.id ?? null;
        onWorkflowSelected?.(selected);
        return selected;
      });
      setError(null);
    } catch (cause) {
      setError(cause.message);
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, [api, onWorkflowSelected, projectId, requestedWorkflowId]);

  useEffect(() => { void loadList(requestedWorkflowId); }, [loadList, requestedWorkflowId]);

  useEffect(() => {
    if (!api?.events?.subscribe || !projectId) return undefined;
    return api.events.subscribe((event) => {
      if (event.type !== "WorkflowUpdated") return;
      if (event.payload?.projectId && event.payload.projectId !== projectId) return;
      void loadList(event.payload?.workflow?.id);
    });
  }, [api, loadList, projectId]);

  const createWorkflow = async () => {
    if (!api?.workflows || !projectId) return;
    try {
      const created = await callWithBridgeRetry(() => api.workflows.create({
        projectId,
        name: workflows.length ? `New workflow ${workflows.length + 1}` : "New workflow",
        description: ""
      }));
      await loadList(created.id);
      setSelectedId(created.id);
      onWorkflowSelected?.(created.id);
      setError(null);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const deleteWorkflow = async () => {
    if (!api?.workflows || !projectId || !selectedId) return;
    const target = workflows.find((workflow) => workflow.id === selectedId);
    if (!window.confirm(`Delete “${target?.name ?? "this workflow"}”?\n\nIts run history will also be removed.`)) return;
    try {
      await api.workflows.delete({ projectId, workflowId: selectedId });
      await loadList();
    } catch (cause) {
      setError(cause.message);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter((workflow) => `${workflow.name} ${workflow.description}`.toLowerCase().includes(needle));
  }, [query, workflows]);
  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? null;

  return (
    <div className={styles.workspaceOverlay} data-workflow-workspace="true">
      <div className={styles.workspaceLayout}>
        <aside className={styles.library} aria-label="Workflow library">
          <header className={styles.libraryHeader}>
            <span><small>{projectName ?? "Project"}</small><strong>Workflows</strong></span>
            <button type="button" aria-label="Create workflow" title="Create workflow" onClick={() => void createWorkflow()}><Plus size={15} /></button>
          </header>
          <label className={styles.librarySearch}>
            <MagnifyingGlass size={14} />
            <input className={styles.searchInput} aria-label="Search workflows" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflows" />
          </label>
          <div className={styles.workflowList}>
            {loading && <div className={styles.loadingState}><SpinnerGap className={styles.spin} size={17} />Loading…</div>}
            {!loading && visible.map((workflow) => (
              <button
                type="button"
                className={styles.workflowCard}
                data-active={workflow.id === selectedId}
                onClick={() => {
                  setSelectedId(workflow.id);
                  onWorkflowSelected?.(workflow.id);
                }}
                key={workflow.id}
              >
                <span className={styles.workflowCardIcon}><TreeStructure size={15} /></span>
                <span className={styles.workflowCardCopy}>
                  <strong>{workflow.name}</strong>
                  <small>{workflow.latestRun ? `${workflowStatusLabel(workflow.latestRun.status)} · ${relativeTimestamp(workflow.latestRun.createdAt)}` : `${workflow.graph.nodes.length} nodes · ${relativeTimestamp(workflow.updatedAt)}`}</small>
                </span>
                <i className={styles.workflowCardStatus} data-status={workflow.latestRun?.status ?? "idle"} />
              </button>
            ))}
            {!loading && visible.length === 0 && (
              <div className={styles.emptyLibrary}>
                <span><TreeStructure size={18} /></span>
                <strong>{workflows.length ? "No matches" : "No workflows yet"}</strong>
                <small>{workflows.length ? "Try another search." : "Create one or ask a Loom Agent to build it."}</small>
              </div>
            )}
          </div>
        </aside>

        <main className={styles.workspaceMain}>
          <header className={styles.workspaceTopbar}>
            <span className={styles.workflowCardIcon}><TreeStructure size={15} /></span>
            <span className={styles.workspaceTitle}><small>Workflows</small><strong>{selected?.name ?? projectName ?? "Loom"}</strong></span>
            <div className={styles.workspaceActions}>
              <button type="button" onClick={() => void loadList(selectedId)}><ArrowClockwise size={13} />Refresh</button>
              {selected && <button type="button" className={styles.deleteWorkflow} onClick={() => void deleteWorkflow()}><Trash size={13} />Delete</button>}
            </div>
          </header>
          <div className={styles.editorFrame}>
            {selectedId ? (
              <WorkflowEditor
                api={api}
                projectId={projectId}
                workflowId={selectedId}
                models={models}
                onSaved={(saved) => setWorkflows((current) => current.map((workflow) => workflow.id === saved.id ? { ...workflow, ...saved } : workflow))}
                onDeleted={() => void loadList()}
              />
            ) : (
              <div className={styles.emptyWorkspace}>
                <span><TreeStructure size={22} /></span>
                <strong>Build a Loom-native workflow</strong>
                <small>Connect triggers, Loom Agents, and outputs. Agent nodes can run quietly in the background or become full foreground task threads.</small>
                <button type="button" className={styles.primaryButton} onClick={() => void createWorkflow()}><Plus size={14} />Create workflow</button>
              </div>
            )}
          </div>
        </main>
      </div>
      {error && <div className={styles.notice} data-tone="error"><Warning size={14} /><span>{error}</span></div>}
    </div>
  );
}

export function WorkflowPreview({ api = window.loom, projectId, workflowId, models = [], reason = "open", onOpenWorkspace, onClose }) {
  const [title, setTitle] = useState("Workflow");
  return (
    <section className={styles.previewOverlay} aria-label="Workflow preview" data-workflow-preview="true">
      <header className={styles.previewHeader}>
        <span className={styles.previewTab}><TreeStructure size={13} /><span>{title}</span></span>
        <small>{reason === "run" ? "Agent is running this workflow" : reason === "edit" ? "Agent is editing this workflow" : "Loom workflow canvas"}</small>
        <div className={styles.previewActions}>
          <button type="button" onClick={() => onOpenWorkspace?.(workflowId)}><Eye size={13} />Open full workspace</button>
          <button type="button" className={styles.iconButton} aria-label="Close workflow preview" title="Close workflow preview" onClick={onClose}><X size={13} /></button>
        </div>
      </header>
      <div className={styles.previewBody}>
        <WorkflowEditor
          api={api}
          projectId={projectId}
          workflowId={workflowId}
          models={models}
          compact
          onSaved={(saved) => setTitle(saved.name)}
          onDeleted={onClose}
        />
      </div>
    </section>
  );
}
