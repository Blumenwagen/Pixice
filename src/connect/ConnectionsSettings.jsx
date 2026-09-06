import { useEffect, useState } from 'react';
import { Plus, Globe, ArrowClockwise } from '../components/icons/index.jsx';
import { InstanceList, useConnect } from './ConnectRoot.jsx';

function Group({ title, description, children }) { return <section className="settings-group"><header><h2>{title}</h2>{description && <p>{description}</p>}</header><div className="settings-card">{children}</div></section>; }
function Row({ title, description, children }) { return <div className="preference-row"><span><strong>{title}</strong><small>{description}</small></span><div className="preference-control">{children}</div></div>; }
export function ConnectionsSettings() {
  const connect = useConnect();
  const api = window.pixice?.connect;
  const [service, setService] = useState(null);
  const [host, setHost] = useState(null);
  const [url, setUrl] = useState('');
  const [port, setPort] = useState('43187');
  const [name, setName] = useState('');
  const [bind, setBind] = useState('127.0.0.1');
  const [origin, setOrigin] = useState('');
  const [pair, setPair] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    if (!api) return;
    if (window.pixice?.service) setService(await window.pixice.service.status());
    const status = await api.status(); setHost(status); setUrl(status.publicUrl); setPort(String(status.port)); setName(status.name); setBind(status.host); setOrigin(status.origins.join('\n'));
  }
  useEffect(() => {
    if (!api) return;
    void refresh().catch((cause) => setError(cause.message));
    return window.pixice.events.subscribe((event) => { if (event.type === 'ConnectStatus') void refresh().catch((cause) => setError(cause.message)); });
  }, [api]);
  async function perform(action) {
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  async function configure(enabled) {
    setPair(null);
    await api.configure({ enabled, port: Number(port), name, publicUrl: url, host: bind, origins: origin.split('\n').map((value) => value.trim()).filter(Boolean) });
  }
  return <>
    <section className="settings-group"><header><h2>Your instances</h2><p>Open another Pixice host with the same projects, tasks, and live agent activity.</p></header><InstanceList /><div className="connect-actions connect-section-actions"><button className="settings-action" onClick={() => connect?.add()}><Plus size={14} /> Add instance</button></div></section>
    {window.pixice?.service && <Group title="Background backend" description="Tasks, workflows, and remote access continue when you close or quit the interface. Stopping requires all active work to finish first.">
      <Row title="Service" description={service ? `${service.phase === 'ready' ? 'Running' : service.phase} · Process ${service.pid}` : 'Checking backend…'}><div className="connect-actions"><button className="settings-action" disabled={busy} onClick={() => perform(() => window.pixice.service.restart())}>Restart backend</button><button className="settings-action" disabled={busy} onClick={() => perform(() => window.pixice.service.stop())}>Stop backend</button></div></Row>
      {service?.loginSupported && <Row title="Start at login" description="Starts the backend and native browser helper in the background."><button className="settings-action" disabled={busy || !service} onClick={() => perform(() => window.pixice.service.setOpenAtLogin({ enabled: !service.openAtLogin }))}>{service?.openAtLogin ? 'Turn off' : 'Enable'}</button></Row>}
      {service?.native?.error && <p className="settings-footnote">{service.native.error}</p>}
    </Group>}
    {api && <>
      <Group title="This device" description="Paired devices can work with every project and run agent actions on this host. Provider accounts and connection administration stay here.">
        <Row title="Remote access" description={host?.running ? `Listening on ${host.host}:${host.port}` : host?.error || 'Off until you enable it.'}><button className={`settings-action${host?.running ? '' : ' primary'}`} disabled={busy || !host} onClick={() => perform(() => configure(!host.running))}>{host?.running ? 'Turn off' : 'Enable remote access'}</button></Row>
        <Row title="Instance name" description="Shown on your other devices."><input aria-label="Instance name" className="connect-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Row>
        <Row title="Listen on" description="Network listeners require a trusted TLS certificate configured on the host."><select className="settings-select" aria-label="Connect bind address" value={bind} onChange={(event) => setBind(event.target.value)}><option value="127.0.0.1">This machine (tunnel)</option><option value="0.0.0.0">Network (TLS required)</option><option value="::1">IPv6 loopback</option></select></Row>
        <Row title="Port" description="The local listener used by your HTTPS tunnel."><input aria-label="Connect port" className="connect-input connect-port" type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></Row>
      </Group>
      <Group title="Access over the web" description="Create a temporary HTTPS address without router configuration. Cloudflare carries the encrypted transport and terminates HTTPS; use your own endpoint for a permanent address.">
        <Row title="Temporary HTTPS tunnel" description={host?.tunnel?.error || (host?.tunnel?.state === 'ready' ? host.tunnel.url : 'Downloads a verified Cloudflare tunnel on first use. The address changes each time it starts.')}><button className="settings-action" disabled={busy || !host?.running} onClick={() => perform(async () => { setPair(null); if (host.tunnel?.state === 'ready') await api.stopTunnel(); else await api.startTunnel(); })}><Globe size={14} />{busy ? 'Working…' : host?.tunnel?.state === 'ready' ? 'Stop tunnel' : 'Start tunnel'}</button></Row>
        <Row title="HTTPS endpoint" description="Your reverse proxy, Tailscale HTTPS, or tunnel origin."><input aria-label="HTTPS endpoint" className="connect-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://pixice.example.com" spellCheck={false} /></Row>
        <Row title="Additional web clients" description="Optional: one trusted HTTPS client origin per line. Direct host pages and Pixice desktops already work."><textarea aria-label="Allowed web client origins" className="connect-input" value={origin} onChange={(event) => setOrigin(event.target.value)} rows={2} spellCheck={false} /></Row>
        <Row title="Save connection settings" description="Restarts the listener and reconnects paired devices."><button className="settings-action" disabled={busy || !host} onClick={() => perform(() => configure(host.enabled))}>Save settings</button></Row>
      </Group>
      <Group title="Pair a device" description="Create one link for each browser or Pixice desktop. Links expire after five minutes and can be used once.">
        <Row title="Pairing link" description="Only people with this link can pair. Paired access expires after 30 days."><button className="settings-action" disabled={busy || !host?.running} onClick={() => perform(async () => { setPair(await api.pair()); setCopied(false); })}>Create pairing link</button></Row>
        {pair && <div className="connect-pair-output"><input aria-label="Pairing link" className="connect-input" value={pair.url} readOnly onFocus={(event) => event.target.select()} /><div className="connect-actions"><small>Expires {new Date(pair.expiresAt).toLocaleTimeString()}</small><button className="settings-action" onClick={() => perform(async () => { await navigator.clipboard.writeText(pair.url); setCopied(true); })}>{copied ? 'Copied' : 'Copy link'}</button><button className="settings-action" onClick={() => perform(async () => { await api.revoke({ id: pair.id }); setPair(null); })}>Revoke link</button></div>{pair.endpoint.startsWith('http://127.0.0.1') && <p className="settings-footnote">This address works on this machine. Start a tunnel or save an HTTPS endpoint to reach it from another device.</p>}</div>}
      </Group>
      <Group title="Paired devices" description="Revoking access disconnects that device immediately.">
        {!host?.devices?.length && <Row title="No paired devices" description="Devices appear here after using a pairing link." />}
        {host?.devices?.map((device) => <Row key={device.id} title={device.name} description={`Last seen ${new Date(device.lastSeen).toLocaleString()} · Expires ${new Date(device.expiresAt).toLocaleDateString()}`}><button className="settings-action" disabled={busy} onClick={() => perform(() => api.revoke({ id: device.id }))}>Revoke</button></Row>)}
        {Boolean(host?.devices?.length || host?.offers?.length) && <Row title="Revoke all access" description="Disconnect all devices and invalidate every unused pairing link."><button className="settings-action" disabled={busy} onClick={() => perform(async () => { await api.revoke({ all: true }); setPair(null); })}>Revoke all</button></Row>}
      </Group>
      <details className="connect-audit"><summary>Recent connection activity</summary>{host?.audit?.map((entry, index) => <p key={index}><time>{new Date(entry.at).toLocaleString()}</time> · {entry.action} · {entry.result}</p>)}</details>
    </>}
    {!api && <p className="settings-footnote">Enable sharing, create pairing links, and manage paired devices in Connections on the host’s desktop.</p>}
    {error && <p className="connect-error" role="alert">{error}</p>}
    {api && <button className="settings-action connect-refresh" disabled={busy} onClick={() => perform(refresh)}><ArrowClockwise size={14} /> Refresh</button>}
  </>;
}
