import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DitherAreaChart, DitherBarChart } from "../dither-kit/DitherChart.jsx";
import { CheckCircle, Circle, SpinnerGap, Warning } from "../icons/index.jsx";
import styles from "./InstrumentHost.module.css";

function valueAt(source, path) {
  if (!path) return source;
  return path.split(".").filter(Boolean).reduce((value, key) => value?.[key], source);
}

export function resolveInstrumentValue(value, context, depth = 0) {
  if (depth > 12) return null;
  if (typeof value === "string" && value.startsWith("$")) {
    const match = value.match(/^\$(state|data|params|event)(?:\.(.+))?$/);
    if (match) return valueAt(context[match[1]], match[2]);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveInstrumentValue(entry, context, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveInstrumentValue(entry, context, depth + 1)]));
  }
  return value;
}

function text(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatValue(value, format = "text", unit = "") {
  if (format === "text") return text(value);
  const number = finite(value);
  if (format === "currency") {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: unit || "USD", maximumFractionDigits: 2 }).format(number);
    } catch {
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number)} ${unit}`.trim();
    }
  }
  if (format === "percent") return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number)}%`;
  if (format === "compact") return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(number);
  const output = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number);
  return unit ? `${output}${unit}` : output;
}

function statusIcon(status) {
  if (status === "success") return <CheckCircle size={15} weight="fill" />;
  if (status === "running") return <SpinnerGap className={styles.spin} size={15} />;
  if (status === "warning" || status === "error") return <Warning size={15} weight="fill" />;
  return <Circle size={12} weight={status === "pending" ? "regular" : "fill"} />;
}

function graphElements(rawNodes, rawEdges) {
  const nodes = (Array.isArray(rawNodes) ? rawNodes : []).filter((node) => node && typeof node === "object" && node.id !== undefined && node.id !== null).map((node, index) => ({
    id: text(node.id),
    position: {
      x: Number.isFinite(node.x) ? node.x : (index % 4) * 220,
      y: Number.isFinite(node.y) ? node.y : Math.floor(index / 4) * 120
    },
    data: { label: text(node.label ?? node.id), detail: text(node.detail), tone: node.tone },
    className: `${styles.graphNode} ${styles[`tone_${node.tone ?? "neutral"}`] ?? ""}`,
    ariaLabel: node.detail ? `${text(node.label ?? node.id)}: ${text(node.detail)}` : text(node.label ?? node.id)
  }));
  const edges = (Array.isArray(rawEdges) ? rawEdges : []).filter((edge) => edge && typeof edge === "object" && edge.source !== undefined && edge.target !== undefined).map((edge, index) => ({
    id: edge.id ? text(edge.id) : `${text(edge.source)}-${text(edge.target)}-${index}`,
    source: text(edge.source),
    target: text(edge.target),
    label: text(edge.label),
    className: styles.graphEdge
  }));
  return { nodes, edges };
}

