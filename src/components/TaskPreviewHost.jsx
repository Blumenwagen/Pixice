import { getPixiceApi } from "../connect/client.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Circle, Gauge, GitBranch, Plus, SpinnerGap, Trash, TreeStructure, Warning, X } from "./icons/index.jsx";
import { KANBAN_COLUMNS } from "./KanbanBoard.jsx";
import styles from "./TaskPreviewHost.module.css";

const TRIGGERS = [
  ["entered-ready", "Entered Ready"],
  ["dependencies-completed", "Dependencies completed"],
  ["planned-start-reached", "Planned start reached"],
  ["deadline-approaching", "Deadline approaching"],
  ["became-overdue", "Became overdue"],
  ["schedule-changed", "Schedule changed"]
];

function localInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoInput(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function draftFromTask(task) {
  return {
    title: task.title ?? "",
    description: task.description ?? "",
    column: task.column ?? "backlog",
    kind: task.kind ?? "task",
    priority: task.priority ?? "normal",
    estimateMinutes: task.estimateMinutes ?? "",
    owner: task.owner ?? "",
    plannedStart: localInput(task.schedule?.plannedStart),
    plannedEnd: localInput(task.schedule?.plannedEnd),
    hardDeadline: localInput(task.schedule?.hardDeadline),
    allDay: Boolean(task.schedule?.allDay),
    timezone: task.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    autoSchedule: Boolean(task.schedule?.autoSchedule),
    lockedFields: task.schedule?.lockedFields ?? [],
    dependencies: (task.dependencies ?? []).map((entry) => entry.dependsOnTaskId)
  };
}

function draftWithScheduleProposal(task, proposal) {
  const draft = draftFromTask(task);
  if (!proposal) return draft;
  const locked = new Set(draft.lockedFields);
  return {
    ...draft,
    plannedStart: locked.has("plannedStart") ? draft.plannedStart : localInput(proposal.plannedStart),
    plannedEnd: locked.has("plannedEnd") ? draft.plannedEnd : localInput(proposal.plannedEnd),
    hardDeadline: locked.has("hardDeadline") ? draft.hardDeadline : localInput(proposal.hardDeadline ?? task.schedule?.hardDeadline),
    allDay: proposal.allDay ?? draft.allDay,
    timezone: proposal.timezone ?? draft.timezone,
    autoSchedule: proposal.autoSchedule ?? draft.autoSchedule,
    lockedFields: proposal.lockedFields ?? draft.lockedFields
  };
}

function taskPatch(draft) {
  const hasSchedule = draft.plannedStart || draft.plannedEnd || draft.hardDeadline;
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    kind: draft.kind,
    priority: draft.priority,
    estimateMinutes: draft.estimateMinutes === "" ? null : Math.max(0, Number(draft.estimateMinutes)),
    owner: draft.owner.trim(),
    schedule: hasSchedule ? {
      plannedStart: isoInput(draft.plannedStart),
      plannedEnd: isoInput(draft.plannedEnd || draft.plannedStart),
      hardDeadline: isoInput(draft.hardDeadline),
      allDay: draft.allDay,
      timezone: draft.timezone,
      constraintType: draft.lockedFields.includes("plannedStart") ? "fixed-start" : "flexible",
      lockedFields: draft.lockedFields,
      autoSchedule: draft.autoSchedule,
      explanation: "Edited in task Preview."
    } : null,
    dependencies: draft.dependencies.map((dependsOnTaskId) => ({ dependsOnTaskId, type: "finish-to-start", lagMinutes: 0 }))
  };
}

