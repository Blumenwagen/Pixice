import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Background, BackgroundVariant, Handle, NodeResizer, Position, ReactFlow, ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges, useReactFlow } from "@xyflow/react";
import { ArrowClockwise, CaretLeft, Check, File, Folder, Globe, MagnifyingGlass, PaperPlaneTilt, Plus, Stack, Trash, TreeStructure, X } from "../icons/index.jsx";
import { createWorkflowEdge, createWorkflowNode, WORKFLOW_NODE_META, WORKFLOW_NODE_CATEGORIES, workflowCanConnect, workflowNodeHeight, WORKFLOW_NODE_WIDTH } from "../workflows/workflow-utils.js";
import { CanvasAvatar, CanvasCompanionMenu } from "./CanvasAvatar.jsx";
import { CanvasAgent } from "./CanvasAgent.jsx";
import { CanvasBoardTask, CanvasResourcePicker, CanvasTool } from "./CanvasResources.jsx";
import { CanvasContext } from "./canvas-context.js";
import { CanvasWorkflowLabel, CanvasWorkflowNode } from "./CanvasWorkflowGraph.jsx";
import { canvasWorkflowGraph, flattenCanvasWorkflows, placeCanvasWorkflow } from "./canvas-workflows.js";
import { createCanvas, createCanvasItem } from "./canvas-store.js";
import styles from "./Canvas.module.css";

const OPTIONS = [
  { kind: "agent", label: "Ask an agent", icon: PaperPlaneTilt },
  { kind: "text", label: "Write a note", icon: File },
  { kind: "image", label: "Add an image", icon: Stack },
  { kind: "workflow", label: "Build a workflow", icon: TreeStructure },
  { kind: "task", label: "Board task", icon: Check },
  { kind: "tool", label: "Add a tool", icon: Plus }
];
const TITLES = { text: "Note", workflow: "Workflow", image: "Image", task: "Board task", tool: "Tool", agent: "Agent", file: "File", link: "Link" };
const TYPE_ICONS = { text: File, workflow: TreeStructure, image: Stack, task: Check, tool: Plus, agent: PaperPlaneTilt, file: File, link: Globe };

export function createCanvasWorkflow(name = "Untitled workflow", example = false) {
  const nodes = example ? [createWorkflowNode("manualTrigger", { x: 30, y: 85 }), createWorkflowNode("pixiceAgent", { x: 340, y: 85 })] : [];
  return { id: crypto.randomUUID(), name, description: "", enabled: false, graph: { nodes, edges: example ? [createWorkflowEdge(nodes[0].id, nodes[1].id)] : [], viewport: { x: 25, y: 50, zoom: .9 } } };
}

