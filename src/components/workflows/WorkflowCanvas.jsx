import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Check,
  CheckCircle,
  Circle,
  Code,
  Eye,
  Lightning,
  PaperPlaneTilt,
  Pause,
  Plus,
  Sparkle,
  SpinnerGap,
  Trash,
  Warning,
  X
} from "../icons/index.jsx";
import styles from "./WorkflowWorkspace.module.css";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_META,
  WORKFLOW_NODE_WIDTH,
  createWorkflowEdge,
  createWorkflowNode,
  fitWorkflowViewport,
  nextNodePosition,
  nodePort,
  parseWorkflowInput,
  stringifyWorkflowValue,
  workflowEdgePath,
  workflowStatusLabel
} from "./workflow-utils.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancelling"]);
const PERMISSIONS = [
  ["read-only", "Read only"],
  ["workspace-write", "Workspace access"],
  ["auto-approve", "Auto-review"],
  ["full-access", "Full access"]
];

function IconButton({ label, className = "", children, ...props }) {
  return <button type="button" className={`${styles.iconButton} ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function nodeIcon(type, size = 19) {
  if (type === "manualTrigger") return <Lightning size={size} />;
  if (type === "loomAgent") return <Brain size={size} />;
  return <Code size={size} />;
}

function runStatusIcon(status) {
  if (status === "running" || status === "queued") return <SpinnerGap className={styles.spin} size={12} />;
  if (status === "completed") return <CheckCircle size={12} />;
  if (status === "failed") return <Warning size={12} />;
  if (status === "cancelled" || status === "cancelling") return <Pause size={12} />;
  return null;
}

function WorkflowNode({ node, selected, connecting, runState, onSelect, onDragStart, onStartConnection, onFinishConnection }) {
  const meta = WORKFLOW_NODE_META[node.type];
  const executionMode = node.type === "loomAgent" ? node.config?.executionMode ?? "background" : null;
  return (
    <article
      className={`${styles.node} ${selected ? styles.selectedNode : ""}`}
      data-tone={meta.tone}
      data-status={runState?.status ?? "idle"}
      data-workflow-node="true"
      style={{
        width: WORKFLOW_NODE_WIDTH,
        height: WORKFLOW_NODE_HEIGHT,
        transform: `translate(${node.position.x}px, ${node.position.y}px)`
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target.closest("button, input, textarea, select")) return;
        onSelect();
        onDragStart(event);
      }}
      onClick={onSelect}
      role="group"
      aria-label={`${meta.label}: ${node.name}`}
    >
      {meta.hasInput && (
        <button
          type="button"
          className={`${styles.port} ${styles.inputPort} ${connecting ? styles.connectingPort : ""}`}
          aria-label={`Connect into ${node.name}`}
          title={connecting ? `Connect to ${node.name}` : "Input"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onFinishConnection();
          }}
        />
      )}
      <span className={styles.nodeIcon}>{nodeIcon(node.type)}</span>
      <span className={styles.nodeCopy}>
        <small>{meta.label}</small>
        <em>{meta.action}</em>
        <strong>{node.name}</strong>
      </span>
      {executionMode && (
        <span className={styles.nodeModeBadge} data-mode={executionMode}>
          {executionMode === "foreground" ? "Foreground thread" : "Background"}
        </span>
      )}
      {runState?.status && (
        <span className={styles.nodeRunState} title={runState.error || workflowStatusLabel(runState.status)}>
          {runStatusIcon(runState.status)}
        </span>
      )}
      {meta.hasOutput && (
        <button
          type="button"
          className={`${styles.port} ${styles.outputPort} ${connecting ? styles.activePort : ""}`}
          aria-label={`Connect from ${node.name}`}
          title="Output"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onStartConnection();
          }}
        />
      )}
    </article>
  );
}

function NodeInspector({ node, models, onUpdate, onDelete, onClose }) {
  const selectedModel = models.find((model) => model.model === node.config?.model || model.id === node.config?.model);
  const efforts = selectedModel?.supportedReasoningEfforts?.map((option) => option.reasoningEffort ?? option.effort ?? option) ?? ["low", "medium", "high"];
  const updateConfig = (patch) => onUpdate({ config: { ...(node.config ?? {}), ...patch } });
  const executionMode = node.config?.executionMode ?? "background";

  return (
    <aside className={styles.inspector} aria-label="Workflow node inspector">
      <header className={styles.inspectorHeader}>
        <span className={styles.inspectorGlyph} data-tone={WORKFLOW_NODE_META[node.type].tone}>{nodeIcon(node.type, 17)}</span>
        <span><small>{WORKFLOW_NODE_META[node.type].label}</small><strong>{node.name}</strong></span>
        <IconButton label="Close node inspector" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className={styles.inspectorBody}>
        <label className={styles.field}>
          <span>Name</span>
          <input value={node.name} maxLength={160} onChange={(event) => onUpdate({ name: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <textarea value={node.description ?? ""} maxLength={2000} rows={3} onChange={(event) => onUpdate({ description: event.target.value })} />
        </label>
        {node.type === "loomAgent" && (
          <>
            <div className={styles.field}>
              <span>Run agent as</span>
              <div className={styles.executionModePicker} role="radiogroup" aria-label="Agent execution mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={executionMode === "background"}
                  data-selected={executionMode === "background"}
                  onClick={() => updateConfig({ executionMode: "background" })}
                >
                  <Brain size={16} />
                  <span><strong>Background</strong><small>Stay inside the workflow and source task.</small></span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={executionMode === "foreground"}
                  data-selected={executionMode === "foreground"}
                  onClick={() => updateConfig({ executionMode: "foreground" })}
                >
                  <Eye size={16} />
                  <span><strong>Foreground</strong><small>Create a normal Loom task thread.</small></span>
                </button>
              </div>
              <small>Both modes return their final answer to downstream nodes. Foreground threads also appear in Loom’s task list so you can steer or inspect them directly.</small>
            </div>
            <label className={styles.field}>
              <span>Agent prompt</span>
              <textarea value={String(node.config?.prompt ?? "")} rows={7} onChange={(event) => updateConfig({ prompt: event.target.value })} />
              <small>Incoming node values are appended as structured workflow context.</small>
            </label>
            <label className={styles.field}>
              <span>Model</span>
              <select value={String(node.config?.model ?? "")} onChange={(event) => updateConfig({ model: event.target.value || null, effort: null })}>
                <option value="">Project default</option>
                {models.map((model) => <option value={model.model} key={model.id ?? model.model}>{model.displayName ?? model.model}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>Reasoning effort</span>
              <select value={String(node.config?.effort ?? "")} onChange={(event) => updateConfig({ effort: event.target.value || null })}>
                <option value="">Model default</option>
                {efforts.map((effort) => <option value={effort} key={effort}>{String(effort).replace(/^./, (letter) => letter.toUpperCase())}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>Permissions</span>
              <select value={String(node.config?.permissionMode ?? "workspace-write")} onChange={(event) => updateConfig({ permissionMode: event.target.value })}>
                {PERMISSIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <footer className={styles.inspectorFooter}>
        <button type="button" className={styles.dangerButton} onClick={onDelete}><Trash size={14} />Delete node</button>
      </footer>
    </aside>
  );
}

function WorkflowInspector({ workflow, onChange, onClose }) {
  return (
    <aside className={styles.inspector} aria-label="Workflow inspector">
      <header className={styles.inspectorHeader}>
        <span className={styles.inspectorGlyph} data-tone="neutral"><Sparkle size={17} /></span>
        <span><small>Workflow</small><strong>{workflow.name}</strong></span>
        <IconButton label="Close workflow inspector" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className={styles.inspectorBody}>
        <label className={styles.field}>
          <span>Name</span>
          <input value={workflow.name} maxLength={240} onChange={(event) => onChange({ ...workflow, name: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <textarea value={workflow.description ?? ""} maxLength={10000} rows={6} onChange={(event) => onChange({ ...workflow, description: event.target.value })} />
        </label>
        <div className={styles.workflowFacts}>
          <span><strong>{workflow.graph.nodes.length}</strong><small>nodes</small></span>
          <span><strong>{workflow.graph.edges.length}</strong><small>connections</small></span>
        </div>
      </div>
    </aside>
  );
}

function RunPopover({ value, error, onChange, onRun, onClose }) {
  return (
    <div className={styles.runPopover} role="dialog" aria-label="Run workflow">
      <header><span><strong>Run workflow</strong><small>Supply a JSON value to every Manual Trigger node.</small></span><IconButton label="Close run options" onClick={onClose}><X size={13} /></IconButton></header>
      <textarea aria-label="Workflow input JSON" rows={8} value={value} onChange={(event) => onChange(event.target.value)} spellCheck="false" />
      {error && <p><Warning size={13} />{error}</p>}
      <button type="button" className={styles.primaryButton} onClick={onRun}><PaperPlaneTilt size={14} />Start run</button>
    </div>
  );
}

export function WorkflowCanvas({ workflow, models = [], run = null, savingState = "saved", compact = false, onChange, onRun, onCancel }) {
  const canvasRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 700 });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [connectingFrom, setConnectingFrom] = useState(null);
  const [connectionPointer, setConnectionPointer] = useState(null);
  const [drag, setDrag] = useState(null);
  const [pan, setPan] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(!compact);
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState("{}");
  const [runError, setRunError] = useState("");
  const graph = workflow.graph;
  const viewport = graph.viewport ?? { x: 0, y: 0, zoom: 1 };
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const activeRun = ACTIVE_RUN_STATUSES.has(run?.status);

  const changeGraph = useCallback((updater) => {
    const nextGraph = typeof updater === "function" ? updater(workflow.graph) : updater;
    onChange({ ...workflow, graph: nextGraph });
  }, [onChange, workflow]);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return undefined;
    const measure = () => setCanvasSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (selectedNodeId && !nodesById.has(selectedNodeId)) setSelectedNodeId(null);
  }, [nodesById, selectedNodeId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.target.closest?.("input, textarea, select")) return;
      if (event.key === "Escape") {
        setConnectingFrom(null);
        setSelectedEdgeId(null);
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      if (selectedNodeId) {
        event.preventDefault();
        changeGraph((current) => ({
          ...current,
          nodes: current.nodes.filter((node) => node.id !== selectedNodeId),
          edges: current.edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId)
        }));
        setSelectedNodeId(null);
      } else if (selectedEdgeId) {
        event.preventDefault();
        changeGraph((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== selectedEdgeId) }));
        setSelectedEdgeId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeGraph, selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    if (!drag && !pan) return undefined;
    const move = (event) => {
      if (drag) {
        const dx = (event.clientX - drag.startClient.x) / viewport.zoom;
        const dy = (event.clientY - drag.startClient.y) / viewport.zoom;
        changeGraph((current) => ({
          ...current,
          nodes: current.nodes.map((node) => node.id === drag.nodeId
            ? { ...node, position: { x: Math.round(drag.startPosition.x + dx), y: Math.round(drag.startPosition.y + dy) } }
            : node)
        }));
      }
      if (pan) {
        changeGraph((current) => ({
          ...current,
          viewport: {
            ...current.viewport,
            x: pan.startViewport.x + event.clientX - pan.startClient.x,
            y: pan.startViewport.y + event.clientY - pan.startClient.y
          }
        }));
      }
    };
    const stop = () => {
      setDrag(null);
      setPan(null);
      document.body.classList.remove(styles.draggingBody);
    };
    document.body.classList.add(styles.draggingBody);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      document.body.classList.remove(styles.draggingBody);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [changeGraph, drag, pan, viewport.zoom]);

  const clientToWorld = useCallback((clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom
    };
  }, [viewport]);

  const addNode = (type) => {
    const node = createWorkflowNode(type, nextNodePosition(graph, viewport, canvasSize));
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
  };

  const updateNode = (nodeId, patch) => {
    changeGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node)
    }));
  };

  const deleteNode = (nodeId) => {
    changeGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
    }));
    setSelectedNodeId(null);
  };

  const finishConnection = (targetId) => {
    if (!connectingFrom || connectingFrom === targetId) {
      setConnectingFrom(null);
      return;
    }
    const duplicate = graph.edges.some((edge) => edge.source === connectingFrom && edge.target === targetId);
    if (!duplicate) changeGraph((current) => ({ ...current, edges: [...current.edges, createWorkflowEdge(connectingFrom, targetId)] }));
    setConnectingFrom(null);
    setConnectionPointer(null);
  };

  const fitView = () => {
    changeGraph((current) => ({ ...current, viewport: fitWorkflowViewport(current, canvasSize.width, canvasSize.height, compact ? 44 : 84) }));
  };

  const zoomBy = (factor, anchor = { x: canvasSize.width / 2, y: canvasSize.height / 2 }) => {
    const nextZoom = Math.max(0.2, Math.min(3, viewport.zoom * factor));
    const worldX = (anchor.x - viewport.x) / viewport.zoom;
    const worldY = (anchor.y - viewport.y) / viewport.zoom;
    changeGraph((current) => ({
      ...current,
      viewport: {
        x: anchor.x - worldX * nextZoom,
        y: anchor.y - worldY * nextZoom,
        zoom: nextZoom
      }
    }));
  };

  const startRun = () => {
    try {
      const input = parseWorkflowInput(runInput);
      setRunError("");
      setRunOpen(false);
      onRun(input);
    } catch (error) {
      setRunError(error.message);
    }
  };

  const connectionPath = connectingFrom && nodesById.get(connectingFrom) && connectionPointer
    ? (() => {
        const source = nodePort(nodesById.get(connectingFrom), "output");
        const bend = Math.max(72, Math.abs(connectionPointer.x - source.x) * 0.48);
        return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${connectionPointer.x - bend} ${connectionPointer.y}, ${connectionPointer.x} ${connectionPointer.y}`;
      })()
    : null;

  return (
    <section className={`${styles.editor} ${compact ? styles.compactEditor : ""}`}>
      <header className={styles.canvasToolbar}>
        <div className={styles.nodePalette}>
          <span>Add</span>
          {Object.entries(WORKFLOW_NODE_META).map(([type, meta]) => (
            <button type="button" data-tone={meta.tone} onClick={() => addNode(type)} key={type}>
              {nodeIcon(type, 14)}<span>{meta.label}</span>
            </button>
          ))}
        </div>
        <div className={styles.canvasToolbarCenter}>
          <span className={styles.saveState} data-state={savingState}>
            {savingState === "saving" ? <SpinnerGap className={styles.spin} size={13} /> : savingState === "error" ? <Warning size={13} /> : <Check size={13} />}
            {savingState === "saving" ? "Saving" : savingState === "error" ? "Save failed" : "Saved"}
          </span>
          {run && <span className={styles.runBadge} data-status={run.status}>{runStatusIcon(run.status)}{workflowStatusLabel(run.status)}</span>}
        </div>
        <div className={styles.canvasActions}>
          <IconButton label="Zoom out" onClick={() => zoomBy(0.86)}>−</IconButton>
          <button type="button" className={styles.zoomReadout} onClick={fitView}>{Math.round(viewport.zoom * 100)}%</button>
          <IconButton label="Zoom in" onClick={() => zoomBy(1.16)}>+</IconButton>
          <button type="button" className={styles.secondaryButton} onClick={() => {
            setSelectedNodeId(null);
            setInspectorOpen((open) => !open);
          }}><Eye size={14} />Inspect</button>
          {activeRun ? (
            <button type="button" className={styles.stopButton} disabled={run.status === "cancelling"} onClick={() => onCancel(run.id)}><Pause size={14} />{run.status === "cancelling" ? "Stopping" : "Stop"}</button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={() => setRunOpen((open) => !open)}><PaperPlaneTilt size={14} />Run</button>
          )}
        </div>
        {runOpen && <RunPopover value={runInput} error={runError} onChange={setRunInput} onRun={startRun} onClose={() => setRunOpen(false)} />}
      </header>

      <div className={styles.canvasShell}>
        <div
          className={styles.canvas}
          ref={canvasRef}
          data-connecting={Boolean(connectingFrom)}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target.closest("[data-workflow-node], [data-workflow-edge], button, input, textarea, select")) return;
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
            setPan({ startClient: { x: event.clientX, y: event.clientY }, startViewport: viewport });
          }}
          onPointerMove={(event) => {
            if (connectingFrom) setConnectionPointer(clientToWorld(event.clientX, event.clientY));
          }}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const rect = canvasRef.current.getBoundingClientRect();
            zoomBy(event.deltaY > 0 ? 0.92 : 1.08, { x: event.clientX - rect.left, y: event.clientY - rect.top });
          }}
          onDoubleClick={(event) => {
            if (event.target.closest("[data-workflow-node], [data-workflow-edge]")) return;
            const position = clientToWorld(event.clientX, event.clientY);
            const node = createWorkflowNode("loomAgent", { x: position.x - WORKFLOW_NODE_WIDTH / 2, y: position.y - WORKFLOW_NODE_HEIGHT / 2 });
            changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
            setSelectedNodeId(node.id);
            setInspectorOpen(true);
          }}
        >
          <div
            className={styles.world}
            style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
          >
            <svg className={styles.edgeLayer} width="4000" height="2600" viewBox="-1000 -650 5000 3300" aria-hidden="true">
              {graph.edges.map((edge) => {
                const source = nodesById.get(edge.source);
                const target = nodesById.get(edge.target);
                if (!source || !target) return null;
                const tone = WORKFLOW_NODE_META[source.type]?.tone ?? "neutral";
                return (
                  <path
                    key={edge.id}
                    d={workflowEdgePath(source, target)}
                    className={`${styles.edge} ${edge.id === selectedEdgeId ? styles.selectedEdge : ""}`}
                    data-tone={tone}
                    data-workflow-edge="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedEdgeId(edge.id);
                      setSelectedNodeId(null);
                    }}
                  />
                );
              })}
              {connectionPath && <path d={connectionPath} className={`${styles.edge} ${styles.pendingEdge}`} data-tone={WORKFLOW_NODE_META[nodesById.get(connectingFrom)?.type]?.tone ?? "neutral"} />}
            </svg>
            {graph.nodes.map((node) => (
              <WorkflowNode
                key={node.id}
                node={node}
                selected={node.id === selectedNodeId}
                connecting={connectingFrom === node.id}
                runState={run?.nodeRuns?.[node.id]}
                onSelect={() => {
                  setSelectedNodeId(node.id);
                  setSelectedEdgeId(null);
                  setInspectorOpen(true);
                }}
                onDragStart={(event) => setDrag({
                  nodeId: node.id,
                  startClient: { x: event.clientX, y: event.clientY },
                  startPosition: node.position
                })}
                onStartConnection={() => {
                  setConnectingFrom((current) => current === node.id ? null : node.id);
                  setSelectedNodeId(node.id);
                }}
                onFinishConnection={() => finishConnection(node.id)}
              />
            ))}
          </div>
          {graph.nodes.length === 0 && (
            <div className={styles.emptyCanvas}>
              <span><Plus size={22} /></span>
              <strong>Build your first workflow</strong>
              <small>Add a trigger, a Loom Agent, and an output—or double-click the canvas to add an agent.</small>
              <button type="button" className={styles.primaryButton} onClick={() => addNode("manualTrigger")}><Lightning size={14} />Add trigger</button>
            </div>
          )}
          {connectingFrom && <div className={styles.connectionHint}><Circle size={11} />Choose an input port · Esc to cancel</div>}
        </div>

        {inspectorOpen && selectedNode && (
          <NodeInspector
            node={selectedNode}
            models={models}
            onUpdate={(patch) => updateNode(selectedNode.id, patch)}
            onDelete={() => deleteNode(selectedNode.id)}
            onClose={() => setInspectorOpen(false)}
          />
        )}
        {inspectorOpen && !selectedNode && <WorkflowInspector workflow={workflow} onChange={onChange} onClose={() => setInspectorOpen(false)} />}
      </div>

      {run && !activeRun && (run.output !== null || run.error) && (
        <footer className={styles.runResult} data-status={run.status}>
          <span>{run.status === "completed" ? <CheckCircle size={15} /> : <Warning size={15} />}<strong>{workflowStatusLabel(run.status)}</strong></span>
          <pre>{run.error || stringifyWorkflowValue(run.output) || "Workflow completed without an output value."}</pre>
        </footer>
      )}
    </section>
  );
}
