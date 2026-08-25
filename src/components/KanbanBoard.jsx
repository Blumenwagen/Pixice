import { useEffect, useMemo, useState } from "react";
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

function TaskCard({ task, thread, columnId, waitingForInput, draggingId, starting, selected, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
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
      {task.schedule?.plannedStart && <div className={styles.scheduleChip}><Gauge size={11} /><span>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.schedule.plannedStart))}{task.schedule.plannedEnd ? ` – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.schedule.plannedEnd))}` : ""}</span>{task.schedule.hardDeadline && <b>Deadline</b>}</div>}
      {task.latestActivity && <p className={styles.cardActivity}><strong>Pixice</strong><span>{task.latestActivity.summary}</span></p>}
      <div className={styles.cardMeta}><span>{thread ? "Linked thread" : "No thread yet"}</span><span className={styles.cardActions}>{thread && <button onClick={() => onOpen(thread.id)} aria-label={`Open thread for ${task.title}`} title="Open linked thread"><Eye size={13} /></button>}{!thread && <button onClick={() => onStart(task)} disabled={starting} aria-label={`Start ${task.title}`} title="Start task"><StartTaskIcon size={13} />{starting ? "Starting" : "Start"}</button>}<button onClick={() => onEdit(task)} aria-label={`Edit ${task.title}`} title="Edit task"><PencilSimple size={13} /></button></span></div>
    </article>
  );
}

