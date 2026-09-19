import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConversationWorkspace,
  ApprovalCard,
  Inspector,
  generatedImageAttachment,
  generatedImageRevisionPrompt,
  previewContextForWorkspace
} from '../App.jsx';
import { ArrowClockwise, Warning, X } from '../components/icons/index.jsx';
import { applyRuntimePayload, coalesceRuntimeDeltas, mergeThreadSnapshot, appendLocalUserMessage, removeLocalUserMessage, projectCollabAgents } from '../state/runtime.js';
import { createWorkspaceStorage, executionWorkspaceId, saveRemoteThreadLinks, threadReference } from './execution-storage.js';
import { assertSubmissionRequestBudget, prepareSubmissionAttachments, requestPayloadWithAttachments } from './transfer-client.js';

const EMPTY_BROWSER_STATE = { native: false, activeTabId: null, tabs: [] };
const EMPTY_PREVIEW = { open: false, browserState: EMPTY_BROWSER_STATE, fileTabs: [], instrumentTabs: [], customTabs: [], activeTabId: null };
const PERMISSION_OPTIONS = [
  { value: 'read-only', label: 'Read only', description: 'Inspect files without changing them.' },
  { value: 'workspace-write', label: 'Workspace', description: 'Change files inside the target project.' },
  { value: 'auto-approve', label: 'Auto-review', description: 'Use model review inside the target project.' },
  { value: 'full-access', label: 'Full access', description: 'Allow all target-host actions.' }
];

function modelEfforts(model) {
  return model?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort ?? entry.effort ?? entry) ?? [];
}

function resolveEffort(model, candidate = '') {
  const efforts = modelEfforts(model);
  return candidate && (!efforts.length || efforts.includes(candidate))
    ? candidate
    : model?.defaultReasoningEffort ?? efforts[0] ?? 'high';
}

function fileTab(file) {
  return {
    ...file,
    id: `file:${file.path}`,
    type: 'file',
    previewKind: file.kind,
    draft: file.content ?? '',
    editing: false,
    dirty: false,
    saving: false,
    error: null
  };
}

function isQuestion(event) {
  return event?.method?.includes('requestUserInput') && Array.isArray(event.params?.questions ?? event.questions);
}

function isApproval(event) {
  return event?.method === 'approval/request' || event?.method?.toLowerCase?.().includes('approval');
}

function applyExecutionPayload(current, payload) {
  if (payload?.method === 'item/agentMessage/delta') return applyRuntimePayload(current, payload);
  return applyRuntimePayload(current ?? payload?.thread ?? null, payload);
}

const ACTIVE_TURN_STATUSES = new Set(['inProgress', 'running', 'started', 'active']);

function activeTurnFor(candidate) {
  return [...(candidate?.turns ?? [])].reverse().find((turn) => ACTIVE_TURN_STATUSES.has(turn.status)) ?? null;
}

function eventThreadId(payload) {
  return payload?.threadId ?? payload?.params?.threadId ?? payload?.thread?.id ?? null;
}

