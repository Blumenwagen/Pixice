import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle,
  Circle,
  Eye,
  MagnifyingGlass,
  PaperPlaneTilt,
  Pause,
  Plus,
  Sparkle,
  SpinnerGap,
  Warning,
  X
} from "../icons/index.jsx";
import { WorkflowNodeIcon } from "./workflow-icons.jsx";
import { WorkflowNodeInspector } from "./WorkflowNodeInspector.jsx";
import workspaceStyles from "./WorkflowWorkspace.module.css";
import nodeStyles from "./WorkflowNodes.module.css";
import {
  WORKFLOW_NODE_CATEGORIES,
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
  workflowInputPorts,
  workflowNodeHeight,
  workflowOutputPorts,
  workflowStatusLabel
} from "./workflow-utils.js";

const styles = { ...workspaceStyles, ...nodeStyles };
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancelling"]);

function IconButton({ label, className = "", children, ...props }) {
  return <button type="button" className={`${styles.iconButton} ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function runStatusIcon(status) {
  if (status === "running" || status === "queued") return <SpinnerGap className={styles.spin} size={12} />;
  if (status === "completed") return <CheckCircle size={12} />;
  if (status === "failed") return <Warning size={12} />;
  if (status === "cancelled" || status === "cancelling") return <Pause size={12} />;
  if (status === "skipped") return <Circle size={12} />;
  return null;
}

function Port({ node, port, side, connecting, onActivate }) {
  const position = nodePort(node, side, port.id);
  const top = position.y - node.position.y;
  const active = side === "output" && connecting?.nodeId === node.id && connecting?.portId === port.id;
  return (
    <span
      className={`${styles.portGroup} ${side === "input" ? styles.inputPortGroup : styles.outputPortGroup}`}
      style={{ top }}
      data-port-id={port.id}
    >
      {side === "output" && <small className={styles.portLabel}>{port.label}</small>}
      <button
        type="button"
        className={`${styles.port} ${side === "input" ? styles.inputPort : styles.outputPort} ${active ? styles.activePort : ""} ${side === "input" && connecting ? styles.connectingPort : ""}`}
        aria-label={`${side === "input" ? "Connect into" : "Connect from"} ${node.name} · ${port.label}`}
        title={port.label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onActivate(port.id);
        }}
      />
    </span>
  );
}

function WorkflowNode({ node, selected, connecting, runState, onSelect, onDragStart, onStartConnection, onFinishConnection }) {
  const meta = WORKFLOW_NODE_META[node.type];
  const executionMode = node.type === "loomAgent" ? node.config?.executionMode ?? "background" : null;
  const inputPorts = workflowInputPorts(node);
  const outputPorts = workflowOutputPorts(node);
  return (
    <article
      className={`${styles.node} ${styles.nodeExtension} ${selected ? styles.selectedNode : ""}`}
      data-tone={meta.tone}
      data-status={runState?.status ?? "idle"}
      data-workflow-node="true"
      style={{
        width: WORKFLOW_NODE_WIDTH,
        height: workflowNodeHeight(node),
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
      {inputPorts.map((port) => (
        <Port key={port.id} node={node} port={port} side="input" connecting={connecting} onActivate={(portId) => onFinishConnection(portId)} />
      ))}
      <span className={styles.nodeIcon}><WorkflowNodeIcon type={node.type} /></span>
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
        <span className={styles.nodeRunState} title={runState.error || runState.skipReason || workflowStatusLabel(runState.status)}>
          {runStatusIcon(runState.status)}
        </span>
      )}
      {outputPorts.map((port) => (
        <Port key={port.id} node={node} port={port} side="output" connecting={connecting} onActivate={(portId) => onStartConnection(portId)} />
      ))}
    </article>
  );
}

function NodePicker({ query, onQueryChange, onAdd, onClose }) {
  const needle = query.trim().toLowerCase();
  const entries = Object.entries(WORKFLOW_NODE_META).filter(([_type, meta]) => (
    !needle || `${meta.label} ${meta.action} ${meta.category} ${meta.defaultDescription}`.toLowerCase().includes(needle)
  ));
  return (
    <div className={styles.nodePicker} role="dialog" aria-label="Add workflow node">
      <header>
        <span><strong>Add node</strong><small>Native building blocks for useful Loom automations.</small></span>
        <IconButton label="Close node picker" onClick={onClose}><X size={13} /></IconButton>
      </header>
      <label className={styles.nodePickerSearch}>
        <MagnifyingGlass size={14} />
        <input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search actions, data, flow…" />
      </label>
      <div className={styles.nodePickerBody}>
        {WORKFLOW_NODE_CATEGORIES.map((category) => {
          const nodes = entries.filter(([_type, meta]) => meta.category === category);
          if (!nodes.length) return null;
          return (
            <section className={styles.nodePickerGroup} key={category}>
              <h3>{category}</h3>
              <div>
                {nodes.map(([type, meta]) => (
                  <button type="button" data-tone={meta.tone} onClick={() => onAdd(type)} key={type}>
                    <span><WorkflowNodeIcon type={type} size={16} /></span>
                    <span><strong>{meta.label}</strong><small>{meta.action}</small></span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!entries.length && <p className={styles.nodePickerEmpty}>No matching nodes.</p>}
      </div>
    </div>
  );
}

function WorkflowInspector({ workflow, onChange, onClose }) {
  const automaticTriggerCount = workflow.graph.nodes.filter((node) => node.type === "scheduleTrigger" || node.type === "webhookTrigger").length;
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
        <label className={styles.toggleField}>
          <input type="checkbox" checked={Boolean(workflow.enabled)} onChange={(event) => onChange({ ...workflow, enabled: event.target.checked })} />
          <span>
            <strong>Enable automatic triggers</strong>
            <small>{automaticTriggerCount ? `${automaticTriggerCount} Schedule or Webhook trigger${automaticTriggerCount === 1 ? "" : "s"} will be hosted while Loom is running.` : "Add a Schedule or Local Webhook node before enabling this workflow."}</small>
          </span>
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
      <header><span><strong>Test workflow</strong><small>Supply a JSON value to the Manual Trigger, or the first trigger when no Manual Trigger exists.</small></span><IconButton label="Close run options" onClick={onClose}><X size={13} /></IconButton></header>
      <textarea aria-label="Workflow input JSON" rows={8} value={value} onChange={(event) => onChange(event.target.value)} spellCheck="false" />
      {error && <p><Warning size={13} />{error}</p>}
      <button type="button" className={styles.primaryButton} onClick={onRun}><PaperPlaneTilt size={14} />Start run</button>
    </div>
  );
}

export function WorkflowCanvas({
  workflow,
  models = [],
  workflows = [],
  api = globalThis.loom ?? null,
  run = null,
  savingState = "saved",
  compact = false,
  onChange,
  onRun,
  onCancel
}) {
  const canvasRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 700 });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [connectingFrom, setConnectingFrom] = useState(null);
  const [connectionPointer, setConnectionPointer] = useState(null);
  const [drag, setDrag] = useState(null);
  const [pan, setPan] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(!compact);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [nodeQuery, setNodeQuery] = useState("");
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
        setConnectionPointer(null);
        setSelectedEdgeId(null);
        setNodePickerOpen(false);
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

  const addNode = (type, position = nextNodePosition(graph, viewport, canvasSize)) => {
    const node = createWorkflowNode(type, position);
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
    setNodePickerOpen(false);
    setNodeQuery("");
  };

  const updateNode = (nodeId, patch) => {
    changeGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
      edges: current.edges.filter((edge) => {
        if (edge.source !== nodeId) return true;
        const nextNode = current.nodes.find((candidate) => candidate.id === nodeId);
        const updatedNode = nextNode ? { ...nextNode, ...patch } : null;
        return updatedNode ? workflowOutputPorts(updatedNode).some((port) => port.id === edge.sourcePort) : false;
      })
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

  const finishConnection = (targetId, targetPort) => {
    if (!connectingFrom || connectingFrom.nodeId === targetId) {
      setConnectingFrom(null);
      setConnectionPointer(null);
      return;
    }
    const duplicate = graph.edges.some((edge) => edge.source === connectingFrom.nodeId
      && edge.target === targetId
      && edge.sourcePort === connectingFrom.portId
      && edge.targetPort === targetPort);
    if (!duplicate) {
      changeGraph((current) => ({
        ...current,
        edges: [...current.edges, createWorkflowEdge(connectingFrom.nodeId, targetId, connectingFrom.portId, targetPort)]
      }));
    }
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

  const connectionPath = connectingFrom && nodesById.get(connectingFrom.nodeId) && connectionPointer
    ? (() => {
        const source = nodePort(nodesById.get(connectingFrom.nodeId), "output", connectingFrom.portId);
        const bend = Math.max(72, Math.abs(connectionPointer.x - source.x) * 0.48);
        return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${connectionPointer.x - bend} ${connectionPointer.y}, ${connectionPointer.x} ${connectionPointer.y}`;
      })()
    : null;

  return (
    <section className={`${styles.editor} ${compact ? styles.compactEditor : ""}`}>
      <header className={styles.canvasToolbar}>
        <div className={styles.nodePalette}>
          <button type="button" className={styles.addNodeButton} onClick={() => setNodePickerOpen((open) => !open)}><Plus size={14} /><span>Add node</span></button>
          <small className={styles.paletteMeta}>{graph.nodes.length} nodes · {graph.edges.length} connections</small>
        </div>
        <div className={styles.canvasToolbarCenter}>
          <span className={styles.saveState} data-state={savingState}>
            {savingState === "saving" ? <SpinnerGap className={styles.spin} size={13} /> : savingState === "error" ? <Warning size={13} /> : <Check size={13} />}
            {savingState === "saving" ? "Saving" : savingState === "error" ? "Save failed" : "Saved"}
          </span>
          {workflow.enabled && <span className={styles.runBadge} data-status="completed"><Circle size={11} />Automatic</span>}
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
        {nodePickerOpen && <NodePicker query={nodeQuery} onQueryChange={setNodeQuery} onAdd={addNode} onClose={() => setNodePickerOpen(false)} />}
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
            setNodePickerOpen(false);
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
            addNode("loomAgent", { x: position.x - WORKFLOW_NODE_WIDTH / 2, y: position.y - 56 });
          }}
        >
          <div className={styles.world} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
            <svg className={styles.edgeLayer} width="4000" height="2600" viewBox="-1000 -650 5000 3300" aria-hidden="true">
              {graph.edges.map((edge) => {
                const source = nodesById.get(edge.source);
                const target = nodesById.get(edge.target);
                if (!source || !target) return null;
                const tone = WORKFLOW_NODE_META[source.type]?.tone ?? "neutral";
                return (
                  <path
                    key={edge.id}
                    d={workflowEdgePath(source, target, edge.sourcePort, edge.targetPort)}
                    className={`${styles.edge} ${styles.edgeTone} ${edge.id === selectedEdgeId ? styles.selectedEdge : ""}`}
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
              {connectionPath && <path d={connectionPath} className={`${styles.edge} ${styles.edgeTone} ${styles.pendingEdge}`} data-tone={WORKFLOW_NODE_META[nodesById.get(connectingFrom?.nodeId)?.type]?.tone ?? "neutral"} />}
            </svg>
            {graph.nodes.map((node) => (
              <WorkflowNode
                key={node.id}
                node={node}
                selected={node.id === selectedNodeId}
                connecting={connectingFrom}
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
                onStartConnection={(portId) => {
                  setConnectingFrom((current) => current?.nodeId === node.id && current?.portId === portId ? null : { nodeId: node.id, portId });
                  setSelectedNodeId(node.id);
                }}
                onFinishConnection={(portId) => finishConnection(node.id, portId)}
              />
            ))}
          </div>
          {graph.nodes.length === 0 && (
            <div className={styles.emptyCanvas}>
              <span><Plus size={22} /></span>
              <strong>Build your first useful workflow</strong>
              <small>Trigger on time or local webhooks, call APIs, aggregate data, query SQLite, loop through subworkflows, notify yourself, inspect Git, manage files or board tasks, and hand ambiguous work to Loom Agents.</small>
              <button type="button" className={styles.primaryButton} onClick={() => setNodePickerOpen(true)}><Plus size={14} />Browse nodes</button>
            </div>
          )}
          {connectingFrom && <div className={styles.connectionHint}><Circle size={11} />Choose an input port · Esc to cancel</div>}
        </div>

        {inspectorOpen && selectedNode && (
          <WorkflowNodeInspector
            node={selectedNode}
            models={models}
            api={api}
            projectId={workflow.projectId}
            workflows={workflows}
            currentWorkflowId={workflow.id}
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
