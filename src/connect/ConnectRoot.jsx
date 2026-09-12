import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LOCAL_HOST_ID, createRemoteClientRegistry, savedInstances, pairInstance, forgetInstance } from './client.js';
import { createWorkspaceStorage } from './execution-storage.js';
import { useConnectOverview, ConnectOverviewView } from './ConnectOverview.jsx';
import { ObserverWorkspace } from './observer-workspace.jsx';
import { RecoveryWorkspace } from './recovery-workspace.jsx';
import { loadRecoveryRecords, recoveryRecordKey, sanitizeRecoveryRecord, saveRecoveryRecords } from './recovery.js';
import { parseConnectDeepLink, routeConnectDeepLink } from './pairing-links.js';
import { CaretDown, Check, Desktop, Globe, Plus, X, Folder, ArrowClockwise } from '../components/icons/index.jsx';
import pixiceIcon from '../assets/pixice-icon.png';
import './connect.css';
const ConnectContext = createContext(null);
export const useConnect = () => useContext(ConnectContext);
const ACTIVE_KEY = 'pixice.connect.active';
const LOCAL_ACTIVE_SENTINEL = '__pixice_local__';
const UsagePage = lazy(() => import('../App.jsx').then((module) => ({ default: module.UsagePage })));
const ExecutionThreadWorkspace = lazy(() => import('./execution-workspace.jsx').then((module) => ({ default: module.ExecutionThreadWorkspace })));

function equalClientState(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => {
    const a = left[key]; const b = right[key];
    return a && b && typeof a === 'object' || a === b
      ? JSON.stringify(a) === JSON.stringify(b)
      : false;
  });
}

function recoveryStatusKey(record) {
  return recoveryRecordKey(record);
}

function sessionStorageOrNull() {
  try { return globalThis.sessionStorage; } catch { return null; }
}

function readActiveHostId() {
  const instances = savedInstances();
  const session = sessionStorageOrNull();
  const current = session?.getItem(ACTIVE_KEY);
  if (current === LOCAL_ACTIVE_SENTINEL) return null;
  if (current && instances.some((instance) => instance.id === current)) return current;
  // One-time migration for tabs opened before environment selection became
  // tab-local. Keep the old value intact so another existing tab is not
  // changed under its feet.
  const legacy = localStorage.getItem(ACTIVE_KEY);
  if (legacy && instances.some((instance) => instance.id === legacy)) {
    try { session?.setItem(ACTIVE_KEY, legacy); } catch { /* session storage can be unavailable in privacy mode. */ }
    return legacy;
  }
  return null;
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
    <p className="settings-footnote">Create a link in Settings → Connections on the host. Access follows the host-issued pairing role. After connecting, this device shows its authenticated role and project scope. Observer devices can read their allowed projects but cannot run agents or use the host browser.</p>
    {error && <p role="alert" className="connect-error">{error}</p>}
    <div className="connect-actions">{onCancel && <button type="button" className="settings-action" onClick={onCancel}>Cancel</button>}<button className="settings-action primary" disabled={busy || !name.trim()}>{busy ? 'Pairing…' : 'Pair instance'}</button></div>
  </form>;
}

export function InstanceList({ compact = false }) {
  const connect = useConnect();
  if (!connect) return null;
  return <div className={compact ? 'connect-instance-list compact' : 'settings-card connect-instance-list'}>
    {connect.local && <div className="preference-row"><span><strong><Desktop size={14} /> This device</strong><small>Local Pixice instance · {connect.localState?.state ?? 'connected'}</small></span><button className="settings-action" disabled={!connect.active} onClick={() => connect.select(null)}>{connect.active ? 'Open' : 'Current'}</button></div>}
    {connect.instances.map((instance) => <div className="preference-row" key={instance.id}>
      <span><strong><Globe size={14} /> {instance.name}</strong><small>{instance.endpoint} · {instance.role === 'observer' ? `View only${Array.isArray(instance.projectIds) ? ` · ${instance.projectIds.length} project${instance.projectIds.length === 1 ? '' : 's'}` : ''}` : 'Operator access'}</small></span>
      <div className="connect-actions"><button className="settings-action" disabled={connect.active === instance.id} onClick={() => connect.select(instance.id)}>{connect.active === instance.id ? 'Current' : 'Open'}</button><button className="settings-action" aria-label={`Forget ${instance.name}`} onClick={() => connect.forget(instance.id)}>Forget</button></div>
    </div>)}
    {!connect.instances.length && !connect.local && <p className="settings-footnote">Pair an instance to get started.</p>}
  </div>;
}

function environmentStateLabel(state) {
  return {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    error: 'Unavailable',
    unauthorized: 'Unauthorized',
    unavailable: 'Unavailable',
    saved: 'Saved'
  }[state] ?? state ?? 'Saved';
}

