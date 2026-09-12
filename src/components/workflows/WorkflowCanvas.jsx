import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Check,
  CheckCircle,
  CaretRight,
  Circle,
  MagnifyingGlass,
  PaperPlaneTilt,
  Pause,
  Plus,
  Sparkle,
  SpinnerGap,
  Trash,
  TreeStructure,
  Warning,
  X
} from "../icons/index.jsx";
import { WorkflowNodeIcon } from "./workflow-icons.jsx";
import { WorkflowNodeInspector } from "./WorkflowNodeInspector.jsx";
import { WorkflowSkillInspector } from "./WorkflowSkillInspector.jsx";
import workspaceStyles from "./WorkflowWorkspace.module.css";
import nodeStyles from "./WorkflowNodes.module.css";
import {
  WORKFLOW_NODE_CATEGORIES,
  WORKFLOW_NODE_META,
  WORKFLOW_NODE_WIDTH,
  createWorkflowEdge,
  createWorkflowNode,
  nextNodePosition,
  nodePort,
  parseWorkflowInput,
  stringifyWorkflowValue,
  workflowCanConnect,
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

const NODE_TONES = {
  violet: "#ff5364",
  orange: "#ff5364",
  blue: "#58a99a",
  pink: "#ef6b72",
  yellow: "#d3a949",
  green: "#4fa58e",
  neutral: "#9b9389"
};

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
      <small className={styles.portLabel}>{port.label}</small>
      <Handle
        id={port.id}
        type={side === "input" ? "target" : "source"}
        position={side === "input" ? Position.Left : Position.Right}
        className={`${styles.port} ${side === "input" ? styles.inputPort : styles.outputPort} ${active ? styles.activePort : ""} ${side === "input" && connecting ? styles.connectingPort : ""}`}
        aria-label={`${side === "input" ? "Connect into" : "Connect from"} ${node.name} · ${port.label}`}
        title={port.label}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          onActivate(port.id);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onActivate(port.id);
        }}
      />
    </span>
  );
}

function WorkflowNode({ data, selected }) {
  const { node, connecting, runState, onStartConnection, onFinishConnection } = data;
  const meta = WORKFLOW_NODE_META[node.type];
  const executionMode = node.type === "pixiceAgent" ? node.config?.executionMode ?? "background" : null;
  const inputPorts = workflowInputPorts(node);
  const outputPorts = workflowOutputPorts(node);
  return (
    <article
      className={`${styles.node} ${styles.nodeExtension} ${selected ? styles.selectedNode : ""}`}
      data-tone={meta.tone}
      data-status={runState?.status ?? "idle"}
      data-selected={selected}
      data-workflow-node="true"
      style={{
        width: WORKFLOW_NODE_WIDTH,
        height: workflowNodeHeight(node)
      }}
      aria-hidden="true"
    >
      {inputPorts.map((port) => (
        <Port key={port.id} node={node} port={port} side="input" connecting={connecting} onActivate={(portId) => onFinishConnection(portId)} />
      ))}
      <header className={styles.nodeHeader}>
        <span className={styles.nodeIcon}><WorkflowNodeIcon type={node.type} /></span>
        <span className={styles.nodeCopy}>
          <strong>{node.name}</strong>
          <small>{meta.action}</small>
        </span>
        <span className={styles.nodeRunState} data-status={runState?.status ?? "idle"} title={runState?.error || runState?.skipReason || workflowStatusLabel(runState?.status ?? "idle")}>
          {runState?.status ? runStatusIcon(runState.status) : <Circle size={9} />}
        </span>
      </header>
      <p className={styles.nodeSummary}>{node.description || meta.defaultDescription}</p>
      <footer className={styles.nodeFooter}>
        <span>{meta.label}</span>
        {executionMode && (
          <span className={styles.nodeModeBadge} data-mode={executionMode}>
            {executionMode === "foreground" ? "Foreground thread" : "Background"}
          </span>
        )}
      </footer>
      {outputPorts.map((port) => (
        <Port key={port.id} node={node} port={port} side="output" connecting={connecting} onActivate={(portId) => onStartConnection(portId)} />
      ))}
    </article>
  );
}