function normalizedRequestGeneration(request) {
  const value = request?.requestGeneration;
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function sameAttentionRequest(request, other) {
  return String(request?.id) === String(other?.id)
    && normalizedRequestGeneration(request) === normalizedRequestGeneration(other);
}

function mergeAttentionRequests(current, incoming) {
  const next = [...current];
  for (const request of incoming ?? []) {
    if (request?.id === undefined || request?.id === null) continue;
    const index = next.findIndex((candidate) => String(candidate?.id) === String(request.id));
    if (index === -1) {
      next.push(request);
      continue;
    }
    const existingGeneration = normalizedRequestGeneration(next[index]);
    const incomingGeneration = normalizedRequestGeneration(request);
    if (typeof existingGeneration === 'number' && typeof incomingGeneration === 'number' && incomingGeneration < existingGeneration) continue;
    next[index] = request;
  }
  return next;
}

function attentionScopeMatchesTarget(request, { hostId, projectId, threadId }) {
  if (request?.hostId && request.hostId !== hostId) return false;
  if (request?.projectId && request.projectId !== projectId) return false;
  if (request?.params?.projectId && request.params.projectId !== projectId) return false;
  if (request?.threadId && request.threadId !== threadId) return false;
  if (request?.params?.threadId && request.params.threadId !== threadId) return false;
  return true;
}

function attentionResolvedRequest(request, payload) {
  if (String(request?.id) !== String(payload?.requestId)) return false;
  const resolvedGeneration = normalizedRequestGeneration(payload);
  return resolvedGeneration === null || resolvedGeneration === normalizedRequestGeneration(request);
}

function providerQuestionRequest(payload, hostId, projectId) {
  if (!isQuestion(payload)) return null;
  const params = payload.params ?? payload;
  return {
    ...payload,
    id: payload.id ?? payload.requestId,
    requestId: payload.requestId ?? payload.id,
    hostId,
    projectId: payload.projectId ?? projectId,
    params
  };
}

function providerPayloadForEvent(event) {
  const payload = event?.payload ?? {};
  if (event?.type === 'RuntimeEvent') return payload.payload ?? payload;
  if (['TaskUpdated', 'ActivityReceived', 'AgentUpdated'].includes(event?.type) && payload.method) return payload;
  return null;
}

function normalizePlan(steps) {
  return (steps ?? []).map((step) => ({ ...step, status: step.status === 'in_progress' ? 'inProgress' : step.status }));
}

function storedConfiguration(storage, threadId) {
  if (!threadId) return null;
  try { return JSON.parse(storage.getItem(`pixice.threadConfiguration.${threadId}`) || 'null'); } catch { return null; }
}

function validPermission(candidate) {
  return PERMISSION_OPTIONS.some((option) => option.value === candidate) ? candidate : null;
}

function attachmentDraftFingerprint(rawValue) {
  let value = [];
  try {
    value = rawValue ? JSON.parse(rawValue) : [];
  } catch {
    return `invalid:${String(rawValue)}`;
  }
  if (!Array.isArray(value)) return 'invalid:attachments';
  return JSON.stringify(value.map((attachment) => ({
    name: attachment?.name ?? '',
    type: attachment?.type ?? '',
    size: attachment?.size ?? 0,
    sha256: attachment?.sha256 ?? null,
    transferId: attachment?.transferId ?? null,
    transferState: attachment?.transferState ?? null,
    uploadOffset: attachment?.uploadOffset ?? 0
  })));
}

function draftMatchesSnapshot(storage, draftKey, snapshot) {
  return storage.getItem(draftKey) === snapshot.text
    && attachmentDraftFingerprint(storage.getItem(`${draftKey}.attachments`)) === snapshot.attachments;
}

function clearDraftSnapshot(storage, draftKey, snapshot) {
  if (!draftMatchesSnapshot(storage, draftKey, snapshot)) return false;
  storage.removeItem(draftKey);
  storage.removeItem(`${draftKey}.attachments`);
  return true;
}

export function ExecutionThreadWorkspace({
  api,
  hostId,
  hostLabel,
  transportState = null,
  originHostId = 'local',
  originHostLabel = '',
  originProjectId = null,
  projectId,
  project: suppliedProject = null,
  threadId: suppliedThreadId = null,
  initialPrompt = '',
  initialAttachments = [],
  initialPreparedAttachments = null,
  initialModel = '',
  initialEffort = '',
  initialPermissionMode = '',
  initialFastMode = false,
  submissionSignal = null,
  onClose,
  onThreadLinked,
  onInitialSubmissionOutcome = null,
  readOnly = false,
  storage: suppliedStorage = null,
  originStorage: suppliedOriginStorage = null
}) {
  const storage = useMemo(() => suppliedStorage ?? createWorkspaceStorage(hostId), [hostId, suppliedStorage]);
  const originStorage = useMemo(() => suppliedOriginStorage ?? createWorkspaceStorage(originHostId), [originHostId, suppliedOriginStorage]);
  const [project, setProject] = useState(suppliedProject);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [runtime, setRuntime] = useState({ state: 'connecting', connected: false });
  const [thread, setThread] = useState(null);
  const [threads, setThreads] = useState([]);
  const [plan, setPlan] = useState([]);
  const [attention, setAttention] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [draftReloadToken, setDraftReloadToken] = useState(0);
  const [error, setError] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [effort, setEffort] = useState('high');
  const [permissionMode, setPermissionMode] = useState('workspace-write');
  const [fastMode, setFastMode] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const threadIdRef = useRef(suppliedThreadId);
  const projectIdRef = useRef(projectId);
  const submittingRef = useRef(false);
  const pendingDeltasRef = useRef([]);
  const deltaFrameRef = useRef(null);
  const previewRef = useRef(preview);
  const initialPromptRef = useRef(initialPrompt);
  const initialAttachmentsRef = useRef(initialAttachments);
  const initialPreparedAttachmentsRef = useRef(initialPreparedAttachments);
  const initialSubmitStartedRef = useRef(false);
  const initialOutcomeSettledRef = useRef(false);
  const workspaceId = executionWorkspaceId(hostId, threadIdRef.current ?? `draft:${projectId}`);
  const rawWorkspaceId = threadIdRef.current ?? `draft:${projectId}`;
  const identityKey = `${hostId}:${projectId}:${suppliedThreadId ?? 'draft'}`;
  const identityRef = useRef(identityKey);
  const mountedRef = useRef(true);
  const attentionRevisionRef = useRef(0);
  const attentionSnapshotReadTokenRef = useRef(0);

  const reportInitialOutcome = useCallback((accepted) => {
    if (!onInitialSubmissionOutcome || initialOutcomeSettledRef.current) return;
    initialOutcomeSettledRef.current = true;
    onInitialSubmissionOutcome(Boolean(accepted));
  }, [onInitialSubmissionOutcome]);

  previewRef.current = preview;
  projectIdRef.current = projectId;

  useEffect(() => {
    identityRef.current = identityKey;
    threadIdRef.current = suppliedThreadId;
    projectIdRef.current = projectId;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attentionSnapshotReadTokenRef.current += 1;
    };
  }, [identityKey, projectId, suppliedThreadId]);

  const selectedModelInfo = models.find((candidate) => candidate.model === selectedModel);
  const selectedProvider = selectedModelInfo?.provider
    ? providers.find((provider) => provider.id === selectedModelInfo.provider)
    : null;
  const providerReady = selectedProvider
    ? selectedProvider.connected !== false && !['error', 'stopped', 'unavailable'].includes(selectedProvider.status?.state)
    : selectedModelInfo
      ? selectedModelInfo.connected !== false && selectedModelInfo.availability !== 'disconnected'
      : Boolean(runtime.connected);
  const transportReady = transportState
    ? Boolean(transportState.connected ?? transportState.state === 'connected')
    : Boolean(runtime.connected || runtime.state === 'ready');
  const canSubmit = transportReady && Boolean(runtime.connected) && Boolean(selectedModelInfo) && providerReady;

  const refreshThread = useCallback(async (targetThreadId = threadIdRef.current) => {
    if (!targetThreadId || !api?.threads?.read) return null;
    const response = await api.threads.read({ projectId: projectIdRef.current, threadId: targetThreadId });
    if (mountedRef.current && identityRef.current === identityKey && threadIdRef.current === targetThreadId) {
      setThread((current) => mergeThreadSnapshot(current, response.thread));
      if (Array.isArray(response.plan)) setPlan(normalizePlan(response.plan));
    }
    return response.thread;
  }, [api, hostId, identityKey]);

  const refreshInterventions = useCallback(async () => {
    if (!api?.tasks?.interventions) return [];
    const readToken = ++attentionSnapshotReadTokenRef.current;
    const readRevision = attentionRevisionRef.current;
    const readIdentity = identityKey;
    const readProjectId = projectIdRef.current;
    const readThreadId = threadIdRef.current;
    const scope = { hostId, projectId: readProjectId, threadId: readThreadId };
    const result = await api.tasks.interventions();
    const requests = (Array.isArray(result?.requests) ? result.requests : []).filter((request) => attentionScopeMatchesTarget(request, scope));
    if (mountedRef.current && identityRef.current === readIdentity && projectIdRef.current === readProjectId && threadIdRef.current === readThreadId
      && readToken === attentionSnapshotReadTokenRef.current && readRevision === attentionRevisionRef.current) {
      setAttention((current) => {
        if (!mountedRef.current || identityRef.current !== readIdentity || projectIdRef.current !== readProjectId || threadIdRef.current !== readThreadId
          || readToken !== attentionSnapshotReadTokenRef.current || readRevision !== attentionRevisionRef.current) return current;
        return [
          ...current.filter((request) => !attentionScopeMatchesTarget(request, scope)),
          ...requests
        ];
      });
    }
    return requests;
  }, [api, hostId, identityKey]);

  const refreshReceipt = useCallback(async () => {
    if (!threadIdRef.current || !api?.tasks?.receipt) return null;
    const nextReceipt = await api.tasks.receipt({ projectId: projectIdRef.current, threadId: threadIdRef.current });
    if (mountedRef.current && identityRef.current === identityKey) setReceipt(nextReceipt);
    return nextReceipt;
  }, [api, identityKey]);

  useEffect(() => {
    let cancelled = false;
    const initialInterventions = api?.tasks?.interventions
      ? refreshInterventions().catch(() => null)
      : Promise.resolve(null);
    setLoading(true);
    Promise.resolve(api?.app?.bootstrap?.()).then(async (result) => {
      if (cancelled) return;
      const nextProjects = result?.projects ?? [];
      const nextProject = suppliedProject ?? nextProjects.find((candidate) => candidate.id === projectId) ?? null;
      setProject(nextProject);
      setModels(result?.models ?? []);
      let nextProviders = result?.providers ?? [];
      if (!nextProviders.length && api.providers?.list) {
        try { nextProviders = await api.providers.list(); } catch { /* Older or observer hosts may not expose provider details. */ }
      }
      setProviders(nextProviders);
      setRuntime((current) => ({ ...current, ...(result?.runtime ?? { state: 'ready', connected: true }) }));
      const saved = storedConfiguration(storage, suppliedThreadId);
      const requestedModel = saved?.model ?? initialModel ?? result?.settings?.defaultModel;
      const model = (result?.models ?? []).find((candidate) => candidate.model === requestedModel)
        ?? (result?.models ?? []).find((candidate) => candidate.isDefault)
        ?? result?.models?.[0];
      if (model) {
        setSelectedModel(model.model);
        setEffort(resolveEffort(model, saved?.effort ?? initialEffort ?? result?.settings?.defaultEffort));
      }
      setPermissionMode(validPermission(saved?.permissionMode) ?? validPermission(initialPermissionMode) ?? 'workspace-write');
      setFastMode(Boolean(saved?.fastMode ?? initialFastMode));
      if (suppliedThreadId) await refreshThread(suppliedThreadId);
      if (api?.threads?.list) {
        const listed = await api.threads.list({ projectId });
        if (!cancelled && mountedRef.current && identityRef.current === identityKey) setThreads(listed?.data ?? []);
      }
      const [, receipt] = await Promise.all([
        initialInterventions,
        suppliedThreadId && api?.tasks?.receipt ? api.tasks.receipt({ projectId, threadId: suppliedThreadId }).catch(() => null) : null
      ]);
      if (!cancelled && mountedRef.current && identityRef.current === identityKey) {
        setReceipt(receipt);
      }
    }).catch((cause) => { if (!cancelled && mountedRef.current && identityRef.current === identityKey) setError(cause.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      attentionSnapshotReadTokenRef.current += 1;
    };
  }, [api, hostId, identityKey, initialEffort, initialFastMode, initialModel, initialPermissionMode, projectId, refreshInterventions, refreshThread, suppliedProject, suppliedThreadId]);

  useEffect(() => {
    if (!api?.events?.subscribe) return undefined;
    const unsubscribe = api.events.subscribe((event) => {
      const payload = event?.payload ?? {};
      if (!mountedRef.current || identityRef.current !== identityKey) return;
      if (payload.hostId && payload.hostId !== hostId) return;
      if (payload.projectId && payload.projectId !== projectIdRef.current) return;
      if (event.type === 'RuntimeStatus') {
        setRuntime((current) => ({ ...current, ...payload, connected: payload.connected ?? payload.state === 'connected' }));
        if (payload.providers) {
          setProviders((current) => current.map((provider) => {
            const status = payload.providers[provider.id];
            if (!status) return provider;
            const connected = status.connected ?? (status.state === 'ready' ? true : ['error', 'stopped', 'unavailable'].includes(status.state) ? false : provider.connected);
            return { ...provider, connected, status };
          }));
        }
        return;
      }
      if (event.type === 'AttentionRequired') {
        if (attentionScopeMatchesTarget(payload, { hostId, projectId: projectIdRef.current, threadId: threadIdRef.current })) {
          attentionRevisionRef.current += 1;
          setAttention((current) => mergeAttentionRequests(current, [payload]));
        }
        return;
      }
      if (event.type === 'AttentionResolved') {
        if (attentionScopeMatchesTarget(payload, { hostId, projectId: projectIdRef.current, threadId: threadIdRef.current })) {
          attentionRevisionRef.current += 1;
          setAttention((current) => current.filter((item) => !attentionResolvedRequest(item, payload)));
        }
        return;
      }
      if (event.type === 'AttentionReset') {
        attentionRevisionRef.current += 1;
        setAttention((payload.attention ?? []).filter((request) => attentionScopeMatchesTarget(request, { hostId, projectId: projectIdRef.current, threadId: threadIdRef.current })));
        return;
      }
      if (event.type === 'ApplicationResync') {
        void Promise.all([
          refreshThread().catch(() => null),
          refreshInterventions().catch(() => []),
          refreshReceipt().catch(() => null),
          api?.app?.bootstrap?.().then(async (result) => {
            if (!mountedRef.current || identityRef.current !== identityKey || !result) return;
            setRuntime((current) => ({ ...current, ...(result.runtime ?? {}) }));
            setModels(result.models ?? []);
            let nextProviders = result.providers ?? [];
            if (!nextProviders.length && api.providers?.list) {
              nextProviders = await api.providers.list().catch(() => []);
            }
            setProviders(nextProviders);
          }).catch(() => null)
        ]);
        return;
      }
      const providerPayload = providerPayloadForEvent(event);
      if (providerPayload) {
        const question = providerQuestionRequest(providerPayload, hostId, projectIdRef.current);
        if (question?.id !== undefined && question?.id !== null && attentionScopeMatchesTarget(question, { hostId, projectId: projectIdRef.current, threadId: threadIdRef.current })) {
          attentionRevisionRef.current += 1;
          setAttention((current) => mergeAttentionRequests(current, [question]));
          return;
        }
        if (eventThreadId(providerPayload) !== threadIdRef.current) return;
        if (providerPayload.item?.type === 'collabAgentToolCall' || providerPayload.item?.type === 'collabToolCall') {
          setThreads((current) => projectCollabAgents(current, providerPayload.item));
        }
        if (providerPayload.method === 'thread/name/updated') {
          setThread((current) => current?.id === threadIdRef.current ? { ...current, name: providerPayload.name } : current);
        } else {
          commitRuntimePayload(providerPayload);
        }
        if (providerPayload.method === 'turn/plan/updated') setPlan(normalizePlan(providerPayload.plan));
        if (providerPayload.method === 'turn/completed') {
          void refreshThread().catch(() => {});
          void refreshReceipt().catch(() => {});
        }
        return;
      }
      if (event.type === 'RuntimeEvent') {
        const runtimePayload = payload.payload ?? payload;
        if (eventThreadId(runtimePayload) === threadIdRef.current) {
          commitRuntimePayload(runtimePayload);
          if (runtimePayload.method === 'turn/plan/updated') setPlan(normalizePlan(runtimePayload.plan));
          if (runtimePayload.method === 'turn/completed') {
            void refreshThread().catch(() => {});
            if (api?.tasks?.receipt) void api.tasks.receipt({ projectId: projectIdRef.current, threadId: threadIdRef.current }).then((nextReceipt) => {
              if (mountedRef.current && identityRef.current === identityKey) setReceipt(nextReceipt);
            }).catch(() => {});
          }
        }
        return;
      }
      if (event.type === 'TaskUpdated' && eventThreadId(payload) === threadIdRef.current) {
        if (Array.isArray(payload.plan)) setPlan(normalizePlan(payload.plan));
        return;
      }
      if (event.type === 'BrowserState' && payload.workspaceId === rawWorkspaceId) setPreview((current) => ({ ...current, browserState: payload }));
      if (event.type === 'BrowserOpenRequested' && (payload.workspaceId ?? payload.threadId) === rawWorkspaceId) setPreview((current) => ({ ...current, open: true }));
      if (event.type === 'FilePreviewOpenRequested' && (payload.workspaceId ?? payload.threadId) === rawWorkspaceId && payload.file) {
        const tab = fileTab(payload.file);
        setPreview((current) => ({ ...current, open: true, activeTabId: tab.id, fileTabs: [...current.fileTabs.filter((item) => item.id !== tab.id), tab] }));
      }
      if ((event.type === 'InstrumentOpenRequested' || event.type === 'InstrumentUpdated' || event.type === 'InstrumentInteractionUpdated')
        && (payload.workspaceId ?? payload.threadId) === rawWorkspaceId && payload.instrument) {
        const instrument = payload.instrument;
        setPreview((current) => {
          if (event.type === 'InstrumentUpdated' && payload.action === 'deleted') {
            return {
              ...current,
              instrumentTabs: current.instrumentTabs.filter((item) => item.id !== instrument.id),
              activeTabId: current.activeTabId === `instrument:${instrument.id}` ? null : current.activeTabId
            };
          }
          const exists = current.instrumentTabs.some((item) => item.id === instrument.id);
          return {
            ...current,
            open: event.type === 'InstrumentOpenRequested' ? true : current.open,
            activeTabId: event.type === 'InstrumentOpenRequested' ? `instrument:${instrument.id}` : current.activeTabId,
            instrumentTabs: exists ? current.instrumentTabs.map((item) => item.id === instrument.id ? { ...instrument, launchValues: item.launchValues } : item) : [...current.instrumentTabs, instrument]
          };
        });
      }
      if (event.type === 'WorkflowOpenRequested' && (payload.workspaceId ?? payload.threadId) === rawWorkspaceId && payload.workflowId) {
        const tab = { id: `workflow:${payload.workflowId}`, kind: 'workflow', title: payload.workflowName ?? 'Workflow', payload: { ...payload, projectId: projectIdRef.current } };
        openCustom(tab);
      }
      if (event.type === 'TaskPreviewOpenRequested' && (payload.workspaceId ?? payload.threadId) === rawWorkspaceId && (payload.taskId || payload.proposalId)) {
        const kind = payload.proposalId ? 'plan' : 'task';
        openCustom({ id: `${kind}:${payload.proposalId ?? payload.taskId}`, kind, title: kind === 'plan' ? 'Plan proposal' : 'Work item', payload: { ...payload, projectId: projectIdRef.current } });
      }
    });
    return unsubscribe;
  }, [api, hostId, identityKey, projectId, rawWorkspaceId, refreshInterventions, refreshReceipt, refreshThread]);

  useEffect(() => {
    if (!threadIdRef.current || !api?.browser?.state) return undefined;
    let cancelled = false;
    api.browser.state({ workspaceId: rawWorkspaceId }).then((browserState) => {
      if (!cancelled && mountedRef.current && identityRef.current === identityKey) setPreview((current) => ({ ...current, browserState }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, identityKey, rawWorkspaceId]);

  useEffect(() => {
    if (!threadIdRef.current || !api?.instruments?.list) return undefined;
    let cancelled = false;
    api.instruments.list({ projectId: projectIdRef.current, threadId: threadIdRef.current }).then((response) => {
      if (cancelled || !mountedRef.current || identityRef.current !== identityKey) return;
      setPreview((current) => ({ ...current, instrumentTabs: response?.data ?? [] }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, identityKey, rawWorkspaceId]);

  useEffect(() => {
    if ((!initialPromptRef.current?.trim() && !initialAttachmentsRef.current?.length) || threadIdRef.current || loading || initialSubmitStartedRef.current) return;
    initialSubmitStartedRef.current = true;
    const prompt = initialPromptRef.current;
    const attachments = initialAttachmentsRef.current;
    const draftKey = `pixice.draft.${hostId}:${projectId}:new`;
    const initialSnapshot = {
      text: prompt,
      attachments: attachmentDraftFingerprint(JSON.stringify(attachments))
    };
    const controller = new AbortController();
    const signal = controller.signal;
    const abortInitial = () => controller.abort(new DOMException('The initial submission was cancelled.', 'AbortError'));
    if (submissionSignal?.aborted) abortInitial();
    else submissionSignal?.addEventListener?.('abort', abortInitial, { once: true });
    storage.setItem(draftKey, prompt);
    try { storage.setItem(`${draftKey}.attachments`, JSON.stringify(attachments)); } catch { /* In-memory submission still carries the files. */ }
    void submit(prompt, attachments, initialPreparedAttachmentsRef.current, attachments, signal).then((accepted) => {
      if (!mountedRef.current) return;
      if (signal.aborted) {
        reportInitialOutcome(false);
        return;
      }
      if (accepted) {
        initialPromptRef.current = '';
        initialAttachmentsRef.current = [];
        const draftKeys = [draftKey];
        if (threadIdRef.current) draftKeys.push(`pixice.draft.${hostId}:${projectId}:${threadIdRef.current}`);
        let clearedDraft = false;
        for (const key of new Set(draftKeys)) {
          clearedDraft = clearDraftSnapshot(storage, key, initialSnapshot) || clearedDraft;
        }
        if (clearedDraft) setDraftReloadToken((value) => value + 1);
        reportInitialOutcome(true);
      } else {
        if (storage.getItem(draftKey) === prompt) storage.setItem(draftKey, prompt);
        reportInitialOutcome(false);
        setDraftReloadToken((value) => value + 1);
      }
    }).finally(() => {
      submissionSignal?.removeEventListener?.('abort', abortInitial);
    });
    return () => {
      controller.abort(new DOMException('The execution workspace closed.', 'AbortError'));
      submissionSignal?.removeEventListener?.('abort', abortInitial);
    };
  }, [hostId, loading, projectId, reportInitialOutcome, storage, submissionSignal]);

  const flushDeltas = useCallback(() => {
    deltaFrameRef.current = null;
    const pending = coalesceRuntimeDeltas(pendingDeltasRef.current.splice(0));
    if (pending.length && mountedRef.current && identityRef.current === identityKey) setThread((current) => pending.reduce(applyExecutionPayload, current));
  }, [identityKey]);

  const commitRuntimePayload = useCallback((payload) => {
    if (!payload?.threadId || payload.threadId !== threadIdRef.current) return;
    if (payload.method === 'item/agentMessage/delta') {
      pendingDeltasRef.current.push(payload);
      if (deltaFrameRef.current !== null) return;
      deltaFrameRef.current = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(flushDeltas)
        : window.setTimeout(flushDeltas, 16);
      return;
    }
    const pending = coalesceRuntimeDeltas(pendingDeltasRef.current.splice(0));
    if (deltaFrameRef.current !== null) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(deltaFrameRef.current);
      else window.clearTimeout(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    if (mountedRef.current && identityRef.current === identityKey) {
      setThread((current) => {
        const merged = pending.reduce(applyExecutionPayload, current);
        return applyExecutionPayload(merged, payload);
      });
    }
  }, [flushDeltas, identityKey]);

  const linkTargetThread = useCallback((targetThread) => {
    if (!targetThread?.id || !originProjectId) return null;
    const title = targetThread.name || targetThread.preview || 'Untitled task';
    const reference = threadReference({
      originHostId,
      originProjectId,
      executionHostId: hostId,
      executionProjectId: projectIdRef.current,
      rawThreadId: targetThread.id,
      cachedOriginHostLabel: originHostLabel || originHostId,
      cachedExecutionHostLabel: hostLabel,
      cachedProjectLabel: project?.displayName,
      cachedThreadTitle: title,
      rawTaskName: title
    });
    saveRemoteThreadLinks(originHostId, originProjectId, [reference], originStorage);
    onThreadLinked?.(reference);
    return reference;
  }, [hostId, hostLabel, onThreadLinked, originHostId, originHostLabel, originProjectId, originStorage, project?.displayName]);

  useEffect(() => {
    if (thread?.id) linkTargetThread(thread);
  }, [linkTargetThread, thread?.id, thread?.name, thread?.preview]);

  const submit = useCallback(async (text, attachments = [], preparedAttachments = null, sourceAttachments = attachments, signal = null, draftLifecycle = null) => {
    if (!api || !projectIdRef.current || !canSubmit || submittingRef.current) return false;
    if (signal?.aborted) return false;
    submittingRef.current = true;
    setSubmitting(true);
    const fixedProjectId = projectIdRef.current;
    let targetThreadId = threadIdRef.current;
    const existingThread = thread;
    let optimisticTurnId = null;
    let optimisticMessageId = null;
    try {
      const prepared = preparedAttachments ?? await prepareSubmissionAttachments({
        api,
        projectId: fixedProjectId,
        hostId,
        deviceId: api?.remote?.deviceId,
        attachments,
        signal
      });
      if (signal?.aborted) return false;
      const model = models.find((candidate) => candidate.model === selectedModel);
      const serviceTier = fastMode && model?.serviceTiers?.find?.((tier) => (typeof tier === 'string' ? tier : tier.id) === 'priority') ? 'priority' : undefined;
      if (!targetThreadId) {
        const prospectivePayload = requestPayloadWithAttachments({
          projectId: fixedProjectId,
          threadId: '00000000-0000-0000-0000-000000000000',
          text,
          previewContext: previewContextForWorkspace(previewRef.current),
          model: selectedModel || undefined,
          ...(serviceTier ? { serviceTier } : {}),
          effort,
          permissionMode
        }, prepared);
        assertSubmissionRequestBudget({ api, operation: 'turns.start', payload: prospectivePayload });
      }
      if (!targetThreadId) {
        const created = await api.threads.create({ projectId: fixedProjectId, model: selectedModel || undefined, ...(serviceTier ? { serviceTier } : {}), permissionMode });
        if (signal?.aborted) return false;
        targetThreadId = created.thread.id;
        draftLifecycle?.adoptDraftKey(`${hostId}:${fixedProjectId}:${targetThreadId}`);
        threadIdRef.current = targetThreadId;
        setThread(created.thread);
        setThreads((current) => [created.thread, ...current.filter((item) => item.id !== targetThreadId)]);
        storage.setItem(`pixice.threadConfiguration.${targetThreadId}`, JSON.stringify({ model: selectedModel, effort, fastMode, permissionMode }));
        const newDraftKey = `pixice.draft.${hostId}:${fixedProjectId}:new`;
        const threadDraftKey = `pixice.draft.${hostId}:${fixedProjectId}:${targetThreadId}`;
        storage.setItem(threadDraftKey, storage.getItem(newDraftKey) ?? text);
        const storedAttachments = storage.getItem(`${newDraftKey}.attachments`);
        if (storedAttachments !== null) storage.setItem(`${threadDraftKey}.attachments`, storedAttachments);
        else {
          try { storage.setItem(`${threadDraftKey}.attachments`, JSON.stringify(sourceAttachments)); } catch { /* Keep the original in-memory files for retry. */ }
        }
        await api.browser?.adopt?.({ fromWorkspaceId: `draft:${fixedProjectId}`, toWorkspaceId: targetThreadId });
        if (signal?.aborted) return false;
        linkTargetThread(created.thread);
      }
      const activeTurn = activeTurnFor(existingThread);
      optimisticTurnId = activeTurn?.id ?? `local-turn:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
      optimisticMessageId = `local-user:${optimisticTurnId}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
      setThread((current) => appendLocalUserMessage(current, { turnId: optimisticTurnId, text, attachments, messageId: optimisticMessageId }));
      const previewContext = previewContextForWorkspace(previewRef.current);
      const payload = requestPayloadWithAttachments(activeTurn
        ? { projectId: fixedProjectId, threadId: targetThreadId, turnId: activeTurn.id, text, previewContext }
        : { projectId: fixedProjectId, threadId: targetThreadId, text, previewContext, model: selectedModel || undefined, ...(serviceTier ? { serviceTier } : {}), effort, permissionMode }, prepared);
      assertSubmissionRequestBudget({ api, operation: activeTurn ? 'turns.steer' : 'turns.start', payload });
      const operation = activeTurn ? api.turns.steer(payload) : api.turns.start(payload);
      const response = await operation;
      if (signal?.aborted) return false;
      if (response?.turn) {
        setThread((current) => {
          const withoutOptimistic = removeLocalUserMessage(current, { turnId: optimisticTurnId, messageId: optimisticMessageId, removeEmptyTurn: true });
          return mergeThreadSnapshot(withoutOptimistic, appendLocalUserMessage({ id: targetThreadId, turns: [response.turn] }, { turnId: response.turn.id, text, attachments, messageId: optimisticMessageId, skipIfMatching: true }));
        });
      }
      setError('');
      return true;
    } catch (cause) {
      if (!signal?.aborted) setError(cause.message);
      if (mountedRef.current && identityRef.current === identityKey) setThread((current) => removeLocalUserMessage(current, { turnId: optimisticTurnId, messageId: optimisticMessageId, removeEmptyTurn: true }));
      return false;
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [api, canSubmit, effort, fastMode, hostId, linkTargetThread, models, originHostId, permissionMode, project?.displayName, selectedModel, storage, thread]);

  const interrupt = useCallback(async () => {
    const activeTurn = activeTurnFor(thread);
    if (!activeTurn || !threadIdRef.current) return;
    try { await api.turns.interrupt({ projectId: projectIdRef.current, threadId: threadIdRef.current, turnId: activeTurn.id }); }
    catch (cause) { setError(cause.message); }
  }, [api, thread]);

  const resolveAttention = useCallback(async (request, decision) => {
    try {
      if (request.method === 'workflow/taskEvent/requestApproval' && api.workflows?.resolveMissedTrigger) {
        await api.workflows.resolveMissedTrigger({ projectId: projectIdRef.current, requestId: request.id, requestGeneration: request.requestGeneration, decision: decision === 'accept' ? 'accept' : 'decline' });
      } else if (isQuestion(request) && api.questions?.respond) {
        await api.questions.respond({ requestId: request.id, requestGeneration: request.requestGeneration, action: decision?.action ?? 'answer', answers: decision?.answers ?? {} });
      } else if (isQuestion(request) && api.requests?.respond) {
        if (decision?.action === 'cancel') throw new Error('This host cannot cancel an older input request. Refresh the task and try again.');
        const answers = Object.fromEntries(Object.entries(decision?.answers ?? decision ?? {}).map(([id, value]) => [id, { answers: Array.isArray(value) ? value : [String(value)] }]));
        await api.requests.respond({ requestId: request.id, requestGeneration: request.requestGeneration, answers });
      }
      else if (isApproval(request)) await api.approvals.resolve({ requestId: request.id, requestGeneration: request.requestGeneration, decision });
      else if (request.method?.toLowerCase?.().includes('elicitation')) await api.elicitations.respond({ requestId: request.id, requestGeneration: request.requestGeneration, ...decision });
      attentionRevisionRef.current += 1;
      setAttention((current) => current.filter((item) => !sameAttentionRequest(item, request)));
      return true;
    } catch (cause) { setError(cause.message); return false; }
  }, [api]);

  const updatePreview = useCallback((updater) => setPreview((current) => typeof updater === 'function' ? updater(current) : updater), []);
  const openPreview = useCallback(() => updatePreview((current) => ({ ...current, open: true, activeTabId: current.activeTabId ?? current.customTabs.at(-1)?.id ?? null })), [updatePreview]);
  const onBrowserCreated = useCallback((tabId, next) => updatePreview((current) => ({ ...current, browserState: next, activeTabId: next.activeTabId ?? tabId })), [updatePreview]);
  const openResource = useCallback(async (target) => {
    if (/^https?:\/\//i.test(target)) {
      const next = await api.browser.create({ workspaceId: rawWorkspaceId, url: target });
      updatePreview((current) => ({ ...current, open: true, browserState: next, activeTabId: next.activeTabId }));
      return;
    }
    const file = await (api.files.preview ?? api.files.read)({ projectId: projectIdRef.current, path: target });
    const tab = fileTab(file);
    updatePreview((current) => ({ ...current, open: true, fileTabs: [...current.fileTabs.filter((item) => item.id !== tab.id), tab], activeTabId: tab.id }));
  }, [api, rawWorkspaceId, updatePreview]);
  const closeBrowser = useCallback((tabId) => { void api.browser.close({ workspaceId: rawWorkspaceId, tabId }).then((next) => updatePreview((current) => ({ ...current, browserState: next, activeTabId: next.activeTabId ?? null }))).catch((cause) => setError(cause.message)); }, [api, rawWorkspaceId, updatePreview]);
  const fileUpdate = useCallback((tabId, patch) => updatePreview((current) => ({ ...current, fileTabs: current.fileTabs.map((file) => file.id === tabId ? { ...file, ...patch } : file) })), [updatePreview]);
  const closeFile = useCallback((tabId) => updatePreview((current) => ({ ...current, fileTabs: current.fileTabs.filter((file) => file.id !== tabId), activeTabId: current.activeTabId === tabId ? null : current.activeTabId })), [updatePreview]);
  const openCustom = useCallback((tab) => updatePreview((current) => ({ ...current, open: true, customTabs: [...current.customTabs.filter((item) => item.id !== tab.id), tab], activeTabId: tab.id })), [updatePreview]);
  const updateCustom = useCallback((tabId, patch) => updatePreview((current) => ({ ...current, customTabs: current.customTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab) })), [updatePreview]);
  const closeCustom = useCallback((tabId) => updatePreview((current) => ({ ...current, customTabs: current.customTabs.filter((tab) => tab.id !== tabId), activeTabId: current.activeTabId === tabId ? null : current.activeTabId })), [updatePreview]);

  const refreshInstrument = useCallback(async (instrumentId, source) => {
    if (!api?.instruments || !threadIdRef.current) throw new Error('Instrument data refresh is unavailable');
    const instrument = await api.instruments.refresh({ projectId: projectIdRef.current, threadId: threadIdRef.current, instrumentId, source });
    updatePreview((current) => ({ ...current, instrumentTabs: current.instrumentTabs.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate) }));
    return instrument;
  }, [api, updatePreview]);
  const sendInstrumentEvent = useCallback(async (instrumentId, actionId, payload) => {
    if (!api?.instruments || !threadIdRef.current) throw new Error('Instrument agent events are unavailable');
    return api.instruments.event({ projectId: projectIdRef.current, threadId: threadIdRef.current, instrumentId, actionId, payload, model: selectedModel || undefined, effort: effort || undefined, permissionMode });
  }, [api, effort, permissionMode, selectedModel]);
  const invokeInstrument = useCallback(async (instrumentId, actionId, argumentsValue) => {
    if (!api?.instruments || !threadIdRef.current) throw new Error('Trusted Instrument actions are unavailable');
    return api.instruments.invoke({ projectId: projectIdRef.current, threadId: threadIdRef.current, instrumentId, actionId, arguments: argumentsValue, requestId: globalThis.crypto?.randomUUID?.() ?? `request:${Date.now()}` });
  }, [api]);
  const pinInstrument = useCallback(async (instrumentId, pinned) => {
    if (!api?.instruments || !threadIdRef.current) throw new Error('Instrument pinning is unavailable');
    const instrument = await api.instruments.pin({ projectId: projectIdRef.current, threadId: threadIdRef.current, instrumentId, pinned });
    updatePreview((current) => ({ ...current, instrumentTabs: current.instrumentTabs.map((candidate) => candidate.id === instrument.id ? { ...instrument, launchValues: candidate.launchValues } : candidate) }));
    return instrument;
  }, [api, updatePreview]);

  const forkTargetResponse = useCallback(async ({ threadId, turnId, itemId }) => {
    if (!api?.threads?.fork || !threadId || !turnId || !itemId) return false;
    try {
      const response = await api.threads.fork({ projectId: projectIdRef.current, threadId, lastTurnId: turnId, lastItemId: itemId });
      if (response?.thread) {
        setThreads((current) => current.some((candidate) => candidate.id === response.thread.id)
          ? current.map((candidate) => candidate.id === response.thread.id ? { ...candidate, ...response.thread } : candidate)
          : [response.thread, ...current]);
      }
      setError('');
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    }
  }, [api]);

  const composerProps = {
    disabled: !canSubmit || !project,
    busy: submitting,
    draftKey: `${hostId}:${projectId}:${threadIdRef.current ?? 'new'}`,
    draftReloadToken,
    preserveDrafts: true,
    storage,
    attachmentContext: { api, hostId, deviceId: api?.remote?.deviceId, projectId },
    sendShortcut: 'enter',
    spellCheckComposer: true,
    autoFocusComposer: true,
    showSlashCommands: true,
    running: Boolean(thread?.turns?.findLast?.((turn) => ['inProgress', 'running', 'started'].includes(turn.status))),
    questionRequest: attention.find((request) => isQuestion(request) && request.params?.threadId === threadIdRef.current) ?? null,
    onQuestionResolve: resolveAttention,
    models,
    selectedModel,
    onModelChange: (value) => { setSelectedModel(value); setEffort(resolveEffort(models.find((model) => model.model === value), effort)); },
    effort,
    onEffortChange: setEffort,
    fastMode,
    onFastModeChange: setFastMode,
    permissionMode,
    onPermissionModeChange: setPermissionMode,
    providers,
    onProviderLogin: unsupportedTargetProviderLogin,
    onProvidersRefresh: refreshTargetProviders,
    onSubmit: submit,
    onInterrupt: interrupt,
    onImageRevision: ({ comment, source, prompt }) => {
      const attachments = generatedImageAttachment(source);
      return submit(generatedImageRevisionPrompt(comment, prompt, attachments.length > 0), attachments);
    },
    onForkResponse: forkTargetResponse
  };

  const previewWorkspace = preview;
  const taskMapProps = { thread, threads, plan, attention, onResolve: resolveAttention };
  const registerSideThread = (tabId, createdThread, payload) => {
    updateCustom(tabId, { title: createdThread?.name || 'Side thread', payload: { ...payload, threadId: createdThread?.id, hostThreadId: rawWorkspaceId } });
    setThreads((current) => current.some((item) => item.id === createdThread?.id) ? current : [createdThread, ...current]);
  };
  const unsupportedMainOpen = () => { setError('Opening a target-host side thread as the main task is not available in this execution view.'); };
  async function refreshTargetProviders() {
    if (!api?.app?.bootstrap) return false;
    const result = await api.app.bootstrap();
    setModels(result?.models ?? []);
    let nextProviders = result?.providers ?? [];
    if (!nextProviders.length && api.providers?.list) {
      try { nextProviders = await api.providers.list(); } catch { /* The target may intentionally hide provider administration. */ }
    }
    setProviders(nextProviders);
    return true;
  }
  async function unsupportedTargetProviderLogin() {
    setError('Provider sign-in must be completed on the target host.');
    return false;
  }
  const openTargetBoard = async (detail) => {
    if (!api?.board?.list) throw new Error('Board preview is unavailable on this host.');
    await api.board.list({ projectId: projectIdRef.current });
    setError('The full Board workspace is not available inside an execution view.');
    return false;
  };
  const openTargetWorkflow = async (detail) => {
    if (!api?.workflows?.list) throw new Error('Workflow preview is unavailable on this host.');
    await api.workflows.list({ projectId: projectIdRef.current });
    setError('The full Workflow workspace is not available inside an execution view.');
    return false;
  };
  useEffect(() => {
    const matches = (detail) => {
      if (!detail || detail.hostId !== hostId) return false;
      if (detail.projectId && detail.projectId !== projectIdRef.current) return false;
      const eventWorkspaceId = detail.workspaceId ?? detail.threadId;
      return !eventWorkspaceId || eventWorkspaceId === rawWorkspaceId;
    };
    const openPreview = (event) => {
      if (matches(event.detail)) setPreview((current) => ({ ...current, open: true }));
    };
    const openTab = (event) => {
      const detail = event.detail;
      if (!matches(detail) || !detail?.tab?.id || !detail.tab.kind) return;
      openCustom({ ...detail.tab, payload: { ...detail.tab.payload, projectId: projectIdRef.current } });
    };
    const openBoard = (event) => {
      if (matches(event.detail)) void openTargetBoard(event.detail).catch((cause) => setError(cause.message));
    };
    const openWorkflow = (event) => {
      if (matches(event.detail)) void openTargetWorkflow(event.detail).catch((cause) => setError(cause.message));
    };
    window.addEventListener('pixice:request-task-preview', openPreview);
    window.addEventListener('pixice:open-preview-tab', openTab);
    window.addEventListener('pixice:open-board-workspace', openBoard);
    window.addEventListener('pixice:open-workflow-workspace', openWorkflow);
    return () => {
      window.removeEventListener('pixice:request-task-preview', openPreview);
      window.removeEventListener('pixice:open-preview-tab', openTab);
      window.removeEventListener('pixice:open-board-workspace', openBoard);
      window.removeEventListener('pixice:open-workflow-workspace', openWorkflow);
    };
  }, [hostId, openCustom, openTargetBoard, openTargetWorkflow, rawWorkspaceId]);
  const recordSideThreadActivity = (threadId) => {
    if (!threadId) return;
    setThreads((current) => current.map((candidate) => candidate.id === threadId ? { ...candidate, updatedAt: Date.now() } : candidate));
  };
  const recordSideThreadViewed = (candidate) => {
    if (!candidate?.id) return;
    setThreads((current) => current.some((item) => item.id === candidate.id)
      ? current.map((item) => item.id === candidate.id ? { ...item, ...candidate } : item)
      : [candidate, ...current]);
  };
  const unsupportedTargetSuggestion = async () => {
    setError('Suggestions are managed by the target host.');
    return false;
  };
  const connectionState = runtime.connected
    ? 'connected'
    : runtime.state === 'unauthorized'
      ? 'unauthorized'
      : runtime.state === 'reconnecting' || runtime.state === 'connecting'
        ? 'reconnecting'
        : 'disconnected';
  const connectionLabel = connectionState === 'connected'
    ? 'Connected'
    : connectionState === 'unauthorized'
      ? 'Unauthorized'
      : connectionState === 'reconnecting'
        ? 'Reconnecting'
        : 'Disconnected';
  const connectionDescription = `${connectionLabel} to ${hostLabel || hostId}`;
  const executionStatus = (
    <span
      className="execution-toolbar-status"
      data-state={connectionState}
      role="status"
      aria-label={connectionDescription}
      title={connectionDescription}
    >
      <i aria-hidden="true" />
      <span>On {hostLabel || hostId}</span>
    </span>
  );
  const executionAction = (
    <button type="button" className="settings-action execution-toolbar-action" onClick={onClose} aria-label="Close remote task">
      <X size={14} />Close
    </button>
  );
  return (
    <section className="execution-workspace-shell" data-execution-host-id={hostId} data-execution-project-id={projectId} aria-label={`Task on ${hostLabel || hostId}`}>
      {error && <div className="execution-workspace-error" role="alert"><Warning size={14} /><span>{error}</span><button type="button" onClick={() => { setError(''); void refreshThread().catch((cause) => setError(cause.message)); }}><ArrowClockwise size={13} />Retry read</button></div>}
      {!runtime.connected && <div className="execution-workspace-status" role="status">{runtime.state === 'unauthorized' ? 'This host needs pairing again.' : 'Waiting for the target host…'}</div>}
      {!readOnly && attention.filter((request) => !isQuestion(request)).map((request) => <ApprovalCard request={request} onResolve={resolveAttention} key={request.id} />)}
      <ConversationWorkspace
        api={api}
        storage={storage}
        project={project}
        thread={thread}
        threads={threads}
        loading={loading}
        runtime={runtime}
        plan={plan}
        changedCount={0}
        seenResponseIds={new Set()}
        inspectorOpen={inspectorOpen}
        onInspectorToggle={() => setInspectorOpen((open) => !open)}
        onOpenProject={() => setError('Projects are managed on the target host.')}
        showTaskProgress
        expandTaskProgress
        showMessageTimestamps
        completedWorkDetails="auto"
        previewOpen={preview.open}
        onPreviewToggle={() => updatePreview((current) => ({ ...current, open: !current.open }))}
        previewWorkspaceId={workspaceId}
        previewApiWorkspaceId={rawWorkspaceId}
        browserState={preview.browserState}
        onBrowserState={(next) => updatePreview((current) => ({ ...current, browserState: next }))}
        onPreviewBrowserCreated={onBrowserCreated}
        previewFileTabs={preview.fileTabs}
        previewInstrumentTabs={preview.instrumentTabs}
        previewCustomTabs={preview.customTabs}
        previewActiveTabId={preview.activeTabId}
        onPreviewActiveTabChange={(activeTabId) => updatePreview((current) => ({ ...current, activeTabId }))}
        onPreviewBrowserClose={closeBrowser}
        onPreviewFileUpdate={fileUpdate}
        onPreviewFileClose={closeFile}
        onPreviewInstrumentClose={(instrumentId) => updatePreview((current) => ({ ...current, instrumentTabs: current.instrumentTabs.filter((instrument) => instrument.id !== instrumentId), activeTabId: current.activeTabId === `instrument:${instrumentId}` ? null : current.activeTabId }))}
        onPreviewCustomTabOpen={openCustom}
        onPreviewCustomTabUpdate={updateCustom}
        onPreviewCustomTabClose={closeCustom}
        onPreviewNewTab={() => openCustom({ id: `new:${workspaceId}`, kind: 'new', title: 'New tab', payload: {} })}
        onPreviewInstrumentRefresh={refreshInstrument}
        onPreviewInstrumentEvent={sendInstrumentEvent}
        onPreviewInstrumentInvoke={invokeInstrument}
        onPreviewInstrumentPin={pinInstrument}
        onOpenWorkspaceReference={openResource}
        proactiveSuggestions={[]}
        onProactiveSuggestionResolve={unsupportedTargetSuggestion}
        onOpenBoardWorkspace={openTargetBoard}
        onOpenWorkflowWorkspace={openTargetWorkflow}
        sideThreadProps={{ runtime, models, providers, threads, attention, preferences: { preserveDrafts: true, showMessageTimestamps: true, completedWorkDetails: 'auto', spellCheckComposer: true, autoFocusComposer: false }, seenResponseIds: new Set(), defaultModel: selectedModel, defaultEffort: effort, defaultFastMode: fastMode, defaultPermissionMode: permissionMode, onQuestionResolve: resolveAttention, onProviderLogin: unsupportedTargetProviderLogin, onProvidersRefresh: refreshTargetProviders, onThreadCreated: registerSideThread, onThreadActivity: recordSideThreadActivity, onThreadViewed: recordSideThreadViewed, onOpenMain: unsupportedMainOpen, onForkResponse: async () => { setError('Forking target-host side threads is not available in this execution view.'); return false; }, onError: setError, storage }}
        taskMapProps={taskMapProps}
        receipt={receipt}
        onReceiptCompare={() => setError('Model comparison is available on the origin task.')}
        composerProps={composerProps}
        executionStatus={executionStatus}
        executionAction={executionAction}
        readOnly={readOnly}
      />
      {!readOnly && <Inspector open={inspectorOpen} thread={thread} threads={threads} plan={plan} attention={attention} onResolve={resolveAttention} />}
    </section>
  );
}
