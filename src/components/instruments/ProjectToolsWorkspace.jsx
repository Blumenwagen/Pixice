import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Check, Eye, Files, MagnifyingGlass, SpinnerGap, Stack, Trash, X } from "../icons/index.jsx";
import styles from "./ProjectToolsWorkspace.module.css";

function toolName(tool) {
  return tool.metadata?.name || tool.document.title;
}

function relativeTime(value) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function initialParameters(tool) {
  return Object.fromEntries(Object.entries(tool?.document.parameters ?? {}).flatMap(([name, parameter]) => parameter.default === undefined ? [] : [[name, parameter.default]]));
}

function ParameterField({ name, parameter, value, onChange }) {
  if (parameter.type === "boolean") {
    return <label className={styles.checkField}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span><strong>{parameter.label}</strong>{parameter.description && <small>{parameter.description}</small>}</span></label>;
  }
  if (parameter.type === "select") {
    return <label className={styles.field}><span>{parameter.label}{parameter.required && <b>Required</b>}</span><select value={value === undefined ? "" : String(value)} onChange={(event) => onChange(parameter.options.find((option) => String(option.value) === event.target.value)?.value)}><option value="">Choose an option</option>{parameter.options.map((option) => <option value={String(option.value)} key={`${name}:${String(option.value)}`}>{option.label}</option>)}</select>{parameter.description && <small>{parameter.description}</small>}</label>;
  }
  return <label className={styles.field}><span>{parameter.label}{parameter.required && <b>Required</b>}</span><input type={parameter.type === "number" ? "number" : "text"} value={value ?? ""} placeholder={parameter.placeholder} onChange={(event) => onChange(parameter.type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value)} />{parameter.description && <small>{parameter.description}</small>}</label>;
}