function Primitive({ primitive, path, context, state, initialState, setState, dispatchAction, actionState, onOpenResource }) {
  const resolve = useCallback((value, event = {}) => resolveInstrumentValue(value, { ...context, state, event }), [context, state]);
  if (Boolean(resolve(primitive.hidden))) return null;
  const key = primitive.id ?? path;
  const renderChildren = (children, suffix = "child") => children.map((child, index) => (
    <Primitive
      primitive={child}
      path={`${path}.${suffix}.${index}`}
      context={context}
      state={state}
      initialState={initialState}
      setState={setState}
      dispatchAction={dispatchAction}
      actionState={actionState}
      onOpenResource={onOpenResource}
      key={child.id ?? `${suffix}-${index}`}
    />
  ));

  if (primitive.type === "stack") return <div className={`${styles.stack} ${styles[`gap_${primitive.gap}`]}`}>{renderChildren(primitive.children)}</div>;
  if (primitive.type === "grid") return <div className={`${styles.grid} ${styles[`gap_${primitive.gap}`]}`} style={{ "--instrument-columns": primitive.columns }}>{renderChildren(primitive.children)}</div>;
  if (primitive.type === "split") return (
    <div className={`${styles.split} ${primitive.direction === "vertical" ? styles.vertical : ""}`} style={{ "--instrument-ratio": `${primitive.ratio}fr`, "--instrument-inverse-ratio": `${1 - primitive.ratio}fr` }}>
      {renderChildren(primitive.children)}
    </div>
  );
  if (primitive.type === "card") return (
    <section className={styles.card}>
      {(primitive.title || primitive.description) && <header>{primitive.title && <h3>{primitive.title}</h3>}{primitive.description && <p>{primitive.description}</p>}</header>}
      <div className={styles.cardBody}>{renderChildren(primitive.children)}</div>
    </section>
  );
  if (primitive.type === "tabs") {
    const tabStateKey = `__tab_${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const active = primitive.tabs.some((tab) => tab.id === state[tabStateKey]) ? state[tabStateKey] : primitive.tabs[0].id;
    const selected = primitive.tabs.find((tab) => tab.id === active) ?? primitive.tabs[0];
    return (
      <section className={styles.tabs}>
        <div role="tablist" aria-label="Instrument sections">{primitive.tabs.map((tab) => <button type="button" role="tab" aria-selected={tab.id === active} onClick={() => setState((current) => ({ ...current, [tabStateKey]: tab.id }))} key={tab.id}>{tab.label}</button>)}</div>
        <div role="tabpanel">{renderChildren(selected.children, selected.id)}</div>
      </section>
    );
  }
  if (primitive.type === "text") return <div className={`${styles.text} ${styles[`text_${primitive.size}`]} ${styles[`text_${primitive.tone}`]}`}>{text(resolve(primitive.text))}</div>;
  if (primitive.type === "metric") return (
    <article className={styles.metric}>
      <span>{primitive.label}</span>
      <strong>{formatValue(resolve(primitive.value), primitive.format, primitive.unit)}</strong>
      {primitive.detail !== undefined && <small>{text(resolve(primitive.detail))}</small>}
    </article>
  );
  if (primitive.type === "input" || primitive.type === "textarea") {
    const value = state[primitive.id] ?? "";
    return (
      <label className={styles.field}>
        <span>{primitive.label}</span>
        {primitive.type === "textarea"
          ? <textarea rows={primitive.rows} value={text(value)} placeholder={primitive.placeholder} onChange={(event) => setState((current) => ({ ...current, [primitive.id]: event.target.value }))} />
          : <input value={text(value)} placeholder={primitive.placeholder} onChange={(event) => setState((current) => ({ ...current, [primitive.id]: event.target.value }))} />}
      </label>
    );
  }
  if (primitive.type === "select") {
    const fallback = primitive.options[0]?.value ?? "";
    const value = state[primitive.id] ?? fallback;
    return <label className={styles.field}><span>{primitive.label}</span><select value={String(value)} onChange={(event) => {
      const option = primitive.options.find((candidate) => String(candidate.value) === event.target.value);
      setState((current) => ({ ...current, [primitive.id]: option?.value ?? event.target.value }));
    }}>{primitive.options.map((option) => <option value={String(option.value)} key={String(option.value)}>{option.label}</option>)}</select></label>;
  }
  if (primitive.type === "toggle") {
    const enabled = Boolean(state[primitive.id]);
    return <button type="button" className={styles.toggle} aria-pressed={enabled} onClick={() => setState((current) => ({ ...current, [primitive.id]: !enabled }))}><i aria-hidden="true" /><span>{primitive.label}</span></button>;
  }
  if (primitive.type === "range") {
    const value = Math.min(primitive.max, Math.max(primitive.min, finite(state[primitive.id], primitive.min)));
    return (
      <label className={styles.range}>
        <span>{primitive.label}<strong>{formatValue(value, primitive.format, primitive.unit)}</strong></span>
        <input type="range" min={primitive.min} max={primitive.max} step={primitive.step} value={value} onChange={(event) => setState((current) => ({ ...current, [primitive.id]: finite(event.target.value, value) }))} />
      </label>
    );
  }
  if (primitive.type === "button") {
    const status = actionState[primitive.action];
    return <button type="button" className={`${styles.button} ${styles[`button_${primitive.variant}`]}`} disabled={Boolean(resolve(primitive.disabled)) || status === "running"} aria-busy={status === "running"} onClick={() => void dispatchAction(primitive.action, { source: primitive.id ?? path })}>{status === "running" && <SpinnerGap className={styles.spin} size={13} />}{primitive.label}{status === "sent" && <CheckCircle size={13} weight="fill" />}</button>;
  }
  if (primitive.type === "table") {
    const rows = resolve(primitive.rows);
    const values = Array.isArray(rows) ? rows : [];
    const selected = primitive.selection && Array.isArray(state[primitive.selection]) ? state[primitive.selection].map(String) : [];
    return (
      <div className={styles.tableWrap}>
        <table><thead><tr>{primitive.selection && <th aria-label="Selected" />}{primitive.columns.map((column) => <th style={column.width ? { width: column.width } : undefined} key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>{values.map((row, index) => {
            const rowId = String(row?.id ?? index);
            const active = selected.includes(rowId);
            return <tr className={active ? styles.selectedRow : ""} onClick={primitive.selection ? () => setState((current) => ({ ...current, [primitive.selection]: active ? selected.filter((id) => id !== rowId) : [...selected, rowId] })) : undefined} key={rowId}>{primitive.selection && <td><input type="checkbox" checked={active} onChange={() => {}} aria-label={`Select row ${index + 1}`} /></td>}{primitive.columns.map((column) => <td key={column.key}>{text(valueAt(row, column.key))}</td>)}</tr>;
          })}</tbody>
        </table>
        {!values.length && <div className={styles.empty}>{primitive.emptyLabel}</div>}
      </div>
    );
  }
  if (primitive.type === "graph") {
    const { nodes, edges } = graphElements(resolve(primitive.nodes), resolve(primitive.edges));
    const selectedIds = primitive.selection && Array.isArray(state[primitive.selection]) ? state[primitive.selection].map(String) : [];
    const selectedNodes = nodes.map((node) => ({ ...node, selected: selectedIds.includes(node.id) }));
    return (
      <div className={styles.graph} style={{ height: primitive.height }}>
        <ReactFlow
          nodes={selectedNodes}
          edges={edges}
          fitView
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={Boolean(primitive.selection)}
          onSelectionChange={primitive.selection ? ({ nodes: next }) => setState((current) => ({ ...current, [primitive.selection]: next.map((node) => node.id) })) : undefined}
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    );
  }
  if (primitive.type === "statusList") {
    const items = resolve(primitive.items);
    const values = Array.isArray(items) ? items : [];
    return values.length ? <div className={styles.statusList}>{values.map((item, index) => <article className={styles[`status_${item?.status ?? "neutral"}`]} key={text(item?.id) || index}>{statusIcon(item?.status)}<span><strong>{text(item?.label)}</strong>{item?.detail && <small>{text(item.detail)}</small>}</span></article>)}</div> : <div className={styles.empty}>{primitive.emptyLabel}</div>;
  }
  if (primitive.type === "code") return <section className={styles.code}>{primitive.title && <header>{primitive.title}</header>}<pre><code data-language={primitive.language}>{text(resolve(primitive.code))}</code></pre></section>;
  if (primitive.type === "diff") return <section className={styles.diff}>{primitive.title && <header>{primitive.title}</header>}<div><pre><code>{text(resolve(primitive.before))}</code></pre><pre><code>{text(resolve(primitive.after))}</code></pre></div></section>;
  if (primitive.type === "chart") {
    const data = resolve(primitive.data);
    const Chart = primitive.chartType === "area" ? DitherAreaChart : DitherBarChart;
    return <section className={styles.chart}>{primitive.title && <h3>{primitive.title}</h3>}<Chart data={Array.isArray(data) ? data : []} series={primitive.series} labelKey={primitive.xKey} height={primitive.height} valueFormatter={(value) => formatValue(value, primitive.format, primitive.unit)} ariaLabel={primitive.title ?? "Instrument chart"} emptyLabel="No chart data" /></section>;
  }
  return <div className={styles.error}>Unsupported Instrument primitive.</div>;
}

export function InstrumentHost({ instrument, onOpenResource, onRefreshData, onAgentEvent, onInvokeCapability, onSetPinned }) {
  const initialStateSignature = JSON.stringify(instrument.document.state ?? {});
  const initialState = useMemo(() => JSON.parse(initialStateSignature), [initialStateSignature, instrument.id]);
  const [state, setState] = useState(initialState);
  const [actionState, setActionState] = useState({});
  const [actionError, setActionError] = useState("");
  const refreshDataRef = useRef(onRefreshData);
  useEffect(() => setState(initialState), [initialState]);
  useEffect(() => { refreshDataRef.current = onRefreshData; }, [onRefreshData]);
  const context = useMemo(() => ({ data: instrument.document.data ?? {}, params: instrument.launchValues ?? {} }), [instrument.document.data, instrument.launchValues]);
  const runRemoteAction = useCallback(async (actionId, operation) => {
    setActionError("");
    setActionState((current) => ({ ...current, [actionId]: "running" }));
    try {
      const result = await operation();
      setActionState((current) => ({ ...current, [actionId]: result?.cancelled ? "idle" : "sent" }));
      return result;
    } catch (error) {
      setActionState((current) => ({ ...current, [actionId]: "error" }));
      setActionError(error.message);
    }
  }, []);
  const onOpenSources = Object.entries(instrument.document.sources ?? {}).filter(([, source]) => source.refresh === "onOpen").map(([name]) => name);
  const onOpenSourceSignature = onOpenSources.join("\u0000");
  useEffect(() => {
    if (!onOpenSourceSignature || !refreshDataRef.current) return;
    let cancelled = false;
    void runRemoteAction("__open_refresh", async () => {
      for (const source of onOpenSources) {
        if (cancelled) return;
        await refreshDataRef.current(source);
      }
    });
    return () => { cancelled = true; };
  }, [instrument.id, onOpenSourceSignature, runRemoteAction]);
  const dispatchAction = useCallback(async (actionId, event = {}) => {
    const action = instrument.document.actions?.[actionId];
    if (!action) return;
    if (action.type === "resetState") {
      setState(initialState);
      return;
    }
    if (action.type === "setState") {
      setState((current) => ({ ...current, [action.path]: resolveInstrumentValue(action.value, { ...context, state: current, event }) }));
      return;
    }
    if (action.type === "openResource") {
      const target = resolveInstrumentValue(action.target, { ...context, state, event });
      if (typeof target === "string" && target.trim()) onOpenResource?.(target.trim());
      return;
    }
    if (action.type === "refreshData") {
      await runRemoteAction(actionId, () => onRefreshData?.(action.source));
      return;
    }
    if (action.type === "sendAgentEvent") {
      const payload = resolveInstrumentValue(action.payload ?? {}, { ...context, state, event });
      await runRemoteAction(actionId, () => onAgentEvent?.(actionId, payload));
      return;
    }
    if (action.type === "invokeCapability") {
      const argumentsValue = resolveInstrumentValue(action.arguments ?? {}, { ...context, state, event });
      await runRemoteAction(actionId, () => onInvokeCapability?.(actionId, argumentsValue));
    }
  }, [context, initialState, instrument.document.actions, onAgentEvent, onInvokeCapability, onOpenResource, onRefreshData, runRemoteAction, state]);
  const sourceEntries = Object.entries(instrument.document.sources ?? {});
  const sourceErrors = Object.values(instrument.document.sourceState ?? {}).filter((source) => source.status === "error");
  const trustedCapabilities = [...new Set(Object.values(instrument.document.actions ?? {}).filter((action) => action.type === "invokeCapability").map((action) => action.capability))];
  const refreshingAll = actionState.__refresh_all === "running";
  const changingPin = actionState.__pin === "running";

  return (
    <section className={styles.host} aria-label={instrument.document.title}>
      <header className={styles.header}>
        <div><span>Instrument</span><h2>{instrument.metadata?.name || instrument.document.title}</h2>{instrument.document.description && <p>{instrument.document.description}</p>}</div>
        <aside>
          <span>{instrument.lifecycle === "pinned" ? "Project tool" : "This task"}</span>
          {onSetPinned && <button type="button" disabled={changingPin} aria-busy={changingPin} onClick={() => void runRemoteAction("__pin", () => onSetPinned(instrument.lifecycle !== "pinned"))}>{changingPin && <SpinnerGap className={styles.spin} size={12} />}{instrument.lifecycle === "pinned" ? "Unpin" : "Pin to project"}</button>}
          {sourceEntries.length ? <button type="button" disabled={refreshingAll} aria-busy={refreshingAll} onClick={() => void runRemoteAction("__refresh_all", () => onRefreshData?.())}>{refreshingAll && <SpinnerGap className={styles.spin} size={12} />}Refresh data</button> : null}
          <small>{sourceEntries.length ? `${sourceEntries.length} live source${sourceEntries.length === 1 ? "" : "s"}${sourceErrors.length ? `, ${sourceErrors.length} failed` : ""}` : "Local interaction"}</small>
        </aside>
      </header>
      {actionError && <div className={styles.actionError} role="alert"><Warning size={14} weight="fill" />{actionError}</div>}
      {sourceErrors.length > 0 && <div className={styles.sourceErrors} role="status">{Object.entries(instrument.document.sourceState).filter(([, source]) => source.status === "error").map(([name, source]) => <span key={name}><Warning size={13} weight="fill" /><strong>{name}</strong>{source.error}</span>)}</div>}
      {trustedCapabilities.length > 0 && <div className={styles.capabilities} aria-label="Trusted capabilities"><span>Confirmed actions</span>{trustedCapabilities.map((capability) => <code data-granted={instrument.lifecycle !== "pinned" || instrument.grants?.includes(capability)} key={capability}>{capability}</code>)}</div>}
      <div className={styles.body}>
        <Primitive primitive={instrument.document.layout} path="layout" context={context} state={state} initialState={initialState} setState={setState} dispatchAction={dispatchAction} actionState={actionState} onOpenResource={onOpenResource} />
      </div>
    </section>
  );
}
