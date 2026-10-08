import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, MarkdownMessage, ApprovalCard } from "../../App.jsx";
import { appendLocalUserMessage, applyRuntimePayload } from "../../state/runtime.js";
import { createWorkspaceStorage } from "../../connect/execution-storage.js";
import { assertSubmissionRequestBudget, requestPayloadWithAttachments } from "../../connect/transfer-client.js";
import { Plus, SpinnerGap } from "../icons/index.jsx";
import { canvasAgentContext } from "./canvas-store.js";
import { attentionIdentity } from "../../lib/attention-identity.js";
import styles from "./Canvas.module.css";

function generation(request) { return request.requestGeneration === undefined ? {} : { requestGeneration: request.requestGeneration }; }

export function CanvasAgent({ nodeId, data, api, hostId = "local", projects, models, defaults, documentRef, onChange, onPin }) {
  const [thread, setThread] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [requests, setRequests] = useState([]);
  const [providers, setProviders] = useState([]);
  const threadIdRef = useRef(data.threadId);
  const submitting = useRef(false);
  const dataRef = useRef(data); dataRef.current = data;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  threadIdRef.current = data.threadId;
  const projectId = data.projectId || documentRef.current.projectId || "";
  const selectedModel = data.model ?? defaults.defaultModel ?? models[0]?.model ?? "";
  const permissionMode = data.permissionMode ?? defaults.defaultPermissionMode ?? "workspace-write";
  const selected = models.find(model => model.model === selectedModel);
  const efforts = (selected?.supportedReasoningEfforts ?? []).map(entry => typeof entry === "string" ? entry : entry.reasoningEffort);
  const requestedEffort = data.effort ?? defaults.defaultEffort;
  const effort = efforts.includes(requestedEffort) ? requestedEffort : selected?.defaultReasoningEffort;
  const runningTurn = thread?.turns?.findLast(turn => turn.status === "inProgress" || turn.status === "running");
  const messages = (thread?.turns ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === "userMessage" || item.type === "agentMessage"));
  const storage = useMemo(() => createWorkspaceStorage(hostId), [hostId]);
  const draftKey = `canvas:${documentRef.current.id}:${nodeId}`;
  const draftStorage = useMemo(() => {
    if (dataRef.current.prompt && !storage.getItem(`pixice.draft.${draftKey}`)) storage.setItem(`pixice.draft.${draftKey}`, dataRef.current.prompt);
    return { ...storage, setItem(key, value) { storage.setItem(key, value); if (key === `pixice.draft.${draftKey}` && value !== dataRef.current.prompt) changeRef.current({ prompt: value }); }, removeItem(key) { storage.removeItem(key); if (key === `pixice.draft.${draftKey}` && dataRef.current.prompt) changeRef.current({ prompt: "" }); } };
  }, [storage, draftKey]);
  const reload = useCallback(async () => {
    if (!api?.threads?.read || !threadIdRef.current || !projectId) return;
    try { const result = await api.threads.read({ projectId, threadId: threadIdRef.current }); setThread(result.thread); setError(null); }
    catch (cause) { setError(cause.message); }
  }, [api, projectId]);
  useEffect(() => { void reload(); }, [reload, data.threadId]);
  useEffect(() => { if (api?.providers?.list) api.providers.list().then(setProviders).catch(() => {}); }, [api]);
  useEffect(() => {
    if (!api?.events?.subscribe) return;
    let disposed = false;
    api.tasks?.interventions?.().then(result => { if (!disposed) setRequests((result.requests ?? []).filter(request => request.params?.threadId === threadIdRef.current)); }).catch(() => {});
    const unsubscribe = api.events.subscribe(event => {
      const payload = event.payload ?? {};
      if (event.type === "AttentionRequired" && payload.params?.threadId === threadIdRef.current) setRequests(current => [...current.filter(request => request.id !== payload.id), payload]);
      if (event.type === "AttentionResolved") setRequests(current => current.filter(request => String(request.id) !== String(payload.requestId ?? payload.id) || payload.requestGeneration !== undefined && request.requestGeneration !== payload.requestGeneration));
      if (event.type === "AttentionReset") setRequests([]);
      if (["ApplicationResync", "ServiceReset"].includes(event.type)) void reload();
      if (payload.threadId !== threadIdRef.current || !payload.method || payload.projectId && payload.projectId !== projectId) return;
      setThread(current => applyRuntimePayload(current ?? { id: threadIdRef.current, turns: [] }, payload));
    });
    return () => { disposed = true; unsubscribe(); };
  }, [api, data.threadId, projectId, reload]);

  const submit = async (prompt, attachments = [], prepared = {}, sourceAttachments = attachments, signal = null, draftLifecycle = null) => {
    if (submitting.current) return false;
    if (!projectId) { setError("Choose a project for this agent. The canvas can stay independent."); return false; }
    if (!api?.threads?.create || !api?.turns?.start) { setError("Connect a Pixice provider to work with this canvas. Your draft is saved."); return false; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      let threadId = threadIdRef.current;
      if (!threadId) {
        const created = await api.threads.create({ projectId, model: selectedModel || undefined, permissionMode });
        threadId = created.thread.id; threadIdRef.current = threadId; setThread(created.thread);
        onChange({ threadId, projectId });
      }
      const context = canvasAgentContext(documentRef.current, nodeId);
      const payload = requestPayloadWithAttachments({ projectId, threadId, text: prompt + context.text, contextRecords: draftLifecycle?.contextRecords ?? [], images: context.images, model: selectedModel || undefined, effort, permissionMode, serviceTier: data.fastMode ? (selected?.serviceTiers ?? selected?.additionalSpeedTiers ?? []).map(tier => typeof tier === "string" ? tier : tier.id).find(tier => tier === "priority" || tier === "fast") : undefined }, prepared);
      payload.images = [...context.images, ...(payload.images ?? []).filter(image => !context.images.includes(image))];
      assertSubmissionRequestBudget({ api, operation: runningTurn ? "turns.steer" : "turns.start", payload });
      const result = runningTurn ? await api.turns.steer({ ...payload, turnId: runningTurn.id }) : await api.turns.start(payload);
      if (result?.turn) setThread(current => appendLocalUserMessage(applyRuntimePayload(current ?? { id: threadId, turns: [] }, { method: "turn/started", threadId, turn: result.turn }), { turnId: result.turn.id, text: prompt, attachments }));
      return true;
    } catch (cause) { setError(cause.message); return false; } finally { submitting.current = false; setBusy(false); }
  };
  const connected = documentRef.current.edges.some(edge => edge.source === nodeId || edge.target === nodeId);
  const questionRequest = requests.find(request => request.params?.questions?.length);
  return <div className={styles.agentIsland}>
    {messages.length > 0 && <div className={styles.canvasConversation}>{messages.map(item => <div key={item.id} className={styles.canvasMessage} data-role={item.type}><small>{item.type === "userMessage" ? "You" : item.phase === "commentary" ? "Working" : "Pixice"}</small><MarkdownMessage text={item.type === "userMessage" ? (item.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n") : item.text} />{item.phase === "final_answer" && <button className={styles.pinAnswer} onClick={() => onPin(item.text)}><Plus size={12} />Keep as a note</button>}</div>)}</div>}
    {requests.filter(request => !request.params?.questions?.length).map(request => <ApprovalCard key={attentionIdentity(request)} request={request} onResolve={async (_, decision) => {
      try {
        setError(null);
        const result = request.method?.toLowerCase().includes("elicitation")
          ? await api.elicitations.respond({ requestId: request.id, ...generation(request), ...decision })
          : await api.approvals.resolve({ requestId: request.id, ...generation(request), decision });
        if (result?.resolved === false || result?.accepted === false) return false;
        setRequests(current => current.filter(item => attentionIdentity(item) !== attentionIdentity(request)));
        return true;
      } catch (cause) { setError(cause.message); throw cause; }
    }} />)}
    <div className={styles.composerProject}><select aria-label="Agent project" value={projectId} disabled={Boolean(data.threadId) || busy} onChange={event => { onChange({ projectId: event.target.value }); setError(null); }}><option value="">Choose a project for this agent</option>{projects.map(project => <option key={project.id} value={project.id}>{project.displayName ?? project.name}</option>)}</select><small title={connected ? "Only connected items accompany your message." : "Canvas notes, workflow details, and images accompany your message. Connect specific items to narrow the context."}>{connected ? "Connected context" : "Canvas context"}</small>{runningTurn && <span><SpinnerGap className={styles.spin} size={12} />Working</span>}</div>
    {error && <div className={styles.inlineError} role="alert">{error}{data.threadId && <button onClick={reload}>Retry connection</button>}</div>}
    <Composer models={models} selectedModel={selectedModel} onModelChange={model => onChange({ model })} effort={effort} onEffortChange={effort => onChange({ effort })} fastMode={data.fastMode ?? false} onFastModeChange={fastMode => onChange({ fastMode })} permissionMode={permissionMode} onPermissionModeChange={permissionMode => onChange({ permissionMode })} busy={busy} running={Boolean(runningTurn)} draftKey={draftKey} storage={draftStorage} preserveDrafts autoFocusComposer showSlashCommands spellCheckComposer sendShortcut="enter" globalFileDrop={false} ariaLabel="Ask canvas agent" placeholder="Work with this canvas…" runningPlaceholder="Keep working with this canvas…" providers={providers} onProviderLogin={provider => api.providers.login({ provider })} onProvidersRefresh={() => api.providers.list().then(setProviders)} onSubmit={submit} onInterrupt={async () => { try { await api.turns.interrupt({ projectId, threadId: data.threadId, turnId: runningTurn.id }); } catch (cause) { setError(cause.message); } }} questionRequest={questionRequest} onQuestionResolve={async (request, response) => { try { await api.questions.respond({ requestId: request.id, ...generation(request), ...response }); setRequests(current => current.filter(item => item.id !== request.id)); return true; } catch (cause) { setError(cause.message); return false; } }} attachmentContext={{ api, hostId, projectId, threadId: data.threadId }} dictationApi={api} />
  </div>;
}
