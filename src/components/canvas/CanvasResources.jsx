import { useCallback, useEffect, useRef, useState } from "react";
import { InstrumentHost } from "../instruments/InstrumentHost.jsx";
import { ArrowClockwise, Plus, SpinnerGap } from "../icons/index.jsx";
import styles from "./Canvas.module.css";

export function CanvasResourcePicker({ kind: initialKind, api, projects, initialProjectId, onChoose, onCancel }) {
  const [kind, setKind] = useState(initialKind);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const namespace = kind === "task" ? "board" : kind === "tool" ? "instruments" : kind === "agent" ? "threads" : "workflows";
  useEffect(() => {
    let active = true;
    setItems([]); setError(null);
    if (!projectId) return;
    const operation = kind === "tool" ? api?.instruments?.tools : api?.[namespace]?.list;
    if (!operation) { setError("Connect a Pixice environment to use project resources. Notes, images, and workflow drafts work independently."); return; }
    setBusy(true);
    operation({ projectId }).then(result => { if (active) setItems(result.data ?? []); }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, kind, namespace, projectId, revision]);
  const create = async event => {
    event.preventDefault();
    if (!projectId || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const result = kind === "task" ? await api.board.create({ projectId, title: name.trim(), column: "backlog" }) : await api.workflows.create({ projectId, name: name.trim(), enabled: false });
      await onChoose({ kind, projectId, entity: result.task ?? result });
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <div className={styles.resourcePicker} role="dialog" aria-label={`Add ${kind}`}>
    <header><strong>{({ task: "Board task", workflow: "Project workflow", tool: "Project tool", agent: "Existing agent" })[kind]}</strong><button onClick={onCancel}>Cancel</button></header>
    <nav className={styles.resourceTypes} aria-label="Project item type">{["workflow", "task", "agent", "tool"].map(type => <button key={type} aria-pressed={kind === type} onClick={() => setKind(type)}>{({ workflow: "Workflows", task: "Board", agent: "Agents", tool: "Tools" })[type]}</button>)}</nav>
    <label>From project<select aria-label="Resource project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{projects.map(project => <option value={project.id} key={project.id}>{project.displayName ?? project.name}</option>)}</select></label>
    {busy && <p><SpinnerGap className={styles.spin} size={14} />Loading…</p>}
    {error && <div role="alert" className={styles.inlineError}>{error}<button onClick={() => setRevision(value => value + 1)}><ArrowClockwise size={13} />Retry</button></div>}
    <div className={styles.resourceList}>{items.map(item => <button key={item.id} onClick={() => onChoose({ kind, projectId, entity: item })}><span>{item.title ?? item.name ?? item.preview ?? "Untitled"}</span><small>{item.column ?? item.status?.type ?? ""}</small></button>)}{projectId && !busy && !items.length && !error && <p>No {kind === "agent" ? "conversations" : `${kind}s`} yet.</p>}</div>
    {["task", "workflow"].includes(kind) && api?.[namespace]?.create && <form onSubmit={create}><input aria-label={`New ${kind} name`} placeholder={`Name a new ${kind}…`} value={name} onChange={event => setName(event.target.value)} /><button disabled={busy || !projectId || !name.trim()}><Plus size={14} />Create</button></form>}
  </div>;
}

export function CanvasTool({ data, api, onChange }) {
  const [instrument, setInstrument] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!api?.instruments?.read) { setError("Connect the tool’s Pixice environment to open it."); return; }
    api.instruments.read({ projectId: data.projectId, instrumentId: data.instrumentId }).then(result => { if (active) { setInstrument(result); setError(null); } }).catch(cause => { if (active) setError(cause.message); });
    const unsubscribe = api.events?.subscribe(event => { if (event.payload?.instrument?.id === data.instrumentId || event.payload?.instrumentId === data.instrumentId) setRevision(value => value + 1); });
    return () => { active = false; unsubscribe?.(); };
  }, [api, data.projectId, data.instrumentId, revision]);
  if (error) return <div className={styles.inlineError} role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>Retry</button></div>;
  if (!instrument) return <div className={styles.resourceLoading}>Loading tool…</div>;
  const scope = { projectId: data.projectId, threadId: data.threadId ?? instrument.threadId, instrumentId: data.instrumentId };
  return <InstrumentHost instrument={instrument} onOpenResource={resource => { if (/^https?:\/\//i.test(resource)) window.open(resource, "_blank", "noopener,noreferrer"); }} onRefreshData={async source => { const next = await api.instruments.refresh({ ...scope, source }); setInstrument(next); }} onAgentEvent={(actionId, payload) => api.instruments.event({ ...scope, actionId, payload })} onInvokeCapability={(actionId, argumentsValue) => api.instruments.invoke({ ...scope, actionId, arguments: argumentsValue, requestId: crypto.randomUUID() })} onSetPinned={async pinned => { const next = await api.instruments.pin({ ...scope, pinned }); setInstrument(next); onChange({ pinned }); }} />;
}

export function CanvasBoardTask({ data, api, onChange }) {
  const [task, setTask] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const latest = useRef(data); latest.current = data;
  const saving = useRef(false);
  const change = useRef(onChange); change.current = onChange;
  const load = useCallback(async () => {
    if (!api?.board?.read) throw new Error("Connect this task’s Pixice environment to edit it.");
    const result = await api.board.read({ projectId: data.projectId, taskId: data.taskId });
    setTask(result.task);
    if (!latest.current.taskDirty) change.current({ title: result.task.title, taskDescription: result.task.description ?? "", taskColumn: result.task.column });
  }, [api, data.projectId, data.taskId]);
  useEffect(() => {
    let active = true;
    void load().catch(cause => { if (active) setError(cause.message); });
    const unsubscribe = api?.events?.subscribe(event => {
      if (saving.current) return;
      if (event.type !== "BoardUpdated" || event.payload?.projectId && event.payload.projectId !== data.projectId || event.payload?.task?.id && event.payload.task.id !== data.taskId) return;
      if (latest.current.taskDirty) setError("This task changed elsewhere. Your draft is preserved. Reload its latest version before saving.");
      else void load().catch(cause => { if (active) setError(cause.message); });
    });
    return () => { active = false; unsubscribe?.(); };
  }, [api, load, data.projectId, data.taskId]);
  const save = async () => {
    saving.current = true; setBusy(true); setError(null);
    try {
      const next = await api.board.update({ projectId: data.projectId, taskId: data.taskId, title: data.title, description: data.taskDescription ?? "", expectedRevision: task.revision });
      setTask(next);
      if (data.taskColumn !== next.column) await api.board.move({ projectId: data.projectId, taskId: data.taskId, column: data.taskColumn });
      onChange({ taskDirty: latest.current.title !== data.title || latest.current.taskDescription !== data.taskDescription || latest.current.taskColumn !== data.taskColumn });
      setError(null);
    } catch (cause) { setError(cause.message); } finally { saving.current = false; setBusy(false); }
  };
  return <div className={styles.compactTask}>
    {task && <><select aria-label="Board task status" value={data.taskColumn ?? task.column} disabled={busy} onChange={event => onChange({ taskColumn: event.target.value, taskDirty: true })}>{["backlog", "ready", "active", "done"].map(column => <option key={column} value={column}>{column.charAt(0).toUpperCase() + column.slice(1)}</option>)}</select><textarea aria-label="Board task description" placeholder="What needs to happen?" value={data.taskDescription ?? ""} onChange={event => onChange({ taskDescription: event.target.value, taskDirty: true })} /><footer><small>Linked to the project Board</small><button disabled={busy || !data.title?.trim()} onClick={save}>{busy ? "Saving…" : "Save task"}</button></footer></>}
    {!task && !error && <div className={styles.resourceLoading}>Loading task…</div>}
    {error && <div className={styles.inlineError} role="alert">{error}<button onClick={async () => { try { await load(); setError(null); } catch (cause) { setError(cause.message); } }}>Reload</button></div>}
  </div>;
}
