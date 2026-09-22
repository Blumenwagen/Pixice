import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Check, Pause, PaperPlaneTilt, Warning } from "./icons/index.jsx";
import "./FocusCoordination.css";

const EMPTY_STATE = { work: [], decisions: [], policy: null, events: [], seenSequence: 0, latestSequence: 0, unseenEvents: [] };
const TERMINAL = new Set(["done", "failed", "cancelled"]);

function modelId(model) {
  return model?.id ?? model?.model ?? "";
}

function modelProvider(model) {
  return model?.provider ?? (String(modelId(model)).toLowerCase().includes("claude") ? "claude" : "codex");
}

function modelLabel(model) {
  return model?.displayName ?? model?.label ?? modelId(model);
}

function readableStatus(status) {
  return ({
    queued: "Queued", blocked: "Waiting on other work", starting: "Starting", running: "Working", paused: "Paused", cancelling: "Cancelling", review: "Ready for review",
    done: "Verified", failed: "Failed", cancelled: "Cancelled", "needs-attention": "Needs attention"
  })[status] ?? "Working";
}

function eventCopy(event) {
  return event?.summary ?? event?.message ?? event?.title ?? event?.detail ?? (event?.type ? String(event.type).replace(/([A-Z])/g, " $1").trim() : "Work changed");
}

function safeWork(state) {
  return Array.isArray(state?.work) ? state.work : [];
}

function verificationCopy(verification) {
  if (typeof verification === "string") return { status: null, evidence: verification };
  if (!verification || typeof verification !== "object") return null;
  const status = typeof verification.status === "string" ? verification.status.replace(/[-_]/g, " ") : "Recorded";
  const evidence = verification.evidence;
  const text = typeof evidence === "string"
    ? evidence
    : Array.isArray(evidence)
      ? evidence.map((entry) => typeof entry === "string" ? entry : entry?.summary ?? entry?.message ?? "").filter(Boolean).join(" · ")
      : evidence && typeof evidence === "object"
        ? evidence.summary ?? evidence.message ?? "Evidence recorded"
        : "Evidence recorded";
  return { status, evidence: text };
}

function PolicyModelSelect({ label, value, models, field, onChange, coordinatorProvider, bridgeRequired = false }) {
  const hasCrossProviderLock = field === "coordinatorModel" && coordinatorProvider;
  return (
    <label className="focus-coordination-policy-row">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(field, event.target.value || null)} aria-label={`${label} model`}>
        <option value="">Automatic</option>
        {models.map((model) => {
          const id = modelId(model);
          const locked = hasCrossProviderLock && modelProvider(model) !== coordinatorProvider;
          const unavailable = bridgeRequired && model.bridge?.eligible === false;
          return <option key={id} value={id} disabled={locked || unavailable}>{modelLabel(model)}{locked ? " (provider locked)" : unavailable ? " (unavailable)" : ""}</option>;
        })}
      </select>
    </label>
  );
}

function WorkItem({ item, onControl, onFollowUp, busy }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const active = !TERMINAL.has(item.status) && item.status !== "review";
  const canPause = ["queued", "blocked", "starting", "running"].includes(item.status);
  const canResume = ["paused", "needs-attention"].includes(item.status);
  const decisionCurrent = item.decisionRevision == null || item.acknowledgedDecisionRevision === item.decisionRevision;
  const verification = verificationCopy(item.verification);
  const submit = async (event) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    if (await onFollowUp(item.id, text)) setPrompt("");
  };
  return (
    <article className="focus-coordination-work" data-status={item.status}>
      <div className="focus-coordination-work-main">
        <span className="focus-coordination-status" aria-label={readableStatus(item.status)}>{item.status === "failed" || item.status === "needs-attention" ? <Warning size={13} /> : item.status === "done" ? <Check size={13} /> : item.status === "paused" ? <Pause size={12} /> : <i />}</span>
        <button className="focus-coordination-work-title" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
          <span><strong>{item.title || "Untitled work"}</strong><small>{readableStatus(item.status)}{item.model ? ` · ${item.model}` : ""}</small></span>
          <CaretDown size={13} />
        </button>
        <div className="focus-coordination-work-actions">
          {canPause && <button type="button" onClick={() => onControl(item.id, "pause")} disabled={busy}>Pause</button>}
          {canResume && <button type="button" onClick={() => onControl(item.id, "resume")} disabled={busy}>Resume</button>}
          {active && <button type="button" className="danger" onClick={() => onControl(item.id, "cancel")} disabled={busy}>Cancel</button>}
        </div>
      </div>
      {open && <div className="focus-coordination-work-detail">
        {item.prompt && <p>{item.prompt}</p>}
        {item.answer && <div className="focus-coordination-answer"><strong>Result</strong><p>{item.answer}</p></div>}
        {item.artifacts?.length > 0 && <div className="focus-coordination-artifacts"><strong>Artifacts</strong>{item.artifacts.map((artifact, index) => <p key={index}>{typeof artifact === "string" ? artifact : artifact?.path ?? artifact?.url ?? artifact?.label ?? "Artifact"}</p>)}</div>}
        {item.error && <p className="focus-coordination-error">{item.error}</p>}
        {verification && <p className="focus-coordination-verification">{item.status === "review" ? "Review pending" : "Verification"}{verification.status ? ` · ${verification.status}` : ""}: {verification.evidence}</p>}
        {item.dependsOn?.length > 0 && <p className="focus-coordination-meta">Waiting on {item.dependsOn.length} dependency{item.dependsOn.length === 1 ? "" : "ies"}</p>}
        {item.decisionRevision != null && <p className={`focus-coordination-decision-state${decisionCurrent ? " acknowledged" : ""}`}>{decisionCurrent ? "Decision acknowledged" : "Decision needs acknowledgement"}</p>}
        <form onSubmit={submit} className="focus-coordination-followup">
          <input aria-label={`Redirect ${item.title || "work"}`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Redirect or add detail" disabled={busy} />
          <button type="submit" aria-label="Send follow-up" disabled={busy || !prompt.trim()}><PaperPlaneTilt size={13} /></button>
        </form>
      </div>}
    </article>
  );
}

