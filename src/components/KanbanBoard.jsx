import { useMemo, useState } from "react";
import { Check, CheckCircle, Circle, MagnifyingGlass, PencilSimple, Plus, SpinnerGap, Trash, X } from "./icons/index.jsx";
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

const TASK_MIME = "text/x-loom-board-task";
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

function TaskEditor({ task, busy, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [column, setColumn] = useState(task.column);
  const submit = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onSave(task.id, { title: title.trim(), description: description.trim(), column });
  };
  const remove = async () => {
    if (!window.confirm(`Delete “${task.title}”?\n\nIts linked thread will stay in Pixice.`)) return;
    await onDelete(task.id);
  };
  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className={styles.taskDialog} role="dialog" aria-modal="true" aria-labelledby="board-task-editor-title" onSubmit={submit}>
        <header><div><span>Board task</span><h2 id="board-task-editor-title">Edit task</h2></div><button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close task editor"><X size={16} /></button></header>
        <label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /></label>
        <label>Notes<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={10000} /></label>
        <label>Status<select value={column} onChange={(event) => setColumn(event.target.value)}>{KANBAN_COLUMNS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
        <footer><button type="button" className={styles.deleteButton} onClick={remove} disabled={busy}><Trash size={14} />Delete</button><span /><button type="button" className={styles.quietButton} onClick={onClose}>Cancel</button><button type="submit" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save changes"}</button></footer>
      </form>
    </div>
  );
}

function TaskCard({ task, thread, columnId, waitingForInput, draggingId, starting, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
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
    <article className={`${styles.card} ${dragTarget ? styles.cardDropTarget : ""}`} draggable onDragStart={(event) => {
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
      <button className={styles.cardTitle} onClick={() => thread ? onOpen(thread.id) : onEdit(task)} onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          moveFromKeyboard(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}><strong>{task.title}</strong>{task.description && <span>{task.description}</span>}</button>
      <div className={styles.cardMeta}><span>{thread ? "Linked thread" : "No thread yet"}</span><span className={styles.cardActions}>{!thread && <button onClick={() => onStart(task)} disabled={starting} aria-label={`Start ${task.title}`} title="Start task"><StartTaskIcon size={13} />{starting ? "Starting" : "Start"}</button>}<button onClick={() => onEdit(task)} aria-label={`Edit ${task.title}`} title="Edit task"><PencilSimple size={13} /></button></span></div>
    </article>
  );
}

function BoardColumn({ column, tasks, threadsById, draggingId, waitingThreadIds, adding, creating, startingId, onBeginAdd, onCancelAdd, onCreate, onOpen, onEdit, onStart, onMove, onDragStart, onDragEnd }) {
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
        {tasks.map((task) => <TaskCard key={task.id} task={task} thread={task.threadId ? threadsById.get(task.threadId) : null} columnId={column.id} waitingForInput={task.threadId ? waitingThreadIds.has(task.threadId) : false} draggingId={draggingId} starting={startingId === task.id} onOpen={onOpen} onEdit={onEdit} onStart={onStart} onMove={onMove} onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
      </div>
    </section>
  );
}

export function KanbanBoard({ project, tasks = [], threads = [], attention = [], loading = false, onCreate, onUpdate, onMove, onDelete, onOpenThread, onStartTask }) {
  const [query, setQuery] = useState("");
  const [draggingId, setDraggingId] = useState(null);
  const [addingColumn, setAddingColumn] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startingId, setStartingId] = useState(null);
  const waitingThreadIds = useMemo(() => new Set(attention.map((request) => request?.params?.threadId ?? request?.threadId).filter(Boolean)), [attention]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
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
  const save = async (taskId, patch) => {
    setSaving(true);
    try { await onUpdate(taskId, patch); setEditingTask(null); } finally { setSaving(false); }
  };
  const remove = async (taskId) => {
    setSaving(true);
    try { await onDelete(taskId); setEditingTask(null); } finally { setSaving(false); }
  };
  const start = async (task) => {
    setStartingId(task.id);
    try { await onStartTask(task); } finally { setStartingId(null); }
  };
  if (!project) return <div className={styles.noProject}><Circle size={28} /><h1>Open a project to use the board</h1><p>Each project keeps its own tasks.</p></div>;
  return (
    <div className={styles.boardWorkspace}>
      <div className={styles.boardHeader}><div><span>Project board</span><h1>Plan work before it runs</h1><p>Add and order tasks here. Start one when it is ready, or let an active Pixice agent manage the same board.</p></div><div className={styles.boardActions}><label className={styles.search}><MagnifyingGlass size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tasks" aria-label="Filter board tasks" /></label><button className={styles.newTask} onClick={() => setAddingColumn("backlog")}><Plus size={15} />Add task</button></div></div>
      {loading ? <div className={styles.loading}><SpinnerGap size={22} className="spin-icon" />Loading board</div> : <div className={styles.columns} role="region" aria-label={`${project.displayName} task board`}>{KANBAN_COLUMNS.map((column) => <BoardColumn key={column.id} column={column} tasks={columns.get(column.id) ?? []} threadsById={threadsById} draggingId={draggingId} waitingThreadIds={waitingThreadIds} adding={addingColumn === column.id} creating={creating} startingId={startingId} onBeginAdd={setAddingColumn} onCancelAdd={() => setAddingColumn(null)} onCreate={create} onOpen={onOpenThread} onEdit={setEditingTask} onStart={start} onMove={onMove} onDragStart={setDraggingId} onDragEnd={() => setDraggingId(null)} />)}</div>}
      {editingTask && <TaskEditor task={editingTask} busy={saving} onSave={save} onDelete={remove} onClose={() => setEditingTask(null)} />}
    </div>
  );
}
