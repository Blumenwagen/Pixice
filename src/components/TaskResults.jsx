import { useEffect, useState } from "react";
import { CaretDown, CaretLeft, Warning, ArrowClockwise, Brain, Gauge, Circle } from "./icons/index.jsx";
import { ModelBrandIcon } from "./ModelBrandIcon.jsx";
import "./TaskResults.css";

const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value ?? 0);
const elapsed = (ms) => ms < 60_000 ? `${Math.round(ms / 1_000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1_000)}s`;
const stateLabel = (receipt) => receipt.status === "running" ? "Working" : receipt.status === "failed" ? "Failed" : receipt.status === "interrupted" ? "Interrupted" : "Result";

export function TaskReceipt({ receipt, onCompare, onOpen, onLoadEvidence, renderDiff, compact = false, leadingAction = null }) {
  const [expanded, setExpanded] = useState(false);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setExpanded(false); setError(null); }, [receipt?.threadId]);
  if (!receipt) return null;
  const running = receipt.status === "running";
  const checks = receipt.checks ?? [];
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.filter((check) => check.status === "passed").length;
  const Status = failed || ["failed", "interrupted"].includes(receipt.status) ? Warning : Circle;
  const showEvidence = async () => {
    setExpanded(!expanded);
    if (!expanded && onLoadEvidence) {
      setLoadingEvidence(true); setError(null);
      try { await onLoadEvidence(receipt); } catch (cause) { setError(cause.message); }
      finally { setLoadingEvidence(false); }
    }
  };
  return (
    <section className={`task-receipt${running ? " is-running" : ""}${leadingAction ? " answer-result" : ""}${compact ? " comparison-result" : ""}`} aria-label={`Task receipt: ${receipt.title}`}>
      {compact && <header className="comparison-result-heading"><ModelBrandIcon model={receipt.model?.replace(/^(codex|claude):/, "")} size={16} /><strong>{receipt.modelLabel ?? receipt.model?.replace(/^(codex|claude):/, "") ?? "Model not recorded"}</strong><span>{receipt.sourceThreadId ? "Replay" : "Original"}</span></header>}
      <div className="receipt-bar">
        {leadingAction}
        <button type="button" className="receipt-disclosure" aria-label={expanded ? (running ? "Hide working details" : "Hide evidence") : (running ? "Show working details" : "View evidence")} aria-expanded={expanded} onClick={showEvidence}>
          <Status size={14} /><span>{stateLabel(receipt)}</span><CaretDown size={12} className={expanded ? "expanded" : ""} />
        </button>
        {(!running || expanded) && <span className="receipt-inline-meta"><span title="Agent time">{elapsed(receipt.durationMs ?? 0)}</span><span title="Estimated API cost">{receipt.usage?.events ? money(receipt.usage.costUsd) : "Cost unavailable"}{receipt.usage?.unpricedEvents > 0 && " + unpriced"}</span><span title="Total tokens used">{new Intl.NumberFormat("en-US").format(receipt.usage?.tokens ?? 0)} tokens</span></span>}
        <div className="receipt-bar-actions">
          {!running && onCompare && <button type="button" className="receipt-action receipt-replay-link" title="Compare models" aria-label="Compare models" onClick={() => onCompare(receipt)}><ArrowClockwise size={14} /><span>Replay</span></button>}
          {onOpen && <button type="button" className="receipt-action" onClick={() => onOpen(receipt)}>{running ? "Open running task" : "Open task"}</button>}
        </div>
      </div>
      {compact && (!running || expanded) && <p className="receipt-summary">{running ? "Working on the original prompt…" : receipt.summary || "No final message was recorded."}</p>}
      {running && expanded && receipt.remainingReplayTurns > 0 && <p className="receipt-note">{receipt.remainingReplayTurns} more original prompts queued.</p>}
      {error && <p className="receipt-error" role="alert">{error}</p>}
      {expanded && <div className="receipt-evidence">
        <dl className="receipt-detail-facts">
          <div><dt>Latest checks</dt><dd className={failed ? "receipt-failed" : ""}>{checks.length ? `${passed} passed${failed ? ` · ${failed} failed` : ""}${checks.some((check) => check.status === "unknown") ? " · unconfirmed" : ""}` : "None recorded"}</dd></div>
          {!compact && <div><dt>Model</dt><dd>{receipt.modelLabel ?? receipt.model?.replace(/^(codex|claude):/, "") ?? "Not recorded"}</dd></div>}
        </dl>
        {receipt.error && <p className="receipt-error">{receipt.error}</p>}
        <div className="receipt-evidence-section"><h3>Checks</h3>
          {!checks.length && <p className="receipt-note">No checks recorded in the latest turn.</p>}
          {checks.map((check) => <details className="receipt-check" key={check.id}><summary><span data-status={check.status}>{check.status === "unknown" ? "Unconfirmed" : check.status}</span><code>{check.command}</code></summary><pre>{check.output || "No command output was recorded."}</pre></details>)}
          {receipt.turns?.slice(0, -1).some((turn) => turn.checks?.length) && <details className="receipt-check"><summary>Earlier checks · may predate current changes</summary>{receipt.turns.slice(0, -1).flatMap((turn) => turn.checks ?? []).map((check) => <p key={check.id}><span>{check.status}</span> <code>{check.command}</code></p>)}</details>}
        </div>
        {receipt.unresolved?.length > 0 && <div className="receipt-evidence-section"><h3>Unresolved</h3><ul>{receipt.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        <div className="receipt-evidence-section"><h3>Changes <span>{receipt.changes?.fileCount ?? ""}</span></h3>
          <p className="receipt-note">{receipt.changesError || "Since task start. Includes any concurrent workspace edits."}</p>
          {loadingEvidence ? <p className="receipt-note" role="status">Loading captured changes…</p> : receipt.changes && <>
            {receipt.changes.fileCount === 0 ? <p className="receipt-note">No file changes.</p> : renderDiff ? renderDiff(receipt.changes) : <ul className="receipt-files">{receipt.changes.files.map((file) => <li key={`${file.root}:${file.path}`}><code>{file.path}</code><span>+{file.plus} −{file.minus}</span></li>)}</ul>}
            {receipt.changes.truncated && <p className="receipt-note">Captured changes are truncated. Open the task’s workspace to review all changes.</p>}
          </>}
        </div>
      </div>}
    </section>
  );
}

export function ModelReplay({ source, comparisons, models, onReplay, onClose, onOpen, onLoadEvidence, renderDiff, Picker }) {
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [fast, setFast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const model = models.find((candidate) => (candidate.id ?? candidate.model) === modelId) ?? models.find((candidate) => ![candidate.id, candidate.model].includes(source.model)) ?? models[0];
  const efforts = (model?.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort ?? option.effort ?? option);
  const effectiveEffort = efforts.includes(effort) ? effort : model?.defaultReasoningEffort ?? efforts[0] ?? "";
  const tiers = model?.serviceTiers?.length ? model.serviceTiers : model?.additionalSpeedTiers ?? [];
  const fastTier = tiers.map((tier) => tier.id ?? tier).find((tier) => ["priority", "fast"].includes(tier));
  useEffect(() => { setFast(false); setEffort(""); }, [modelId]);
  const start = async () => {
    setBusy(true); setError(null);
    try { await onReplay(source, { model: model.id ?? model.model, ...(effectiveEffort ? { effort: effectiveEffort } : {}), serviceTier: fast && fastTier ? fastTier : null }); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const modelOptions = models.map((candidate) => ({ value: candidate.id ?? candidate.model, label: candidate.displayName ?? candidate.model, description: candidate.description ?? candidate.model, provider: candidate.provider ?? (/claude|sonnet|opus|haiku/i.test(candidate.id ?? candidate.model) ? "claude" : "codex") }));
  return <section className="model-replay" aria-label="Model replay comparison">
    <div className="replay-context"><button type="button" className="receipt-action" onClick={onClose}><CaretLeft size={13} />Back to task</button><span>{source.projectName}</span></div>
    <header className="replay-heading"><h1>{source.title}</h1><p>Replay the original task with another model.</p></header>
    <div className="replay-compose">
      <p className="replay-prompt">{source.prompt || source.title}</p>
      <div className="replay-controls">
        <span className="replay-input-count">{source.promptCount} original prompt{source.promptCount === 1 ? "" : "s"}</span>
        <div className="composer-actions">
          {fastTier && <button type="button" className="composer-fast-toggle" aria-label="Fast mode" aria-pressed={fast} title="Use faster inference with increased usage" disabled={busy} onClick={() => setFast(!fast)}><Gauge size={14} /><span>Fast</span></button>}
          {Picker && <Picker label="Replay model" hint="Choose a model for this replay" value={model?.id ?? model?.model} options={modelOptions} onChange={setModelId} kind="model" disabled={busy || !models.length} />}
          {Picker && efforts.length > 0 && <Picker label="Reasoning" hint="Control depth and speed" value={effectiveEffort} options={efforts.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), icon: Brain }))} onChange={setEffort} kind="reasoning" disabled={busy} />}
          <button type="button" className="settings-action primary" disabled={busy || !model || !source.replayAvailable} onClick={start}><ArrowClockwise size={13} />{busy ? "Preparing…" : "Run replay"}</button>
        </div>
      </div>
    </div>
    <p className="receipt-note replay-scope">{source.replayAvailable ? "Uses a separate workspace and additional model usage." : source.replayUnavailableReason || "No starting snapshot was recorded for this task."}</p>
    {source.replayAvailable && <details className="replay-details"><summary>What gets replayed</summary><p>Original prompts and preserved attachments, starting from the captured Git files and uncommitted changes. Ignored files, installed dependencies, and external services are not captured. Questions may differ between models.</p></details>}
    {error && <p className="receipt-error" role="alert">{error}</p>}
    <div className="replay-comparisons">{comparisons.map((receipt) => <TaskReceipt key={receipt.threadId} compact receipt={{ ...receipt, modelLabel: models.find((candidate) => [candidate.id, candidate.model].includes(receipt.model))?.displayName }} onOpen={onOpen} onLoadEvidence={onLoadEvidence} renderDiff={renderDiff} />)}</div>
  </section>;
}
