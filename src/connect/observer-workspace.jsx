import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationWorkspace } from '../App.jsx';
import { createWorkspaceStorage } from './execution-storage.js';
import './mobile-connect.css';

const REFRESH_EVENT_TYPES = new Set(['ActivityReceived', 'AgentUpdated', 'TaskUpdated', 'TaskReceiptUpdated']);
const COMPLETION_METHODS = new Set(['turn/completed', 'task/completed', 'thread/completed']);
const MAX_REFRESHES_PER_SECOND = 4;
const REFRESH_WINDOW_MS = 1000;

function safeProjectIds(value) {
  return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []);
}

function projectLabel(project) {
  if (!project) return 'Unknown project';
  return [project.displayName || project.name || project.id, project.canonicalPath || project.path].filter(Boolean).join(' · ');
}

function taskLabel(task) {
  return task?.title || task?.name || task?.id || 'Untitled task';
}

function fileLabel(file) {
  return file?.path || file?.name || 'Unnamed file';
}

function receiptSummary(receipt) {
  if (!receipt) return null;
  return {
    status: receipt.status || 'unknown',
    revision: receipt.revision ?? 'n/a',
    projectId: receipt.projectId || 'n/a',
    threadId: receipt.threadId || 'n/a',
    checks: Array.isArray(receipt.checks) ? receipt.checks.map((check) => ({
      command: check.command,
      status: check.status,
      exitCode: check.exitCode
    })) : [],
    changes: receipt.changes ? {
      fileCount: receipt.changes.fileCount ?? receipt.changes.files?.length ?? 0,
      files: (receipt.changes.files ?? []).map((file) => ({ path: file.path, plus: file.plus, minus: file.minus }))
    } : null
  };
}

function filePreviewText(file) {
  if (!file) return '';
  if (typeof file.content === 'string') return file.content;
  if (typeof file.text === 'string') return file.text;
  return '';
}

function refreshFlagsForEvent(event) {
  const payload = event?.payload ?? {};
  const method = payload.method;
  const completed = COMPLETION_METHODS.has(method)
    || payload.turn?.status === 'completed'
    || payload.status?.type === 'completed';
  if (event?.type === 'TaskReceiptUpdated') return { thread: true, receipt: true };
  return { thread: true, receipt: completed };
}

function mergeRefreshFlags(current, next) {
  return {
    thread: Boolean(current?.thread || next?.thread),
    receipt: Boolean(current?.receipt || next?.receipt),
    board: Boolean(current?.board || next?.board),
    review: Boolean(current?.review || next?.review)
  };
}