const NODE_TYPES = { workflowNode: WorkflowNode };
const DEFAULT_EDGE_OPTIONS = { type: "bezier" };
const CONNECTION_LINE_STYLE = { stroke: "#ff5364", strokeWidth: 2 };
const REACT_FLOW_OPTIONS = { hideAttribution: true };

function layoutWorkflowNodes(graph) {
  const nodes = graph.nodes ?? [];
  if (!nodes.length) return nodes;
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges ?? []) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }

  const levels = new Map();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  if (!queue.length) queue.push(nodes[0].id);
  queue.forEach((id) => levels.set(id, 0));
  for (let index = 0; index < queue.length; index += 1) {
    const sourceId = queue[index];
    const sourceLevel = levels.get(sourceId) ?? 0;
    for (const targetId of outgoing.get(sourceId) ?? []) {
      levels.set(targetId, Math.max(levels.get(targetId) ?? 0, sourceLevel + 1));
      indegree.set(targetId, indegree.get(targetId) - 1);
      if (indegree.get(targetId) === 0) queue.push(targetId);
    }
  }

  let fallbackLevel = Math.max(0, ...levels.values());
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, fallbackLevel += 1);
  }
  const columns = new Map();
  for (const node of nodes) {
    const level = levels.get(node.id);
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(node);
  }
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length));
  const rowGap = 168;
  return nodes.map((node) => {
    const level = levels.get(node.id);
    const column = columns.get(level);
    const row = column.findIndex((candidate) => candidate.id === node.id);
    const offset = (maxRows - column.length) * rowGap / 2;
    return { ...node, position: { x: 72 + level * 282, y: 64 + offset + row * rowGap } };
  });
}

