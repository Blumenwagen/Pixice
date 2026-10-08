import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { WorkflowNodeInspector } from "../workflows/WorkflowNodeInspector.jsx";
import { WorkflowNodeIcon } from "../workflows/workflow-icons.jsx";
import { WORKFLOW_NODE_META, workflowInputPorts, workflowOutputPorts } from "../workflows/workflow-utils.js";
import { Check, Plus, SpinnerGap, TreeStructure, X } from "../icons/index.jsx";
import { CanvasContext } from "./canvas-context.js";
import { canvasWorkflowGraph } from "./canvas-workflows.js";
import styles from "./Canvas.module.css";

export function CanvasWorkflowNode({ id, data, selected }) {
  const context = useContext(CanvasContext);
  const [editing, setEditing] = useState(false);
  const [inspectorSide, setInspectorSide] = useState("right");
  const root = useRef(null);
  useLayoutEffect(() => {
    if (!editing) return;
    const bounds = root.current?.getBoundingClientRect();
    const surface = root.current?.closest(".react-flow")?.getBoundingClientRect();
    if (bounds && surface) setInspectorSide(bounds.right + 340 > surface.right ? "left" : "right");
  }, [editing]);
  const node = data.node;
  const meta = WORKFLOW_NODE_META[node.type];
  const owner = context.documentRef.current.nodes.find(candidate => candidate.id === data.ownerId);
  const renderPorts = side => (side === "input" ? workflowInputPorts(node) : workflowOutputPorts(node)).map((port, index, ports) => <Handle key={port.id} id={port.id} type={side === "input" ? "target" : "source"} position={side === "input" ? Position.Left : Position.Right} className={styles.workflowPort} style={{ top: `${50 + (index - (ports.length - 1) / 2) * 20}%` }} title={port.label} aria-label={`${node.name}: ${port.label}`}><span>{port.label}</span></Handle>);
  return <div ref={root} className={styles.workflowPrimitive} role="group" aria-label={`Workflow node: ${node.name}`} data-selected={selected} data-status={data.runState?.status} onDoubleClick={() => setEditing(value => !value)}>
    {renderPorts("input")}
    <header className="pixice-workflow-node-handle"><span><WorkflowNodeIcon type={node.type} size={17} /></span><div><strong>{node.name}</strong><small>{meta.action}</small></div><button className="nodrag" aria-label={`Edit ${node.name}`} title="Edit node" onClick={() => setEditing(value => !value)}><TreeStructure size={12} /></button></header>
    <p>{node.description || meta.defaultDescription}</p><footer><small>{meta.label}</small>{data.runState?.status && <span>{data.runState.status === "running" ? <SpinnerGap className={styles.spin} size={12} /> : data.runState.status === "completed" ? <Check size={12} /> : data.runState.status}</span>}</footer>
    {renderPorts("output")}
    {editing && <div className={`${styles.nodeProperties} nodrag nopan nowheel`} data-side={inspectorSide} onDoubleClick={event => event.stopPropagation()}><WorkflowNodeInspector node={node} api={context.api} projectId={owner?.data.projectId ?? context.documentRef.current.projectId} models={context.models} currentWorkflowId={owner?.data.workflowId} onUpdate={patch => context.updateNode(id, { node: { ...node, ...patch }, title: patch.name ?? node.name })} onDelete={() => context.removeNode(id)} onClose={() => setEditing(false)} /></div>}
  </div>;
}