export function ObserverWorkspace({
  api,
  hostId,
  hostLabel,
  projectIds = [],
  initialProjectId = null,
  initialThreadId = null,
  onOriginChange,
  onOpenOverview
} = {}) {
  const allowedProjectKey = JSON.stringify([...safeProjectIds(projectIds)].sort());
  const allowedProjectIds = useMemo(() => new Set(JSON.parse(allowedProjectKey)), [allowedProjectKey]);
  const storage = useMemo(() => createWorkspaceStorage(hostId), [hostId]);
  const requestedProjectId = initialProjectId ?? null;
  const requestedThreadId = initialThreadId ?? null;
  const [projects, setProjects] = useState([]);
  const [models, setModels] = useState([]);
  const [runtime, setRuntime] = useState({ state: 'unknown', connected: false });
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [thread, setThread] = useState(null);
  const [plan, setPlan] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [board, setBoard] = useState({ data: [], phases: [] });
  const [review, setReview] = useState(null);
  const [selectedFilePath, setSelectedFilePath] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [loading, setLoading] = useState({ bootstrap: true, project: false, thread: false, file: false });
  const [error, setError] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [completedBootstrapGeneration, setCompletedBootstrapGeneration] = useState(0);
  const hostGenerationRef = useRef(0);
  const selectionRef = useRef({ generation: 0, hostId, api, projectId: null, threadId: null });
  const refreshTargetRef = useRef({ projectId: null, threadId: null, filePath: null });
  const previousRequestRef = useRef({ projectId: requestedProjectId, threadId: requestedThreadId });
  const refreshTimerRef = useRef(null);
  const refreshCoordinatorRef = useRef({ inFlight: false, pending: null, scheduled: null, disposed: false, starts: [] });
  const scheduleRefreshRef = useRef(null);
  const fileRequestRef = useRef(0);
  const selectedFilePathRef = useRef(null);
  selectedFilePathRef.current = selectedFilePath;

  const isHostCurrent = useCallback((generation) => (
    hostGenerationRef.current === generation
    && selectionRef.current.hostId === hostId
    && selectionRef.current.api === api
  ), [api, hostId]);

  const isSelectionCurrent = useCallback((token) => (
    isHostCurrent(token.hostGeneration)
    && selectionRef.current.generation === token.selectionGeneration
    && selectionRef.current.projectId === token.projectId
    && selectionRef.current.threadId === token.threadId
  ), [isHostCurrent]);

  const clearSelectionData = useCallback(({ clearProjectData = true, clearThreads = true, clearFiles = true } = {}) => {
    if (clearThreads) setThreads([]);
    setSelectedThreadId(null);
    setThread(null);
    setPlan([]);
    setReceipt(null);
    if (clearFiles) {
      setFilePreview(null);
      setSelectedFilePath(null);
    }
    if (clearProjectData) {
      setBoard({ data: [], phases: [] });
      setReview(null);
    }
  }, []);

  const commitSelection = useCallback((projectId, threadId = null, { preserveFiles = false } = {}) => {
    const current = selectionRef.current;
    const next = {
      ...current,
      generation: current.generation + 1,
      projectId: projectId || null,
      threadId: threadId || null
    };
    selectionRef.current = next;
    clearSelectionData({
      clearProjectData: current.projectId !== next.projectId,
      clearThreads: current.projectId !== next.projectId,
      clearFiles: !preserveFiles && current.projectId !== next.projectId
    });
    setSelectedProjectId(next.projectId);
    setSelectedThreadId(next.threadId);
    setError('');
  }, [clearSelectionData]);

  const readThreadReceipt = useCallback(async (token) => {
    if (!token.projectId || !token.threadId || !api?.threads?.read) return;
    const results = await Promise.allSettled([
      api.threads.read({ projectId: token.projectId, threadId: token.threadId }),
      api.tasks?.receipt ? api.tasks.receipt({ projectId: token.projectId, threadId: token.threadId }) : Promise.resolve(null)
    ]);
    if (!isSelectionCurrent(token)) return;
    const [threadResult, receiptResult] = results;
    if (threadResult.status === 'fulfilled') {
      setThread(threadResult.value?.thread ?? null);
      setPlan(Array.isArray(threadResult.value?.plan) ? threadResult.value.plan : []);
    } else {
      setError(threadResult.reason?.message || 'The selected task could not be read.');
      setThread(null);
      setPlan([]);
    }
    if (receiptResult.status === 'fulfilled') setReceipt(receiptResult.value ?? null);
  }, [api, isSelectionCurrent]);

  const runRefresh = useCallback(async (flags = {}) => {
    const coordinator = refreshCoordinatorRef.current;
    if (coordinator.disposed || coordinator.inFlight) return;
    const token = {
      hostGeneration: hostGenerationRef.current,
      selectionGeneration: selectionRef.current.generation,
      projectId: selectionRef.current.projectId,
      threadId: selectionRef.current.threadId
    };
    if (!token.projectId) return;
    const requests = [];
    if (flags.thread && token.threadId && api?.threads?.read) {
      requests.push({ key: 'thread', promise: api.threads.read({ projectId: token.projectId, threadId: token.threadId }) });
    }
    if (flags.receipt && token.threadId && api?.tasks?.receipt) {
      requests.push({ key: 'receipt', promise: api.tasks.receipt({ projectId: token.projectId, threadId: token.threadId }) });
    }
    if (flags.board && api?.board?.list) {
      requests.push({ key: 'board', promise: api.board.list({ projectId: token.projectId }) });
    }
    if (flags.review && api?.review?.read) {
      requests.push({ key: 'review', promise: api.review.read({ projectId: token.projectId }) });
    }
    if (!requests.length) return;
    coordinator.inFlight = true;
    coordinator.starts = coordinator.starts.filter((startedAt) => Date.now() - startedAt < REFRESH_WINDOW_MS);
    coordinator.starts.push(Date.now());
    try {
      const results = await Promise.allSettled(requests.map((request) => request.promise));
      if (!coordinator.disposed && isSelectionCurrent(token) && refreshCoordinatorRef.current === coordinator) {
        results.forEach((result, index) => {
          const key = requests[index].key;
          if (result.status === 'rejected') {
            setError(result.reason?.message || `The selected ${key} could not be refreshed.`);
            return;
          }
          if (key === 'thread') {
            setThread(result.value?.thread ?? null);
            setPlan(Array.isArray(result.value?.plan) ? result.value.plan : []);
          } else if (key === 'receipt') {
            setReceipt(result.value ?? null);
          } else if (key === 'board') {
            setBoard({ data: result.value?.data ?? [], phases: result.value?.phases ?? [] });
          } else if (key === 'review') {
            setReview({ ...result.value, projectId: token.projectId });
          }
        });
      }
    } finally {
      if (refreshCoordinatorRef.current !== coordinator) return;
      coordinator.inFlight = false;
      if (coordinator.pending && !coordinator.disposed) {
        const followup = coordinator.pending;
        coordinator.pending = null;
        scheduleRefreshRef.current?.(followup);
      }
    }
  }, [api, isSelectionCurrent]);

  const scheduleRefresh = useCallback((flags = {}) => {
    const coordinator = refreshCoordinatorRef.current;
    if (coordinator.disposed) return;
    if (coordinator.inFlight) {
      coordinator.pending = mergeRefreshFlags(coordinator.pending, flags);
      return;
    }
    coordinator.scheduled = mergeRefreshFlags(coordinator.scheduled, flags);
    if (refreshTimerRef.current !== null) return;
    const waitForRateLimit = () => {
      const now = Date.now();
      coordinator.starts = coordinator.starts.filter((startedAt) => now - startedAt < REFRESH_WINDOW_MS);
      if (coordinator.starts.length < MAX_REFRESHES_PER_SECOND) return 0;
      return Math.max(1, coordinator.starts[0] + REFRESH_WINDOW_MS - now);
    };
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      if (coordinator.disposed || coordinator.inFlight) return;
      const delay = waitForRateLimit();
      if (delay) {
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          const next = coordinator.scheduled;
          coordinator.scheduled = null;
          void runRefresh(next);
        }, delay);
        return;
      }
      const next = coordinator.scheduled;
      coordinator.scheduled = null;
      void runRefresh(next);
    }, waitForRateLimit());
  }, [runRefresh]);
  scheduleRefreshRef.current = scheduleRefresh;

  const refreshProject = useCallback(() => {
    const coordinator = refreshCoordinatorRef.current;
    coordinator.disposed = true;
    coordinator.pending = null;
    coordinator.scheduled = null;
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    hostGenerationRef.current += 1;
    setRefreshRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const previousSelection = selectionRef.current;
    const previousRequest = previousRequestRef.current;
    const requestChanged = previousRequest.projectId !== requestedProjectId || previousRequest.threadId !== requestedThreadId;
    const preserveSelection = refreshRevision > 0
      && !requestChanged
      && previousSelection.hostId === hostId
      && previousSelection.api === api;
    const preferredProjectId = preserveSelection ? (previousSelection.projectId ?? requestedProjectId) : requestedProjectId;
    const preferredThreadId = preserveSelection
      ? (previousSelection.threadId ?? (preferredProjectId === requestedProjectId ? requestedThreadId : null))
      : requestedThreadId;
    previousRequestRef.current = { projectId: requestedProjectId, threadId: requestedThreadId };
    refreshTargetRef.current = {
      projectId: preferredProjectId,
      threadId: preferredThreadId,
      filePath: preserveSelection ? selectedFilePathRef.current : null
    };
    const hostGeneration = ++hostGenerationRef.current;
    const oldCoordinator = refreshCoordinatorRef.current;
    oldCoordinator.disposed = true;
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    refreshCoordinatorRef.current = { inFlight: false, pending: null, scheduled: null, disposed: false, starts: [] };
    selectionRef.current = { generation: selectionRef.current.generation + 1, hostId, api, projectId: null, threadId: null };
    setProjects([]);
    setModels([]);
    setRuntime({ state: 'unknown', connected: false });
    setSelectedProjectId(null);
    setSelectedThreadId(null);
    clearSelectionData({ clearFiles: !preserveSelection });
    setLoading({ bootstrap: true, project: false, thread: false, file: false });
    setError('');
    let cancelled = false;
    Promise.resolve(api?.app?.bootstrap?.()).then((result) => {
      if (cancelled || !isHostCurrent(hostGeneration)) return;
      const fetchedProjects = Array.isArray(result?.projects) ? result.projects : [];
      const nextProjects = fetchedProjects.filter((project) => allowedProjectIds.has(project.id));
      setProjects(nextProjects);
      setModels(Array.isArray(result?.models) ? result.models : []);
      setRuntime(result?.runtime ?? { state: 'unknown', connected: false });
      const requestedProject = preferredProjectId
        ? nextProjects.find((project) => project.id === preferredProjectId)
        : null;
      if (requestedProjectId && !allowedProjectIds.has(requestedProjectId)) {
        setError('The requested project is not available in this observer scope.');
      } else if (preferredThreadId && !preferredProjectId) {
        setError('The requested task cannot be selected without a project.');
      } else if (preferredProjectId && !requestedProject) {
        setError(preferredProjectId === requestedProjectId
          ? 'The requested project was not returned by the host.'
          : 'The selected project is no longer available in this observer scope.');
      } else {
        commitSelection(requestedProject?.id ?? nextProjects[0]?.id ?? null, null, { preserveFiles: preserveSelection });
        setCompletedBootstrapGeneration((value) => value + 1);
      }
    }).catch((cause) => {
      if (!cancelled && isHostCurrent(hostGeneration)) setError(cause.message || 'The host could not be read.');
    }).finally(() => {
      if (!cancelled && isHostCurrent(hostGeneration)) setLoading((current) => ({ ...current, bootstrap: false }));
    });
    return () => {
      cancelled = true;
      refreshCoordinatorRef.current.disposed = true;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [allowedProjectIds, api, clearSelectionData, commitSelection, isHostCurrent, hostId, refreshRevision, requestedProjectId, requestedThreadId]);

  useEffect(() => {
    if (!selectedProjectId
      || selectionRef.current.projectId !== selectedProjectId
      || !isHostCurrent(hostGenerationRef.current)) return undefined;
    const token = {
      hostGeneration: hostGenerationRef.current,
      selectionGeneration: selectionRef.current.generation,
      projectId: selectedProjectId,
      threadId: null
    };
    let cancelled = false;
    setLoading((current) => ({ ...current, project: true }));
    Promise.allSettled([
      api?.threads?.list?.({ projectId: selectedProjectId }) ?? Promise.resolve({ data: [] }),
      api?.board?.list?.({ projectId: selectedProjectId }) ?? Promise.resolve({ data: [], phases: [] }),
      api?.review?.read?.({ projectId: selectedProjectId }) ?? Promise.resolve(null)
    ]).then(([threadResult, boardResult, reviewResult]) => {
      if (cancelled || !isSelectionCurrent(token)) return;
      if (threadResult.status === 'rejected') {
        setError(threadResult.reason?.message || 'Tasks could not be read.');
        setThreads([]);
      } else {
        const nextThreads = Array.isArray(threadResult.value?.data) ? threadResult.value.data : [];
        setThreads(nextThreads);
        const target = refreshTargetRef.current;
        const targetThreadId = target.projectId === selectedProjectId ? target.threadId : null;
        if (targetThreadId) {
          const requestedThread = nextThreads.find((candidate) => candidate.id === targetThreadId);
          if (!requestedThread) {
            setError('The requested task is not available in this observer scope.');
          } else {
            commitSelection(selectedProjectId, requestedThread.id);
          }
        } else {
          commitSelection(selectedProjectId, nextThreads[0]?.id ?? null);
        }
        if (target.projectId === selectedProjectId) {
          refreshTargetRef.current = { projectId: selectedProjectId, threadId: null, filePath: target.filePath };
        }
      }
      if (boardResult.status === 'fulfilled') setBoard({ data: boardResult.value?.data ?? [], phases: boardResult.value?.phases ?? [] });
      else setError(boardResult.reason?.message || 'Board items could not be read.');
      if (reviewResult.status === 'fulfilled') setReview(reviewResult.value ? { ...reviewResult.value, projectId: selectedProjectId } : null);
      else setError(reviewResult.reason?.message || 'Project files could not be read.');
    }).finally(() => {
      if (!cancelled && isHostCurrent(token.hostGeneration) && selectionRef.current.projectId === selectedProjectId) setLoading((current) => ({ ...current, project: false }));
    });
    return () => { cancelled = true; };
  }, [api, commitSelection, completedBootstrapGeneration, isHostCurrent, isSelectionCurrent, refreshRevision, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedThreadId) {
      setLoading((current) => ({ ...current, thread: false }));
      return undefined;
    }
    const token = {
      hostGeneration: hostGenerationRef.current,
      selectionGeneration: selectionRef.current.generation,
      projectId: selectedProjectId,
      threadId: selectedThreadId
    };
    let cancelled = false;
    setLoading((current) => ({ ...current, thread: true }));
    readThreadReceipt(token).finally(() => {
      if (!cancelled && isSelectionCurrent(token)) setLoading((current) => ({ ...current, thread: false }));
    });
    return () => { cancelled = true; };
  }, [isSelectionCurrent, readThreadReceipt, selectedProjectId, selectedThreadId]);

  useEffect(() => {
    if (!api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      const payload = event?.payload ?? {};
      if (payload.hostId && payload.hostId !== hostId) return;
      if (event.type === 'ApplicationResync' || event.type === 'ConnectReset') {
        refreshProject();
        return;
      }
      if (event.type === 'RuntimeStatus') {
        if (isHostCurrent(hostGenerationRef.current)) setRuntime(payload);
        if (payload.resync || payload.state === 'reconnecting') refreshProject();
        return;
      }
      if (event.type === 'ServiceConnectionState') {
        if (isHostCurrent(hostGenerationRef.current)) setRuntime((current) => ({ ...current, ...payload }));
        if (payload.resync || payload.state === 'reconnecting') refreshProject();
        return;
      }
      const eventProjectId = payload.projectId ?? payload.task?.projectId;
      if (eventProjectId && eventProjectId !== selectionRef.current.projectId) return;
      if (payload.threadId && payload.threadId !== selectionRef.current.threadId) return;
      if (event.type === 'BoardUpdated') {
        scheduleRefresh({ board: true });
        return;
      }
      if (!selectionRef.current.projectId || !REFRESH_EVENT_TYPES.has(event.type)) return;
      scheduleRefresh(refreshFlagsForEvent(event));
    });
  }, [api, hostId, isHostCurrent, refreshProject, scheduleRefresh]);

  const files = Array.isArray(review?.files) ? review.files : [];
  useEffect(() => {
    if (!files.length) {
      if (loading.bootstrap || loading.project) return;
      setSelectedFilePath(null);
      setFilePreview(null);
      return;
    }
    const target = refreshTargetRef.current;
    const preferredFilePath = target.projectId === selectedProjectId ? target.filePath : null;
    const hasPreferredFile = preferredFilePath && files.some((file) => file.path === preferredFilePath);
    const nextFilePath = files.some((file) => file.path === selectedFilePathRef.current)
      ? selectedFilePathRef.current
      : hasPreferredFile ? preferredFilePath : files[0].path;
    if (target.projectId === selectedProjectId) refreshTargetRef.current = { projectId: null, threadId: null, filePath: null };
    setSelectedFilePath(nextFilePath);
  }, [files, loading.bootstrap, loading.project, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedFilePath || !api?.files?.preview) return undefined;
    const requestId = ++fileRequestRef.current;
    const hostGeneration = hostGenerationRef.current;
    const selectionGeneration = selectionRef.current.generation;
    let cancelled = false;
    setLoading((current) => ({ ...current, file: true }));
    api.files.preview({ projectId: selectedProjectId, path: selectedFilePath }).then((result) => {
      if (cancelled || requestId !== fileRequestRef.current || !isHostCurrent(hostGeneration) || selectionRef.current.generation !== selectionGeneration || selectionRef.current.projectId !== selectedProjectId) return;
      setFilePreview(result ?? null);
    }).catch((cause) => {
      if (!cancelled && requestId === fileRequestRef.current && isHostCurrent(hostGeneration) && selectionRef.current.generation === selectionGeneration && selectionRef.current.projectId === selectedProjectId) {
        setError(cause.message || 'The selected file could not be read.');
      }
    }).finally(() => {
      if (!cancelled && requestId === fileRequestRef.current && isHostCurrent(hostGeneration) && selectionRef.current.generation === selectionGeneration && selectionRef.current.projectId === selectedProjectId) {
        setLoading((current) => ({ ...current, file: false }));
      }
    });
    return () => { cancelled = true; };
  }, [api, hostId, isHostCurrent, refreshRevision, selectedFilePath, selectedProjectId]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const hasSelectedProject = Boolean(selectedProject);
  const hasSelectedThread = threads.some((candidate) => candidate.id === selectedThreadId);
  const selectedFile = files.find((file) => file.path === selectedFilePath) ?? files[0] ?? null;
  useEffect(() => {
    if (!selectedProject || selectedProject.id !== selectedProjectId || !allowedProjectIds.has(selectedProjectId)) return;
    onOriginChange?.({ hostId, hostLabel, projectId: selectedProject.id });
  }, [allowedProjectIds, hostId, hostLabel, onOriginChange, selectedProject, selectedProjectId]);
  const observerComposer = useMemo(() => ({
    questionRequest: null,
    busy: false,
    running: false,
    onImageRevision: null,
    onForkResponse: null
  }), []);
  const observerTaskMap = useMemo(() => ({ thread, threads, plan, attention: [], onResolve: undefined }), [plan, thread, threads]);
  const phaseName = (task) => board.phases?.find((phase) => phase.id === task?.phaseId)?.name || task?.column || task?.status || 'unscheduled';

  return <section className="connect-observer-workspace connect-mobile-shell" aria-label={`Observer workspace for ${hostLabel || hostId}`}>
    <header className="connect-overview-header observer-workspace-header">
      <div>
        <span className="observer-kicker">Observer access · {hostLabel || hostId}</span>
        <h2>Read-only project view</h2>
        <p>Read the selected host snapshot. This device cannot run tasks, approve requests, open the host browser, or change project files.</p>
        <small className="settings-footnote">Runtime: {runtime.connected ? 'connected' : runtime.state || 'offline'} · {board.data.length} Board items · {files.length} review files</small>
      </div>
        <div className="observer-workspace-actions">
          <button type="button" className="settings-action" onClick={refreshProject} disabled={loading.bootstrap}>Refresh project</button>
          <button type="button" className="settings-action" onClick={onOpenOverview}>Overview</button>
      </div>
    </header>
    {error && <p className="connect-error" role="alert">{error}</p>}
    <div className="connect-observer-picker">
      <label>Allowed project<select aria-label="Observer project" value={selectedProjectId ?? ''} onChange={(event) => commitSelection(event.target.value || null)} disabled={!projects.length}>
        {(!projects.length || !hasSelectedProject) && <option value="">{projects.length ? 'Choose an allowed project' : 'No allowed projects'}</option>}
        {projects.map((project) => <option value={project.id} key={project.id}>{projectLabel(project)}</option>)}
      </select></label>
      <label>Task<select aria-label="Observer task" value={selectedThreadId ?? ''} onChange={(event) => commitSelection(selectedProjectId, event.target.value || null)} disabled={!threads.length}>
        {(!threads.length || !hasSelectedThread) && <option value="">{threads.length ? 'Choose a task' : 'No tasks'}</option>}
        {threads.map((candidate) => <option value={candidate.id} key={candidate.id}>{taskLabel(candidate)}</option>)}
      </select></label>
    </div>
    {(loading.bootstrap || loading.project) && <p className="settings-footnote" role="status">Reading the allowed project snapshot…</p>}

    {selectedProject && <div className="observer-inspection-grid">
      <section className="observer-panel observer-board-panel" aria-labelledby="observer-board-heading">
        <header><div><span className="observer-panel-kicker">Project state</span><h3 id="observer-board-heading">Board</h3></div><small>{board.data.length} items</small></header>
        {board.data.length ? <div className="observer-board-list" role="table" aria-label="Read-only Board items">
          <div className="observer-board-row observer-board-head" role="row"><span>Work item</span><span>Phase</span><span>Owner</span></div>
          {board.data.map((task) => <div className="observer-board-row" role="row" key={task.id}><span><strong>{taskLabel(task)}</strong>{task.description && <small>{task.description}</small>}</span><span>{phaseName(task)}</span><span>{task.owner || 'Unassigned'}</span></div>)}
        </div> : <p className="observer-empty">No Board items were returned for this project.</p>}
      </section>
      <section className="observer-panel observer-files-panel" aria-labelledby="observer-files-heading">
        <header><div><span className="observer-panel-kicker">Permitted inspection</span><h3 id="observer-files-heading">Project files</h3></div><small>{projectLabel(selectedProject)}</small></header>
        {files.length ? <div className="observer-files-layout">
          <div className="observer-file-list" role="listbox" aria-label="Project files">
            {files.map((file) => <button type="button" role="option" aria-selected={file.path === selectedFile?.path} className={file.path === selectedFile?.path ? 'selected' : ''} onClick={() => setSelectedFilePath(file.path)} key={file.path}><span>{fileLabel(file)}</span><small>+{file.plus ?? 0} −{file.minus ?? 0}</small></button>)}
          </div>
          <div className="observer-file-content" aria-live="polite">
            <div className="observer-file-heading"><strong>{fileLabel(selectedFile)}</strong><small>{selectedFile?.path}</small></div>
            {loading.file ? <p className="observer-empty">Reading file…</p> : filePreview?.dataUrl && filePreview.kind === 'image' ? <img src={filePreview.dataUrl} alt={fileLabel(selectedFile)} /> : <pre>{filePreviewText(filePreview) || 'No text preview was returned for this file.'}</pre>}
          </div>
        </div> : <p className="observer-empty">No changed files were returned for this project.</p>}
      </section>
    </div>}

    {selectedProject && <ConversationWorkspace
      api={api}
      storage={storage}
      project={selectedProject}
      thread={thread}
      threads={threads}
      loading={loading.thread || loading.project}
      runtime={runtime}
      plan={plan}
      changedCount={files.length}
      seenResponseIds={new Set()}
      inspectorOpen={false}
      onInspectorToggle={() => {}}
      onOpenProject={() => {}}
      showTaskProgress
      expandTaskProgress
      showMessageTimestamps
      completedWorkDetails="auto"
      previewOpen={false}
      onPreviewToggle={() => {}}
      previewWorkspaceId={selectedThreadId}
      browserState={{ native: false, activeTabId: null, tabs: [] }}
      onBrowserState={() => {}}
      previewFileTabs={[]}
      previewInstrumentTabs={[]}
      previewCustomTabs={[]}
      previewActiveTabId={null}
      onPreviewActiveTabChange={() => {}}
      proactiveSuggestions={[]}
      onProactiveSuggestionResolve={() => {}}
      sideThreadProps={null}
      taskMapProps={observerTaskMap}
      receipt={receipt}
      onReceiptCompare={undefined}
      composerProps={observerComposer}
      readOnly
    />}
    {receipt && <section className="connect-observer-receipt observer-panel" aria-labelledby="observer-receipt-heading">
      <header><div><span className="observer-panel-kicker">Durable evidence</span><h3 id="observer-receipt-heading">Saved receipt</h3></div><span className="observer-receipt-status">{receipt.status || 'unknown'}</span></header>
      <dl className="observer-receipt-facts"><div><dt>Revision</dt><dd>{receipt.revision ?? 'n/a'}</dd></div><div><dt>Project</dt><dd>{receipt.projectId || 'n/a'}</dd></div><div><dt>Task</dt><dd>{receipt.threadId || 'n/a'}</dd></div></dl>
      {receipt.summary && <p className="observer-receipt-summary">{receipt.summary}</p>}
      <details><summary>Receipt data</summary><pre>{JSON.stringify(receiptSummary(receipt), null, 2)}</pre></details>
    </section>}
  </section>;
}