function RunTimeline({ graph, run }) {
  if (!run) return null;
  return (
    <footer className={styles.runTimeline} data-status={run.status}>
      <span className={styles.runTimelineSummary}>
        <strong>Latest run</strong>
        <small>{run.status === "running" || run.status === "queued" ? "In progress" : workflowStatusLabel(run.status)}</small>
      </span>
      <div className={styles.runTimelineNodes} aria-label="Latest workflow run">
        {graph.nodes.map((node, index) => {
          const state = run.nodeRuns?.[node.id];
          return (
            <span className={styles.runTimelineStep} data-status={state?.status ?? "idle"} key={node.id}>
              {index > 0 && <CaretRight className={styles.runTimelineArrow} size={11} />}
              <span className={styles.runTimelinePill}>
                {state?.status ? runStatusIcon(state.status) : <Circle size={8} />}
                <span>{node.name}</span>
              </span>
            </span>
          );
        })}
      </div>
    </footer>
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
        <span><strong>Add node</strong><small>Native building blocks for useful Pixice automations.</small></span>
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

function WorkflowGenerationProgress({ generation, reducedMotion = false }) {
  const busy = ["saving", "generating", "applying"].includes(generation.state);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!busy) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, generation.startedAt]);

  const elapsed = generation.startedAt ? Math.max(0, Math.floor((now - generation.startedAt) / 1000)) : 0;
  return (
    <motion.div
      className={styles.generationOverlay}
      data-state={generation.state}
      role="status"
      aria-live="polite"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <motion.div
        className={styles.generationCard}
        initial={reducedMotion ? false : { opacity: 0, y: 8, filter: "blur(2px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className={styles.generationGlyph}>{busy ? <SpinnerGap className={styles.spin} size={18} /> : <Check size={18} />}</span>
        <span className={styles.generationCopy}>
          <strong>{busy ? "Agent is building this workflow" : "Workflow ready"}</strong>
          <small>{generation.message}</small>
        </span>
        {busy ? (
          <>
            <span className={styles.generationTrack}><i /></span>
            <small className={styles.generationElapsed}>{elapsed}s elapsed · The current canvas stays in place until the graph is valid.</small>
          </>
        ) : (
          <small className={styles.generationElapsed}>{generation.nodes} nodes · {generation.edges} connections{generation.model ? ` · ${generation.model}` : ""}</small>
        )}
      </motion.div>
    </motion.div>
  );
}

function WorkflowInspector({ workflow, generation, onChange, onGenerate, onClose }) {
  const automaticTriggerCount = workflow.graph.nodes.filter((node) => ["scheduleTrigger", "taskEventTrigger", "webhookTrigger"].includes(node.type)).length;
  const generationBusy = ["saving", "generating", "applying"].includes(generation?.state);
  const hasDescription = Boolean(String(workflow.description ?? "").trim());
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
          <input disabled={generationBusy} value={workflow.name} maxLength={240} onChange={(event) => onChange({ ...workflow, name: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <textarea autoFocus={!hasDescription} disabled={generationBusy} value={workflow.description ?? ""} maxLength={10000} rows={6} placeholder="Describe what should trigger the workflow, what it should do, and what result it should return." onChange={(event) => onChange({ ...workflow, description: event.target.value })} />
        </label>
        <section className={styles.generationAction} data-state={generation?.state ?? "idle"}>
          <span>
            <strong>{generationBusy ? "Generating workflow" : "Build from this description"}</strong>
            <small>{generation?.state === "error"
              ? generation.message
              : hasDescription
                ? "A background agent replaces the canvas only after Pixice validates the new graph."
                : "Write a description first. Include the trigger, the work to perform, and the desired output."}</small>
          </span>
          <button type="button" className={styles.generateButton} disabled={!onGenerate || generationBusy || !hasDescription} onClick={() => void onGenerate()}>
            {generationBusy ? <SpinnerGap className={styles.spin} size={14} /> : <Sparkle size={14} />}
            {generationBusy ? "Generating workflow…" : generation?.state === "error" ? "Try generation again" : "Generate workflow from description"}
          </button>
        </section>
        <label className={styles.toggleField}>
          <input disabled={generationBusy} type="checkbox" checked={Boolean(workflow.enabled)} onChange={(event) => onChange({ ...workflow, enabled: event.target.checked })} />
          <span>
            <strong>Enable automatic triggers</strong>
            <small>{automaticTriggerCount ? `${automaticTriggerCount} automatic trigger${automaticTriggerCount === 1 ? "" : "s"} will be hosted while Pixice is running.` : "Add a Schedule, Task Event, or Local Webhook node before enabling this workflow."}</small>
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
  api = globalThis.pixice ?? null,
  run = null,
  savingState = "saved",
  generation = { state: "idle" },
  compact = false,
  hostId = "local",
  previewWorkspaceId = null,
  onChange,
  onGenerate,
  onRun,
  onCancel,
  onDelete
}) {
  const systemReducedMotion = useReducedMotion();
  const canvasRef = useRef(null);
  const flowRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 700 });
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [connectingFrom, setConnectingFrom] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [nodeQuery, setNodeQuery] = useState("");
  const [runOpen, setRunOpen] = useState(false);
  const [runInput, setRunInput] = useState("{}");
  const [runError, setRunError] = useState("");
  const graph = workflow.graph;
  const viewport = graph.viewport ?? { x: 0, y: 0, zoom: 1 };
  const liveViewportRef = useRef(viewport);
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
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setConnectingFrom(null);
    setConnectionError("");
    setInspectorOpen(!String(workflow.description ?? "").trim());
    liveViewportRef.current = viewport;
    flowRef.current?.setViewport(viewport, { duration: 0 });
  }, [workflow.id]);

  useEffect(() => {
    if (selectedNodeId && !nodesById.has(selectedNodeId)) setSelectedNodeId(null);
  }, [nodesById, selectedNodeId]);

  useEffect(() => {
    if (!inspectorOpen || compact) return undefined;
    const timer = window.setTimeout(() => {
      void flowRef.current?.fitView({ padding: 0.16, duration: 220, maxZoom: 1 });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [compact, inspectorOpen]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.target.closest?.("input, textarea, select")) return;
      if (event.key === "Escape") {
        setConnectingFrom(null);
        setConnectionError("");
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

  const addNode = (type, position = nextNodePosition(graph, liveViewportRef.current, canvasSize)) => {
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

  const connectNodes = useCallback((sourceId, sourcePort, targetId, targetPort) => {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const sourceNode = nodesById.get(sourceId);
    const targetNode = nodesById.get(targetId);
    if (!workflowCanConnect(sourceNode, sourcePort, targetNode, targetPort)) {
      setConnectionError(sourceNode?.type === "useSkill" || sourcePort === "skill" || targetPort === "skill"
        ? "Use Skill nodes connect only from Skill to a Pixice Agent’s Skill input."
        : "These workflow ports cannot be connected.");
      return false;
    }
    const duplicate = graph.edges.some((edge) => edge.source === sourceId
      && edge.target === targetId
      && edge.sourcePort === sourcePort
      && edge.targetPort === targetPort);
    if (!duplicate) {
      changeGraph((current) => ({
        ...current,
        edges: [...current.edges, createWorkflowEdge(sourceId, targetId, sourcePort, targetPort)]
      }));
    }
    setConnectionError("");
    return true;
  }, [changeGraph, graph.edges, nodesById]);

  const finishConnection = (targetId, targetPort) => {
    if (!connectingFrom) return;
    if (connectNodes(connectingFrom.nodeId, connectingFrom.portId, targetId, targetPort)) setConnectingFrom(null);
  };

  const fitView = () => {
    void flowRef.current?.fitView({ padding: compact ? 0.12 : 0.2, duration: 280, maxZoom: 1.15 });
  };

  const autoLayout = () => {
    changeGraph((current) => ({ ...current, nodes: layoutWorkflowNodes(current) }));
    window.setTimeout(fitView, 40);
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

  const flowNodes = useMemo(() => graph.nodes.map((node) => ({
    id: node.id,
    type: "workflowNode",
    position: node.position,
    selected: node.id === selectedNodeId,
    draggable: true,
    data: {
      node,
      tone: WORKFLOW_NODE_META[node.type]?.tone ?? "neutral",
      connecting: connectingFrom,
      runState: run?.nodeRuns?.[node.id],
      onStartConnection: (portId) => {
        setConnectingFrom((current) => current?.nodeId === node.id && current?.portId === portId ? null : { nodeId: node.id, portId });
        setConnectionError("");
        setSelectedNodeId(node.id);
      },
      onFinishConnection: (portId) => finishConnection(node.id, portId)
    }
  })), [connectingFrom, graph.nodes, run?.nodeRuns, selectedNodeId]);

  const flowEdges = useMemo(() => graph.edges.map((edge) => {
    const sourceNode = nodesById.get(edge.source);
    const tone = WORKFLOW_NODE_META[sourceNode?.type]?.tone ?? "neutral";
    const sourcePorts = sourceNode ? workflowOutputPorts(sourceNode) : [];
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      selected: edge.id === selectedEdgeId,
      animated: run?.nodeRuns?.[edge.source]?.status === "running",
      type: "bezier",
      label: edge.id === selectedEdgeId && sourcePorts.length > 1 ? sourcePorts.find((port) => port.id === edge.sourcePort)?.label : undefined,
      labelStyle: { fill: "#b8ada0", fontSize: 10, fontWeight: 650 },
      labelBgStyle: { fill: "#24201c", fillOpacity: 0.96 },
      labelBgPadding: [7, 4],
      labelBgBorderRadius: 7,
      style: {
        stroke: NODE_TONES[tone],
        strokeWidth: edge.id === selectedEdgeId ? 2.4 : 1.45,
        opacity: edge.id === selectedEdgeId ? 1 : 0.66
      },
      interactionWidth: 20
    };
  }), [graph.edges, nodesById, run?.nodeRuns, selectedEdgeId]);

  const validConnection = useCallback((connection) => workflowCanConnect(
    nodesById.get(connection.source),
    connection.sourceHandle,
    nodesById.get(connection.target),
    connection.targetHandle
  ), [nodesById]);

  const runOutput = typeof run?.output === "string" ? run.output : stringifyWorkflowValue(run?.output);
  const runProposal = run?.output?.proposal ?? null;
  const openRunProposal = useCallback(() => {
    if (!previewWorkspaceId || !runProposal?.id) return;
    window.dispatchEvent(new CustomEvent("pixice:task-preview-requested", {
      detail: {
        hostId,
        projectId: workflow.projectId,
        proposalId: runProposal.id,
        workspaceId: previewWorkspaceId,
        threadId: previewWorkspaceId,
        reason: "workflow-plan",
        actorKind: "workflow",
        actorId: workflow.id
      }
    }));
  }, [hostId, previewWorkspaceId, runProposal?.id, workflow.id, workflow.projectId]);

  return (
    <section className={`${styles.editor} ${compact ? styles.compactEditor : ""}`}>
      <header className={styles.canvasToolbar}>
        <div className={styles.nodePalette}>
          <button type="button" className={styles.addNodeButton} onClick={() => setNodePickerOpen((open) => !open)}><Plus size={14} /><span>Add node</span></button>
          <small className={styles.paletteMeta}>{graph.nodes.length} nodes · {graph.edges.length} connections</small>
        </div>
        <div className={styles.canvasToolbarCenter}>
          <span className={styles.saveState} data-state={savingState}>
            <AnimatePresence initial={false} mode="wait">
              <motion.span className={styles.stateContent} key={savingState} initial={systemReducedMotion ? false : { opacity: 0, y: 2, scale: 0.88, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }} exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, y: -2, scale: 0.9, filter: "blur(2px)" }} transition={{ duration: systemReducedMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}>
                {savingState === "saving" ? <SpinnerGap className={styles.spin} size={13} /> : savingState === "error" ? <Warning size={13} /> : <Check size={13} />}
                {savingState === "saving" ? "Saving" : savingState === "error" ? "Save failed" : "Saved"}
              </motion.span>
            </AnimatePresence>
          </span>
          {workflow.enabled && <span className={styles.runBadge} data-status="completed"><Circle size={11} />Automatic</span>}
          <AnimatePresence initial={false} mode="wait">
            {run && <motion.span className={styles.runBadge} data-status={run.status} key={run.status} initial={systemReducedMotion ? false : { opacity: 0, scale: 0.88, filter: "blur(2px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={systemReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: "blur(2px)" }} transition={{ duration: systemReducedMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}>{runStatusIcon(run.status)}{workflowStatusLabel(run.status)}</motion.span>}
          </AnimatePresence>
        </div>
        <div className={styles.canvasActions}>
          <IconButton label="Workflow settings" className={styles.settingsButton} onClick={() => {
            setSelectedNodeId(null);
            setInspectorOpen((open) => !open);
          }}><Sparkle size={14} /></IconButton>
          <button type="button" className={styles.secondaryButton} onClick={autoLayout}><TreeStructure size={14} />Tidy</button>
          {onDelete && <IconButton label="Delete workflow" className={styles.deleteWorkflow} onClick={onDelete}><Trash size={14} /></IconButton>}
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
        <div className={styles.canvas} ref={canvasRef} data-connecting={Boolean(connectingFrom)}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            defaultViewport={viewport}
            minZoom={0.16}
            maxZoom={2}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            connectionLineType={ConnectionLineType.Bezier}
            connectionLineStyle={CONNECTION_LINE_STYLE}
            isValidConnection={validConnection}
            onInit={(instance) => {
              flowRef.current = instance;
              if (viewport.zoom < 0.42 || viewport.zoom > 1.5) {
                window.setTimeout(() => void instance.fitView({ padding: compact ? 0.12 : 0.18, duration: 0, maxZoom: 1 }), 0);
              }
            }}
            onMove={(_event, nextViewport) => { liveViewportRef.current = nextViewport; }}
            onMoveEnd={(_event, nextViewport) => {
              liveViewportRef.current = nextViewport;
              changeGraph((current) => ({ ...current, viewport: nextViewport }));
            }}
            onNodeClick={(_event, flowNode) => {
              setSelectedNodeId(flowNode.id);
              setSelectedEdgeId(null);
              setInspectorOpen(true);
            }}
            onNodeDragStop={(_event, flowNode) => {
              changeGraph((current) => ({
                ...current,
                nodes: current.nodes.map((node) => node.id === flowNode.id
                  ? { ...node, position: { x: Math.round(flowNode.position.x), y: Math.round(flowNode.position.y) } }
                  : node)
              }));
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              setNodePickerOpen(false);
              setInspectorOpen(false);
            }}
            onConnect={(connection) => {
              connectNodes(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
              setConnectingFrom(null);
            }}
            onConnectStart={(_event, params) => {
              if (params.handleType === "source") setConnectingFrom({ nodeId: params.nodeId, portId: params.handleId });
              setConnectionError("");
            }}
            onConnectEnd={() => setConnectingFrom(null)}
            deleteKeyCode={null}
            nodesFocusable
            edgesFocusable
            elevateEdgesOnSelect
            panOnDrag
            panOnScroll
            zoomOnPinch
            zoomOnScroll
            selectionOnDrag={false}
            proOptions={REACT_FLOW_OPTIONS}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.1} color="rgba(230,216,196,.095)" />
            <Controls position="bottom-left" />
            {!compact && (
              <MiniMap
                position="bottom-right"
                nodeColor={(flowNode) => NODE_TONES[flowNode.data.tone] ?? NODE_TONES.neutral}
                nodeStrokeWidth={2}
                maskColor="rgba(24, 21, 18, .74)"
                pannable
                zoomable
              />
            )}
          </ReactFlow>
          <div className={styles.accessibleGraph} aria-label="Workflow nodes">
            {graph.nodes.map((node) => (
              <div
                role="group"
                aria-label={`${WORKFLOW_NODE_META[node.type].label}: ${node.name}`}
                onClick={() => {
                  setSelectedNodeId(node.id);
                  setSelectedEdgeId(null);
                  setInspectorOpen(true);
                }}
                key={node.id}
              >
                {workflowInputPorts(node).map((port) => (
                  <button type="button" aria-label={`Connect into ${node.name} · ${port.label}`} onClick={(event) => {
                    event.stopPropagation();
                    finishConnection(node.id, port.id);
                  }} key={`input-${port.id}`} />
                ))}
                {workflowOutputPorts(node).map((port) => (
                  <button type="button" aria-label={`Connect from ${node.name} · ${port.label}`} onClick={(event) => {
                    event.stopPropagation();
                    setConnectingFrom((current) => current?.nodeId === node.id && current?.portId === port.id ? null : { nodeId: node.id, portId: port.id });
                    setConnectionError("");
                    setSelectedNodeId(node.id);
                  }} key={`output-${port.id}`} />
                ))}
              </div>
            ))}
          </div>
          {graph.nodes.length === 0 && (
            <div className={styles.emptyCanvas}>
              <span><Plus size={22} /></span>
              <strong>Build your first useful workflow</strong>
              <small>Trigger on time or local webhooks, call APIs, aggregate data, query SQLite, loop through subworkflows, attach Skills to Agents, notify yourself, inspect Git, manage files or board tasks, and hand ambiguous work to Pixice Agents.</small>
              <button type="button" className={styles.primaryButton} onClick={() => setNodePickerOpen(true)}><Plus size={14} />Browse nodes</button>
            </div>
          )}
          {(connectingFrom || connectionError) && <div className={styles.connectionHint}><Circle size={11} />{connectionError || "Drag to a compatible input · Esc to cancel"}</div>}
          <AnimatePresence>{generation.state !== "idle" && generation.state !== "error" && <WorkflowGenerationProgress generation={generation} reducedMotion={systemReducedMotion} />}</AnimatePresence>
        </div>

        {inspectorOpen && selectedNode?.type === "useSkill" && (
          <WorkflowSkillInspector
            node={selectedNode}
            api={api}
            projectId={workflow.projectId}
            onUpdate={(patch) => updateNode(selectedNode.id, patch)}
            onDelete={() => deleteNode(selectedNode.id)}
            onClose={() => setInspectorOpen(false)}
          />
        )}
        {inspectorOpen && selectedNode && selectedNode.type !== "useSkill" && (
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
        {inspectorOpen && !selectedNode && <WorkflowInspector workflow={workflow} generation={generation} onChange={onChange} onGenerate={onGenerate} onClose={() => setInspectorOpen(false)} />}
      </div>

      <RunTimeline graph={graph} run={run} />
      {run && !activeRun && (run.output !== null || run.error) && (
        <details className={styles.runResult} data-status={run.status}>
          <summary>{run.status === "completed" ? <CheckCircle size={14} /> : <Warning size={14} />}View run output</summary>
          <pre>{run.error || runOutput || "Workflow completed without an output value."}</pre>
          {runProposal?.id && <button type="button" onClick={openRunProposal}>Open plan proposal</button>}
        </details>
      )}
    </section>
  );
}
