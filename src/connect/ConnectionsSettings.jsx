import { useEffect, useRef, useState } from 'react';
import { Plus, Globe, ArrowClockwise } from '../components/icons/index.jsx';
import { InstanceList, useConnect } from './ConnectRoot.jsx';
import { createPairingQrDataUrl, pairingExpiryLabel, pairingExpired } from './pairing-qr.js';
import { probeEndpoint as probeConnectEndpoint } from './pairing-links.js';
import { createPushClient } from './push-client.js';
import { getInstallState, installHelp, requestInstall, subscribeInstallPrompt } from './push-pwa.js';
import { normalizeEndpoint } from '../../electron/connect/protocol.mjs';
import './mobile-connect.css';

function Group({ title, description, children }) { return <section className="settings-group"><header><h2>{title}</h2>{description && <p>{description}</p>}</header><div className="settings-card">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="preference-row"><span><strong>{title}</strong><small>{description}</small></span><div className="preference-control">{children}</div></div>; }

function PairingQr({ pair }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setSource(''); setError('');
    void createPairingQrDataUrl(pair).then((value) => { if (active) setSource(value); }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [pair]);
  if (error) return <p className="connect-error" role="alert">{error}</p>;
  return source ? <img className="connect-pair-qr" src={source} alt="QR code for this one-time Pixice pairing link" width="220" height="220" /> : <p className="settings-footnote">Creating local QR code…</p>;
}

function BrowserInstallSettings() {
  const [install, setInstall] = useState(() => getInstallState());
  useEffect(() => subscribeInstallPrompt(setInstall), []);
  if (install.standalone) return <Group title="Installed app" description={installHelp()}><Row title="Pixice is installed" description="Open it from your device’s home screen for a standalone workspace." /></Group>;
  return <Group title="Install Pixice" description="The web app can open offline. Actions still require a live host."><Row title="Install on this device" description={install.available ? 'Your browser has an install prompt ready.' : installHelp()}>{install.available ? <button className="settings-action" onClick={() => void requestInstall()}>Install app</button> : <small className="settings-footnote">{install.ios ? 'Safari supports Add to Home Screen from its Share menu.' : 'The browser will show Install app when this HTTPS site meets its install requirements.'}</small>}</Row></Group>;
}

export function BrowserPushSettings({ instance }) {
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setBusy(false);
    if (!instance || globalThis.window?.pixice) { setClient(null); setStatus(null); return undefined; }
    const next = createPushClient({ hostId: instance.id, endpoint: instance.endpoint, token: instance.token });
    setClient(next); setStatus(null);
    void next.status().then((value) => { if (generation.current === current) setStatus(value); }).catch((cause) => { if (generation.current === current) setStatus({ state: 'error', message: cause.message }); });
    return () => { if (generation.current === current) { generation.current += 1; setClient(null); } };
  }, [instance?.endpoint, instance?.id, instance?.token]);
  if (!instance || globalThis.window?.pixice) return null;
  async function enable() {
    if (!client) return;
    const current = generation.current;
    setBusy(true);
    try { const value = await client.enable(); if (generation.current === current) setStatus(value); } catch (cause) {
      if (generation.current === current) {
        const actual = await client.status().catch(() => ({}));
        if (generation.current === current) setStatus({ ...actual, state: actual.state || 'error', message: cause.message, localSubscription: Boolean(actual.localSubscription) });
      }
    } finally { if (generation.current === current) setBusy(false); }
  }
  async function disable() {
    if (!client) return;
    const current = generation.current;
    setBusy(true);
    try { const value = await client.disable(); if (generation.current === current) setStatus(value); } catch (cause) {
      if (generation.current === current) {
        const actual = await client.status().catch(() => ({}));
        if (generation.current === current) setStatus({ ...actual, state: actual.state || 'error', message: cause.message, localSubscription: Boolean(actual.localSubscription ?? cause.localSubscription) });
      }
    } finally { if (generation.current === current) setBusy(false); }
  }
  const enabled = status?.state === 'enabled' && status?.registered === true && status?.localKeyMatches === true;
  const needsRepair = Boolean(status?.needsRepair || (status?.localSubscription && !enabled && status?.state !== 'unverified'));
  const canEnable = Boolean(status && client && status.publicKey && (status.readiness === 'ready' || ['ready', 'enabled', 'repair'].includes(status.state)));
  const message = status?.message || (enabled ? 'This browser is registered for generic Pixice attention notices on this host.' : 'Notifications are off until you enable them here.');
  const hasLocalSubscription = status?.localSubscription === true;
  return <Group title="Browser notifications" description="Opt in separately for each host. Pixice sends generic attention notices that open this receiving client."><Row title="This host" description={message}><button className="settings-action" disabled={busy || !canEnable || enabled} onClick={() => void enable()}>{busy ? 'Working…' : needsRepair ? 'Repair notifications' : 'Enable notifications'}</button>{hasLocalSubscription && <button className="settings-action" disabled={busy} onClick={() => void disable()}>Turn off</button>}</Row>{status?.state === 'denied' && <p className="connect-error" role="alert">Notifications are blocked in this browser. Change the site permission, then try again.</p>}{status?.state === 'unconfigured' && <p className="settings-footnote">The host has no configured notification route or contact details yet.</p>}{status?.state === 'unsupported' && <p className="settings-footnote">This browser cannot provide web push notifications.</p>}</Group>;
}