function CanvasItem({ id, data, selected }) {
  const context = useContext(CanvasContext);
  const Icon = TYPE_ICONS[data.kind] ?? File;
  const change = patch => context.updateNode(id, patch);
  const remove = () => context.removeNode(id);
  if (data.kind === "workflow") return <CanvasWorkflowLabel id={id} data={data} />;
  if (data.kind === "agent") return <div className={styles.agentOnCanvas} data-selected={selected}>
    <Handle type="target" position={Position.Left} title="Connect canvas context" className={styles.contextHandle} /><Handle type="source" position={Position.Right} className={styles.contextHandle} />
    <div className={`${styles.agentGrip} pixice-canvas-item-handle`}><span>Pixice</span><button className="nodrag" aria-label={`Remove ${data.title} from canvas`} onClick={remove}><X size={13} /></button></div>
    <div className="nodrag nopan nowheel"><CanvasAgent nodeId={id} data={data} api={context.api} hostId={context.hostId} projects={context.projects} models={context.models} defaults={context.defaults} documentRef={context.documentRef} onChange={patch => context.updateNode(id, patch, true)} onPin={content => { const node = context.documentRef.current.nodes.find(node => node.id === id); context.addItem("text", { x: node.position.x + (node.measured?.width ?? node.style.width) + 40, y: node.position.y }, { title: "Agent answer", content }); }} /></div>
  </div>;
  return <article className={styles.item} data-kind={data.kind} data-selected={selected} aria-label={`${TITLES[data.kind]}: ${data.title}`}>
    <NodeResizer minWidth={data.kind === "workflow" ? 620 : 260} minHeight={data.kind === "workflow" ? 420 : 180} isVisible={selected} color="#9a9793" />
    <Handle type="target" position={Position.Left} title="Connect context" className={styles.contextHandle} />
    <Handle type="source" position={Position.Right} title="Share context with an agent" className={styles.contextHandle} />
    <header className={`${styles.itemHeader} pixice-canvas-item-handle`}><Icon size={14} /><input className="nodrag" aria-label={`${TITLES[data.kind]} title`} value={data.title} onChange={event => change({ title: event.target.value, ...(data.kind === "task" ? { taskDirty: true } : {}), ...(data.workflow ? { workflow: { ...data.workflow, name: event.target.value } } : {}) })} /><small>{TITLES[data.kind]}</small><button className="nodrag" aria-label={`Remove ${data.title} from canvas`} title="Remove from canvas" onClick={remove}><X size={13} /></button></header>
    <div className={`${styles.itemBody} nodrag nopan nowheel`}>
      {data.kind === "text" && <textarea className={styles.note} aria-label="Note text" placeholder="A thought, a brief, a little context…" value={data.content ?? ""} onChange={event => change({ content: event.target.value })} />}
      {data.kind === "file" && <div className={styles.fileContent}><small>{data.filename} · imported copy</small><textarea aria-label="File content" value={data.content ?? ""} onChange={event => change({ content: event.target.value })} /><button onClick={() => context.download(data.filename ?? data.title, data.content)}>Export file</button></div>}
      {data.kind === "link" && <div className={styles.linkContent}><label>Web address<input aria-label="Canvas web address" placeholder="https://…" value={data.url ?? ""} onChange={event => change({ url: event.target.value })} /></label>{/^https?:\/\//i.test(data.url ?? "") && <a href={data.url} target="_blank" rel="noopener noreferrer"><Globe size={15} />Open page</a>}</div>}
      {data.kind === "image" && <button className={styles.image} aria-label={`Inspect ${data.title}`} onClick={() => context.setImage(data)}><img src={data.src} alt={data.title} draggable={false} /><small>Click to inspect</small></button>}
      {data.kind === "task" && <CanvasBoardTask data={data} api={context.api} onChange={change} />}
      {data.kind === "tool" && <ReactFlowProvider><CanvasTool data={data} api={context.api} onChange={change} /></ReactFlowProvider>}
    </div>
  </article>;
}
const NODE_TYPES = { canvasItem: CanvasItem, canvasWorkflowNode: CanvasWorkflowNode };

function Picture({ image, onClose }) {
  const [actual, setActual] = useState(false);
  const root = useRef(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => { root.current?.querySelector("button")?.focus(); return () => previousFocus.current?.focus?.(); }, []);
  return <div className={styles.picture} ref={root} role="dialog" aria-modal="true" aria-label="Canvas image inspector" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") { const buttons = [...root.current.querySelectorAll("button")]; event.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus(); }
  }}><header><strong>{image.title}</strong><button onClick={() => setActual(value => !value)}>{actual ? "Fit image" : "Actual size"}</button><button aria-label="Close image inspector" onClick={onClose}><X size={16} /></button></header><div data-actual={actual}><img src={image.src} alt={image.title} /></div></div>;
}