export function ProjectToolsWorkspace({ project, threadId, tools, loading, onReload, onLaunch, onRename, onGrants, onDuplicate, onDelete, onRevisions, onReceipts, onRestore }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState("");
  const [launchValues, setLaunchValues] = useState({});
  const [revisions, setRevisions] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tools.filter((tool) => !needle || `${toolName(tool)} ${tool.document.description} ${tool.requestedCapabilities.join(" ")}`.toLowerCase().includes(needle));
  }, [query, tools]);
  const selected = tools.find((tool) => tool.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setName(toolName(selected));
    setLaunchValues(initialParameters(selected));
    let cancelled = false;
    Promise.all([onRevisions(selected.id), onReceipts(selected.id)]).then(([revisionValues, receiptValues]) => {
      if (!cancelled) {
        setRevisions(revisionValues);
        setReceipts(receiptValues);
      }
    }).catch((cause) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.documentVersion, onReceipts, onRevisions]);

  const run = async (key, operation) => {
    setBusy(key);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy("");
    }
  };

  const parameters = Object.entries(selected?.document.parameters ?? {});
  const canLaunch = Boolean(threadId) && parameters.every(([nameKey, parameter]) => !parameter.required || launchValues[nameKey] !== undefined && launchValues[nameKey] !== "");

  return (
    <main className={styles.workspace}>
      <header className="workspace-header">
        <div><span>Project library</span><h1>Tools</h1><p>Reusable interfaces created for {project?.displayName ?? "this project"}.</p></div>
        <div><button type="button" onClick={onReload} disabled={loading}>{loading && <SpinnerGap className={styles.spin} size={14} />}Refresh</button></div>
      </header>
      <div className={styles.layout}>
        <aside className={styles.library}>
          <label className={styles.search}><MagnifyingGlass size={14} /><input aria-label="Search project tools" placeholder="Search tools" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button>}</label>
          <div className={styles.list}>
            {filtered.map((tool) => <button type="button" className={tool.id === selected?.id ? styles.selected : ""} onClick={() => setSelectedId(tool.id)} key={tool.id}><Stack size={16} /><span><strong>{toolName(tool)}</strong><small>{tool.document.description || "No description"}</small></span><em>{tool.usageCount}</em></button>)}
            {!loading && !filtered.length && <p>{tools.length ? "No tools match this search." : "Pin an Instrument to add your first project tool."}</p>}
          </div>
        </aside>
        {selected ? (
          <section className={styles.detail}>
            <div className={styles.detailHeader}>
              <div><span>Project tool</span><h2>{toolName(selected)}</h2><p>{selected.document.description || "This tool has no description."}</p></div>
              <div className={styles.actions}><button type="button" onClick={() => void run("duplicate", () => onDuplicate(selected.id))} disabled={!threadId || Boolean(busy)}><Files size={14} />Duplicate</button><button type="button" className={styles.danger} onClick={() => window.confirm(`Delete ${toolName(selected)}?`) && void run("delete", () => onDelete(selected.id))} disabled={!threadId || Boolean(busy)}><Trash size={14} />Delete</button></div>
            </div>
            {error && <div className={styles.error} role="alert">{error}</div>}
            {!threadId && <div className={styles.notice}>Select or create a task before launching or editing a project tool. Its actions need a controlling thread.</div>}
            <div className={styles.sections}>
              <section>
                <h3>Launch</h3>
                <p>Inputs stay in this Preview session. They do not change the shared definition.</p>
                {parameters.length ? <div className={styles.form}>{parameters.map(([parameterName, parameter]) => <ParameterField name={parameterName} parameter={parameter} value={launchValues[parameterName]} onChange={(value) => setLaunchValues((current) => ({ ...current, [parameterName]: value }))} key={parameterName} />)}</div> : <div className={styles.muted}>This tool has no launch inputs.</div>}
                <button type="button" className={styles.primary} disabled={!canLaunch || Boolean(busy)} onClick={() => void run("launch", () => onLaunch(selected.id, launchValues))}>{busy === "launch" ? <SpinnerGap className={styles.spin} size={14} /> : <Eye size={14} />}Open in Preview</button>
              </section>
              <section>
                <h3>Name</h3>
                <label className={styles.field}><span>Library name</span><input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} /></label>
                <button type="button" disabled={!threadId || !name.trim() || name.trim() === toolName(selected) || Boolean(busy)} onClick={() => void run("rename", () => onRename(selected.id, name.trim()))}><Check size={14} />Save name</button>
              </section>
              <section>
                <h3>Capabilities</h3>
                <p>Turn off authority this tool does not need. A document revision cannot turn it back on.</p>
                {selected.requestedCapabilities.length ? <div className={styles.grants}>{selected.requestedCapabilities.map((capability) => <label key={capability}><input type="checkbox" checked={selected.grants.includes(capability)} disabled={!threadId || Boolean(busy)} onChange={(event) => {
                  const next = event.target.checked ? [...selected.grants, capability] : selected.grants.filter((grant) => grant !== capability);
                  void run(`grant:${capability}`, () => onGrants(selected.id, next));
                }} /><code>{capability}</code><span>{selected.grants.includes(capability) ? "Allowed with confirmation" : "Disabled"}</span></label>)}</div> : <div className={styles.muted}>This tool has no mutating capabilities.</div>}
              </section>
              <section>
                <h3>Activity</h3>
                <p>Confirmed actions leave bounded receipts. Inputs are represented by a hash, not repeated here.</p>
                {receipts.length ? <div className={styles.receipts}>{receipts.map((receipt) => <div data-status={receipt.status} key={receipt.requestId}><span><strong>{receipt.effectSummary}</strong><small>{receipt.capability} · {relativeTime(receipt.createdAt)}</small></span><b>{receipt.status}</b>{receipt.error && <em>{receipt.error}</em>}</div>)}</div> : <div className={styles.muted}>No confirmed actions yet.</div>}
              </section>
              <section>
                <h3>History</h3>
                <p>Restoring changes the document only. Current capability grants stay in place.</p>
                <div className={styles.history}>{revisions.map((revision) => <div key={revision.id}><ArrowClockwise size={14} /><span><strong>Version {revision.version}</strong><small>{relativeTime(revision.createdAt)}</small></span>{revision.version !== selected.documentVersion && <button type="button" disabled={!threadId || Boolean(busy)} onClick={() => void run(`restore:${revision.version}`, () => onRestore(selected.id, revision.version))}>Restore</button>}</div>)}</div>
              </section>
              <section className={styles.metadata}><span><strong>{selected.usageCount}</strong> opens</span><span>Last opened <strong>{relativeTime(selected.lastOpenedAt)}</strong></span><span>Updated <strong>{relativeTime(selected.updatedAt)}</strong></span>{selected.lastError && <span className={styles.failure}>Last error <strong>{selected.lastError}</strong></span>}</section>
            </div>
          </section>
        ) : <section className={styles.empty}><Stack size={28} /><h2>No project tools yet</h2><p>Ask an agent to create an Instrument, then pin it from Preview.</p></section>}
      </div>
    </main>
  );
}
