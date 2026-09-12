import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChartLineUp, Check, CheckCircle, Circle, Eye, Gauge, List, MagnifyingGlass, PencilSimple, Plus, SpinnerGap } from "./icons/index.jsx";
import { APP_ICONS } from "./icons/app-iconography.jsx";
import { threadStatus } from "../state/runtime.js";
import styles from "./KanbanBoard.module.css";

const StartTaskIcon = APP_ICONS.startTask;

export const KANBAN_COLUMNS = [
  { id: "backlog", label: "Backlog", help: "Captured work", icon: Circle },
  { id: "ready", label: "Ready", help: "Ordered to start next", icon: Check },
  { id: "active", label: "In progress", help: "Work being carried out", icon: SpinnerGap },
  { id: "done", label: "Done", help: "Finished work", icon: CheckCircle }
];

const TASK_MIME = "text/x-pixice-board-task";
const RUNNING_STATUSES = new Set(["running", "inProgress", "active"]);
const DONE_STATUSES = new Set(["completed", "complete", "idle"]);

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(value) {
  const timestamp = timestampMs(value);
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function runState(thread, waitingForInput) {
  if (!thread) return { label: "Planned", tone: "planned" };
  const status = threadStatus(thread);
  if (waitingForInput || status === "attention") return { label: "Needs input", tone: "waiting" };
  if (RUNNING_STATUSES.has(status)) return { label: "Running", tone: "running" };
  if (DONE_STATUSES.has(status)) return { label: "Run complete", tone: "complete" };
  return { label: "Thread linked", tone: "linked" };
}

function QuickAdd({ column, busy, onCreate, onCancel }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onCreate({ title: title.trim(), description: description.trim(), column });
  };
  return (
    <form className={styles.quickAdd} onSubmit={submit}>
      <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" aria-label="Task title" maxLength={240} />
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Notes (optional)" aria-label="Task notes" maxLength={10000} rows={2} />
      <div><button type="submit" disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add task"}</button><button type="button" className={styles.quietButton} onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function TaskCard({ task, phase, thread, columnId, waitingForInput, draggingId, starting, selected, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
  const [dragTarget, setDragTarget] = useState(false);
  const state = runState(thread, waitingForInput);
  const toneClass = styles[`runtime${state.tone[0].toUpperCase()}${state.tone.slice(1)}`] ?? "";
  const columnIndex = KANBAN_COLUMNS.findIndex((column) => column.id === columnId);
  const updated = relativeTime(task.updatedAt);
  const moveFromKeyboard = (direction) => {
    const next = KANBAN_COLUMNS[columnIndex + direction];
    if (next) onMove(task.id, next.id);
  };
  return (
    <article className={`${styles.card} ${dragTarget ? styles.cardDropTarget : ""} ${selected ? styles.cardSelected : ""}`} draggable onDragStart={(event) => {
      event.dataTransfer.setData(TASK_MIME, task.id);
      event.dataTransfer.effectAllowed = "move";
      onDragStart(task.id);
    }} onDragEnd={onDragEnd} onDragOver={(event) => {
      if (!draggingId || draggingId === task.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragTarget(true);
    }} onDragLeave={() => setDragTarget(false)} onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      setDragTarget(false);
      const movedTaskId = event.dataTransfer.getData(TASK_MIME);
      if (movedTaskId && movedTaskId !== task.id) onMove(movedTaskId, columnId, task.id);
    }}>
      <div className={styles.cardTopline}><span className={`${styles.runtime} ${toneClass}`}><i />{state.label}</span>{updated && <time>{updated}</time>}</div>
      <button className={styles.cardTitle} onClick={() => onEdit(task)} onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          moveFromKeyboard(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}><strong>{task.title}</strong>{task.description && <span>{task.description}</span>}</button>
      {phase && <div className={styles.phaseChip}><span>Phase</span>{phase.title}</div>}
      {task.schedule?.plannedStart && <div className={styles.scheduleChip}><Gauge size={11} /><span>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.schedule.plannedStart))}{task.schedule.plannedEnd ? ` – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.schedule.plannedEnd))}` : ""}</span>{task.schedule.hardDeadline && <b>Deadline</b>}</div>}
      {task.latestActivity && <p className={styles.cardActivity}><strong>Pixice</strong><span>{task.latestActivity.summary}</span></p>}
      <div className={styles.cardMeta}><span>{thread ? "Linked thread" : "No thread yet"}</span><span className={styles.cardActions}>{thread && <button onClick={() => onOpen(thread.id)} aria-label={`Open thread for ${task.title}`} title="Open linked thread"><Eye size={13} /></button>}{!thread && <button onClick={() => onStart(task)} disabled={starting} aria-label={`Start ${task.title}`} title="Start task"><StartTaskIcon size={13} />{starting ? "Starting" : "Start"}</button>}<button onClick={() => onEdit(task)} aria-label={`Edit ${task.title}`} title="Edit task"><PencilSimple size={13} /></button></span></div>
    </article>
  );
}