function CanvasSurface({ document, update, api, hostId, projects, models, defaults, onExit, saveStatus, onToggleLibrary }) {
  const flow = useReactFlow();
  const documentRef = useRef(document);
  documentRef.current = document;
  const surfaceRef = useRef(null);
  const fileRef = useRef(null);
  const importPoint = useRef({ x: 100, y: 100 });
  const [menu, setMenu] = useState(null);
  const closeMenu = useCallback(() => { setMenu(null); surfaceRef.current?.focus(); }, []);
  const [picker, setPicker] = useState(null);
  const [nodePicker, setNodePicker] = useState(null);
  const [nodeQuery, setNodeQuery] = useState("");
  const [image, setImage] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(document.viewport.zoom);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const lastHistory = useRef(0);
  const edit = useCallback(updater => {
    const current = documentRef.current;
    const now = Date.now();
    if (now - lastHistory.current > 700) { setUndoStack(stack => [...stack.slice(-29), structuredClone(current)]); lastHistory.current = now; }
    setRedoStack([]);
    update(updater);
  }, [update]);
  const restoreHistory = snapshot => update(current => {
    const live = new Map(current.nodes.map(node => [node.id, node]));
    return { ...snapshot, nodes: snapshot.nodes.map(node => {
      const latest = live.get(node.id)?.data;
      if (!latest) return node;
      // Reverting canvas layout must never forget a thread or workflow that was
      // already created in Pixice, or roll back its concurrency revision.
      const identities = Object.fromEntries(["threadId", "workflowId", "pendingWorkflowId", "updatedAt", "loaded", "run"].filter(key => latest[key] !== undefined).map(key => [key, latest[key]]));
      return { ...node, data: { ...node.data, ...identities, ...(latest.threadId || latest.workflowId || latest.pendingWorkflowId ? { projectId: latest.projectId } : {}), ...(latest.workflowId ? { dirty: true } : {}) } };
    }) };
  });
  const undo = () => { if (!undoStack.length) return; setRedoStack(stack => [...stack, structuredClone(documentRef.current)]); const previous = undoStack.at(-1); setUndoStack(stack => stack.slice(0, -1)); restoreHistory(previous); };
  const redo = () => { if (!redoStack.length) return; setUndoStack(stack => [...stack, structuredClone(documentRef.current)]); const next = redoStack.at(-1); setRedoStack(stack => stack.slice(0, -1)); restoreHistory(next); };
  const updateNode = (id, patch, runtime = false) => (runtime ? update : edit)(current => {
    const ownerId = current.nodes.find(node => node.id === id)?.data.ownerId;
    return { ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, ...patch } } : !runtime && node.id === ownerId ? { ...node, data: { ...node.data, dirty: true } } : node) };
  });
  const removeNode = id => edit(current => { const removed = new Set(current.nodes.filter(node => node.id === id || node.data.ownerId === id).map(node => node.id)); const ownerId = current.nodes.find(node => node.id === id)?.data.ownerId; return { ...current, nodes: current.nodes.filter(node => !removed.has(node.id)).map(node => node.id === ownerId ? { ...node, data: { ...node.data, dirty: true } } : node), edges: current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) }; });
  const addWorkflow = (workflow, position, metadata = {}) => { const placed = placeCanvasWorkflow(workflow, position, metadata); edit(current => ({ ...current, nodes: [...current.nodes, placed.label, ...placed.nodes], edges: [...current.edges, ...placed.edges] })); };
  const replaceWorkflow = (ownerId, workflow) => update(current => {
    const owner = current.nodes.find(node => node.id === ownerId); if (!owner) return current;
    const placed = placeCanvasWorkflow(workflow, owner.position, { ...owner.data, workflowId: workflow.id, updatedAt: workflow.updatedAt, loaded: true, dirty: false, title: workflow.name }, ownerId);
    const previous = new Map(current.nodes.filter(node => node.data.ownerId === ownerId).map(node => [node.id, node]));
    const ids = new Set(placed.nodes.map(node => node.id));
    return { ...current, nodes: [...current.nodes.filter(node => node.id !== ownerId && node.data.ownerId !== ownerId), placed.label, ...placed.nodes.map(node => previous.has(node.id) ? { ...node, position: previous.get(node.id).position, selected: previous.get(node.id).selected } : node)], edges: [...current.edges.filter(edge => edge.data?.ownerId !== ownerId && (!previous.has(edge.source) || ids.has(edge.source)) && (!previous.has(edge.target) || ids.has(edge.target))), ...placed.edges] };
  });
  const applyWorkflowRun = (ownerId, run) => update(current => ({ ...current, nodes: current.nodes.map(node => node.id === ownerId ? { ...node, data: { ...node.data, run: { id: run.id, status: run.status } } } : node.data.ownerId === ownerId ? { ...node, data: { ...node.data, runState: run.nodeRuns?.[node.data.node.id] ? { status: run.nodeRuns[node.data.node.id].status } : null } } : node) }));
  const addItem = (kind, position, data = {}) => {
    if (kind === "workflow") { addWorkflow(data.workflow ?? createCanvasWorkflow("Untitled workflow", true), position, data); return; }
    const item = createCanvasItem(kind, position, data);
    if (kind === "agent") item.style = { width: 520 };
    edit(current => ({ ...current, nodes: [...current.nodes.map(node => ({ ...node, selected: false })), { ...item, selected: true }] }));
    setTimeout(() => surfaceRef.current?.querySelector(`[data-id="${item.id}"] textarea`)?.focus(), 40);
  };
  const centerPoint = () => { const bounds = surfaceRef.current.getBoundingClientRect(); return flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2 - 140, y: bounds.top + bounds.height / 2 - 100 }); };
  const showMenu = (event, flowPoint = null) => {
    if (event.target.closest?.("input, textarea, [contenteditable=true]")) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = surfaceRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - bounds.left, 170), bounds.width - 170);
    const y = Math.min(Math.max(event.clientY - bounds.top, 140), bounds.height - 150);
    setMenu({ x, y, position: flowPoint ?? flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  };
  const choose = kind => {
    const position = menu?.position ?? centerPoint();
    setMenu(null);
    if (kind === "image") { importPoint.current = position; fileRef.current.accept = "image/png,image/jpeg,image/webp,image/gif"; fileRef.current.click(); }
    else if (["task", "tool", "existing-workflow", "existing-agent"].includes(kind)) setPicker({ kind: kind.replace("existing-", ""), position });
    else addItem(kind, position, kind === "agent" && document.projectId ? { projectId: document.projectId } : {});
  };
  const readFiles = async (files, position) => {
    setError(null);
    const accepted = [...files].slice(0, 12);
    for (const [index, file] of accepted.entries()) {
      const point = { x: position.x + index * 30, y: position.y + index * 30 };
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        if (file.size > 15 * 1024 * 1024) { setError(`${file.name} is too large. Canvas images can be up to 15 MB.`); continue; }
        const src = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        addItem("image", point, { title: file.name, src });
      } else if (/\.(txt|md|json|csv|js|jsx|ts|tsx|html|css|py|yaml|yml|xml|svg|log)$/i.test(file.name) || file.type.startsWith("text/")) {
        if (file.size > 1024 * 1024) { setError(`${file.name} is too large for a text card (1 MB maximum).`); continue; }
        addItem("file", point, { title: file.name, filename: file.name, content: await file.text() });
      } else setError(`${file.name} is not supported yet. Add a raster image or text/code file.`);
    }
  };
  const download = (name, content) => { const url = URL.createObjectURL(new Blob([content ?? ""], { type: "text/plain" })); const anchor = globalThis.document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const context = { api, hostId, projects, models, defaults, documentRef, updateNode, removeNode, addItem, setImage, download, setNodePicker, replaceWorkflow, applyWorkflowRun };
  return <CanvasContext.Provider value={context}><section className={styles.surface} ref={surfaceRef} aria-label="Canvas workspace" onContextMenu={showMenu} onKeyDown={event => {
    if (event.target.closest("input,textarea,[contenteditable=true]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); edit(current => { const selected = new Set(current.nodes.filter(node => node.selected).map(node => node.id)); current.nodes.forEach(node => { if (selected.has(node.data.ownerId)) selected.add(node.id); }); const dirty = new Set([...current.nodes.filter(node => selected.has(node.id)).map(node => node.data.ownerId), ...current.edges.filter(edge => edge.selected).map(edge => edge.data?.ownerId)]); return { ...current, nodes: current.nodes.filter(node => !selected.has(node.id)).map(node => dirty.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node), edges: current.edges.filter(edge => !selected.has(edge.source) && !selected.has(edge.target) && !edge.selected) }; }); }
    if (event.shiftKey && event.key === "F10") { event.preventDefault(); const bounds = surfaceRef.current.getBoundingClientRect(); showMenu({ ...event, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2, preventDefault() {}, stopPropagation() {}, target: event.target }); }
  }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); void readFiles(event.dataTransfer.files, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })).catch(cause => setError(cause.message)); }} onPaste={event => {
    if (event.target.closest("input,textarea")) return;
    const files = event.clipboardData.files;
    if (files.length) { event.preventDefault(); void readFiles(files, centerPoint()).catch(cause => setError(cause.message)); }
    else { const text = event.clipboardData.getData("text/plain"); if (text) { event.preventDefault(); addItem("text", centerPoint(), { content: text }); } }
  }} tabIndex={0}>
    <header className={styles.surfaceHeader}><button aria-label="Back to task" title="Back to task" onClick={onExit}><CaretLeft size={17} /></button><div className={styles.canvasTitleCapsule}><button aria-label="Toggle canvases" title="Your canvases" onClick={onToggleLibrary}><Stack size={15} /></button><input aria-label="Canvas name" value={document.name} onChange={event => update(current => ({ ...current, name: event.target.value }))} /></div><div className={styles.headerQuickActions}>{OPTIONS.slice(0,4).map(({ kind, label, icon: Icon }) => <button key={kind} title={label} aria-label={label} onClick={() => choose(kind)}><Icon size={15} /></button>)}</div><span className={styles.headerSpacer} /><span className={styles.saveState} data-state={saveStatus}>{saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Unsaved changes" : "Saved locally"}</span><button aria-label="Add from project" title="Add project content" onClick={() => choose("existing-workflow")}><Plus size={16} /></button><select aria-label="Link canvas to project" value={document.projectId ?? ""} onChange={event => update(current => ({ ...current, projectId: event.target.value || null }))}><option value="">Independent canvas</option>{projects.map(project => <option value={project.id} key={project.id}>{project.displayName ?? project.name}</option>)}</select><button aria-label="Export canvas" title="Export canvas as JSON" onClick={() => download(`${document.name || "canvas"}.json`, JSON.stringify(document, null, 2))}><File size={16} /></button></header>
    <ReactFlow nodes={document.nodes} edges={document.edges} nodeTypes={NODE_TYPES} defaultViewport={document.viewport} minZoom={.15} maxZoom={1.75} panOnScroll zoomOnScroll={false} zoomOnPinch selectionOnDrag panOnDrag={[1, 2]} deleteKeyCode={null} onInit={instance => { if (document.nodes.length && new URLSearchParams(location.search).has("canvas-preview")) void instance.fitView({ padding: .14, maxZoom: .85 }); }} onNodesChange={changes => {
      const mutation = changes.some(change => ["position", "dimensions", "remove", "add"].includes(change.type));
      const apply = current => { const positions = new Set(changes.filter(change => change.type === "position").map(change => change.id)); const synchronized = [...changes]; for (const change of changes) { const label = current.nodes.find(node => node.id === change.id); if (change.type !== "position" || !change.position || label?.data.kind !== "workflow") continue; const dx = change.position.x - label.position.x, dy = change.position.y - label.position.y; current.nodes.filter(node => node.data.ownerId === label.id && !positions.has(node.id)).forEach(node => synchronized.push({ type: "position", id: node.id, position: { x: node.position.x + dx, y: node.position.y + dy }, dragging: change.dragging })); } const dirtyOwners = new Set(changes.filter(change => change.type === "position" && change.position).map(change => current.nodes.find(node => node.id === change.id)?.data.ownerId).filter(Boolean)); return { ...current, nodes: applyNodeChanges(synchronized, current.nodes).map(node => dirtyOwners.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node) }; };
      mutation && changes.some(change => change.dragging) ? edit(apply) : update(apply);
    }} onEdgesChange={changes => update(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges) }))} onConnect={connection => {
      if (connection.source === connection.target) return;
      const source = documentRef.current.nodes.find(node => node.id === connection.source), target = documentRef.current.nodes.find(node => node.id === connection.target);
      const workflow = source?.data.kind === "workflowNode" && target?.data.kind === "workflowNode";
      if (workflow && (source.data.ownerId !== target.data.ownerId || !workflowCanConnect(source.data.node, connection.sourceHandle, target.data.node, connection.targetHandle))) { setError("These workflow ports cannot be connected."); return; }
      edit(current => ({ ...current, nodes: current.nodes.map(node => workflow && node.id === source.data.ownerId ? { ...node, data: { ...node.data, dirty: true } } : node), edges: addEdge({ ...connection, type: "smoothstep", data: workflow ? { kind: "workflow", ownerId: source.data.ownerId } : { kind: "context" }, style: { stroke: workflow ? "#a38aab" : "#77726e", strokeWidth: 1.3 } }, current.edges) }));
    }} onMoveEnd={(_, viewport) => { setZoom(viewport.zoom); update(current => ({ ...current, viewport })); }} onPaneClick={() => { setMenu(null); setNodePicker(null); surfaceRef.current?.focus(); }} onNodeClick={() => setMenu(null)} onEdgeDoubleClick={(_, edge) => edit(current => ({ ...current, nodes: current.nodes.map(node => node.id === edge.data?.ownerId ? { ...node, data: { ...node.data, dirty: true } } : node), edges: current.edges.filter(item => item.id !== edge.id) }))} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#41403f" />
    </ReactFlow>
    {!document.nodes.length && !menu && <div className={styles.emptyCanvas}><CanvasAvatar /><h1>A space to think together.</h1><p>Bring your ideas, work, and agents into the same canvas.<br />Start anywhere. Everything has room here.</p><div><button onClick={() => choose("text")}><File size={15} />Write a note</button><button onClick={() => choose("agent")}><PaperPlaneTilt size={15} />Ask an agent</button><button onClick={() => choose("workflow")}><TreeStructure size={15} />Build a workflow</button></div><small>Right-click anywhere to meet your canvas companion.</small></div>}
    <div className={styles.bottomBar}><div className={styles.toolbar} role="toolbar" aria-label="Canvas tools">{OPTIONS.slice(4).map(({ kind, label, icon: Icon }) => <button key={kind} title={label} aria-label={label} onClick={() => choose(kind)}><Icon size={17} /></button>)}<span /><button title="Import file" aria-label="Import file" onClick={() => { importPoint.current = centerPoint(); fileRef.current.accept = ".txt,.md,.json,.csv,.js,.jsx,.ts,.tsx,.html,.css,.py,.yaml,.yml,.xml,.svg,.log"; fileRef.current.click(); }}><Folder size={17} /></button><button title="Add link" aria-label="Add link" onClick={() => choose("link")}><Globe size={17} /></button></div><div className={styles.zoom}><button aria-label="Zoom out" onClick={() => flow.zoomOut()}>−</button><button aria-label="Fit canvas" title="Fit canvas" onClick={() => flow.fitView({ padding: .15, maxZoom: 1 })}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" onClick={() => flow.zoomIn()}>+</button></div></div>
    <div className={styles.hint}>{document.nodes.length ? "Drag a header to move · connect handles to share context · double-click a line to remove it" : "Scroll to pan · pinch to zoom"}</div>
    <input ref={fileRef} type="file" multiple hidden onChange={event => { void readFiles(event.target.files, importPoint.current).catch(cause => setError(cause.message)); event.target.value = ""; }} />
    <AnimatePresence>{menu && <CanvasCompanionMenu key="canvas-companion" point={menu} options={OPTIONS} onChoose={choose} onClose={closeMenu} />}</AnimatePresence>
    {picker && <><div className={styles.pickerBackdrop} onClick={() => setPicker(null)} /><CanvasResourcePicker kind={picker.kind} api={api} projects={projects} initialProjectId={document.projectId} onCancel={() => setPicker(null)} onChoose={async ({ kind, projectId, entity }) => { try { if (kind === "workflow") { const result = await api.workflows.read({ projectId, workflowId: entity.id }); addWorkflow(result.workflow, picker.position, { projectId, workflowId: entity.id, updatedAt: result.workflow.updatedAt, loaded: true }); } else { const fields = kind === "task" ? { taskId: entity.id } : kind === "tool" ? { instrumentId: entity.id, threadId: entity.threadId } : { threadId: entity.id }; addItem(kind, picker.position, { ...fields, projectId, title: entity.title ?? entity.name ?? entity.preview ?? TITLES[kind] }); } setPicker(null); } catch (cause) { setError(cause.message); } }} /></>}
    {nodePicker && <div className={styles.workflowNodePicker} role="dialog" aria-label="Add workflow node"><header><strong>Add a node</strong><button aria-label="Close node picker" onClick={() => { setNodePicker(null); setNodeQuery(""); }}><X size={14} /></button></header><input aria-label="Find workflow nodes" placeholder="Find a node…" value={nodeQuery} onChange={event => setNodeQuery(event.target.value)} />{WORKFLOW_NODE_CATEGORIES.map(category => <section key={category}><small>{category}</small>{Object.entries(WORKFLOW_NODE_META).filter(([, meta]) => meta.category === category && `${meta.label} ${meta.defaultDescription}`.toLowerCase().includes(nodeQuery.toLowerCase())).map(([type, meta]) => <button key={type} onClick={() => { const owner = documentRef.current.nodes.find(node => node.id === nodePicker.ownerId); const siblings = documentRef.current.nodes.filter(node => node.data.ownerId === owner.id); const node = createWorkflowNode(type, { x: siblings.length * 285, y: 65 }); edit(current => ({ ...current, nodes: [...current.nodes.map(node => node.id === owner.id ? { ...node, data: { ...node.data, dirty: true } } : node), { id: `${owner.id}:${node.id}`, type: "canvasWorkflowNode", dragHandle: ".pixice-workflow-node-handle", position: { x: owner.position.x + node.position.x, y: owner.position.y + 100 + node.position.y }, style: { width: WORKFLOW_NODE_WIDTH + 30, height: workflowNodeHeight(node) + 20 }, data: { kind: "workflowNode", ownerId: owner.id, title: node.name, node } }] })); setNodePicker(null); setNodeQuery(""); }}><span>{meta.label}</span><small>{meta.action}</small></button>)}</section>)}</div>}
    {image && <Picture image={image} onClose={() => setImage(null)} />}
    {error && <div className={styles.surfaceError} role="alert">{error}<button aria-label="Dismiss canvas error" onClick={() => setError(null)}><X size={13} /></button></div>}
  </section></CanvasContext.Provider>;
}

