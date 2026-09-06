import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { RemoteClient, savedInstances, pairInstance, forgetInstance } from './client.js';
import { Desktop, Globe, Plus, X, Folder, ArrowClockwise } from '../components/icons/index.jsx';
import pixiceIcon from '../assets/pixice-icon.png';
import './connect.css';
const ConnectContext = createContext(null);
export const useConnect = () => useContext(ConnectContext);
const ACTIVE_KEY = 'pixice.connect.active';
const UsagePage = lazy(() => import('../App.jsx').then((module) => ({ default: module.UsagePage })));

// Instance changes isolate drafts, preview tabs, project selection, and cached task IDs.
// Global visual preferences stay shared; server-backed defaults are supplied by bootstrap.
export function switchInstanceStorage(previous, next) {
  if (previous === next) return;
  const shared = /^(pixice\.connect\.|pixice\.(preferences|accentColor|reduceTransparency))/;
  const keys = Object.keys(localStorage).filter((key) => key.startsWith('pixice.') && !shared.test(key));
  const snapshot = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
  localStorage.setItem(`pixice.connect.workspace.${previous || 'local'}`, JSON.stringify(snapshot));
  let restored = {};
  try { restored = JSON.parse(localStorage.getItem(`pixice.connect.workspace.${next || 'local'}`) || '{}'); } catch { /* A damaged cache must not block switching hosts. */ }
  for (const key of keys) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(restored)) if (typeof value === 'string' && key.startsWith('pixice.') && !shared.test(key)) localStorage.setItem(key, value);
}