function BoardColumn({ column, tasks, threadsById, draggingId, waitingThreadIds, adding, creating, startingId, selectedTaskId, onBeginAdd, onCancelAdd, onCreate, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
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
        {tasks.map((task) => <TaskCard key={task.id} task={task} thread={task.threadId ? threadsById.get(task.threadId) : null} columnId={column.id} waitingForInput={task.threadId ? waitingThreadIds.has(task.threadId) : false} draggingId={draggingId} starting={startingId === task.id} selected={selectedTaskId === task.id} onOpen={onOpen} onEdit={onEdit} onStart={onStart} onMove={onMove} onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
      </div>
    </section>
  );
}

const DAY_MS = 86_400_000;

function dayStart(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayKey(value) {
  const date = dayStart(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(value, count) {
  const date = dayStart(value);
  date.setDate(date.getDate() + count);
  return date;
}

function rescheduled(task, targetDate) {
  const currentStart = task.schedule?.plannedStart ? new Date(task.schedule.plannedStart) : dayStart(targetDate);
  const currentEnd = task.schedule?.plannedEnd ? new Date(task.schedule.plannedEnd) : currentStart;
  const duration = Math.max(0, currentEnd.getTime() - currentStart.getTime());
  const target = dayStart(targetDate);
  target.setHours(currentStart.getHours(), currentStart.getMinutes(), 0, 0);
  return { ...task.schedule, plannedStart: target.toISOString(), plannedEnd: new Date(target.getTime() + duration).toISOString() };
}

function TimelineView({ tasks, onOpenTask, onScheduleMove }) {
  const scheduled = tasks.filter((task) => task.schedule?.plannedStart);
  const scheduledTimes = scheduled.flatMap((task) => [task.schedule.plannedStart, task.schedule.plannedEnd, task.schedule.hardDeadline].map(timestampMs).filter(Boolean));
  const earliest = scheduledTimes.length > 0 ? new Date(Math.min(...scheduledTimes)) : new Date();
  const latest = scheduledTimes.length > 0 ? new Date(Math.max(...scheduledTimes)) : addDays(earliest, 34);
  const start = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const dayCount = Math.max(35, Math.ceil((dayStart(latest).getTime() - start.getTime()) / DAY_MS) + 1);
  const days = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
  const todayIndex = Math.round((dayStart(new Date()).getTime() - start.getTime()) / DAY_MS);
  return (
    <div className={styles.timeline} aria-label="Scheduled work timeline" style={{ "--timeline-days": days.length }}>
      <div className={styles.timelineHeader}><span>Work item</span><div>{days.map((day, index) => <time key={dayKey(day)} data-week={index % 7 === 0}>{day.getDate()}<small>{index % 7 === 0 ? new Intl.DateTimeFormat(undefined, { month: "short" }).format(day) : ""}</small></time>)}</div></div>
      <div className={styles.timelineBody}>
        {scheduled.length === 0 && <div className={styles.timelineEmpty}>Add dates to a task and it will appear here.</div>}
        {scheduled.map((task) => {
          const rawFrom = Math.round((dayStart(task.schedule.plannedStart).getTime() - start.getTime()) / DAY_MS);
          const rawTo = task.schedule.plannedEnd ? Math.round((dayStart(task.schedule.plannedEnd).getTime() - start.getTime()) / DAY_MS) + 1 : rawFrom + 1;
          const from = Math.max(0, rawFrom);
          const to = Math.min(days.length, Math.max(from + 1, rawTo));
          return <div className={styles.timelineRow} key={task.id}><button className={styles.timelineLabel} onClick={() => onOpenTask(task)}><strong>{task.title}</strong><span>{task.owner || KANBAN_COLUMNS.find((column) => column.id === task.column)?.label}</span></button><div className={styles.timelineTrack}>{days.map((day, index) => <span key={dayKey(day)} data-week={index % 7 === 0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
            event.preventDefault();
            const dragged = tasks.find((candidate) => candidate.id === event.dataTransfer.getData(TASK_MIME));
            if (dragged) onScheduleMove(dragged, rescheduled(dragged, day));
          }} />)}{todayIndex >= 0 && todayIndex < days.length && <i className={styles.timelineToday} style={{ left: `${todayIndex / days.length * 100}%` }} />}{rawFrom < days.length && rawTo > 0 && <button draggable onDragStart={(event) => event.dataTransfer.setData(TASK_MIME, task.id)} className={styles.timelineBar} data-column={task.column} data-kind={task.kind} style={{ left: `${from / days.length * 100}%`, width: `${(to - from) / days.length * 100}%` }} onClick={() => onOpenTask(task)}><span>{task.title}</span>{task.kind !== "milestone" && <i style={{ width: `${task.column === "done" ? 100 : task.column === "active" ? 56 : 0}%` }} />}</button>}</div></div>;
        })}
      </div>
    </div>
  );
}

export function KanbanBoard({ project, tasks = [], threads = [], attention = [], loading = false, onCreate, onMove, onOpenThread, onOpenTask, onScheduleMove, onStartTask }) {
  const [query, setQuery] = useState(() => localStorage.getItem(`pixice.boardFilter.${project?.id}`) ?? "");
  const [view, setView] = useState("board");
  const [selectedTaskId, setSelectedTaskId] = useState(() => localStorage.getItem(`pixice.boardSelection.${project?.id}`));
  const [draggingId, setDraggingId] = useState(null);
  const [addingColumn, setAddingColumn] = useState(null);
  const [creating, setCreating] = useState(false);
  const [startingId, setStartingId] = useState(null);
  const waitingThreadIds = useMemo(() => new Set(attention.map((request) => request?.params?.threadId ?? request?.threadId).filter(Boolean)), [attention]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  useEffect(() => {
    setView("board");
    if (project?.id) localStorage.setItem(`pixice.boardView.${project.id}`, "board");
  }, [project?.id]);
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
  const openTask = (task) => { setSelectedTaskId(task.id); localStorage.setItem(`pixice.boardSelection.${project.id}`, task.id); onOpenTask(task); };
  const visibleTasks = tasks.filter((task) => !query.trim() || `${task.title} ${task.description ?? ""} ${task.owner ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={styles.boardWorkspace}>
      <div className={styles.boardHeader}><div><span>Scheduled work</span><h1>{view === "board" ? "Plan work before it runs" : "Delivery timeline"}</h1><p>Board status, dates, dependencies, agents, and Workflows all stay attached to the same work item.</p></div><div className={styles.boardActions}><label className={styles.search}><MagnifyingGlass size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); localStorage.setItem(`pixice.boardFilter.${project.id}`, event.target.value); }} placeholder="Filter work" aria-label="Filter work items" /></label><button className={styles.newTask} aria-label="Add task" onClick={() => setAddingColumn("backlog")}><Plus size={15} />Add work</button></div></div>
      <div className={styles.viewToolbar}><div className={styles.viewSwitch} role="tablist" aria-label="Board view"><button role="tab" aria-selected={view === "board"} onClick={() => changeView("board")}><List size={14} />Board</button><button role="tab" aria-selected={view === "timeline"} onClick={() => changeView("timeline")}><ChartLineUp size={14} />Timeline</button></div><span className={styles.viewSummary}>{visibleTasks.filter((task) => task.schedule).length} scheduled · {visibleTasks.length} total</span></div>
      {addingColumn && view !== "board" && <div className={styles.floatingQuickAdd}><QuickAdd column={addingColumn} busy={creating} onCreate={create} onCancel={() => setAddingColumn(null)} /></div>}
      {loading ? <div className={styles.loading}><SpinnerGap size={22} className="spin-icon" />Loading work</div> : view === "board" ? <div className={styles.columns} role="region" aria-label={`${project.displayName} task board`}>{KANBAN_COLUMNS.map((column) => <BoardColumn key={column.id} column={column} tasks={columns.get(column.id) ?? []} threadsById={threadsById} draggingId={draggingId} waitingThreadIds={waitingThreadIds} adding={addingColumn === column.id} creating={creating} startingId={startingId} selectedTaskId={selectedTaskId} onBeginAdd={setAddingColumn} onCancelAdd={() => setAddingColumn(null)} onCreate={create} onOpen={onOpenThread} onEdit={openTask} onStart={start} onMove={onMove} onDragStart={setDraggingId} onDragEnd={() => setDraggingId(null)} />)}</div> : <TimelineView tasks={visibleTasks} onOpenTask={openTask} onScheduleMove={onScheduleMove} />}
    </div>
  );
}