export function CanvasWorkspace({ api, hostId = "local", store, active, onBack }) {
  const [documents, setDocuments] = useState([]);
  const documentsRef = useRef(documents);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveStatus, setSaveStatus] = useState("saved");
  const [projects, setProjects] = useState([]);
  const [models, setModels] = useState([]);
  const [defaults, setDefaults] = useState({});
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const pending = useRef(new Map());
  const timer = useRef(null);
  const saveChain = useRef(Promise.resolve());
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  documentsRef.current = documents;
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const batch = [...pending.current.values()];
    pending.current.clear();
    saveChain.current = saveChain.current.catch(() => {}).then(async () => {
      for (const snapshot of batch) {
        try { await store.save(snapshot); if (!pending.current.size && documentsRef.current.find(document => document.id === snapshot.id)?.updatedAt === snapshot.updatedAt) { setSaveStatus("saved"); setError(null); } }
        catch (cause) { if (!pending.current.has(snapshot.id)) pending.current.set(snapshot.id, documentsRef.current.find(document => document.id === snapshot.id) ?? snapshot); setSaveStatus("error"); setError(`Canvas could not be saved: ${cause.message}. Your changes are still here. Export a copy or retry.`); }
      }
    });
    return saveChain.current;
  }, [store]);
  const queueSave = useCallback(document => { pending.current.set(document.id, document); setSaveStatus("saving"); clearTimeout(timer.current); timer.current = setTimeout(flush, 240); }, [flush]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    store.list().then(async saved => {
      if (cancelled) return;
      if (!saved.length) {
        const document = createCanvas();
        if (import.meta.env.DEV && new URLSearchParams(location.search).has("canvas-preview")) {
          document.name = "A place for the next idea";
          document.nodes = [createCanvasItem("text", { x: 0, y: 0 }, { title: "A little context", content: "A canvas for the messy middle.\n\nKeep a brief beside the workflow. Invite an agent when you need another pair of eyes. Let the useful things stay together." }), createCanvasItem("workflow", { x: 370, y: 0 }, { title: "From idea to something useful", workflow: createCanvasWorkflow("From idea to something useful", true) }), createCanvasItem("text", { x: 0, y: 310 }, { title: "Room to explore", content: "Try right-clicking anywhere.\n\nYour little canvas companion can add notes, images, workflows, Board tasks, tools, or another agent." })];
        }
        saved = [document];
        queueSave(document);
      }
      saved = saved.map(document => { const flattened = flattenCanvasWorkflows(document); if (flattened !== document) queueSave(flattened); return flattened; });
      setDocuments(saved); documentsRef.current = saved; setSelectedId(saved[0].id); setError(null); setLoading(false);
    }).catch(cause => { if (!cancelled) { setError(`Canvases could not load: ${cause.message}`); setLoading(false); } });
    return () => { cancelled = true; };
  }, [store, loadRevision]);
  useEffect(() => { if (!active) void flush(); }, [active, flush]);
  useEffect(() => {
    const saveWhenHidden = () => { if (document.visibilityState === "hidden") void flush(); };
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => { document.removeEventListener("visibilitychange", saveWhenHidden); void flush(); };
  }, [flush]);
  useEffect(() => {
    if (!active || !api) return;
    let cancelled = false;
    Promise.allSettled([api.projects?.list?.() ?? [], api.models?.list?.() ?? [], api.app?.bootstrap?.() ?? {}]).then(results => {
      if (cancelled) return;
      if (results[0].status === "fulfilled") setProjects(results[0].value ?? []);
      if (results[1].status === "fulfilled") setModels(results[1].value ?? []);
      if (results[2].status === "fulfilled") setDefaults(results[2].value.settings ?? {});
    });
    return () => { cancelled = true; };
  }, [api, active]);
  const update = useCallback(updater => {
    const current = documentsRef.current.find(document => document.id === selectedRef.current);
    if (!current) return;
    const next = { ...updater(current), updatedAt: new Date().toISOString() };
    const updated = documentsRef.current.map(document => document.id === next.id ? next : document);
    documentsRef.current = updated; setDocuments(updated); queueSave(next);
  }, [queueSave]);
  const selected = documents.find(document => document.id === selectedId);
  const create = () => { const document = createCanvas(); const next = [document, ...documentsRef.current]; documentsRef.current = next; setDocuments(next); setSelectedId(document.id); queueSave(document); setConfirmDelete(false); };
  const remove = async () => {
    try {
      await flush();
      await store.remove(selectedId);
      pending.current.delete(selectedId);
      const next = documentsRef.current.filter(document => document.id !== selectedId); documentsRef.current = next; setDocuments(next); setSelectedId(next[0]?.id ?? null); setConfirmDelete(false);
    } catch (cause) { setError(`Canvas could not be removed: ${cause.message}`); }
  };
  const visible = useMemo(() => documents.filter(document => document.name.toLowerCase().includes(query.toLowerCase())), [documents, query]);
  return <div className={styles.workspace}>
    <aside className={styles.sidebar} hidden={!libraryOpen} aria-label="Canvases navigation"><button className={styles.back} onClick={() => setLibraryOpen(false)}><CaretLeft size={15} />Back to canvas</button><div className={styles.sidebarHeading}><Stack size={18} /><strong>Canvases</strong><button aria-label="New canvas" title="New canvas" onClick={() => { create(); setLibraryOpen(false); }}><Plus size={17} /></button></div><label className={styles.search}><MagnifyingGlass size={14} /><input aria-label="Search canvases" placeholder="Find a canvas" value={query} onChange={event => setQuery(event.target.value)} /></label><div className={styles.canvasList}>{visible.map(document => <button key={document.id} aria-label={`${document.name || "Untitled canvas"} ${document.nodes.length} ${document.nodes.length === 1 ? "item" : "items"}`} aria-current={selectedId === document.id ? "page" : undefined} onClick={() => { void flush(); setSelectedId(document.id); setConfirmDelete(false); setLibraryOpen(false); }}><span>{document.name || "Untitled canvas"}</span><small>{document.nodes.length} {document.nodes.length === 1 ? "item" : "items"}</small></button>)}{!visible.length && !loading && <small>No canvases here yet.</small>}</div><div className={styles.sidebarFooter}><p>Your ideas can live outside a project.<br />Link one whenever you need it.</p>{selected && (confirmDelete ? <div className={styles.deleteConfirm}><span>Delete this canvas?</span><button onClick={remove}>Delete</button><button onClick={() => setConfirmDelete(false)}>Keep</button></div> : <button onClick={() => setConfirmDelete(true)}><Trash size={13} />Delete canvas</button>)}</div></aside>
    {selected ? <ReactFlowProvider key={selectedId}><CanvasSurface document={selected} update={update} api={api} hostId={hostId} projects={projects} models={models} defaults={defaults} saveStatus={saveStatus} onExit={() => { void flush(); onBack(); }} onToggleLibrary={() => setLibraryOpen(value => !value)} /></ReactFlowProvider> : <div className={styles.noCanvas}><CanvasAvatar /><h2>{loading ? "Opening your canvases…" : "Give your next idea some space."}</h2>{!loading && <button onClick={create}><Plus size={15} />New canvas</button>}</div>}
    {error && <div className={styles.storageError} role="alert"><span>{error}</span><button onClick={() => { if (pending.current.size) void flush(); else setLoadRevision(value => value + 1); }}><ArrowClockwise size={13} />Retry</button>{selected && <button onClick={() => { const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "canvas-backup.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export backup</button>}</div>}
  </div>;
}