function shortDate(value) {
  if (!value) return "Unscheduled";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function compactRunOutput(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function scheduleImpactMessage(target) {
  if (!target.scheduleProposal) return null;
  const impact = target.scheduleImpact ?? { dependents: [], enabledBindings: 0, lockedFields: [] };
  const parts = [`Review this move before saving: ${shortDate(target.scheduleProposal.plannedStart)} to ${shortDate(target.scheduleProposal.plannedEnd)}.`];
  parts.push(impact.dependents.length
    ? `${impact.dependents.length} downstream ${impact.dependents.length === 1 ? "item needs" : "items need"} review: ${impact.dependents.map((entry) => entry.title).join(", ")}.`
    : "No dependent work items move automatically.");
  if (impact.enabledBindings) parts.push(`${impact.enabledBindings} enabled Workflow ${impact.enabledBindings === 1 ? "binding keeps" : "bindings keep"} its event rule.`);
  if (impact.lockedFields.length) parts.push(`Protected fields stay unchanged: ${impact.lockedFields.join(", ")}.`);
  return parts.join(" ");
}

function PlanPreview({ api, target, onClose, onOpenWorkspace, onTitleChange, tabbed = false }) {
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    api.board.readProposal({ projectId: target.projectId, proposalId: target.proposalId }).then((value) => active && setProposal(value)).catch((cause) => active && setError(cause.message));
    return () => { active = false; };
  }, [api, target.projectId, target.proposalId]);
  useEffect(() => {
    if (proposal?.title) onTitleChange?.(proposal.title);
  }, [proposal?.title]);
  const act = async (action) => {
    setBusy(true);
    try {
      const value = await api.board[action]({ projectId: target.projectId, proposalId: target.proposalId });
      setProposal(value.proposal ?? value);
      if (action === "discardProposal") onClose();
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  if (error) return <div className={styles.preview} data-tabbed={tabbed}><header><span><Warning size={15} />Plan unavailable</span>{!tabbed && <button onClick={onClose} aria-label="Close task preview"><X size={15} /></button>}</header><div className={styles.empty}>{error}</div></div>;
  if (!proposal) return <div className={styles.preview} data-tabbed={tabbed}><div className={styles.loading}><SpinnerGap className="spin-icon" size={18} />Loading plan</div></div>;
  const plan = proposal.proposal;
  return <div className={styles.preview} data-tabbed={tabbed}><header><span><Gauge size={15} />Plan proposal</span><div><button onClick={onOpenWorkspace}>Open Board</button>{!tabbed && <button onClick={onClose} aria-label="Close task preview"><X size={15} /></button>}</div></header><div className={styles.planHero}><small>{proposal.status}</small><h2>{proposal.title}</h2><p>{plan.outcome || "Review the dates and dependencies before applying this plan."}</p><div><span>{plan.items.length} items</span><span>{plan.timezone}</span><span>{plan.conflicts.length} conflicts</span></div></div>{plan.conflicts.length > 0 && <div className={styles.conflicts}>{plan.conflicts.map((conflict) => <p key={`${conflict.taskId}:${conflict.type}`}><Warning size={13} />{conflict.message}</p>)}</div>}<div className={styles.planList}>{plan.items.map((item) => <article key={item.id}><span data-column={item.column} /><div><strong>{item.title}</strong><small>{item.kind} · {item.estimateMinutes} min · {item.confidence} confidence</small></div><time>{shortDate(item.schedule.plannedStart)}<b>to {shortDate(item.schedule.plannedEnd)}</b></time></article>)}</div><footer><button className={styles.quiet} disabled={busy || proposal.status !== "proposed"} onClick={() => act("discardProposal")}>Discard</button><span /><button className={styles.primary} disabled={busy || proposal.status !== "proposed" || plan.conflicts.length > 0} onClick={() => act("applyProposal")}>{busy ? "Applying…" : proposal.status === "applied" ? "Plan applied" : "Apply plan"}</button></footer></div>;
}

function TaskEditor({ api, target, onClose, onOpenWorkspace, onTitleChange, tabbed = false }) {
  const [task, setTask] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [activity, setActivity] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [workflowRuns, setWorkflowRuns] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [remoteTask, setRemoteTask] = useState(null);
  const [bindingDraft, setBindingDraft] = useState({ workflowId: "", triggerType: "entered-ready", missedTriggerPolicy: "ask" });
  const baselineRef = useRef("");
  const dirty = draft ? JSON.stringify(draft) !== baselineRef.current : false;
  const load = useCallback(async ({ preserveDraft = false } = {}) => {
    const [detail, board, workflowList, taskRuns] = await Promise.all([
      api.board.read({ projectId: target.projectId, taskId: target.taskId }),
      api.board.list({ projectId: target.projectId }),
      api.workflows?.list({ projectId: target.projectId }).catch(() => ({ data: [] })) ?? { data: [] },
      api.workflows?.taskRuns?.({ projectId: target.projectId, taskId: target.taskId }).catch(() => ({ data: [] })) ?? Promise.resolve({ data: [] })
    ]);
    setTask(detail.task);
    setTasks(board.data ?? []);
    setActivity(detail.activity ?? []);
    setWorkflows(workflowList.data ?? []);
    setWorkflowRuns(taskRuns.data ?? []);
    if (!preserveDraft) {
      const saved = draftFromTask(detail.task);
      const next = draftWithScheduleProposal(detail.task, target.scheduleProposal);
      setDraft(next);
      baselineRef.current = JSON.stringify(saved);
      setRemoteTask(null);
      setError(scheduleImpactMessage(target));
    } else setRemoteTask(detail.task);
    setBindingDraft((current) => ({ ...current, workflowId: current.workflowId || workflowList.data?.[0]?.id || "" }));
  }, [api, target, target.projectId, target.scheduleProposal, target.taskId]);
  useEffect(() => { setError(null); void load().catch((cause) => setError(cause.message)); }, [load]);
  useEffect(() => {
    if (task?.title) onTitleChange?.(task.title);
  }, [task?.title]);
  useEffect(() => api.events?.subscribe?.((event) => {
    if (!new Set(["BoardUpdated", "WorkflowTriggersUpdated", "WorkflowRunUpdated", "ApplicationResync"]).has(event.type) || event.payload?.projectId && event.payload.projectId !== target.projectId) return;
    if (event.type === "WorkflowTriggersUpdated" && !event.payload?.statuses?.some((status) => status.projectId === target.projectId && (!status.taskId || status.taskId === target.taskId))) return;
    if (event.type === "WorkflowRunUpdated" && !task?.workflowBindings?.some((binding) => binding.workflowId === event.payload?.workflowId)) return;
    if (event.type === "BoardUpdated" && event.payload?.task?.id && event.payload.task.id !== target.taskId) return;
    void load({ preserveDraft: dirty }).catch(() => {});
  }), [api, dirty, load, target.projectId, target.taskId, task]);
  const change = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const save = async () => {
    if (!draft.title.trim()) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.board.update({ projectId: target.projectId, taskId: task.id, ...taskPatch(draft), expectedRevision: task.revision, expectedScheduleRevision: task.schedule?.revision ?? 0 });
      if (draft.column !== updated.column) await api.board.move({ projectId: target.projectId, taskId: task.id, column: draft.column });
      await load();
      if (target.scheduleProposal) onClose();
    } catch (cause) {
      setError(cause.message);
      if (/changed after|newer revision|schedule changed/i.test(cause.message)) await load({ preserveDraft: true }).catch(() => {});
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete “${task.title}”?\n\nIts linked thread and Workflows will stay in Pixice.`)) return;
    setBusy(true);
    try { await api.board.delete({ projectId: target.projectId, taskId: task.id }); onClose(); } catch (cause) { setError(cause.message); setBusy(false); }
  };
  const saveBinding = async () => {
    if (!bindingDraft.workflowId) return;
    setBusy(true);
    try {
      await api.board.saveBinding({ projectId: target.projectId, taskId: task.id, workflowId: bindingDraft.workflowId, triggerType: bindingDraft.triggerType, enabled: false, missedTriggerPolicy: bindingDraft.missedTriggerPolicy });
      await load({ preserveDraft: dirty });
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const updateBinding = async (binding, patch) => {
    setBusy(true);
    try {
      await api.board.saveBinding({ projectId: target.projectId, taskId: task.id, bindingId: binding.id, workflowId: binding.workflowId, triggerNodeId: binding.triggerNodeId, triggerType: binding.triggerType, enabled: binding.enabled, missedTriggerPolicy: binding.missedTriggerPolicy, ...patch });
      await load({ preserveDraft: dirty });
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  if (error && !task) return <div className={styles.preview} data-tabbed={tabbed}><header><span><Warning size={15} />Work item unavailable</span>{!tabbed && <button onClick={onClose} aria-label="Close task preview"><X size={15} /></button>}</header><div className={styles.empty}>{error}</div></div>;
  if (!task || !draft) return <div className={styles.preview} data-tabbed={tabbed}><div className={styles.loading}><SpinnerGap className="spin-icon" size={18} />Loading work item</div></div>;
  const workflowRunSection = <section><div className={styles.sectionTitle}><SpinnerGap size={14} /><div><strong>Workflow runs</strong><small>Runs started by this work item, including status and output.</small></div></div><div className={styles.workflowRuns}>{workflowRuns.length ? workflowRuns.map((run) => <article key={run.id} data-status={run.status}><i /><div><strong>{run.workflowName}</strong><small>{run.eventType ? `${TRIGGERS.find(([id]) => id === run.eventType)?.[1] ?? run.eventType} · ` : ""}{run.status}{run.error ? ` · ${run.error}` : ""}</small>{compactRunOutput(run.output) && <code>{compactRunOutput(run.output)}</code>}</div><time>{shortDate(run.completedAt ?? run.startedAt ?? run.createdAt)}</time></article>) : <p>No Workflow runs for this item yet.</p>}</div></section>;
  return <div className={styles.preview} data-tabbed={tabbed}><header><span><Circle size={15} />Work item · revision {task.revision}</span><div><button onClick={onOpenWorkspace}>Open Board</button>{!tabbed && <button onClick={onClose} aria-label="Close task preview"><X size={15} /></button>}</div></header>{remoteTask && <div className={styles.remoteNotice}><Warning size={14} /><span>A newer saved revision is available. Your unsaved fields are still here.</span><button onClick={() => { const next = draftFromTask(remoteTask); setTask(remoteTask); setDraft(next); baselineRef.current = JSON.stringify(next); setRemoteTask(null); }}>Reload saved version</button></div>}<div className={styles.editorScroll}><section className={styles.editorHero}><label>Title<input autoFocus value={draft.title} maxLength={240} onChange={(event) => change({ title: event.target.value })} /></label><label>Notes<textarea rows={5} value={draft.description} maxLength={10000} onChange={(event) => change({ description: event.target.value })} /></label><div className={styles.fieldGrid}><label>Status<select value={draft.column} onChange={(event) => change({ column: event.target.value })}>{KANBAN_COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label><label>Kind<select value={draft.kind} onChange={(event) => change({ kind: event.target.value })}><option value="task">Task</option><option value="milestone">Milestone</option><option value="event">Event</option></select></label><label>Priority<select value={draft.priority} onChange={(event) => change({ priority: event.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Estimate · minutes<input type="number" min="0" value={draft.estimateMinutes} onChange={(event) => change({ estimateMinutes: event.target.value })} /></label><label className={styles.wide}>Owner<input value={draft.owner} maxLength={160} placeholder="Person or agent" onChange={(event) => change({ owner: event.target.value })} /></label></div></section><section><div className={styles.sectionTitle}><Gauge size={14} /><div><strong>Schedule</strong><small>Dates place this same item on Timeline.</small></div></div><div className={styles.fieldGrid}><label>Planned start<input type="datetime-local" value={draft.plannedStart} onChange={(event) => change({ plannedStart: event.target.value })} /></label><label>Planned end<input type="datetime-local" value={draft.plannedEnd} onChange={(event) => change({ plannedEnd: event.target.value })} /></label><label>Hard deadline<input type="datetime-local" value={draft.hardDeadline} onChange={(event) => change({ hardDeadline: event.target.value })} /></label><label>Timezone<input value={draft.timezone} onChange={(event) => change({ timezone: event.target.value })} /></label></div><div className={styles.inlineChecks}><label><input type="checkbox" checked={draft.allDay} onChange={(event) => change({ allDay: event.target.checked })} />All day</label><label><input type="checkbox" checked={draft.autoSchedule} onChange={(event) => change({ autoSchedule: event.target.checked })} />Maintain unlocked dates</label><label><input type="checkbox" checked={draft.lockedFields.includes("hardDeadline")} onChange={(event) => change({ lockedFields: event.target.checked ? [...new Set([...draft.lockedFields, "hardDeadline"])] : draft.lockedFields.filter((field) => field !== "hardDeadline") })} />Protect deadline</label></div></section><section><div className={styles.sectionTitle}><GitBranch size={14} /><div><strong>Dependencies</strong><small>Finish-to-start links are cycle checked before saving.</small></div></div><div className={styles.dependencyList}>{tasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={draft.dependencies.includes(candidate.id)} onChange={(event) => change({ dependencies: event.target.checked ? [...draft.dependencies, candidate.id] : draft.dependencies.filter((id) => id !== candidate.id) })} /><span>{candidate.title}</span><small>{candidate.column}</small></label>)}</div></section><section><div className={styles.sectionTitle}><TreeStructure size={14} /><div><strong>Workflow bindings</strong><small>Dates never run work by themselves. Enable each binding explicitly.</small></div></div><div className={styles.bindings}>{task.workflowBindings?.map((binding) => <article key={binding.id}><div><strong>{workflows.find((workflow) => workflow.id === binding.workflowId)?.name ?? binding.workflowId}</strong><small>{TRIGGERS.find(([id]) => id === binding.triggerType)?.[1] ?? binding.triggerType}</small></div><label className={styles.bindingPolicy}>Missed<select aria-label={`Missed event policy for ${binding.triggerType}`} value={binding.missedTriggerPolicy} onChange={(event) => updateBinding(binding, { missedTriggerPolicy: event.target.value })}><option value="ask">Ask</option><option value="skip">Skip</option><option value="notify">Notify</option><option value="run">Run</option></select></label><label><input type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(binding, { enabled: event.target.checked })} />Enabled</label><button onClick={() => api.board.deleteBinding({ projectId: target.projectId, taskId: task.id, bindingId: binding.id }).then(() => load({ preserveDraft: dirty }))} aria-label="Remove workflow binding"><Trash size={13} /></button></article>)}</div><div className={styles.bindingAdd}><select value={bindingDraft.workflowId} onChange={(event) => setBindingDraft((current) => ({ ...current, workflowId: event.target.value }))}><option value="">Choose workflow</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select><select value={bindingDraft.triggerType} onChange={(event) => setBindingDraft((current) => ({ ...current, triggerType: event.target.value }))}>{TRIGGERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Missed event policy" value={bindingDraft.missedTriggerPolicy} onChange={(event) => setBindingDraft((current) => ({ ...current, missedTriggerPolicy: event.target.value }))}><option value="ask">Ask if missed</option><option value="skip">Skip if missed</option><option value="notify">Notify if missed</option><option value="run">Run if missed</option></select><button disabled={!bindingDraft.workflowId || busy} onClick={saveBinding}><Plus size={13} />Add disabled binding</button></div></section>{workflowRunSection}<section><div className={styles.sectionTitle}><Check size={14} /><div><strong>Activity</strong><small>Recent user, agent, and Workflow changes.</small></div></div><div className={styles.activity}>{activity.length ? activity.map((entry) => <article key={entry.id}><i /><div><strong>{entry.summary}</strong><small>{entry.actorKind || "Pixice"}{entry.actorId ? ` · ${entry.actorId}` : ""}</small></div><time>{shortDate(entry.createdAt)}</time></article>) : <p>No recorded changes yet.</p>}</div></section></div>{error && <div className={styles.error}>{error}</div>}<footer><button className={styles.delete} disabled={busy} onClick={remove}><Trash size={13} />Delete</button><span /><small>{dirty ? "Unsaved changes" : `Saved ${shortDate(task.updatedAt)}`}</small><button className={styles.primary} disabled={busy || !dirty || !draft.title.trim()} onClick={save}>{busy ? "Saving…" : "Save changes"}</button></footer></div>;
}

export function TaskPreviewContent({ api = getPixiceApi(), target, onClose, onOpenWorkspace, onTitleChange, tabbed = false }) {
  if (!target) return null;
  return target.proposalId
    ? <PlanPreview api={api} target={target} onClose={onClose} onOpenWorkspace={onOpenWorkspace} onTitleChange={onTitleChange} tabbed={tabbed} />
    : <TaskEditor key={`${target.taskId}:${target.scheduleProposal?.plannedStart ?? "saved"}`} api={api} target={target} onClose={onClose} onOpenWorkspace={onOpenWorkspace} onTitleChange={onTitleChange} tabbed={tabbed} />;
}

export function TaskPreviewHost({ children, api: explicitApi = null }) {
  const api = explicitApi ?? getPixiceApi();
  const open = useCallback((detail) => {
    if (!detail?.workspaceId || (!detail.taskId && !detail.proposalId)) return;
    const currentHostId = api?.remote?.hostId ?? "local";
    const hostId = detail.hostId ?? api?.remote?.hostId ?? "local";
    if (detail.hostId !== undefined && detail.hostId !== currentHostId) return;
    const scopedDetail = { ...detail, hostId };
    window.dispatchEvent(new CustomEvent("pixice:request-task-preview", { detail: scopedDetail }));
    const kind = detail.proposalId ? "plan" : "task";
    const entityId = detail.proposalId ?? detail.taskId;
    const tabId = `${hostId}:${kind}:${entityId}`;
    window.dispatchEvent(new CustomEvent("pixice:open-preview-tab", {
      detail: {
        workspaceId: detail.workspaceId,
        ...(hostId ? { hostId } : {}),
        tab: {
          id: tabId,
          kind,
          title: kind === "plan" ? "Plan proposal" : "Work item",
          payload: scopedDetail
        }
      }
    }));
  }, [api]);
  useEffect(() => {
    const custom = (event) => open(event.detail);
    window.addEventListener("pixice:task-preview-requested", custom);
    const unsubscribe = api?.events?.subscribe?.((event) => {
      if (event.type !== "TaskPreviewOpenRequested") return;
      const detail = event.payload ?? {};
      if (detail.workspaceId) open(detail);
    });
    return () => { window.removeEventListener("pixice:task-preview-requested", custom); unsubscribe?.(); };
  }, [api, open]);
  return children;
}