function BoardColumn({ column, tasks, phasesByTaskId, threadsById, draggingId, waitingThreadIds, adding, creating, startingId, selectedTaskId, onBeginAdd, onCancelAdd, onCreate, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
  const [dragOver, setDragOver] = useState(false);
  const Icon = column.icon;
  return (
    <section className={`${styles.column} ${dragOver ? styles.columnDrop : ""}`} aria-labelledby={`board-column-${column.id}`} onDragOver={(event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (draggingId) setDragOver(true);
    }} onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
    }} onDrop={(event) => {
      event.preventDefault();
      setDragOver(false);
      const taskId = event.dataTransfer.getData(TASK_MIME);
      if (taskId) onMove(taskId, column.id);
    }}>
      <header><span className={styles.columnIcon}><Icon size={15} className={column.id === "active" ? "spin-icon" : ""} /></span><span><strong id={`board-column-${column.id}`}>{column.label}</strong><small>{column.help}</small></span><b>{tasks.length}</b><button className={styles.columnAdd} onClick={() => onBeginAdd(column.id)} aria-label={`Add task to ${column.label}`}><Plus size={14} /></button></header>
      <div className={styles.cardList}>
        {adding && <QuickAdd column={column.id} busy={creating} onCreate={onCreate} onCancel={onCancelAdd} />}
        {tasks.length === 0 && !adding && <button className={styles.columnEmpty} onClick={() => onBeginAdd(column.id)}><Plus size={14} />Add a task</button>}
        {tasks.map((task) => <TaskCard key={task.id} task={task} phase={phasesByTaskId.get(task.id)} thread={task.threadId ? threadsById.get(task.threadId) : null} columnId={column.id} waitingForInput={task.threadId ? waitingThreadIds.has(task.threadId) : false} draggingId={draggingId} starting={startingId === task.id} selected={selectedTaskId === task.id} onOpen={onOpen} onEdit={onEdit} onStart={onStart} onMove={onMove} onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
      </div>
    </section>
  );
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function dayStart(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayKey(value) {
  const date = dayStart(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromDayKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value, count) {
  const date = dayStart(value);
  date.setDate(date.getDate() + count);
  return date;
}

function weekStart(value) {
  const date = dayStart(value);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date;
}

function addWeeks(value, count) {
  const date = weekStart(value);
  date.setDate(date.getDate() + count * 7);
  return date;
}

function sameDay(left, right) {
  return dayKey(left) === dayKey(right);
}

function floorHour(value) {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date;
}

function ceilHour(value) {
  const date = floorHour(value);
  if (date.getTime() < new Date(value).getTime()) date.setHours(date.getHours() + 1);
  return date;
}

function addHours(value, count) {
  return new Date(new Date(value).getTime() + count * HOUR_MS);
}

function rescheduled(task, targetDate, preserveTime = true) {
  const currentStart = task.schedule?.plannedStart ? new Date(task.schedule.plannedStart) : dayStart(targetDate);
  const currentEnd = task.schedule?.plannedEnd ? new Date(task.schedule.plannedEnd) : currentStart;
  const duration = Math.max(0, currentEnd.getTime() - currentStart.getTime());
  const target = preserveTime ? dayStart(targetDate) : new Date(targetDate);
  if (preserveTime) target.setHours(currentStart.getHours(), currentStart.getMinutes(), 0, 0);
  return { ...task.schedule, plannedStart: target.toISOString(), plannedEnd: new Date(target.getTime() + duration).toISOString() };
}

function timeLabel(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function timeRange(task) {
  const start = timeLabel(task.schedule.plannedStart);
  if (task.schedule.plannedEnd && !sameDay(task.schedule.plannedStart, task.schedule.plannedEnd)) {
    const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    return `${formatter.format(new Date(task.schedule.plannedStart))}–${formatter.format(new Date(task.schedule.plannedEnd))}`;
  }
  return task.schedule.plannedEnd ? `${start}–${timeLabel(task.schedule.plannedEnd)}` : start;
}

function intradayBounds(scheduledTimes) {
  const earliest = new Date(Math.min(...scheduledTimes));
  const latest = new Date(Math.max(...scheduledTimes));
  const dateStart = dayStart(earliest);
  const dateEnd = addDays(dateStart, 1);
  let start = addHours(floorHour(earliest), -1);
  let end = addHours(ceilHour(latest), 1);
  if (start < dateStart) start = dateStart;
  if (end > dateEnd) end = dateEnd;
  const minimumHours = 6;
  while ((end.getTime() - start.getTime()) / HOUR_MS < minimumHours) {
    if (start > dateStart) start = addHours(start, -1);
    else if (end < dateEnd) end = addHours(end, 1);
    else break;
  }
  return { start, end };
}

const ZOOM_MIN = 0;
const ZOOM_MAX = 2;
const ZOOM_POSITIONS = { hour: .18, day: 1, phase: 1.82 };
const TIMELINE_MORPH_EASE = [.22, 1, .36, 1];
const TIMELINE_MORPH_VARIANTS = {
  initial: ({ direction, origin, reducedMotion }) => reducedMotion ? { opacity: 1 } : {
    opacity: 0,
    scale: direction > 0 ? 1.018 : .982,
    filter: "blur(2px)",
    transformOrigin: origin
  },
  animate: ({ origin }) => ({ opacity: 1, scale: 1, filter: "blur(0px)", transformOrigin: origin }),
  exit: ({ direction, origin, reducedMotion }) => reducedMotion ? { opacity: 0 } : {
    opacity: 0,
    scale: direction > 0 ? .982 : 1.018,
    filter: "blur(2px)",
    transformOrigin: origin
  }
};
const PHASE_STOP_WORDS = new Set(["add", "build", "create", "implement", "make", "setup", "the", "and", "for", "with", "work", "task", "phase"]);

function plannedEnd(task) {
  return timestampMs(task.schedule?.plannedEnd) || timestampMs(task.schedule?.plannedStart) + HOUR_MS;
}

function dependencyId(dependency) {
  return typeof dependency === "string" ? dependency : dependency?.dependsOnTaskId;
}

function fittedZoom(tasks) {
  if (!tasks.length) return "day";
  const start = Math.min(...tasks.map((task) => timestampMs(task.schedule.plannedStart)));
  const end = Math.max(...tasks.map(plannedEnd));
  const distinctDays = new Set(tasks.map((task) => dayKey(task.schedule.plannedStart))).size;
  if (distinctDays === 1 && end - start <= DAY_MS) return "hour";
  if (end - start <= DAY_MS * 21) return "day";
  return "phase";
}

function clampZoom(value) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function semanticZoom(value) {
  if (value < .68) return "hour";
  if (value < 1.48) return "day";
  return "phase";
}

function initialZoomPosition(projectId, tasks, storage = localStorage) {
  const storedValue = storage.getItem(`pixice.timelineZoomPosition.${projectId}`);
  const stored = Number(storedValue);
  if (storedValue !== null && Number.isFinite(stored)) return clampZoom(stored);
  const legacy = storage.getItem(`pixice.timelineZoom.${projectId}`);
  const scale = legacy && legacy !== "fit" ? legacy : fittedZoom(tasks);
  return ZOOM_POSITIONS[scale] ?? ZOOM_POSITIONS.day;
}

function phaseTitle(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const words = new Set(task.title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const word of words) if (word.length > 3 && !PHASE_STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const shared = [...counts.entries()].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 2).map(([word]) => word);
  if (shared.length) return `${shared.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ")} phase`;
  const keywords = tasks.map((task) => (task.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).find((word) => word.length > 3 && !PHASE_STOP_WORDS.has(word))).filter(Boolean);
  const distinct = [...new Set(keywords)];
  return distinct.length > 1 ? `${distinct[0][0].toUpperCase() + distinct[0].slice(1)} and ${distinct.at(-1)[0].toUpperCase() + distinct.at(-1).slice(1)}` : "Planned work phase";
}

function phaseSuggestions(tasks, phases) {
  const assigned = new Set(phases.flatMap((phase) => phase.taskIds ?? []));
  const candidates = tasks.filter((task) => task.schedule?.plannedStart && !assigned.has(task.id)).sort((left, right) => timestampMs(left.schedule.plannedStart) - timestampMs(right.schedule.plannedStart));
  const clusters = [];
  for (const task of candidates) {
    const start = timestampMs(task.schedule.plannedStart);
    const end = plannedEnd(task);
    const current = clusters.at(-1);
    const fitsCurrent = current && start - current.end <= DAY_MS * 2 && Math.max(current.end, end) - current.start <= DAY_MS * 14 && current.tasks.length < 12;
    if (fitsCurrent) {
      current.tasks.push(task);
      current.end = Math.max(current.end, end);
    } else clusters.push({ start, end, tasks: [task] });
  }
  return clusters.filter((cluster) => cluster.tasks.length > 1 && new Set(cluster.tasks.map((task) => dayKey(task.schedule.plannedStart))).size > 1).map((cluster) => ({
    id: `suggested:${cluster.tasks.map((task) => task.id).join(":")}`,
    title: phaseTitle(cluster.tasks),
    taskIds: cluster.tasks.map((task) => task.id),
    tasks: cluster.tasks,
    plannedStart: new Date(cluster.start).toISOString(),
    plannedEnd: new Date(cluster.end).toISOString(),
    completedCount: cluster.tasks.filter((task) => task.column === "done").length,
    suggested: true
  }));
}

function positionWithin(value, start, end) {
  return (timestampMs(value) - start.getTime()) / (end.getTime() - start.getTime());
}

function TimelineView({ projectId, tasks, phases = [], onOpenTask, onScheduleMove, onCreatePhase, storage = localStorage }) {
  const scheduled = tasks.filter((task) => task.schedule?.plannedStart).sort((left, right) => timestampMs(left.schedule.plannedStart) - timestampMs(right.schedule.plannedStart) || plannedEnd(left) - plannedEnd(right) || left.position - right.position);
  const [zoomPosition, setZoomPosition] = useState(() => initialZoomPosition(projectId, scheduled, storage));
  const [focusDay, setFocusDay] = useState(() => storage.getItem(`pixice.timelineFocusDay.${projectId}`));
  const [reviewing, setReviewing] = useState(null);
  const [phaseName, setPhaseName] = useState("");
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [transitionMeta, setTransitionMeta] = useState({ direction: 0, origin: "50% 45%" });
  const reducedMotion = useReducedMotion();
  const viewportRef = useRef(null);
  const pendingAnchorRef = useRef(null);
  const anchorTimerRef = useRef(null);
  useEffect(() => {
    setZoomPosition(initialZoomPosition(projectId, scheduled, storage));
    setFocusDay(storage.getItem(`pixice.timelineFocusDay.${projectId}`));
    setReviewing(null);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolvedZoom = semanticZoom(zoomPosition);
  const activeFocusDay = resolvedZoom === "hour" ? focusDay ?? dayKey(scheduled[0]?.schedule?.plannedStart ?? new Date()) : focusDay;
  const suggestions = useMemo(() => phaseSuggestions(scheduled, phases), [phases, scheduled]);
  const selectZoom = (next, day = null) => {
    const nextDay = next === "hour" ? day ?? dayKey(scheduled[0]?.schedule?.plannedStart ?? new Date()) : day;
    const nextPosition = ZOOM_POSITIONS[next] ?? ZOOM_POSITIONS.day;
    if (semanticZoom(nextPosition) !== resolvedZoom) setTransitionMeta({ direction: Math.sign(nextPosition - zoomPosition), origin: "50% 45%" });
    setZoomPosition(nextPosition);
    setFocusDay(nextDay);
    setReviewing(null);
    storage.setItem(`pixice.timelineZoomPosition.${projectId}`, String(nextPosition));
    storage.setItem(`pixice.timelineZoom.${projectId}`, next);
    if (nextDay) storage.setItem(`pixice.timelineFocusDay.${projectId}`, nextDay);
    else storage.removeItem(`pixice.timelineFocusDay.${projectId}`);
  };
  const openSuggestion = (suggestion) => {
    setReviewing(suggestion);
    setPhaseName(suggestion.title);
  };
  const confirmPhase = async (event) => {
    event.preventDefault();
    if (!reviewing || !phaseName.trim() || !onCreatePhase) return;
    setPhaseBusy(true);
    try {
      await onCreatePhase({ title: phaseName.trim(), taskIds: reviewing.taskIds });
      setReviewing(null);
    } finally {
      setPhaseBusy(false);
    }
  };

  let start;
  let end;
  let cells = [];
  let rows = [];
  let cellWidth = 54;
  if (resolvedZoom === "hour") {
    const focusStart = activeFocusDay ? dateFromDayKey(activeFocusDay) : null;
    const focusEnd = focusStart ? addDays(focusStart, 1) : null;
    const focused = focusStart ? scheduled.filter((task) => timestampMs(task.schedule.plannedStart) < focusEnd.getTime() && plannedEnd(task) > focusStart.getTime()) : scheduled;
    const visible = focused.length ? focused : scheduled;
    const visibleRanges = new Map(visible.map((task) => [task.id, {
      start: focusStart ? Math.max(timestampMs(task.schedule.plannedStart), focusStart.getTime()) : timestampMs(task.schedule.plannedStart),
      end: focusEnd ? Math.min(plannedEnd(task), focusEnd.getTime()) : plannedEnd(task)
    }]));
    const times = [...visibleRanges.values()].flatMap((range) => [range.start, range.end]);
    const earliest = times.length ? new Date(Math.min(...times)) : new Date();
    const latest = times.length ? new Date(Math.max(...times)) : addHours(earliest, 6);
    if (visible.length && (focusStart || visible.every((task) => sameDay(task.schedule.plannedStart, earliest)))) ({ start, end } = intradayBounds(times));
    else {
      start = addHours(floorHour(earliest), -1);
      end = addHours(ceilHour(latest), 1);
    }
    const hourCount = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / HOUR_MS));
    cells = Array.from({ length: hourCount }, (_, index) => addHours(start, index));
    rows = visible.map((task) => ({ id: task.id, task, start: visibleRanges.get(task.id).start, end: visibleRanges.get(task.id).end, title: task.title, meta: timeRange(task), detail: task.dependencies?.map((dependency) => tasks.find((candidate) => candidate.id === dependencyId(dependency))).find(Boolean)?.title ?? task.owner ?? KANBAN_COLUMNS.find((column) => column.id === task.column)?.label, progress: task.column === "done" ? 100 : task.column === "active" ? 56 : 0 }));
    cellWidth = 96 - zoomPosition / .68 * 28;
  } else {
    const times = scheduled.flatMap((task) => [timestampMs(task.schedule.plannedStart), plannedEnd(task)]);
    const earliest = times.length ? new Date(Math.min(...times)) : new Date();
    const latest = times.length ? new Date(Math.max(...times)) : addDays(earliest, 6);
    if (resolvedZoom === "day") {
      start = addDays(earliest, -1);
      end = addDays(latest, 2);
      const dayCount = Math.max(7, Math.ceil((dayStart(end).getTime() - dayStart(start).getTime()) / DAY_MS));
      cells = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
      end = addDays(start, dayCount);
      const groups = new Map();
      for (const task of scheduled) {
        let cursor = dayStart(task.schedule.plannedStart);
        const finalDay = dayStart(new Date(Math.max(timestampMs(task.schedule.plannedStart), plannedEnd(task) - 1)));
        while (cursor <= finalDay) {
          const key = dayKey(cursor);
          const group = groups.get(key) ?? { id: key, tasks: [], start: cursor.getTime(), end: addDays(cursor, 1).getTime() };
          group.tasks.push(task);
          groups.set(key, group);
          cursor = addDays(cursor, 1);
        }
      }
      rows = [...groups.values()].map((group) => ({ ...group, title: new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(group.start)), meta: `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"}`, detail: `${group.tasks.filter((task) => task.column === "done").length} complete`, progress: group.tasks.filter((task) => task.column === "done").length / group.tasks.length * 100, aggregate: true }));
      cellWidth = 66 - (zoomPosition - .68) / .8 * 28;
    } else {
      start = addWeeks(earliest, -1);
      end = addWeeks(latest, 2);
      const weekCount = Math.max(6, Math.ceil((end.getTime() - start.getTime()) / (DAY_MS * 7)));
      cells = Array.from({ length: weekCount }, (_, index) => addWeeks(start, index));
      end = addWeeks(start, weekCount);
      rows = [...phases.map((phase) => ({ ...phase, start: timestampMs(phase.plannedStart), end: timestampMs(phase.plannedEnd), meta: `${phase.taskIds.length} ${phase.taskIds.length === 1 ? "task" : "tasks"}`, detail: `${phase.completedCount ?? 0} complete`, progress: (phase.completedCount ?? 0) / Math.max(1, phase.taskIds.length) * 100, phase: true })), ...suggestions.map((suggestion) => ({ ...suggestion, start: timestampMs(suggestion.plannedStart), end: timestampMs(suggestion.plannedEnd), meta: `${suggestion.taskIds.length} tasks`, detail: "Suggested by Pixice", progress: suggestion.completedCount / suggestion.taskIds.length * 100, phase: true }))].filter((row) => row.start && row.end);
      cellWidth = 90 - (zoomPosition - 1.48) / .52 * 28;
    }
  }
  const trackWidth = Math.max(590 + (ZOOM_MAX - zoomPosition) * 160, cells.length * cellWidth);
  const total = end.getTime() - start.getTime();
  const nowPosition = positionWithin(new Date(), start, end) * 100;
  const scaleSummary = resolvedZoom === "hour" ? `${cells.length} hours` : resolvedZoom === "day" ? `${cells.length} days${suggestions.length ? ` · ${suggestions.length} phase suggested` : ""}` : `${cells.length} weeks · ${phases.length} confirmed · ${suggestions.length} suggested`;
  const scaleLabel = resolvedZoom === "hour" ? "Hour detail" : resolvedZoom === "day" ? "Daily plan" : "Phases";
  const zoomModifier = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`) ? "⌘" : "Ctrl";

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = pendingAnchorRef.current;
    if (!viewport || !anchor) return undefined;
    const placeAnchor = () => {
      const labelWidth = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--timeline-label-width")) || 210;
      const ratio = Math.max(0, Math.min(1, (anchor.timestamp - start.getTime()) / Math.max(1, total)));
      viewport.scrollLeft = Math.max(0, labelWidth + ratio * trackWidth - anchor.cursorX);
    };
    placeAnchor();
    clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = setTimeout(placeAnchor, 190);
    pendingAnchorRef.current = null;
    return () => clearTimeout(anchorTimerRef.current);
  }, [resolvedZoom, start, total, trackWidth]);

  const zoomAtPointer = (delta, cursorX, cursorY) => {
    const viewport = viewportRef.current;
    if (!viewport || !Number.isFinite(delta) || delta === 0) return;
    const labelWidth = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--timeline-label-width")) || 210;
    const trackX = Math.max(0, Math.min(trackWidth, viewport.scrollLeft + cursorX - labelWidth));
    const timestamp = start.getTime() + trackX / Math.max(1, trackWidth) * total;
    pendingAnchorRef.current = { timestamp, cursorX };
    setZoomPosition((current) => {
      const next = clampZoom(current + delta);
      const currentScale = semanticZoom(current);
      const nextScale = semanticZoom(next);
      if (nextScale !== currentScale) setTransitionMeta({
        direction: Math.sign(next - current),
        origin: `${viewport.scrollLeft + cursorX}px ${viewport.scrollTop + cursorY}px`
      });
      if (nextScale === "hour" && currentScale !== "hour") {
        const nextDay = dayKey(timestamp);
        setFocusDay(nextDay);
        storage.setItem(`pixice.timelineFocusDay.${projectId}`, nextDay);
      }
      if (nextScale !== currentScale) setReviewing(null);
      storage.setItem(`pixice.timelineZoomPosition.${projectId}`, String(next));
      storage.setItem(`pixice.timelineZoom.${projectId}`, nextScale);
      return next;
    });
  };

  const onWheel = (event) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(240, viewport.clientHeight) : 1;
    const delta = Math.max(-.24, Math.min(.24, event.deltaY * unit * .0022));
    const rect = viewport.getBoundingClientRect();
    zoomAtPointer(delta, Math.max(0, event.clientX - rect.left), Math.max(0, event.clientY - rect.top));
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  return (
    <div className={styles.timeline} aria-label="Scheduled work timeline" data-scale={resolvedZoom}>
      <div className={styles.timelineTools}><div className={styles.timelineScaleStatus} aria-live="polite"><AnimatePresence initial={false} mode="popLayout"><motion.span key={resolvedZoom} className={styles.timelineScaleCopy} initial={reducedMotion ? false : { opacity: 0, y: transitionMeta.direction > 0 ? -5 : 5, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: transitionMeta.direction > 0 ? 5 : -5, filter: "blur(2px)" }} transition={reducedMotion ? { duration: 0 } : { duration: .22, ease: TIMELINE_MORPH_EASE }}><b>{scaleLabel}</b><small>{scaleSummary}</small></motion.span></AnimatePresence></div><span className={styles.timelineZoomHint}><b>{zoomModifier}-scroll to zoom</b><small>Scroll rows · Shift-scroll sideways</small></span></div>
      {reviewing && <form className={styles.phaseReview} onSubmit={confirmPhase}><span><b>Confirm suggested phase</b><small>{reviewing.taskIds.length} tasks · {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(reviewing.plannedStart))} to {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(reviewing.plannedEnd))}</small></span><label>Phase name<input autoFocus value={phaseName} maxLength={240} onChange={(event) => setPhaseName(event.target.value)} /></label><button type="button" onClick={() => setReviewing(null)}>Cancel</button><button type="submit" className={styles.phaseConfirm} disabled={phaseBusy || !phaseName.trim()}>{phaseBusy ? "Creating…" : "Confirm phase"}</button></form>}
      <div ref={viewportRef} className={styles.timelineViewport} tabIndex={0} aria-label="Zoomable timeline canvas" onKeyDown={(event) => {
        if (!["+", "=", "-", "_"].includes(event.key)) return;
        event.preventDefault();
        zoomAtPointer(event.key === "+" || event.key === "=" ? -.2 : .2, event.currentTarget.clientWidth / 2, event.currentTarget.clientHeight / 2);
      }}>
        <AnimatePresence initial={false} mode="popLayout" custom={{ ...transitionMeta, reducedMotion }}>
        <motion.div key={resolvedZoom} className={styles.timelineCanvas} data-scale={resolvedZoom} style={{ "--timeline-columns": cells.length, "--timeline-track-width": `${trackWidth}px` }} custom={{ ...transitionMeta, reducedMotion }} variants={TIMELINE_MORPH_VARIANTS} initial="initial" animate="animate" exit="exit" transition={reducedMotion ? { duration: 0 } : { duration: .28, ease: TIMELINE_MORPH_EASE, opacity: { duration: .2, ease: "easeOut" } }}>
          <div className={styles.timelineHeader}><span><b>{resolvedZoom === "phase" ? "Phase" : resolvedZoom === "day" ? "Day" : "Work item"}</b><small>{scaleSummary}</small></span><div>{cells.map((cell, index) => <time key={`${resolvedZoom}:${cell.toISOString()}`} dateTime={cell.toISOString()} data-week={resolvedZoom !== "hour" && (index === 0 || cell.getDay() === 1)}>{resolvedZoom === "hour" ? (cell.getHours() + 11) % 12 + 1 : cell.getDate()}<small>{resolvedZoom === "hour" ? (cell.getHours() === 0 ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(cell) : cell.getHours() < 12 ? "AM" : "PM") : index === 0 || cell.getDate() === 1 ? new Intl.DateTimeFormat(undefined, { month: "short" }).format(cell) : ""}</small></time>)}</div></div>
          <div className={styles.timelineBody}>
            {rows.length === 0 && <div className={styles.timelineEmpty}>{resolvedZoom === "phase" ? "No confirmed or suggested phases yet." : "Add dates to a task and it will appear here."}</div>}
            {rows.map((row) => {
              const from = Math.max(0, (row.start - start.getTime()) / total);
              const to = Math.min(1, Math.max(from + .008, (row.end - start.getTime()) / total));
              const suggested = Boolean(row.suggested);
              const click = () => suggested ? openSuggestion(row) : row.aggregate ? selectZoom("hour", row.id) : row.task ? onOpenTask(row.task) : row.phase ? selectZoom("day") : undefined;
              return <div className={styles.timelineRow} key={row.id} data-suggested={suggested}><button className={styles.timelineLabel} onClick={click}><strong>{suggested ? "Suggested phase" : row.title}</strong><span><time>{row.meta}</time><b>{row.task?.dependencies?.length ? `after ${row.detail}` : row.detail}</b></span></button><div className={styles.timelineTrack}>{cells.map((cell, index) => <span key={cell.toISOString()} data-week={resolvedZoom !== "hour" && (index === 0 || cell.getDay() === 1)} onDragOver={row.task ? (event) => event.preventDefault() : undefined} onDrop={row.task ? (event) => {
                event.preventDefault();
                const dragged = tasks.find((candidate) => candidate.id === event.dataTransfer.getData(TASK_MIME));
                if (dragged) onScheduleMove(dragged, rescheduled(dragged, cell, resolvedZoom !== "hour"));
              } : undefined} />)}{nowPosition >= 0 && nowPosition <= 100 && <i className={styles.timelineToday} style={{ left: `${nowPosition}%` }} />}{row.start < end.getTime() && row.end > start.getTime() && <button draggable={Boolean(row.task)} onDragStart={row.task ? (event) => event.dataTransfer.setData(TASK_MIME, row.task.id) : undefined} className={`${styles.timelineBar} ${row.aggregate || row.phase ? styles.timelineAggregateBar : ""}`} data-column={row.task?.column} data-kind={row.task?.kind} data-suggested={suggested} style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }} onClick={click} aria-label={suggested ? `Review suggested phase, ${row.title}` : row.aggregate ? `Open ${row.title} in Hour view` : row.phase ? `${row.title}, confirmed phase` : `${row.title}, ${row.meta}`}><span>{suggested ? row.title : row.aggregate ? `${row.tasks.length} planned ${row.tasks.length === 1 ? "task" : "tasks"}` : row.title}</span><i style={{ width: `${row.progress}%` }} /></button>}</div></div>;
            })}
          </div>
        </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function KanbanBoard({ project, tasks = [], phases = [], threads = [], attention = [], loading = false, onCreate, onCreatePhase, onMove, onOpenThread, onOpenTask, onScheduleMove, onStartTask, storage = localStorage }) {
  const [query, setQuery] = useState(() => storage.getItem(`pixice.boardFilter.${project?.id}`) ?? "");
  const [view, setView] = useState("board");
  const [selectedTaskId, setSelectedTaskId] = useState(() => storage.getItem(`pixice.boardSelection.${project?.id}`));
  const [draggingId, setDraggingId] = useState(null);
  const [addingColumn, setAddingColumn] = useState(null);
  const [creating, setCreating] = useState(false);
  const [startingId, setStartingId] = useState(null);
  const waitingThreadIds = useMemo(() => new Set(attention.map((request) => request?.params?.threadId ?? request?.threadId).filter(Boolean)), [attention]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const phasesByTaskId = useMemo(() => new Map(phases.flatMap((phase) => (phase.taskIds ?? []).map((taskId) => [taskId, phase]))), [phases]);
  useEffect(() => {
    setView("board");
    if (project?.id) storage.setItem(`pixice.boardView.${project.id}`, "board");
  }, [project?.id, storage]);
  const columns = useMemo(() => {
    const result = new Map(KANBAN_COLUMNS.map((column) => [column.id, []]));
    const normalizedQuery = query.trim().toLowerCase();
    tasks.filter((task) => !normalizedQuery || `${task.title} ${task.description ?? ""}`.toLowerCase().includes(normalizedQuery)).sort((left, right) => left.position - right.position).forEach((task) => result.get(task.column)?.push(task));
    return result;
  }, [query, tasks]);
  const create = async (input) => {
    setCreating(true);
    try { await onCreate(input); setAddingColumn(null); } finally { setCreating(false); }
  };
  const start = async (task) => {
    setStartingId(task.id);
    try { await onStartTask(task); } finally { setStartingId(null); }
  };
  if (!project) return <div className={styles.noProject}><Circle size={28} /><h1>Open a project to use the board</h1><p>Each project keeps its own tasks.</p></div>;
  const changeView = (next) => setView(next);
  const openTask = (task) => { setSelectedTaskId(task.id); storage.setItem(`pixice.boardSelection.${project.id}`, task.id); onOpenTask(task); };
  const visibleTasks = tasks.filter((task) => !query.trim() || `${task.title} ${task.description ?? ""} ${task.owner ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={styles.boardWorkspace}>
      <div className={styles.boardHeader}><div><span>Scheduled work</span><h1>{view === "board" ? "Plan work before it runs" : "Delivery timeline"}</h1><p>Board status, dates, dependencies, agents, and Workflows all stay attached to the same work item.</p></div><div className={styles.boardActions}><label className={styles.search}><MagnifyingGlass size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); storage.setItem(`pixice.boardFilter.${project.id}`, event.target.value); }} placeholder="Filter work" aria-label="Filter work items" /></label><button className={styles.newTask} aria-label="Add task" onClick={() => setAddingColumn("backlog")}><Plus size={15} />Add work</button></div></div>
      <div className={styles.viewToolbar}><div className={styles.viewSwitch} role="tablist" aria-label="Board view"><button role="tab" aria-selected={view === "board"} onClick={() => changeView("board")}><List size={14} />Board</button><button role="tab" aria-selected={view === "timeline"} onClick={() => changeView("timeline")}><ChartLineUp size={14} />Timeline</button></div><span className={styles.viewSummary}>{visibleTasks.filter((task) => task.schedule).length} scheduled · {visibleTasks.length} total</span></div>
      {addingColumn && view !== "board" && <div className={styles.floatingQuickAdd}><QuickAdd column={addingColumn} busy={creating} onCreate={create} onCancel={() => setAddingColumn(null)} /></div>}
      {loading ? <div className={styles.loading}><SpinnerGap size={22} className="spin-icon" />Loading work</div> : view === "board" ? <div className={styles.columns} role="region" aria-label={`${project.displayName} task board`}>{KANBAN_COLUMNS.map((column) => <BoardColumn key={column.id} column={column} tasks={columns.get(column.id) ?? []} phasesByTaskId={phasesByTaskId} threadsById={threadsById} draggingId={draggingId} waitingThreadIds={waitingThreadIds} adding={addingColumn === column.id} creating={creating} startingId={startingId} selectedTaskId={selectedTaskId} onBeginAdd={setAddingColumn} onCancelAdd={() => setAddingColumn(null)} onCreate={create} onOpen={onOpenThread} onEdit={openTask} onStart={start} onMove={onMove} onDragStart={setDraggingId} onDragEnd={() => setDraggingId(null)} />)}</div> : <TimelineView projectId={project.id} tasks={visibleTasks} phases={phases} onOpenTask={openTask} onScheduleMove={onScheduleMove} onCreatePhase={onCreatePhase} storage={storage} />}
    </div>
  );
}
