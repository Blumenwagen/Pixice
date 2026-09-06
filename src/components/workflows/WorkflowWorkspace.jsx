import { getPixiceApi } from "../../connect/client.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  Eye,
  MagnifyingGlass,
  Plus,
  SpinnerGap,
  TreeStructure,
  Warning,
  X
} from "../icons/index.jsx";
import { WorkflowCanvas } from "./WorkflowCanvas.jsx";
import { cloneWorkflow, workflowStatusLabel } from "./workflow-utils.js";
import styles from "./WorkflowWorkspace.module.css";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancelling"]);
const EMPTY_WORKFLOW_LIST = [];

function WorkflowSkeleton({ label = "Loading workflow", rows = 3 }) {
  return (
    <div className={styles.workflowSkeleton} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => <span style={{ "--workflow-skeleton-width": `${92 - index * 12}%` }} key={index}><i /><b /></span>)}
    </div>
  );
}

function workflowRevision(workflow) {
  if (!workflow) return "";
  return JSON.stringify([workflow.name, workflow.description, workflow.enabled, workflow.graph]);
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
  const [generation, setGeneration] = useState({ state: "idle" });
  const [error, setError] = useState(null);
  const persistedRef = useRef(null);
  const draftRef = useRef(null);
  const saveTimerRef = useRef(null);
  const generationRef = useRef(0);
  const savingPromiseRef = useRef(null);
  const generationTimerRef = useRef(null);

  const load = useCallback(async () => {
    if (!api?.workflows || !projectId || !workflowId) {
      setWorkflow(null);
      setRun(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    setGeneration({ state: "idle" });
    try {
      const result = typeof api.workflows.read === "function"
        ? await callWithBridgeRetry(() => api.workflows.read({ projectId, workflowId }))
        : await callWithBridgeRetry(async () => {
            const listed = await api.workflows.list({ projectId });
            const workflow = (listed.data ?? []).find((candidate) => candidate.id === workflowId);
            if (!workflow) throw new Error("The workflow could not be found.");
            return {
              workflow: {
                ...workflow,
                graph: workflow.graph ?? { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
              },
              runs: workflow.latestRun ? [workflow.latestRun] : []
            };
          });
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
    window.clearTimeout(generationTimerRef.current);
    generationRef.current += 1;
    void load();
    return () => {
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(generationTimerRef.current);
    };
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
      enabled: Boolean(submitted.enabled),
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
    if (workflowRevision(normalized) === workflowRevision(draftRef.current)) return;
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

  const generateWorkflow = useCallback(async () => {
    if (!api?.workflows?.generate || !projectId || !workflowId || !draftRef.current) return null;
    if (!String(draftRef.current.description ?? "").trim()) {
      const message = "Add a workflow description before generating.";
      setGeneration({ state: "error", message });
      setError(message);
      return null;
    }
    window.clearTimeout(saveTimerRef.current);
    window.clearTimeout(generationTimerRef.current);
    const startedAt = Date.now();
    setGeneration({ state: "saving", startedAt, message: "Saving your workflow brief" });
    setError(null);
    try {
      await saveNow(draftRef.current);
      const sourceRevision = workflowRevision(draftRef.current);
      setGeneration({ state: "generating", startedAt, message: "Choosing nodes, settings, and connections" });
      const result = await callWithBridgeRetry(() => api.workflows.generate({ projectId, workflowId }));
      if (workflowRevision(draftRef.current) !== sourceRevision) {
        throw new Error("The workflow changed while the agent was working. Generate again to use the latest description.");
      }
      setGeneration({ state: "applying", startedAt, model: result.model, message: "Validating and placing the generated graph" });
      const next = cloneWorkflow({ ...draftRef.current, graph: result.graph });
      const saved = await saveNow(next);
      generationRef.current += 1;
      persistedRef.current = saved;
      draftRef.current = saved;
      setWorkflow(saved);
      setSavingState("saved");
      setGeneration({
        state: "complete",
        startedAt,
        model: result.model,
        nodes: saved.graph.nodes.length,
        edges: saved.graph.edges.length,
        message: "Workflow generated"
      });
      generationTimerRef.current = window.setTimeout(() => setGeneration({ state: "idle" }), 1600);
      return saved;
    } catch (cause) {
      const message = cause?.message || "Workflow generation failed. Your existing canvas was not changed.";
      setGeneration({ state: "error", startedAt, message });
      setError(message);
      return null;
    }
  }, [api, projectId, saveNow, workflowId]);

  useEffect(() => {
    if (!api?.events?.subscribe || !projectId || !workflowId) return undefined;
    let disposed = false;
    const receive = (event) => {
      const payload = event.payload ?? {};
      if (event.type === "ApplicationResync") {
        void api.workflows.read({ projectId, workflowId }).then((result) => {
          if (disposed) return;
          const runs = result.runs ?? [];
          setRun(runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? runs[0] ?? null);
          receive({ type: "WorkflowUpdated", payload: { projectId, workflow: result.workflow } });
        }).catch(() => {});
        return;
      }
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
      if (workflowRevision(incoming) === workflowRevision(draftRef.current)) {
        persistedRef.current = cloneWorkflow(incoming);
        setWorkflow((current) => current ? { ...current, updatedAt: incoming.updatedAt } : current);
        return;
      }
      if (savingState === "saved" && workflowRevision(draftRef.current) === workflowRevision(persistedRef.current)) {
        persistedRef.current = cloneWorkflow(incoming);
        draftRef.current = cloneWorkflow(incoming);
        setWorkflow(cloneWorkflow(incoming));
      } else {
        setSavingState("error");
        setError("This workflow was changed by another agent. Reload before saving over its changes.");
      }
    };
    const unsubscribe = api.events.subscribe(receive);
    return () => { disposed = true; unsubscribe(); };
  }, [api, onDeleted, projectId, savingState, workflowId]);

  return {
    workflow,
    run,
    loading,
    savingState,
    error,
    generation,
    change,
    generateWorkflow,
    runWorkflow,
    cancelRun,
    reload: load,
    saveNow
  };
}

function WorkflowEditor({ api, projectId, workflowId, workflows = EMPTY_WORKFLOW_LIST, models, compact = false, onSaved, onDeleted, onDelete }) {
  const editor = useWorkflowDocument({ api, projectId, workflowId, onSaved, onDeleted });
  const [loadedWorkflows, setLoadedWorkflows] = useState(workflows);

  useEffect(() => {
    setLoadedWorkflows(workflows);
  }, [workflows]);

  useEffect(() => {
    if (workflows.length || !api?.workflows || !projectId) return undefined;
    let alive = true;
    void callWithBridgeRetry(() => api.workflows.list({ projectId }))
      .then((result) => { if (alive) setLoadedWorkflows(result.data ?? []); })
      .catch(() => null);
    return () => { alive = false; };
  }, [api, projectId, workflows.length]);

  if (editor.loading) return <WorkflowSkeleton />;
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
        workflows={loadedWorkflows}
        api={api}
        models={models}
        run={editor.run}
        savingState={editor.savingState}
        generation={editor.generation}
        compact={compact}
        onChange={editor.change}
        onGenerate={editor.generateWorkflow}
        onRun={editor.runWorkflow}
        onCancel={editor.cancelRun}
        onDelete={onDelete}
      />
      {editor.error && <div className={styles.notice} data-tone="error"><Warning size={14} /><span>{editor.error}</span></div>}
    </>
  );
}

export function WorkflowWorkspace({ api = getPixiceApi(), projectId, projectName, models = EMPTY_WORKFLOW_LIST, requestedWorkflowId = null, onWorkflowSelected, onBack }) {
  const [workflows, setWorkflows] = useState([]);
  const [selectedId, setSelectedId] = useState(requestedWorkflowId);
  const selectedIdRef = useRef(requestedWorkflowId);
  const requestedWorkflowIdRef = useRef(requestedWorkflowId);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    requestedWorkflowIdRef.current = requestedWorkflowId;
  }, [requestedWorkflowId]);

  const selectWorkflow = useCallback((workflowId) => {
    selectedIdRef.current = workflowId;
    setSelectedId(workflowId);
    onWorkflowSelected?.(workflowId);
  }, [onWorkflowSelected]);

  const loadList = useCallback(async (preferredId = requestedWorkflowIdRef.current, showLoading = true) => {
    if (!api?.workflows || !projectId) {
      setWorkflows([]);
      selectWorkflow(null);
      setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const result = await callWithBridgeRetry(() => api.workflows.list({ projectId }));
      const next = result.data ?? [];
      setWorkflows(next);
      const requested = preferredId;
      const current = selectedIdRef.current;
      const selected = next.some((candidate) => candidate.id === requested)
        ? requested
        : next.some((candidate) => candidate.id === current)
          ? current
          : next[0]?.id ?? null;
      selectWorkflow(selected);
      setError(null);
    } catch (cause) {
      setError(cause.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [api, projectId, selectWorkflow]);

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!requestedWorkflowId || requestedWorkflowId === selectedIdRef.current) return;
    if (workflows.some((candidate) => candidate.id === requestedWorkflowId)) {
      selectWorkflow(requestedWorkflowId);
      return;
    }
    void loadList(requestedWorkflowId);
  }, [loadList, requestedWorkflowId, selectWorkflow, workflows]);

  useEffect(() => {
    if (!api?.events?.subscribe || !projectId) return undefined;
    return api.events.subscribe((event) => {
      if (event.type === "ApplicationResync") { void loadList(selectedIdRef.current, false); return; }
      if (event.type !== "WorkflowUpdated") return;
      if (event.payload?.projectId && event.payload.projectId !== projectId) return;
      const incoming = event.payload?.workflow;
      if (event.payload?.action === "deleted") {
        void loadList(selectedIdRef.current, false);
        return;
      }
      if (!incoming) return;
      setWorkflows((current) => current.some((candidate) => candidate.id === incoming.id)
        ? current.map((candidate) => candidate.id === incoming.id ? { ...candidate, ...incoming } : candidate)
        : [...current, incoming]);
    });
  }, [api, loadList, projectId]);

  const createWorkflow = async () => {
    if (!api?.workflows || !projectId) return;
    try {
      const created = await callWithBridgeRetry(() => api.workflows.create({
        projectId,
        name: workflows.length ? `New workflow ${workflows.length + 1}` : "New workflow",
        description: "",
        enabled: false
      }));
      setWorkflows((current) => current.some((candidate) => candidate.id === created.id)
        ? current.map((candidate) => candidate.id === created.id ? { ...candidate, ...created } : candidate)
        : [...current, created]);
      selectWorkflow(created.id);
      setError(null);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const deleteWorkflow = async () => {
    if (!api?.workflows || !projectId || !selectedId) return;
    const target = workflows.find((candidate) => candidate.id === selectedId);
    if (!window.confirm(`Delete “${target?.name ?? "this workflow"}”?\n\nIts run history will also be removed.`)) return;
    try {
      await api.workflows.delete({ projectId, workflowId: selectedId });
      const remaining = workflows.filter((candidate) => candidate.id !== selectedId);
      setWorkflows(remaining);
      selectWorkflow(remaining[0]?.id ?? null);
    } catch (cause) {
      setError(cause.message);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter((candidate) => `${candidate.name} ${candidate.description}`.toLowerCase().includes(needle));
  }, [query, workflows]);
  return (
    <div className={styles.workspaceOverlay} data-workflow-workspace="true">
      <div className={styles.workspaceLayout}>
        <aside className={styles.library} aria-label="Workflow navigation">
          <button type="button" className={styles.libraryBack} onClick={onBack}><CaretLeft size={16} />Back to task</button>
          <header className={styles.libraryHeader}>
            <span><small>{projectName ?? "Project"}</small><strong>Workflows</strong></span>
            <button type="button" aria-label="Create workflow" title="Create workflow" onClick={() => void createWorkflow()}><Plus size={15} /></button>
          </header>
          <label className={styles.librarySearch}>
            <MagnifyingGlass size={14} />
            <input className={styles.searchInput} aria-label="Search workflows" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflows" />
          </label>
          <nav className={styles.workflowList}>
            {loading && workflows.length === 0 && <WorkflowSkeleton label="Loading workflows" rows={4} />}
            {visible.map((candidate) => (
              <button
                type="button"
                className={styles.workflowCard}
                data-active={candidate.id === selectedId}
                aria-current={candidate.id === selectedId ? "page" : undefined}
                onClick={() => selectWorkflow(candidate.id)}
                key={candidate.id}
              >
                <span className={styles.workflowCardIcon}><TreeStructure size={15} /></span>
                <span className={styles.workflowCardCopy}>
                  <strong>{candidate.name}</strong>
                  <small>{candidate.latestRun
                    ? `${candidate.enabled ? "Automatic · " : ""}${workflowStatusLabel(candidate.latestRun.status)} · ${relativeTimestamp(candidate.latestRun.createdAt)}`
                    : `${candidate.enabled ? "Automatic · " : ""}${candidate.graph?.nodes?.length ?? 0} nodes · ${relativeTimestamp(candidate.updatedAt)}`}</small>
                </span>
                <CaretRight className={styles.workflowCardCaret} size={13} />
              </button>
            ))}
            {!loading && visible.length === 0 && (
              <div className={styles.emptyLibrary}>
                <span><TreeStructure size={18} /></span>
                <strong>{workflows.length ? "No matches" : "No workflows yet"}</strong>
                <small>{workflows.length ? "Try another search." : "Create one or ask a Pixice Agent to build it."}</small>
              </div>
            )}
          </nav>
        </aside>

        <main className={styles.workspaceMain}>
          <div className={styles.editorFrame}>
            {selectedId ? (
              <WorkflowEditor
                api={api}
                projectId={projectId}
                workflowId={selectedId}
                workflows={workflows}
                models={models}
                onSaved={(saved) => setWorkflows((current) => current.map((candidate) => candidate.id === saved.id ? { ...candidate, ...saved } : candidate))}
                onDeleted={() => void loadList()}
                onDelete={() => void deleteWorkflow()}
              />
            ) : loading ? (
              <WorkflowSkeleton />
            ) : (
              <div className={styles.emptyWorkspace}>
                <span><TreeStructure size={22} /></span>
                <strong>Build a Pixice-native workflow</strong>
                <small>Connect schedules or local webhooks to APIs, deterministic data processing, SQLite, subworkflows, notifications, Pixice Board actions, and Pixice Agents.</small>
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

export function WorkflowPreview({ api = getPixiceApi(), projectId, workflowId, workflowName = "Workflow", models = EMPTY_WORKFLOW_LIST, reason = "open", onOpenWorkspace, onClose, onTitleChange, tabbed = false }) {
  const [title, setTitle] = useState(workflowName || "Workflow");
  const handleSaved = useCallback((saved) => setTitle(saved.name), []);

  useEffect(() => {
    setTitle(workflowName || "Workflow");
  }, [workflowId, workflowName]);
  useEffect(() => {
    onTitleChange?.(title);
  }, [title]);

  return (
    <section className={styles.previewOverlay} aria-label="Workflow preview" data-workflow-preview="true" data-tabbed={tabbed}>
      {!tabbed && <header className={styles.previewHeader}>
        <span className={styles.previewTab}><TreeStructure size={13} /><span>{title}</span></span>
        <small>{reason === "run" ? "Agent is running this workflow" : reason === "edit" ? "Agent is editing this workflow" : "Pixice workflow canvas"}</small>
        <div className={styles.previewActions}>
          <button type="button" onClick={() => onOpenWorkspace?.(workflowId)}><Eye size={13} />Open full workspace</button>
          <button type="button" className={styles.iconButton} aria-label="Close workflow preview" title="Close workflow preview" onClick={onClose}><X size={13} /></button>
        </div>
      </header>}
      {tabbed && <div className={styles.previewContext}><span>{reason === "run" ? "Running workflow" : reason === "edit" ? "Editing workflow" : "Workflow canvas"}</span><button type="button" onClick={() => onOpenWorkspace?.(workflowId)}><Eye size={13} />Open Workflows</button></div>}
      <div className={styles.previewBody}>
        <WorkflowEditor
          api={api}
          projectId={projectId}
          workflowId={workflowId}
          models={models}
          compact
          onSaved={handleSaved}
          onDeleted={onClose}
        />
      </div>
    </section>
  );
}