function PairForm({ initialLink = '', onPaired, onCancel }) {
  const [link, setLink] = useState(initialLink);
  const [name, setName] = useState(window.pixice ? 'Pixice desktop' : 'Web browser');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { const instance = await pairInstance(link, name.trim()); setLink(''); onPaired(instance); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <form className="connect-pair-form" onSubmit={submit}>
    <label>Pairing link<input autoFocus className="connect-input" type="text" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://your-instance/#pair=…" autoComplete="off" spellCheck={false} required /></label>
    <label>This device’s name<input className="connect-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
    <p className="settings-footnote">Create a link in Settings → Connections on the host. Pairing gives this device access to projects, agent actions, and signed-in pages in the host’s preview browser.</p>
    {error && <p role="alert" className="connect-error">{error}</p>}
    <div className="connect-actions">{onCancel && <button type="button" className="settings-action" onClick={onCancel}>Cancel</button>}<button className="settings-action primary" disabled={busy || !name.trim()}>{busy ? 'Pairing…' : 'Pair instance'}</button></div>
  </form>;
}

export function InstanceList({ compact = false }) {
  const connect = useConnect();
  if (!connect) return null;
  return <div className={compact ? 'connect-instance-list compact' : 'settings-card connect-instance-list'}>
    {connect.local && <div className="preference-row"><span><strong><Desktop size={14} /> This Mac or PC</strong><small>Local Pixice instance</small></span><button className="settings-action" disabled={!connect.active} onClick={() => connect.select(null)}>{connect.active ? 'Open' : 'Current'}</button></div>}
    {connect.instances.map((instance) => <div className="preference-row" key={instance.id}>
      <span><strong><Globe size={14} /> {instance.name}</strong><small>{instance.endpoint}</small></span>
      <div className="connect-actions"><button className="settings-action" disabled={connect.active === instance.id} onClick={() => connect.select(instance.id)}>{connect.active === instance.id ? 'Current' : 'Open'}</button><button className="settings-action" aria-label={`Forget ${instance.name}`} onClick={() => connect.forget(instance.id)}>Forget</button></div>
    </div>)}
    {!connect.instances.length && !connect.local && <p className="settings-footnote">Pair an instance to get started.</p>}
  </div>;
}

function FolderPicker({ client, onClose }) {
  const [directory, setDirectory] = useState(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const request = useRef(0);
  async function load(path) {
    const id = ++request.current; setBusy(true); setError('');
    try { const result = await client.api.projects.directories({ path: path || undefined }); if (id === request.current) { setDirectory(result); setInput(result.path); } }
    catch (cause) { if (id === request.current) setError(cause.message); }
    finally { if (id === request.current) setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <div className="connect-modal-backdrop" onKeyDown={(event) => { if (event.key === 'Escape') onClose([]); }}><section className="connect-modal settings-card" role="dialog" aria-modal="true" aria-label="Choose a folder on the host">
    <header><h2>Choose a host folder</h2><button className="settings-action" aria-label="Cancel folder selection" onClick={() => onClose([])}><X size={16} /></button></header>
    <form className="connect-actions" onSubmit={(event) => { event.preventDefault(); void load(input); }}><input autoFocus aria-label="Host folder path" className="connect-input" value={input} onChange={(event) => setInput(event.target.value)} /><button className="settings-action" disabled={busy}>Go</button></form>
    {error && <p role="alert" className="connect-error">{error}</p>}
    <div className="connect-folder-list" aria-busy={busy}>{directory?.parent !== directory?.path && <button disabled={busy} onClick={() => load(directory.parent)}>..</button>}{directory?.directories.map((entry) => <button key={entry.path} disabled={busy} onClick={() => load(entry.path)}><Folder size={15} />{entry.name}</button>)}</div>
    <div className="connect-actions"><button className="settings-action" onClick={() => onClose([])}>Cancel</button><button className="settings-action primary" disabled={busy || !directory || Boolean(error)} onClick={() => onClose([directory.path])}>Use this folder</button></div>
  </section></div>;
}

export function ConnectRoot({ children }) {
  const local = Boolean(window.pixice);
  const initialPair = useRef(null);
  if (initialPair.current === null) {
    initialPair.current = new URLSearchParams(window.location.hash.slice(1)).has('pair') ? window.location.href : '';
    if (initialPair.current) history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const [instances, setInstances] = useState(savedInstances);
  const [active, setActive] = useState(() => {
    const saved = localStorage.getItem(ACTIVE_KEY);
    return savedInstances().some((instance) => instance.id === saved) ? saved : null;
  });
  const [ready, setReady] = useState(false);
  const [state, setState] = useState({ state: 'connecting' });
  const [revision, setRevision] = useState(0);
  const [localState, setLocalState] = useState({ state: window.pixice?.service ? 'connecting' : 'connected' });
  const [retry, setRetry] = useState(0);
  const [pairing, setPairing] = useState(Boolean(initialPair.current));
  const [switcher, setSwitcher] = useState(false);
  const [folderRequest, setFolderRequest] = useState(null);
  const [showUsage, setShowUsage] = useState(false);
  const [usageDays, setUsageDays] = useState(30);
  const clientRef = useRef(null);
  const instance = instances.find((item) => item.id === active);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setState({ state: 'connecting' });
    if (!instance) {
      delete window.pixiceRemote;
      clientRef.current = null;
      setReady(local);
      return;
    }
    const client = new RemoteClient(instance, {
      onState: (value) => { if (!disposed) setState(value); },
      onReset: () => { if (!disposed) setRevision((value) => value + 1); },
      pickFolders: () => new Promise((resolve) => setFolderRequest({ resolve }))
    });
    clientRef.current = client;
    window.pixiceRemote = client.api;
    client.connect().then(() => { if (!disposed) setReady(true); }).catch((error) => { if (!disposed) setState({ state: 'error', error: error.message }); });
    return () => { disposed = true; client.close(); if (window.pixiceRemote === client.api) delete window.pixiceRemote; };
  }, [active, instance?.endpoint, instance?.token, retry, local]);

  useEffect(() => {
    if (!window.pixice?.service) return;
    let disposed = false;
    window.pixice.service.connection().then((value) => { if (!disposed) setLocalState(value); }).catch((error) => { if (!disposed) setLocalState({ state: 'error', error: error.message }); });
    const unsubscribe = window.pixice.events.subscribe((event) => {
      if (event.type === 'ServiceConnectionState') setLocalState(event.payload);
      if (event.type === 'ServiceReset') setRevision((value) => value + 1);
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  async function startLocalService() {
    setLocalState({ state: 'connecting' });
    try { await window.pixice.service.start(); setRevision((value) => value + 1); }
    catch (error) { setLocalState({ state: 'error', error: error.message }); }
  }
  function select(id) {
    if (active === id) { setSwitcher(false); return; }
    // Unmount first; defer changing storage until effect cleanups have saved drafts.
    setReady(false);
    setSwitcher(false);
    setTimeout(() => {
      switchInstanceStorage(active, id);
      if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY);
      setActive(id);
    }, 0);
  }
  const context = { local, active, instances, state,
    select,
    add: () => setPairing(true),
    forget: (id) => { forgetInstance(id); setInstances(savedInstances()); if (id === active) select(null); },
    retry: () => setRetry((value) => value + 1)
  };
  if (showUsage) return <ConnectContext.Provider value={context}><main className="connect-saved-usage"><div className="settings-content usage-settings-content"><header><button className="settings-action" onClick={() => setShowUsage(false)}>Back to connections</button><h1>Usage</h1></header><Suspense fallback={<p>Opening saved usage…</p>}><UsagePage unifiedOnly rangeDays={usageDays} onRangeChange={setUsageDays} /></Suspense></div></main></ConnectContext.Provider>;
  const needsWelcome = !ready && (!instance || state.state === 'error');
  return <ConnectContext.Provider value={context}>
    <div className={`connect-root${active ? ' is-remote' : ''}`}>
      {ready && <div key={`${active || 'local'}:${revision}`} className="connect-application">{children}</div>}
      {local && !active && localState.state !== 'connected' && <div className="connect-service-overlay"><section className="settings-card" role="status"><h2>{localState.state === 'connecting' ? 'Connecting to Pixice…' : 'Backend unavailable'}</h2><p>{localState.error || 'Your projects and saved usage remain on this device.'}</p><div className="connect-actions"><button className="settings-action primary" onClick={startLocalService}>Start backend</button><button className="settings-action" onClick={() => setSwitcher(true)}>Choose another instance</button><button className="settings-action" onClick={() => setShowUsage(true)}>View Unified Usage</button></div></section></div>}
      {!ready && <main className="connect-welcome"><section>
        <img src={pixiceIcon} alt="" width="48" height="48" /><h1>Pixice Connect</h1>
        <p>{instance ? `Opening ${instance.name}…` : 'Your projects, wherever you are.'}</p>
        {state.error && <p role="alert" className="connect-error">{state.error}</p>}
        {instance && <button className="settings-action" onClick={() => setRetry((value) => value + 1)}><ArrowClockwise size={14} /> Retry connection</button>}
        {instances.length > 0 && <button className="settings-action" onClick={() => setShowUsage(true)}>View Unified Usage</button>}
        {needsWelcome && <><InstanceList /><button className="settings-action primary" onClick={() => setPairing(true)}><Plus size={14} /> Add instance</button></>}
        {!needsWelcome && <button className="settings-action" onClick={() => setSwitcher(true)}>Choose another instance</button>}
      </section></main>}
      {ready && active && <div className="connect-instance-bar" data-state={state.state}><button onClick={() => setSwitcher(true)}><Globe size={13} />{instance?.name}<span role="status" title={state.error}>{state.state === 'connected' ? 'Connected' : state.state === 'unauthorized' ? 'Pair again' : 'Reconnecting…'}</span></button>{state.state === 'unauthorized' && <button onClick={() => setPairing(true)}>Pair again</button>}</div>}
    </div>
    {switcher && <div className="connect-modal-backdrop"><section className="connect-modal settings-card" role="dialog" aria-modal="true" aria-label="Switch instance"><header><h2>Instances</h2><button className="settings-action" aria-label="Close instances" onClick={() => setSwitcher(false)}><X size={16} /></button></header><InstanceList compact /><button className="settings-action" onClick={() => { setSwitcher(false); setPairing(true); }}><Plus size={14} /> Add instance</button></section></div>}
    {pairing && <div className="connect-modal-backdrop"><section className="connect-modal settings-card" role="dialog" aria-modal="true" aria-label="Pair instance"><header><h2>Add instance</h2></header><PairForm initialLink={initialPair.current} onCancel={() => { initialPair.current = ''; setPairing(false); }} onPaired={(paired) => { initialPair.current = ''; setPairing(false); setInstances(savedInstances()); if (active === paired.id) setRetry((value) => value + 1); else select(paired.id); }} /></section></div>}
    {folderRequest && clientRef.current && <FolderPicker client={clientRef.current} onClose={(folders) => { folderRequest.resolve(folders); setFolderRequest(null); }} />}
  </ConnectContext.Provider>;
}
