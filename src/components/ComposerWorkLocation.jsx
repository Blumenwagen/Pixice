import { useEffect, useId, useRef, useState } from 'react';
import { CaretDown, Check, Desktop, Globe, X } from './icons/index.jsx';
import './composer-integration.css';

export function cloudTaskId(result) {
  const direct = result?.taskId;
  if (typeof direct === 'string' && /^[A-Za-z0-9_-]+$/.test(direct)) return direct;
  // The existing CLI adapter returns stdout, not a structured task object.
  return String(result?.output ?? '').match(/\btask_[A-Za-z0-9_-]+\b/)?.[0] ?? null;
}

export function useComposerWorkLocation({ api, projectId, provider, hostKey = 'local', previewContext } = {}) {
  const [destination, setDestination] = useState('computer');
  const [environmentId, setEnvironmentId] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [inspection, setInspection] = useState(null);
  const generation = useRef(0);
  const readTicket = useRef(0);
  const pending = useRef(false);
  const scope = `${projectId}:${provider}:${hostKey}`;
  // Update during render too, so a late promise cannot write into a new scope.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const refresh = async () => {
    const currentScope = scope;
    const ticket = ++readTicket.current;
    if (!api?.cloud?.state || !projectId || provider !== 'codex' || api.remote) return null;
    setLoading(true);
    try {
      const value = await api.cloud.state({ projectId });
      if (scopeRef.current !== currentScope || ticket !== readTicket.current) return null;
      setSnapshot(value); setError('');
      setEnvironmentId((current) => value.environments?.some((item) => item.id === current) ? current : value.environments?.[0]?.id ?? '');
      return value;
    } catch (cause) {
      if (scopeRef.current === currentScope && ticket === readTicket.current) { setSnapshot(null); setError(cause.message); }
      return null;
    } finally { if (scopeRef.current === currentScope && ticket === readTicket.current) setLoading(false); }
  };
  useEffect(() => {
    generation.current++; pending.current = false;
    setDestination('computer'); setEnvironmentId(''); setSnapshot(null); setReceipt(null); setInspection(null); setError(''); setBusy(false); setLoading(false);
    void refresh();
    return () => { generation.current++; readTicket.current++; };
  }, [api, scope]);
  const unavailable = provider !== 'codex' ? 'Cloud is available for Codex tasks.'
    : api?.remote ? 'Codex Cloud is available from the host desktop.'
      : !api?.cloud?.state || !api?.cloud?.submit ? 'This Pixice host does not offer Codex Cloud.'
        : !snapshot ? error || 'Checking Codex Cloud…'
          : !snapshot.available ? snapshot.reason || 'Codex Cloud is unavailable.' : '';
  const select = (value) => { if (!pending.current) { setDestination(value); setError(''); } };
  const validate = (attachments = []) => {
    if (unavailable) return unavailable;
    if (!environmentId || !snapshot?.environments?.some((item) => item.id === environmentId)) return 'Save and select a Cloud environment for this project.';
    if (attachments.length) return 'Cloud cannot receive attachments through this integration. Remove them or switch to This computer. Your draft is kept.';
    if (previewContext?.open && previewContext?.active) return 'Cloud cannot receive the open Preview context. Close Preview or switch to This computer. Your draft is kept.';
    return '';
  };
  const submit = async (prompt, attachments, signal) => {
    const issue = validate(attachments);
    if (issue) { setError(issue); return false; }
    if (pending.current || signal?.aborted) return false;
    const ticket = generation.current;
    const currentScope = scope;
    const active = () => generation.current === ticket && scopeRef.current === currentScope && !signal?.aborted;
    pending.current = true; setBusy(true); setError(''); setInspection(null);
    try {
      const current = await api.cloud.state({ projectId });
      if (!active()) return false;
      if (!current.available || !current.environments?.some((item) => item.id === environmentId)) {
        setSnapshot(current); setEnvironmentId('');
        throw new Error(current.reason && !current.available ? current.reason : 'The selected Cloud environment is no longer saved. Choose an environment before sending.');
      }
      const result = await api.cloud.submit({ projectId, environmentId, prompt, attempts: 1 });
      if (!active()) return false;
      setReceipt({ ...result, taskId: cloudTaskId(result), environmentName: current.environments.find((item) => item.id === environmentId)?.name ?? environmentId });
      return true;
    } catch (cause) { if (active()) setError(cause.message || 'Cloud submission failed. Your draft is kept.'); return false; }
    finally { if (generation.current === ticket && scopeRef.current === currentScope) { pending.current = false; setBusy(false); } }
  };
  const inspect = async (operation) => {
    if (!receipt?.taskId || pending.current || !api?.cloud?.[operation]) return;
    const ticket = generation.current;
    const currentScope = scope;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await api.cloud[operation]({ projectId, taskId: receipt.taskId });
      if (generation.current === ticket && scopeRef.current === currentScope) setInspection({ operation, ...result });
    } catch (cause) { if (generation.current === ticket && scopeRef.current === currentScope) setError(cause.message); }
    finally { if (generation.current === ticket && scopeRef.current === currentScope) { pending.current = false; setBusy(false); } }
  };
  const open = async () => {
    const currentScope = scope;
    try { await api?.cloud?.open?.(); }
    catch (cause) { if (scopeRef.current === currentScope) setError(cause.message); }
  };
  // A changed project/provider gets local routing immediately, before effects.
  const validScope = useRef(scope);
  const changed = validScope.current !== scope;
  useEffect(() => { validScope.current = scope; }, [scope]);
  return { destination: changed ? 'computer' : destination, environmentId, setEnvironmentId, snapshot, loading, busy, error, receipt, inspection,
    unavailable, select, refresh, validate, submit, inspect, open, dismissReceipt: () => { setReceipt(null); setInspection(null); } };
}