/** Compact, event-driven companion for a Focus coordinator conversation. */
export function FocusCoordination({ api, projectId, models = [] }) {
  const [state, setState] = useState(EMPTY_STATE);
  const [open, setOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [busyWork, setBusyWork] = useState(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [error, setError] = useState(null);
  const scopeRef = useRef(projectId);
  const requestRef = useRef(0);
  const refreshTimerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!api?.focus?.state || !projectId) return;
    const request = ++requestRef.current;
    try {
      const next = await api.focus.state({ projectId });
      if (scopeRef.current !== projectId || request !== requestRef.current) return;
      setState({ ...EMPTY_STATE, ...(next ?? {}) });
      setError(null);
    } catch (cause) {
      if (scopeRef.current === projectId && request === requestRef.current) setError(cause?.message ?? "Could not refresh Focus activity.");
    }
  }, [api, projectId]);

  useEffect(() => {
    scopeRef.current = projectId;
    requestRef.current += 1;
    setState(EMPTY_STATE);
    setError(null);
    setBusyWork(null);
    setPolicyBusy(false);
    if (projectId) void refresh();
    return () => { if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current); };
  }, [projectId, refresh]);

  useEffect(() => {
    const subscribe = api?.onEvent ?? api?.events?.subscribe;
    if (!subscribe || !projectId) return undefined;
    return subscribe((event) => {
      if (event?.type !== "FocusUpdated" || event?.payload?.projectId !== projectId) return;
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void refresh(); }, 150);
    });
  }, [api, projectId, refresh]);

  const control = async (workId, action) => {
    if (!api?.focus?.controlWork) return;
    const scopedProjectId = projectId;
    setBusyWork(`${workId}:${action}`);
    setError(null);
    try {
      await api.focus.controlWork({ projectId: scopedProjectId, workId, action });
      if (scopeRef.current !== scopedProjectId) return false;
      await refresh();
      return true;
    } catch (cause) {
      if (scopeRef.current === scopedProjectId) setError(cause?.message ?? `Could not ${action} work.`);
      return false;
    } finally {
      if (scopeRef.current === scopedProjectId) setBusyWork(null);
    }
  };

  const followUp = async (workId, prompt) => {
    if (!api?.focus?.followUp) return;
    const scopedProjectId = projectId;
    setBusyWork(`${workId}:follow-up`);
    setError(null);
    try {
      await api.focus.followUp({ projectId: scopedProjectId, workId, prompt });
      if (scopeRef.current !== scopedProjectId) return false;
      await refresh();
      return true;
    } catch (cause) {
      if (scopeRef.current === scopedProjectId) setError(cause?.message ?? "Could not send the follow-up.");
      return false;
    } finally {
      if (scopeRef.current === scopedProjectId) setBusyWork(null);
    }
  };

  const updatePolicy = async (field, value) => {
    if (!api?.focus?.updatePolicy) return;
    const scopedProjectId = projectId;
    setPolicyBusy(true);
    setError(null);
    try {
      const policy = await api.focus.updatePolicy({ projectId: scopedProjectId, patch: { [field]: value } });
      if (scopeRef.current === scopedProjectId) setState((current) => ({ ...current, policy: policy ?? current.policy }));
    } catch (cause) {
      if (scopeRef.current === scopedProjectId) setError(cause?.message ?? "Could not update Focus policy.");
    } finally {
      if (scopeRef.current === scopedProjectId) setPolicyBusy(false);
    }
  };

  const dismissUnseen = async () => {
    if (!api?.focus?.markSeen) return;
    const sequence = Math.max(Number(state.latestSequence) || 0, ...((state.unseenEvents ?? []).map((event) => Number(event.sequence) || 0)));
    if (!sequence) return;
    const scopedProjectId = projectId;
    setError(null);
    try {
      await api.focus.markSeen({ projectId: scopedProjectId, sequence });
      if (scopeRef.current === scopedProjectId) setState((current) => ({ ...current, seenSequence: Math.max(Number(current.seenSequence) || 0, sequence), unseenEvents: [] }));
    } catch (cause) {
      if (scopeRef.current === scopedProjectId) setError(cause?.message ?? "Could not dismiss new activity.");
    }
  };

  const work = safeWork(state);
  const activeCount = work.filter((item) => !TERMINAL.has(item.status)).length;
  const unseen = state.unseenEvents ?? [];
  const policy = state.policy;
  const coordinator = models.find((model) => modelId(model) === policy?.coordinatorModel);
  const coordinatorProvider = coordinator ? modelProvider(coordinator) : null;
  const available = Boolean(api?.focus?.state && projectId);
  if (!available) return null;

  return (
    <section className="focus-coordination" data-focus-coordination="true" aria-label="Coordinator activity">
      {unseen.length > 0 && <div className="focus-coordination-unseen" role="status"><span><strong>Since you were away</strong>{unseen.slice(0, 2).map(eventCopy).join(" · ")}</span><button type="button" onClick={dismissUnseen}>Dismiss</button></div>}
      <button type="button" className="focus-coordination-trigger" onClick={() => setOpen((current) => !current)} aria-label="Activity" aria-expanded={open}>
        <span><strong>Activity</strong><small>{activeCount ? `${activeCount} active` : work.length ? "Up to date" : "No delegated work"}</small></span>
        <CaretDown size={14} />
      </button>
      {open && <div className="focus-coordination-disclosure">
        {work.length ? <div className="focus-coordination-work-list">{work.map((item) => <WorkItem key={item.id} item={item} onControl={control} onFollowUp={followUp} busy={Boolean(busyWork)} />)}</div> : <p className="focus-coordination-empty">The coordinator will show delegated work here.</p>}
        {policy && <section className="focus-coordination-policy">
          <button type="button" onClick={() => setPolicyOpen((current) => !current)} aria-expanded={policyOpen}><span>Coordinator policy</span><CaretDown size={13} /></button>
          {policyOpen && <div className="focus-coordination-policy-body" aria-busy={policyBusy}>
            <PolicyModelSelect label="Coordinator" field="coordinatorModel" value={policy.coordinatorModel} models={models} onChange={updatePolicy} coordinatorProvider={coordinatorProvider} />
            <PolicyModelSelect label="Workers" field="workerModel" value={policy.workerModel} models={models} onChange={updatePolicy} bridgeRequired />
            <PolicyModelSelect label="Review" field="reviewModel" value={policy.reviewModel} models={models} onChange={updatePolicy} bridgeRequired />
            {coordinatorProvider && <p className="focus-coordination-policy-help">The active coordinator stays with {coordinatorProvider}; choose another model from that provider.</p>}
            <p className="focus-coordination-host">Coordinator <strong>Full access</strong></p>
            <label className="focus-coordination-policy-row"><span>Concurrent workers</span><select value={policy.maxWorkers ?? 2} aria-label="Concurrent workers" onChange={(event) => updatePolicy("maxWorkers", Number(event.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <label className="focus-coordination-policy-row"><span>New work access</span><select value={policy.permissionMode ?? "workspace-write"} aria-label="New work access" onChange={(event) => updatePolicy("permissionMode", event.target.value)}><option value="read-only">Read only</option><option value="workspace-write">Workspace access</option><option value="auto-approve">Auto-review</option><option value="full-access">Full access</option></select></label>
            <p className="focus-coordination-host">Execution host <strong>Current host</strong></p>
          </div>}
        </section>}
        {error && <p className="focus-coordination-error" role="alert">{error}</p>}
      </div>}
    </section>
  );
}