export function CanvasWorkflowLabel({ id, data }) {
  const context = useContext(CanvasContext);
  const latest = useRef(data); latest.current = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const projectId = data.projectId ?? context.documentRef.current.projectId ?? "";
  useEffect(() => {
    if (!context.api?.workflows || !data.workflowId || !projectId) return;
    let disposed = false;
    if (!data.loaded) context.api.workflows.read({ projectId, workflowId: data.workflowId }).then(result => { if (!disposed) context.replaceWorkflow(id, result.workflow); }).catch(cause => { if (!disposed) setError(cause.message); });
    const unsubscribe = context.api.events?.subscribe(event => {
      const payload = event.payload ?? {};
      if (payload.projectId && payload.projectId !== projectId) return;
      if (event.type === "WorkflowRunUpdated" && payload.workflowId === latest.current.workflowId) context.applyWorkflowRun(id, payload.run);
      if (event.type === "WorkflowUpdated" && payload.workflow?.id === latest.current.workflowId && payload.workflow.updatedAt !== latest.current.updatedAt) {
        if (payload.action === "deleted") setError("This project workflow was deleted. Its canvas content is preserved.");
        else if (latest.current.dirty) setError("The project workflow changed elsewhere. Your canvas draft is preserved; save will check for conflicts.");
        else context.replaceWorkflow(id, payload.workflow);
      }
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [context.api, id, data.workflowId, projectId]);
  const save = async run => {
    if (!projectId) { setError("Choose a project to save or run this workflow. You can keep building on the canvas."); return; }
    if (!context.api?.workflows) { setError("Connect a Pixice environment to save or run this workflow."); return; }
    setBusy(true); setError(null);
    try {
      let workflowId = latest.current.workflowId ?? latest.current.pendingWorkflowId;
      let updatedAt = latest.current.updatedAt;
      if (!workflowId) {
        const created = await context.api.workflows.create({ projectId, name: latest.current.title || "Untitled workflow", description: latest.current.workflow?.description ?? "", enabled: false });
        workflowId = created.id; updatedAt = created.updatedAt;
        context.updateNode(id, { pendingWorkflowId: workflowId, updatedAt, projectId }, true);
      }
      const name = latest.current.title || "Untitled workflow";
      const graph = canvasWorkflowGraph(context.documentRef.current, id);
      const saved = await context.api.workflows.save({ projectId, workflowId, name, description: latest.current.workflow?.description ?? "", enabled: false, graph, ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) });
      const changedDuringSave = latest.current.title !== name || JSON.stringify(canvasWorkflowGraph(context.documentRef.current, id)) !== JSON.stringify(graph);
      context.updateNode(id, { workflowId: saved.id, pendingWorkflowId: null, updatedAt: saved.updatedAt, projectId, dirty: changedDuringSave, loaded: true }, true);
      setError(null);
      if (run) context.applyWorkflowRun(id, await context.api.workflows.run({ projectId, workflowId: saved.id, input: {} }));
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const activeRun = ["running", "queued", "cancelling"].includes(data.run?.status);
  return <div className={styles.workflowLabel}>
    <Handle type="target" position={Position.Left} title="Connect canvas context" className={styles.contextHandle} /><Handle type="source" position={Position.Right} title="Share workflow context" className={styles.contextHandle} />
    <div className={`${styles.workflowLabelTitle} pixice-canvas-item-handle`}><TreeStructure size={16} /><input className="nodrag" aria-label="Workflow title" value={data.title} onChange={event => context.updateNode(id, { title: event.target.value, dirty: true })} /><small>{data.workflowId ? data.dirty ? "Draft changes" : "Saved" : "Canvas workflow"}</small></div>
    <div className={`${styles.workflowLabelActions} nodrag nopan`}><button title="Add workflow node" aria-label={`Add node to ${data.title}`} onClick={() => context.setNodePicker({ ownerId: id })}><Plus size={15} /></button><select aria-label="Workflow project" value={projectId} disabled={Boolean(data.workflowId || data.pendingWorkflowId) || busy} onChange={event => context.updateNode(id, { projectId: event.target.value })}><option value="">Project, when needed</option>{context.projects.map(project => <option key={project.id} value={project.id}>{project.displayName ?? project.name}</option>)}</select><button disabled={busy || activeRun} onClick={() => save(false)}>Save</button>{activeRun ? <button onClick={async () => { try { await context.api.workflows.cancel({ projectId, runId: data.run.id }); } catch (cause) { setError(cause.message); } }}>Stop</button> : <button disabled={busy} onClick={() => save(true)}>{busy ? "Saving…" : "Run"}</button>}<button aria-label={`Remove ${data.title} from canvas`} onClick={() => context.removeNode(id)}><X size={13} /></button></div>
    {error && <div className={`${styles.inlineError} nodrag`} role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
  </div>;
}