export function ComposerWorkLocation({ location, onSetup, disabled = false, deviceControl = null }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  const cloud = location.destination === 'cloud';
  const environments = location.snapshot?.environments ?? [];
  const environment = environments.find((item) => item.id === location.environmentId);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="composer-location" ref={root}>
    <div className="composer-location-row">
      <button type="button" ref={trigger} className="composer-location-trigger" aria-label={`Work in: ${cloud ? 'Cloud' : 'This computer'}`}
        aria-expanded={open} aria-controls={menuId} aria-haspopup="dialog" disabled={disabled || location.busy}
        onClick={() => { setOpen((value) => !value); if (!open) void location.refresh(); }}>
        {cloud ? <Globe size={15} /> : <Desktop size={15} />}<span>{cloud ? 'Cloud' : 'This computer'}</span><CaretDown size={12} />
      </button>
      {cloud && environment && <span className="composer-location-environment" title={environment.name}>{environment.name}</span>}
      {!cloud && deviceControl}
    </div>
    {open && <section className="composer-location-menu" role="dialog" aria-label="Work location" id={menuId} ref={menu} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const controls = [...menu.current.querySelectorAll('button:not([disabled]), select')];
        const index = controls.indexOf(document.activeElement);
        event.preventDefault(); controls[(index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length]?.focus();
      }
    }}>
      <small>Work in</small>
      <button type="button" className="composer-location-option" aria-pressed={!cloud} disabled={disabled || location.busy} onClick={() => { location.select('computer'); close(); }}><Desktop size={17} /><span>This computer</span>{!cloud && <Check size={15} />}</button>
      <button type="button" className="composer-location-option" aria-pressed={cloud} disabled={disabled || location.busy || Boolean(location.unavailable)} title={location.unavailable || 'Run a new task in Codex Cloud'} onClick={() => location.select('cloud')}><Globe size={17} /><span>Cloud</span>{cloud && <Check size={15} />}</button>
      {location.unavailable && <p role="status">{location.unavailable}</p>}
      {location.loading && !location.unavailable && <p role="status">Refreshing environments…</p>}
      {environments.length > 0 && <label className="composer-environment-picker">Cloud environment<select aria-label="Cloud environment" value={location.environmentId} disabled={disabled || Boolean(location.unavailable) || location.busy} onChange={(event) => { location.setEnvironmentId(event.target.value); location.select('cloud'); }}>
        {!location.environmentId && <option value="">Choose an environment</option>}
        {environments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>}
      {!environments.length && !location.loading && <p>No saved Cloud environments for this project.</p>}
      {onSetup && <button type="button" className="composer-location-setup" disabled={disabled || location.busy} onClick={() => { close(); onSetup(); }}>{environments.length ? 'Manage Cloud environments' : 'Set up a Cloud environment'}</button>}
    </section>}
    {cloud && <p className="composer-cloud-scope">New Cloud task. Sends this prompt only. Local conversation, model and permissions stay here.</p>}
  </div>;
}

export function ComposerCloudFeedback({ location }) {
  const { receipt, inspection } = location;
  if (!receipt) return null;
  return <section className="composer-cloud-receipt" aria-label="Cloud submission">
    <div className="composer-cloud-receipt-heading"><strong>Cloud · {receipt.environmentName}</strong><button className="icon-button" type="button" aria-label="Dismiss Cloud result" onClick={location.dismissReceipt}><X size={14} /></button></div>
    <pre role="status">{receipt.output || 'Cloud returned no submission details. Open Codex Cloud to check the task.'}</pre>
    {receipt.warnings && <p>{receipt.warnings}</p>}
    <div className="composer-cloud-receipt-actions">
      {receipt.taskId && <><button type="button" className="settings-action" disabled={location.busy} onClick={() => void location.inspect('status')}>Check status</button><button type="button" className="settings-action" disabled={location.busy} onClick={() => void location.inspect('diff')}>Review diff</button></>}
      <button type="button" className="settings-action" disabled={location.busy} onClick={() => void location.open()}>Open Codex Cloud</button>
    </div>
    {inspection && <div className="composer-cloud-inspection"><small>{inspection.operation === 'diff' ? 'Cloud diff' : 'Cloud status'} · {receipt.taskId}</small><pre tabIndex={0}>{inspection.output || 'No output returned.'}</pre>{inspection.warnings && <p>{inspection.warnings}</p>}</div>}
  </section>;
}