function deviceExpiry(device) {
  const expiry = new Date(device.expiresAt).getTime();
  const days = Math.ceil((expiry - Date.now()) / 86_400_000);
  if (!Number.isFinite(expiry) || days <= 0) return 'Expired';
  if (days <= 7) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  return `Expires ${new Date(expiry).toLocaleDateString()}`;
}

function deviceAccessDescription(device, projects) {
  const role = device.role === 'operator' ? 'Operator' : device.role === 'observer' ? 'Observer' : 'Access unavailable';
  let scope = 'Project scope unavailable';
  if (device.role === 'operator') scope = 'All projects';
  if (device.role === 'observer') {
    const names = (Array.isArray(device.projectIds) ? device.projectIds : []).map((id) => projects.find((project) => project.id === id)?.name || id);
    scope = `Selected projects: ${names.length ? names.join(', ') : 'none'}`;
  }
  return `${role} · ${scope} · Last seen ${new Date(device.lastSeen).toLocaleString()} · ${deviceExpiry(device)}`;
}

export function ConnectionsSettings() {
  const connect = useConnect();
  const api = globalThis.window?.pixice?.connect;
  const remoteInstance = connect?.active ? connect.instances.find((instance) => instance.id === connect.active) : null;
  const [service, setService] = useState(null);
  const [host, setHost] = useState(null);
  const [url, setUrl] = useState('');
  const [port, setPort] = useState('43187');
  const [name, setName] = useState('');
  const [bind, setBind] = useState('127.0.0.1');
  const [origin, setOrigin] = useState('');
  const [pair, setPair] = useState(null);
  const [role, setRole] = useState('operator');
  const [projectIds, setProjectIds] = useState([]);
  const [projects, setProjects] = useState([]);
  const [probe, setProbe] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const probeGeneration = useRef(0);
  const urlRef = useRef(url);
  urlRef.current = url;
  useEffect(() => {
    probeGeneration.current += 1;
    setProbe(null);
    return () => { probeGeneration.current += 1; };
  }, [api, host?.hostId]);
  async function refresh() {
    if (!api) return;
    if (globalThis.window?.pixice?.service) setService(await globalThis.window.pixice.service.status());
    const status = await api.status();
    const savedUrl = status.publicUrl || '';
    if (urlRef.current !== savedUrl) {
      probeGeneration.current += 1;
      setProbe(null);
    }
    urlRef.current = savedUrl;
    setHost(status); setPair((current) => current && Array.isArray(status.offers) && !status.offers.some((offer) => offer?.id === current.id) ? null : current); setUrl(savedUrl); setPort(String(status.port || 43187)); setName(status.name || ''); setBind(status.host || '127.0.0.1'); setOrigin((status.origins || []).join('\n'));
    const listed = Array.isArray(status.projects) ? status.projects : (await globalThis.window?.pixice?.app?.bootstrap?.())?.projects;
    if (Array.isArray(listed)) {
      const known = listed.filter((project) => project?.id).map((project) => ({ id: project.id, name: project.displayName || project.name || project.id }));
      setProjects(known);
      setProjectIds((current) => current.filter((id) => known.some((project) => project.id === id)));
    }
  }
  useEffect(() => {
    if (!api) return;
    void refresh().catch((cause) => setError(cause.message));
    return globalThis.window.pixice.events.subscribe((event) => { if (event.type === 'ConnectStatus') void refresh().catch((cause) => setError(cause.message)); });
  }, [api]);
  useEffect(() => {
    if (!pair) return undefined;
    const expiry = typeof pair.expiresAt === 'number' ? pair.expiresAt : Date.parse(pair.expiresAt);
    const timer = setTimeout(() => setPair(null), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [pair]);
  async function perform(action) {
    setBusy(true); setError('');
    try { const result = await action(); if (api) await refresh(); return result; }
    catch (cause) { setError(cause.message); return undefined; }
    finally { setBusy(false); }
  }
  async function configure(enabled) {
    setPair(null);
    await api.configure({ enabled, port: Number(port), name, publicUrl: url, host: bind, origins: origin.split('\n').map((value) => value.trim()).filter(Boolean) });
  }
  async function probeEndpoint() {
    const requestedUrl = url;
    const requestedHostId = host?.hostId;
    const requestedApi = api;
    const requestId = ++probeGeneration.current;
    const isCurrentRequest = () => probeGeneration.current === requestId
      && url === requestedUrl
      && host?.hostId === requestedHostId
      && api === requestedApi;
    setProbe({ state: 'checking', message: 'Checking the host identity…', endpoint: requestedUrl, hostId: requestedHostId, requestId });
    try {
      const endpoint = normalizeEndpoint(requestedUrl);
      const info = await probeConnectEndpoint(endpoint);
      if (!isCurrentRequest()) return;
      if (!requestedHostId || info.hostId !== requestedHostId) throw new Error(`Endpoint returned host ${info.hostId || 'no identity'}, expected ${requestedHostId || 'this host'}.`);
      setProbe({ state: 'ok', message: `Verified ${endpoint} belongs to host ${info.hostId}.`, endpoint, hostId: requestedHostId, requestId });
    } catch (cause) {
      if (isCurrentRequest()) setProbe({ state: 'error', message: cause.message, endpoint: requestedUrl, hostId: requestedHostId, requestId });
    }
  }
  const rolesSupported = Boolean(host?.pairing?.roles || host?.features?.connectPairingRoles || host?.capabilities?.connectPairingRoles);
  const renewSupported = Boolean(typeof api?.renew === 'function' && host?.pairing?.renew !== false && host?.features?.connectRenew !== false && host?.capabilities?.connectRenew !== false);
  const canPair = role !== 'observer' || projectIds.length > 0;
  return <>
    <section className="settings-group"><header><h2>Your instances</h2><p>Open another Pixice host with the same projects, tasks, and live agent activity.</p></header><InstanceList /><div className="connect-actions connect-section-actions"><button className="settings-action" onClick={() => connect?.openOverview?.()}>Overview</button><button className="settings-action" onClick={() => connect?.add()}><Plus size={14} /> Add instance</button></div></section>
    {!globalThis.window?.pixice && <BrowserInstallSettings />}
    <BrowserPushSettings instance={remoteInstance} />
    {globalThis.window?.pixice?.service && <Group title="Background backend" description="Tasks, workflows, and remote access continue when you close or quit the interface. Stopping requires all active work to finish first.">
      <Row title="Service" description={service ? `${service.phase === 'ready' ? 'Running' : service.phase} · Process ${service.pid}` : 'Checking backend…'}><div className="connect-actions"><button className="settings-action" disabled={busy} onClick={() => perform(() => globalThis.window.pixice.service.restart())}>Restart backend</button><button className="settings-action" disabled={busy} onClick={() => perform(() => globalThis.window.pixice.service.stop())}>Stop backend</button></div></Row>
      {service?.loginSupported && <Row title="Start at login" description="Starts the backend and native browser helper in the background."><button className="settings-action" disabled={busy || !service} onClick={() => perform(() => globalThis.window.pixice.service.setOpenAtLogin({ enabled: !service.openAtLogin }))}>{service?.openAtLogin ? 'Turn off' : 'Enable'}</button></Row>}
      {service?.native?.error && <p className="settings-footnote">{service.native.error}</p>}
    </Group>}
    {api && <>
      <Group title="This device" description="This desktop controls which projects paired devices can view or operate. Provider accounts and connection administration stay here.">
        <Row title="Remote access" description={host?.running ? `Listening on ${host.host}:${host.port}` : host?.error || 'Off until you enable it.'}><button className={`settings-action${host?.running ? '' : ' primary'}`} disabled={busy || !host} onClick={() => perform(() => configure(!host.running))}>{host?.running ? 'Turn off' : 'Enable remote access'}</button></Row>
        <Row title="Instance name" description="Shown on your other devices."><input aria-label="Instance name" className="connect-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Row>
        <Row title="Listen on" description="Network listeners require a trusted TLS certificate configured on the host."><select className="settings-select" aria-label="Connect bind address" value={bind} onChange={(event) => setBind(event.target.value)}><option value="127.0.0.1">This machine (tunnel)</option><option value="0.0.0.0">Network (TLS required)</option><option value="::1">IPv6 loopback</option></select></Row>
        <Row title="Port" description="The local listener used by your HTTPS tunnel."><input aria-label="Connect port" className="connect-input connect-port" type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></Row>
      </Group>
      <Group title="Access over the web" description="Use a temporary HTTPS tunnel for testing, or point an existing HTTPS reverse proxy or Tailscale HTTPS address at this listener. Pixice does not configure external services for you.">
        <Row title="Temporary HTTPS tunnel" description={host?.tunnel?.error || (host?.tunnel?.state === 'ready' ? `${host.tunnel.url} · this address changes when the tunnel restarts.` : 'Downloads a verified Cloudflare tunnel on first use.')}><button className="settings-action" disabled={busy || !host?.running} onClick={() => perform(async () => { setPair(null); if (host.tunnel?.state === 'ready') await api.stopTunnel(); else await api.startTunnel(); })}><Globe size={14} />{busy ? 'Working…' : host?.tunnel?.state === 'ready' ? 'Stop tunnel' : 'Start tunnel'}</button></Row>
        <Row title="HTTPS endpoint" description="Enter the existing public origin that your reverse proxy or Tailscale HTTPS address serves."><input aria-label="HTTPS endpoint" className="connect-input" value={url} onChange={(event) => { probeGeneration.current += 1; urlRef.current = event.target.value; setUrl(event.target.value); setProbe(null); }} placeholder="https://pixice.example.com" spellCheck={false} /></Row>
        <Row title="Endpoint probe" description={probe?.message || 'Checks this address and compares its host identity before you share a link.'}><button className="settings-action" disabled={busy || !url.trim() || !host?.hostId || probe?.state === 'checking'} onClick={() => void probeEndpoint()}>{probe?.state === 'checking' ? 'Checking…' : 'Probe endpoint'}</button></Row>
        <Row title="Additional web clients" description="Optional: one trusted HTTPS client origin per line. Direct host pages and Pixice desktops already work."><textarea aria-label="Allowed web client origins" className="connect-input" value={origin} onChange={(event) => setOrigin(event.target.value)} rows={2} spellCheck={false} /></Row>
        <Row title="Save connection settings" description="Restarts the listener and reconnects paired devices."><button className="settings-action" disabled={busy || !host} onClick={() => perform(() => configure(host.enabled))}>Save settings</button></Row>
        <div className="connect-endpoint-guide"><strong>Permanent endpoint checklist</strong><p>Keep this endpoint on an existing HTTPS reverse proxy or Tailscale HTTPS hostname. Forward it to the host listener, preserve the <code>/api/connect/</code> paths, and add the browser origin above if it differs from the endpoint. Probe it before creating a pairing link.</p></div>
      </Group>
      <Group title="Pair a device" description="Create one link for each browser or Pixice desktop. Links expire after five minutes and can be used once.">
        {rolesSupported && <fieldset className="connect-pair-options" disabled={busy}><legend>Access for the paired device</legend><label>Role<select aria-label="Pairing role" value={role} onChange={(event) => setRole(event.target.value)}><option value="operator">Operator · all projects on this host</option><option value="observer">Observer · selected projects only</option></select></label>{role === 'operator' ? <span className="settings-footnote">Operators can use every project on this host.</span> : <><span className="settings-footnote">Observers can view only the projects you select.</span><div className="connect-project-options" aria-label="Projects available to paired device">{projects.map((project) => <label key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={(event) => setProjectIds((current) => event.target.checked ? [...new Set([...current, project.id])] : current.filter((id) => id !== project.id))} />{project.name}</label>)}{!projects.length && <small className="settings-footnote">No local projects were found yet.</small>}</div></>}</fieldset>}
        {!rolesSupported && <p className="settings-footnote">This host does not advertise separate access roles. Update the host to choose observer or operator access.</p>}
        <Row title="Pairing link" description="Only people with this link can pair. Paired access expires after 30 days."><button className="settings-action" disabled={busy || !host?.running || !canPair} onClick={() => perform(async () => { const options = { role, projectIds: role === 'operator' ? null : [...projectIds] }; setPair(await api.pair(rolesSupported ? options : undefined)); setCopied(false); })}>Create pairing link</button></Row>
        {role === 'observer' && !projectIds.length && <p className="connect-error" role="alert">Choose at least one known local project for an observer.</p>}
        {pair && !pairingExpired(pair) && <div className="connect-pair-output"><PairingQr pair={pair} /><p className="settings-footnote">{pairingExpiryLabel(pair)} · The QR image was generated locally in this browser.</p><input aria-label="Pairing link" className="connect-input" value={pair.url} readOnly onFocus={(event) => event.target.select()} /><a className="connect-pair-link" href={pair.url}>Open pairing link</a><div className="connect-actions"><button className="settings-action" onClick={() => perform(async () => { await navigator.clipboard.writeText(pair.url); setCopied(true); })}>{copied ? 'Copied' : 'Copy link'}</button><button className="settings-action" onClick={() => perform(async () => { await api.revoke({ id: pair.id }); setPair(null); })}>Revoke link</button></div>{pair.endpoint?.startsWith('http://127.0.0.1') && <p className="settings-footnote">This address works on this machine. Start a tunnel or save and verify an HTTPS endpoint to reach it from another device.</p>}</div>}
      </Group>
      <Group title="Paired devices" description="Each device shows its role, project scope, and expiry. Revoking access disconnects that device immediately.">
        {!host?.devices?.length && <Row title="No paired devices" description="Devices appear here after using a pairing link." />}
        {host?.devices?.map((device) => <Row key={device.id} title={device.name} description={deviceAccessDescription(device, projects)}><div className="connect-actions"><button className="settings-action" disabled={busy} onClick={() => perform(() => api.revoke({ id: device.id }))}>Revoke</button>{renewSupported && <button className="settings-action" disabled={busy} onClick={() => perform(() => api.renew({ id: device.id }))}>Renew 30 days</button>}</div></Row>)}
        {Boolean(host?.devices?.length || host?.offers?.length) && <Row title="Revoke all access" description="Disconnect all devices and invalidate every unused pairing link."><button className="settings-action" disabled={busy} onClick={() => perform(async () => { await api.revoke({ all: true }); setPair(null); })}>Revoke all</button></Row>}
      </Group>
      <details className="connect-audit"><summary>Recent connection activity</summary>{host?.audit?.map((entry, index) => <p key={index}><time>{new Date(entry.at).toLocaleString()}</time> · {entry.action} · {entry.result}</p>)}</details>
    </>}
    {!api && !remoteInstance && <p className="settings-footnote">Enable sharing, create pairing links, and manage paired devices in Connections on the host’s desktop.</p>}
    {error && <p className="connect-error" role="alert">{error}</p>}
    {api && <button className="settings-action connect-refresh" disabled={busy} onClick={() => perform(refresh)}><ArrowClockwise size={14} /> Refresh</button>}
  </>;
}