function EnvironmentDropdown({ connect, onManage, onOverview, onRecovery }) {
  const options = [
    ...(connect.local ? [{ id: LOCAL_HOST_ID, label: 'This device', state: connect.localState?.state ?? 'connected' }] : []),
    ...connect.instances.map((instance) => ({ id: instance.id, label: instance.name, state: connect.clientStates[instance.id]?.state ?? 'saved' }))
  ];
  const selectedOption = options.find((option) => option.id === (connect.active ?? LOCAL_HOST_ID)) ?? options[0] ?? null;
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const menuItems = () => [...(menuRef.current?.querySelectorAll('[role="menuitemradio"], [role="menuitem"]') ?? [])];
  const focusMenuItem = (index) => menuItems()[index]?.focus?.({ preventScroll: true });
  const closeMenu = ({ restoreFocus = false } = {}) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus?.({ preventScroll: true });
  };
  const invoke = (callback) => {
    closeMenu({ restoreFocus: true });
    callback?.();
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('click', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('click', closeOutside);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    focusMenuItem(options.length ? Math.max(0, options.findIndex((option) => option.id === selectedOption?.id)) : 0);
  }, [open, options.length, selectedOption?.id]);

  const onMenuKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      event.stopPropagation();
      closeMenu();
      return;
    }
    const items = menuItems();
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    const selectedIndex = Math.max(0, options.findIndex((option) => option.id === selectedOption?.id));
    const baseIndex = currentIndex >= 0 ? currentIndex : selectedIndex;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (baseIndex + 1) % items.length
          : (baseIndex - 1 + items.length) % items.length;
    focusMenuItem(nextIndex);
  };

  const chooseEnvironment = (id) => invoke(() => connect.select(id === LOCAL_HOST_ID ? null : id));
  return (
    <div className="connect-environment-bar" data-state={selectedOption?.state}>
      <div className="connect-environment-menu-root" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="connect-environment-trigger"
          aria-label={`Environment: ${selectedOption?.label ?? 'No configured environments'}`}
          title={`Environment: ${selectedOption?.label ?? 'No configured environments'}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (!['Enter', ' ', 'Spacebar', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <span className="connect-environment-trigger-label">{selectedOption?.label ?? 'Add environment'}</span>
          <CaretDown className="connect-environment-trigger-caret" size={12} weight="bold" />
        </button>
        {open && (
          <div id={menuId} ref={menuRef} className="connect-environment-menu" role="menu" aria-label="Environment menu" onKeyDown={onMenuKeyDown}>
            {options.map((option) => {
              const selected = option.id === selectedOption?.id;
              const Icon = option.id === LOCAL_HOST_ID ? Desktop : Globe;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`connect-environment-menu-item${selected ? ' selected' : ''}`}
                  onClick={() => chooseEnvironment(option.id)}
                >
                  <Icon size={15} />
                  <span className="connect-environment-menu-copy"><strong>{option.label}</strong><small>{environmentStateLabel(option.state)}</small></span>
                  <span className="connect-environment-menu-check">{selected && <Check size={13} weight="bold" />}</span>
                </button>
              );
            })}
            <div className="connect-environment-menu-divider" role="separator" />
            <button type="button" role="menuitem" className="connect-environment-menu-item" onClick={() => invoke(onOverview)}>Overview</button>
            {connect.recoveryCount > 0 && <button type="button" role="menuitem" className="connect-environment-menu-item" onClick={() => invoke(onRecovery)}>Recovery <small>{connect.recoveryCount}</small></button>}
            <button type="button" role="menuitem" className="connect-environment-menu-item" onClick={() => invoke(onManage)}><Plus size={15} />Add or manage</button>
          </div>
        )}
      </div>
    </div>
  );
}

const CONNECT_DIALOG_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const connectDialogStack = [];

function ConnectDialog({ backdropClassName, dialogClassName, ariaLabel, onClose, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const dialogToken = useRef({}).current;
  closeRef.current = onClose;

  useEffect(() => {
    connectDialogStack.push(dialogToken);
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll(CONNECT_DIALOG_FOCUSABLE) ?? [])];
    const isTopmost = () => connectDialogStack.at(-1) === dialogToken;
    const focusFirst = () => { if (isTopmost()) (focusable()[0] ?? dialog)?.focus?.({ preventScroll: true }); };
    const usesAnimationFrame = typeof window.requestAnimationFrame === 'function';
    const frame = usesAnimationFrame
      ? window.requestAnimationFrame(focusFirst)
      : window.setTimeout(focusFirst, 0);
    const onKeyDown = (event) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog?.focus?.({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      const active = document.activeElement;
      if (!dialog?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (usesAnimationFrame) window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
      document.removeEventListener('keydown', onKeyDown);
      const index = connectDialogStack.lastIndexOf(dialogToken);
      if (index >= 0) connectDialogStack.splice(index, 1);
      previousFocus?.focus?.();
    };
  }, [dialogToken]);

  return <div className={backdropClassName}><section ref={dialogRef} className={dialogClassName} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1}>{children}</section></div>;
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
  return <ConnectDialog backdropClassName="connect-modal-backdrop" dialogClassName="connect-modal settings-card" ariaLabel="Choose a folder on the host" onClose={() => onClose([])}>
    <header><h2>Choose a host folder</h2><button className="settings-action" aria-label="Cancel folder selection" onClick={() => onClose([])}><X size={16} /></button></header>
    <form className="connect-actions" onSubmit={(event) => { event.preventDefault(); void load(input); }}><input autoFocus aria-label="Host folder path" className="connect-input" value={input} onChange={(event) => setInput(event.target.value)} /><button className="settings-action" disabled={busy}>Go</button></form>
    {error && <p role="alert" className="connect-error">{error}</p>}
    <div className="connect-folder-list" aria-busy={busy}>{directory?.parent !== directory?.path && <button disabled={busy} onClick={() => load(directory.parent)}>..</button>}{directory?.directories.map((entry) => <button key={entry.path} disabled={busy} onClick={() => load(entry.path)}><Folder size={15} />{entry.name}</button>)}</div>
    <div className="connect-actions"><button className="settings-action" onClick={() => onClose([])}>Cancel</button><button className="settings-action primary" disabled={busy || !directory || Boolean(error)} onClick={() => onClose([directory.path])}>Use this folder</button></div>
  </ConnectDialog>;
}

function OverviewPanel({ connect, onClose, onOpen } = {}) {
  const localApi = connect.local ? globalThis.window?.pixice : undefined;
  const { snapshot, loading, error, refresh } = useConnectOverview({ instances: connect.instances, localApi });
  return <ConnectDialog backdropClassName="connect-panel-backdrop" dialogClassName="connect-panel settings-card" ariaLabel="Connect overview" onClose={onClose}>
    <header><div><h2>Overview</h2><p>Host and task status from the latest check.</p></div><button type="button" className="settings-action" onClick={onClose}>Close</button></header>
    <ConnectOverviewView snapshot={snapshot} loading={loading} error={error} refresh={refresh} onOpen={onOpen} onOpenEnvironment={(hostId) => { connect.select(hostId); onClose(); }} />
  </ConnectDialog>;
}

function RecoveryPanel({ records, statuses, onCheck, onDismiss, onOpen, onClose }) {
  return <ConnectDialog backdropClassName="connect-panel-backdrop" dialogClassName="connect-panel settings-card" ariaLabel="Connect recovery" onClose={onClose}>
    <header><h2>Recovery</h2><button type="button" className="settings-action" onClick={onClose}>Close</button></header>
    <RecoveryWorkspace records={records} statuses={statuses} onCheck={onCheck} onDismiss={onDismiss} onOpen={onOpen} />
  </ConnectDialog>;
}

export function ConnectRoot({ children }) {
  const local = Boolean(window.pixice);
  const initialPair = useRef(null);
  if (initialPair.current === null) {
    initialPair.current = new URLSearchParams(window.location.hash.slice(1)).has('pair') ? window.location.href : '';
    if (initialPair.current) history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const [instances, setInstances] = useState(savedInstances);
  const [active, setActive] = useState(readActiveHostId);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState({ state: 'connecting' });
  const [localState, setLocalState] = useState({ state: window.pixice?.service ? 'connecting' : 'connected' });
  const [retry, setRetry] = useState(0);
  const [pairing, setPairing] = useState(Boolean(initialPair.current));
  const [switcher, setSwitcher] = useState(false);
  const [folderRequest, setFolderRequest] = useState(null);
  const [showUsage, setShowUsage] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [observerTarget, setObserverTarget] = useState(null);
  const [navigationNotice, setNavigationNotice] = useState('');
  const navigationHandledRef = useRef(false);
  const [usageDays, setUsageDays] = useState(30);
  const [clientStates, setClientStates] = useState({});
  const [hostCatalogs, setHostCatalogs] = useState({});
  const [execution, setExecution] = useState(null);
  const executionRequestRef = useRef(null);
  const executionRequestSequenceRef = useRef(0);
  const openExecutionRef = useRef(null);
  const originRef = useRef({ hostId: LOCAL_HOST_ID, projectId: null, hostLabel: 'This device' });
  const recoveryStorage = useMemo(() => createWorkspaceStorage(LOCAL_HOST_ID), []);
  const [recoveryRecords, setRecoveryRecords] = useState(() => loadRecoveryRecords(recoveryStorage));
  const recoveryRecordsRef = useRef(recoveryRecords);
  recoveryRecordsRef.current = recoveryRecords;
  const [recoveryStatuses, setRecoveryStatuses] = useState({});
  const recoveryHandlerRef = useRef(null);
  const storage = useMemo(() => createWorkspaceStorage(active ?? LOCAL_HOST_ID), [active]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mountedRootRef = useRef(true);
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const registryRef = useRef(null);
  if (!registryRef.current) {
    registryRef.current = createRemoteClientRegistry({
      getInstance: (id) => instancesRef.current.find((candidate) => candidate.id === id),
      getOrigin: (id) => registryRef.current?.get(id)?.origin ?? (originRef.current.hostId === id ? originRef.current : null),
      onState: (id, value) => {
        setClientStates((currentStates) => equalClientState(currentStates[id], value) ? currentStates : { ...currentStates, [id]: value });
        if (id === activeRef.current) setState((current) => equalClientState(current, value) ? current : value);
        if (value?.commandId) setRecoveryOpen(true);
      },
      onCommandIssued: (id, descriptor) => recoveryHandlerRef.current?.('issued', id, descriptor),
      onCommandSettled: (id, descriptor) => recoveryHandlerRef.current?.('settled', id, descriptor),
      onCommandUncertain: (id, descriptor) => recoveryHandlerRef.current?.(id, descriptor),
      pickFolders: () => new Promise((resolve) => setFolderRequest({ resolve }))
    });
  }
  const clientRef = useRef(null);
  const instance = instances.find((item) => item.id === active);

  function stampedRecoveryRecord(hostId, descriptor) {
    const saved = instancesRef.current.find((candidate) => candidate.id === hostId);
    return sanitizeRecoveryRecord(descriptor, { hostId, deviceId: saved?.deviceId });
  }

  function persistRecoveryRecords(nextRecords) {
    const persisted = saveRecoveryRecords(nextRecords, recoveryStorage);
    recoveryRecordsRef.current = persisted;
    setRecoveryRecords(persisted);
    return persisted;
  }

  function recordRecovery(hostId, descriptor) {
    const safe = stampedRecoveryRecord(hostId, descriptor);
    if (!safe) return;
    const next = [...recoveryRecordsRef.current.filter((record) => recoveryRecordKey(record) !== recoveryRecordKey(safe)), safe];
    persistRecoveryRecords(next);
  }

  function settleRecovery(hostId, descriptor) {
    const safe = stampedRecoveryRecord(hostId, descriptor);
    if (!safe) return;
    const next = recoveryRecordsRef.current.filter((record) => !(record.hostId === safe.hostId && record.deviceId === safe.deviceId && record.commandId === safe.commandId && record.backendInstanceId === safe.backendInstanceId));
    if (next.length !== recoveryRecordsRef.current.length) persistRecoveryRecords(next);
  }

  function handleRecoveryEvent(kind, hostId, descriptor) {
    if (kind === 'issued') recordRecovery(hostId, descriptor);
    else if (kind === 'settled') settleRecovery(hostId, descriptor);
    else recordRecovery(hostId, descriptor);
  }
  recoveryHandlerRef.current = (kindOrHostId, hostIdOrDescriptor, maybeDescriptor) => {
    if (kindOrHostId === 'issued' || kindOrHostId === 'settled') handleRecoveryEvent(kindOrHostId, hostIdOrDescriptor, maybeDescriptor);
    else handleRecoveryEvent('uncertain', kindOrHostId, hostIdOrDescriptor);
  };

  function ensureRemoteClient(id, force = false) {
    const entry = registryRef.current.ensure(id, { force });
    entry.connecting.catch((cause) => {
      if (registryRef.current.get(id) !== entry || entry.client.closed) return;
      const value = { state: 'error', error: cause.message, connected: false };
      setClientStates((currentStates) => equalClientState(currentStates[id], value) ? currentStates : { ...currentStates, [id]: value });
    });
    entry.connecting.then(() => {
      if (registryRef.current.get(id) !== entry || entry.client.closed) return;
      for (const descriptor of entry.client.listUncertainCommands?.() ?? []) recoveryHandlerRef.current?.(id, descriptor);
    }).catch(() => {});
    return entry;
  }

  useEffect(() => {
    mountedRootRef.current = true;
    return () => {
      mountedRootRef.current = false;
      closeExecution();
      registryRef.current?.close();
    };
  }, []);

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
    const entry = ensureRemoteClient(instance.id, retry > 0);
    const client = entry.client;
    clientRef.current = client;
    // This is the only place that changes the whole-environment global.
    window.pixiceRemote = client.api;
    entry.connecting.then(() => {
      if (disposed) return;
      const connectedState = { state: 'connected', connected: true, role: entry.client.api.remote?.role ?? instance.role ?? 'operator', projectIds: entry.client.api.remote?.projectIds ?? instance.projectIds ?? null, readiness: entry.client.api.remote?.readiness ?? null };
      setClientStates((currentStates) => equalClientState(currentStates[instance.id], connectedState) ? currentStates : { ...currentStates, [instance.id]: connectedState });
      setState((current) => equalClientState(current, connectedState) ? current : connectedState);
      setReady(true);
    }).catch((error) => { if (!disposed) setState({ state: 'error', connected: false, error: error.message }); });
    return () => { disposed = true; if (window.pixiceRemote === client.api) delete window.pixiceRemote; };
  }, [active, instance?.endpoint, instance?.token, retry, local]);

  useEffect(() => {
    if (!window.pixice?.service) return;
    let disposed = false;
    window.pixice.service.connection().then((value) => { if (!disposed) setLocalState(value); }).catch((error) => { if (!disposed) setLocalState({ state: 'error', error: error.message }); });
    const unsubscribe = window.pixice.events.subscribe((event) => {
      if (event.type === 'ServiceConnectionState') setLocalState(event.payload);
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  async function startLocalService() {
    setLocalState({ state: 'connecting' });
    try { await window.pixice.service.start(); }
    catch (error) { setLocalState({ state: 'error', error: error.message }); }
  }
  function select(id) {
    if (active === id) { setSwitcher(false); return; }
    // The origin application is changing environments. Close only the local
    // execution view; the target client remains in the registry so its turn
    // can finish without being retargeted to the new origin.
    closeExecution();
    const originHostId = id ?? LOCAL_HOST_ID;
    const originHostLabel = originHostId === LOCAL_HOST_ID
      ? 'This device'
      : instancesRef.current.find((candidate) => candidate.id === originHostId)?.name ?? originHostId;
    originRef.current = { hostId: originHostId, projectId: null, hostLabel: originHostLabel };
    registryRef.current?.setOrigin(originHostId, originRef.current);
    setReady(false);
    setSwitcher(false);
    try {
      sessionStorageOrNull()?.setItem(ACTIVE_KEY, id || LOCAL_ACTIVE_SENTINEL);
    } catch { /* The active host remains in memory when session storage is blocked. */ }
    setActive(id);
  }

  function beginExecutionRequest(request) {
    cancelExecutionRequest(executionRequestRef.current, new DOMException('The execution request was superseded.', 'AbortError'));
    const requestId = ++executionRequestSequenceRef.current;
    const hasInitialSubmission = Boolean(request?.initialPrompt?.trim() || request?.initialAttachments?.length);
    const controller = new AbortController();
    const originalSignal = request?.submissionSignal;
    let resolve;
    const promise = new Promise((nextResolve) => { resolve = nextResolve; });
    const current = {
      requestId,
      targetHostId: request?.hostId ?? null,
      hasInitialSubmission,
      resolve,
      promise,
      settled: false,
      controller,
      submissionSignal: controller.signal,
      originalSignal,
      originalAbortHandler: null
    };
    current.originalAbortHandler = () => cancelExecutionRequest(current, originalSignal?.reason ?? new DOMException('The execution submission was cancelled.', 'AbortError'));
    executionRequestRef.current = current;
    if (originalSignal?.aborted) current.originalAbortHandler();
    else originalSignal?.addEventListener?.('abort', current.originalAbortHandler, { once: true });
    setExecution(null);
    setObserverTarget(null);
    return current;
  }

  function isCurrentExecutionRequest(requestId) {
    const current = executionRequestRef.current;
    return current?.requestId === requestId && !current.settled && !current.submissionSignal.aborted;
  }

  function cleanupExecutionRequest(current) {
    current?.originalSignal?.removeEventListener?.('abort', current.originalAbortHandler);
    if (current) current.originalAbortHandler = null;
  }

  function cancelExecutionRequest(current, reason) {
    if (!current || current.settled) return false;
    current.controller.abort(reason);
    current.settled = true;
    if (executionRequestRef.current === current) executionRequestRef.current = null;
    cleanupExecutionRequest(current);
    current.resolve(false);
    return true;
  }

  function settleExecutionRequest(requestId, accepted) {
    const current = executionRequestRef.current;
    if (!current || current.requestId !== requestId || current.settled) return false;
    current.settled = true;
    executionRequestRef.current = null;
    cleanupExecutionRequest(current);
    current.resolve(Boolean(accepted));
    return true;
  }

  async function openExecution(request) {
    const pending = beginExecutionRequest(request ?? {});
    if (!isCurrentExecutionRequest(pending.requestId)) return pending.promise;
    const targetHostId = request?.hostId;
    if (!targetHostId || !request?.projectId) {
      settleExecutionRequest(pending.requestId, false);
      throw new Error('Choose a target environment and project before starting.');
    }
    const origin = {
      originHostId: request.originHostId ?? originRef.current.hostId,
      originHostLabel: request.originHostLabel ?? originRef.current.hostLabel,
      originProjectId: request.originProjectId ?? originRef.current.projectId
    };
    try {
      if (targetHostId === LOCAL_HOST_ID) {
        if (!window.pixice) throw new Error('This device is not available as an execution host.');
        if (!isCurrentExecutionRequest(pending.requestId)) return false;
        setExecution({ ...request, ...origin, hostId: LOCAL_HOST_ID, api: window.pixice, hostLabel: 'This device', requestId: pending.requestId, submissionSignal: pending.submissionSignal });
        if (!pending.hasInitialSubmission) settleExecutionRequest(pending.requestId, true);
        return pending.promise;
      }
      const target = instances.find((candidate) => candidate.id === targetHostId);
      if (!target) throw new Error('That saved environment is no longer available.');
      const entry = ensureRemoteClient(targetHostId);
      registryRef.current.setOrigin(targetHostId, { hostId: origin.originHostId, projectId: origin.originProjectId, hostLabel: origin.originHostLabel });
      await entry.connecting;
      if (!isCurrentExecutionRequest(pending.requestId)) return false;
      const targetRole = entry.client.api.remote?.role ?? target.role ?? 'operator';
      if (targetRole === 'observer') {
        if (pending.hasInitialSubmission) throw new Error('This environment is view-only. Observer instances cannot run tasks.');
        if (request.threadId && entry.client.api.threads?.read) {
          await entry.client.api.threads.read({ projectId: request.projectId, threadId: request.threadId });
          if (!isCurrentExecutionRequest(pending.requestId)) return false;
        }
        setObserverTarget({ ...request, ...origin, hostId: targetHostId, api: entry.client.api, hostLabel: target.name, projectIds: entry.client.api.remote?.projectIds ?? target.projectIds ?? [] });
        settleExecutionRequest(pending.requestId, true);
        return pending.promise;
      }
      if (!isCurrentExecutionRequest(pending.requestId)) return false;
      setExecution({ ...request, ...origin, hostId: targetHostId, api: entry.client.api, hostLabel: target.name, requestId: pending.requestId, submissionSignal: pending.submissionSignal });
      if (!pending.hasInitialSubmission) settleExecutionRequest(pending.requestId, true);
      return pending.promise;
    } catch (cause) {
      if (!isCurrentExecutionRequest(pending.requestId)) return pending.promise;
      settleExecutionRequest(pending.requestId, false);
      throw cause;
    }
  }
  openExecutionRef.current = openExecution;
  async function loadHostCatalog(id) {
    if (!id) return null;
    const entry = id === LOCAL_HOST_ID ? null : ensureRemoteClient(id);
    if (entry) await entry.connecting;
    const api = id === LOCAL_HOST_ID ? window.pixice : entry?.client.api;
    if (!api?.app?.bootstrap) return null;
    const result = await api.app.bootstrap();
    let providers = result.providers ?? [];
    if (!providers.length && api.providers?.list) {
      try { providers = await api.providers.list(); } catch { /* Observer or older hosts may not expose provider details. */ }
    }
    const catalog = { projects: result.projects ?? [], models: result.models ?? [], providers, runtime: result.runtime ?? null, role: api.remote?.role ?? null, projectIds: api.remote?.projectIds ?? null, readiness: api.remote?.readiness ?? null };
    setHostCatalogs((current) => ({ ...current, [id]: catalog }));
    return catalog;
  }
  function closeExecution() {
    cancelExecutionRequest(executionRequestRef.current, new DOMException('The execution request was closed.', 'AbortError'));
    setExecution(null);
    setObserverTarget(null);
  }
  function closeObserver() { setObserverTarget(null); }
  const settleExecution = useCallback((accepted) => {
    if (!execution?.requestId) return;
    settleExecutionRequest(execution.requestId, accepted);
  }, [execution?.requestId]);

  async function checkRecovery(record) {
    const key = recoveryStatusKey(record);
    setRecoveryStatuses((current) => ({ ...current, [key]: { ...(current[key] ?? {}), state: 'pending', busy: true } }));
    const instanceForRecord = instancesRef.current.find((candidate) => candidate.id === record.hostId);
    if (!instanceForRecord) {
      setRecoveryStatuses((current) => ({ ...current, [key]: { state: 'unknown', message: 'This host was forgotten or is no longer paired.' } }));
      return;
    }
    if (!record.deviceId || instanceForRecord.deviceId !== record.deviceId) {
      setRecoveryStatuses((current) => ({ ...current, [key]: { state: 'unknown', message: 'The saved pairing changed, so the original receipt is inaccessible from this device.' } }));
      return;
    }
    try {
      const entry = ensureRemoteClient(record.hostId);
      await entry.connecting;
      if (entry.client.instanceId && record.backendInstanceId && entry.client.instanceId !== record.backendInstanceId) {
        setRecoveryStatuses((current) => ({ ...current, [key]: { state: 'unknown', message: 'The host restarted after this command was issued, so its outcome is unknown.' } }));
        return;
      }
      const result = await entry.client.commandStatus(record.commandId, record.backendInstanceId);
      if (result?.currentInstanceId && record.backendInstanceId && result.currentInstanceId !== record.backendInstanceId) {
        setRecoveryStatuses((current) => ({ ...current, [key]: { state: 'unknown', message: 'The host restarted after this command was issued, so its outcome is unknown.' } }));
        return;
      }
      const status = result?.status === 'completed' ? 'completed' : result?.status === 'failed' ? 'failed' : result?.status === 'pending' ? 'pending' : 'unknown';
      const trustedSummaryThreadId = result?.result?.resultSummary?.threadId ?? result?.result?.summary?.threadId;
      const safeThreadId = status === 'completed' && ['threads.create', 'threads.fork'].includes(record.operation)
        ? (result?.result?.truncated ? trustedSummaryThreadId : result?.result?.thread?.id ?? result?.result?.threadId ?? trustedSummaryThreadId)
        : record.operation === 'turns.start' ? record.threadId : null;
      if (safeThreadId && typeof safeThreadId === 'string' && !record.threadId) {
        const nextRecord = sanitizeRecoveryRecord({ ...record, threadId: safeThreadId });
        if (nextRecord) persistRecoveryRecords(recoveryRecordsRef.current.map((item) => recoveryRecordKey(item) === key ? nextRecord : item));
      }
      const message = result?.error ?? (status === 'unknown' ? result?.meaning ?? 'The host cannot prove whether this command ran.' : '');
      setRecoveryStatuses((current) => ({ ...current, [key]: { state: status, result: status === 'completed' && !result?.result?.truncated ? result?.result ?? null : null, message } }));
    } catch (cause) {
      setRecoveryStatuses((current) => ({ ...current, [key]: { state: cause.status === 404 ? 'older-host-unsupported' : 'offline', message: cause.message } }));
    }
  }

  function dismissRecovery(record) {
    const key = recoveryStatusKey(record);
    persistRecoveryRecords(recoveryRecordsRef.current.filter((candidate) => recoveryRecordKey(candidate) !== key));
    setRecoveryStatuses((current) => { const next = { ...current }; delete next[key]; return next; });
  }

  async function openRecoveryTask(record) {
    if (!record.projectId || !record.threadId) return;
    try {
      const accepted = await openExecution({ hostId: record.hostId, projectId: record.projectId, threadId: record.threadId, originHostId: record.originHostId, originProjectId: record.originProjectId });
      if (accepted !== false) setRecoveryOpen(false);
    } catch (cause) { setNavigationNotice(cause.message); }
  }

  async function routeTarget(target) {
    if (!target?.hostId) return;
    await openExecutionRef.current?.(target);
  }

  useEffect(() => {
    if (window.location.pathname !== '/') return;
    if (navigationHandledRef.current) return;
    navigationHandledRef.current = true;
    let target;
    try { target = routeConnectDeepLink({ location: window.location }); }
    catch (cause) { setNavigationNotice(cause.message); return; }
    if (!target) return;
    const url = new URL(window.location.href);
    ['connectHost', 'connectProject', 'connectThread'].forEach((key) => url.searchParams.delete(key));
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (target.hostId !== LOCAL_HOST_ID && !instancesRef.current.some((candidate) => candidate.id === target.hostId)) {
      setNavigationNotice('This Connect link targets an unknown or forgotten host. Pair that host again before opening it.');
      return;
    }
    void routeTarget(target).catch((cause) => setNavigationNotice(cause.message));
  }, []);

  useEffect(() => {
    const expected = new URL('/connect-sw.js', window.location.href).href;
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const sourceUrl = event.source?.scriptURL ?? event.source?.url;
      if (sourceUrl !== expected || event.data?.type !== 'pixice-connect-open') return;
      let target;
      try {
        const value = event.data.target;
        const query = new URLSearchParams({ ...(value?.hostId ? { connectHost: value.hostId } : {}), ...(value?.projectId ? { connectProject: value.projectId } : {}), ...(value?.threadId ? { connectThread: value.threadId } : {}) });
        target = parseConnectDeepLink(`${window.location.origin}/?${query.toString()}`, { origin: window.location.origin });
      } catch (cause) { setNavigationNotice(cause.message); return; }
      if (!target || target.hostId !== LOCAL_HOST_ID && !instancesRef.current.some((candidate) => candidate.id === target.hostId)) {
        setNavigationNotice('This notification targets an unknown or forgotten host. Pair it again before opening it.');
        return;
      }
      void routeTarget(target).catch((cause) => setNavigationNotice(cause.message));
    };
    navigator.serviceWorker?.addEventListener?.('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener?.('message', onMessage);
  }, []);
  const executionTransportState = execution
    ? execution.hostId === LOCAL_HOST_ID
      ? localState
      : clientStates[execution.hostId] ?? { state: 'connecting', connected: false }
    : null;
  const activeRemoteClient = active ? registryRef.current.get(active)?.client : null;
  const activeRole = active ? clientStates[active]?.role ?? instance?.role ?? activeRemoteClient?.api?.remote?.role : 'operator';
  const activeObserver = activeRole === 'observer';
  const registerOrigin = useCallback((value = {}) => {
    const hostId = value.hostId ?? activeRef.current ?? LOCAL_HOST_ID;
    const projectId = typeof value.projectId === 'string' && value.projectId ? value.projectId : null;
    const origin = {
      hostId,
      projectId,
      hostLabel: value.hostLabel ?? (hostId === LOCAL_HOST_ID ? 'This device' : instancesRef.current.find((item) => item.id === hostId)?.name ?? hostId)
    };
    originRef.current = origin;
    registryRef.current?.setOrigin(hostId, origin);
  }, []);
  const context = { local, active, instances, state, storage, execution,
    localState, clientStates, hostCatalogs, recoveryCount: recoveryRecords.length,
    select,
    add: () => setPairing(true),
    openOverview: () => setShowOverview(true),
    openRecovery: () => setRecoveryOpen(true),
    registerOrigin,
    forget: (id) => {
      if (execution?.hostId === id || executionRequestRef.current?.targetHostId === id) closeExecution();
      registryRef.current.forget(id);
      forgetInstance(id);
      setInstances(savedInstances());
      setClientStates((current) => { const next = { ...current }; delete next[id]; return next; });
      if (id === active) select(null);
    },
    retry: () => setRetry((value) => value + 1),
    ensureClient: (id) => ensureRemoteClient(id).client,
    getApi: (id) => id === LOCAL_HOST_ID ? window.pixice : registryRef.current.get(id)?.client.api,
    loadHostCatalog,
    openExecution,
    closeExecution,
    closeObserver,
    executionView: execution ? <ExecutionThreadWorkspace key={`${execution.hostId}:${execution.projectId}:${execution.threadId ?? 'draft'}:${execution.requestId}`} {...execution} transportState={executionTransportState} onInitialSubmissionOutcome={settleExecution} onClose={closeExecution} /> : null
  };
  const overlays = <>
    {switcher && <ConnectDialog backdropClassName="connect-modal-backdrop" dialogClassName="connect-modal settings-card" ariaLabel="Switch instance" onClose={() => setSwitcher(false)}>
      <header><h2>Instances</h2><button className="settings-action" aria-label="Close instances" onClick={() => setSwitcher(false)}><X size={16} /></button></header>
      <InstanceList compact />
      <button className="settings-action" onClick={() => { setSwitcher(false); setPairing(true); }}><Plus size={14} /> Add instance</button>
    </ConnectDialog>}
    {pairing && <ConnectDialog backdropClassName="connect-modal-backdrop" dialogClassName="connect-modal settings-card" ariaLabel="Pair instance" onClose={() => { initialPair.current = ''; setPairing(false); }}>
      <header><h2>Add instance</h2></header>
      <PairForm initialLink={initialPair.current} onCancel={() => { initialPair.current = ''; setPairing(false); }} onPaired={(paired) => { initialPair.current = ''; setPairing(false); setInstances(savedInstances()); if (active === paired.id) setRetry((value) => value + 1); else select(paired.id); }} />
    </ConnectDialog>}
    {observerTarget && <div className="connect-observer-overlay"><div className="connect-observer-overlay-toolbar"><strong>Observer view</strong><button type="button" className="settings-action" aria-label="Close observer view" onClick={closeObserver}><X size={14} />Close</button></div><ObserverWorkspace api={observerTarget.api} hostId={observerTarget.hostId} hostLabel={observerTarget.hostLabel} projectIds={observerTarget.projectIds} initialProjectId={observerTarget.projectId} initialThreadId={observerTarget.threadId} onOpenOverview={() => setShowOverview(true)} /></div>}
    {showOverview && <OverviewPanel connect={context} onClose={() => setShowOverview(false)} onOpen={(target) => { void routeTarget(target).catch((cause) => setNavigationNotice(cause.message)); setShowOverview(false); }} />}
    {recoveryOpen && <RecoveryPanel records={recoveryRecords} statuses={recoveryStatuses} onCheck={checkRecovery} onDismiss={dismissRecovery} onOpen={openRecoveryTask} onClose={() => setRecoveryOpen(false)} />}
    {folderRequest && clientRef.current && <FolderPicker client={clientRef.current} onClose={(folders) => { folderRequest.resolve(folders); setFolderRequest(null); }} />}
  </>;
  if (showUsage) return <ConnectContext.Provider value={context}><div className="connect-root"><EnvironmentDropdown connect={context} onManage={() => setSwitcher(true)} onOverview={() => setShowOverview(true)} onRecovery={() => setRecoveryOpen(true)} /><main className="connect-saved-usage"><div className="settings-content usage-settings-content"><header><button className="settings-action" onClick={() => setShowUsage(false)}>Back to connections</button><h1>Usage</h1></header><Suspense fallback={<p>Opening saved usage…</p>}><UsagePage unifiedOnly rangeDays={usageDays} onRangeChange={setUsageDays} /></Suspense></div></main>{overlays}</div></ConnectContext.Provider>;
  const needsWelcome = !ready && (!instance || state.state === 'error');
  return <ConnectContext.Provider value={context}>
    <div className={`connect-root${active ? ' is-remote' : ''}`}>
      <EnvironmentDropdown connect={context} onManage={() => setSwitcher(true)} onOverview={() => setShowOverview(true)} onRecovery={() => setRecoveryOpen(true)} />
      {navigationNotice && <div className="connect-navigation-notice" role="alert">{navigationNotice}<button type="button" onClick={() => setNavigationNotice('')}>Dismiss</button></div>}
      {ready && <div key={active || 'local'} className="connect-application">{activeObserver ? <div className={`connect-observer-layout${execution ? ' has-execution' : ''}`}>
        <div className="connect-observer-origin" aria-hidden={execution ? 'true' : undefined} inert={Boolean(execution)}>
          <ObserverWorkspace api={active ? activeRemoteClient?.api : window.pixice} hostId={active || LOCAL_HOST_ID} hostLabel={instance?.name || 'Observer host'} projectIds={clientStates[active]?.projectIds ?? instance?.projectIds ?? []} onOriginChange={registerOrigin} onOpenOverview={() => setShowOverview(true)} />
        </div>
        {execution && <div className="connect-observer-execution"><Suspense fallback={<p role="status">Opening target task…</p>}>{context.executionView}</Suspense></div>}
      </div> : children}</div>}
      {local && !active && localState.state === 'reconnecting' && <div className="connect-service-notice" role="status" title={[localState.error, localState.diagnostic].filter(Boolean).join(' · ')}>Reconnecting to backend… Your work stays open.</div>}
      {local && !active && !['connected', 'reconnecting'].includes(localState.state) && <div className="connect-service-overlay"><section className="settings-card" role="status"><h2>{localState.state === 'connecting' ? 'Connecting to Pixice…' : 'Backend unavailable'}</h2><p>{localState.error || 'Your projects and saved usage remain on this device.'}</p><div className="connect-actions"><button className="settings-action primary" onClick={startLocalService}>Start backend</button><button className="settings-action" onClick={() => setSwitcher(true)}>Choose another instance</button><button className="settings-action" onClick={() => setShowUsage(true)}>View Unified Usage</button></div></section></div>}
      {!ready && <main className="connect-welcome"><section>
        <img src={pixiceIcon} alt="" width="48" height="48" /><h1>Pixice Connect</h1>
        <p>{instance ? `Opening ${instance.name}…` : 'Your projects, wherever you are.'}</p>
        {state.error && <p role="alert" className="connect-error">{state.error}</p>}
        {instance && <button className="settings-action" onClick={() => setRetry((value) => value + 1)}><ArrowClockwise size={14} /> Retry connection</button>}
        {instances.length > 0 && <button className="settings-action" onClick={() => setShowUsage(true)}>View Unified Usage</button>}
        {needsWelcome && <><InstanceList /><button className="settings-action primary" onClick={() => setPairing(true)}><Plus size={14} /> Add instance</button></>}
        {!needsWelcome && <button className="settings-action" onClick={() => setSwitcher(true)}>Choose another instance</button>}
      </section></main>}
    </div>
    {overlays}
  </ConnectContext.Provider>;
}
