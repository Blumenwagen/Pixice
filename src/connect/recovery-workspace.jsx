export function RecoveryWorkspace({ records = [], statuses = {}, onCheck, onDismiss, onOpen } = {}) {
  return <section className="connect-recovery-panel" aria-label="Connect recovery">
    <header className="connect-overview-header"><div><h2>Check uncertain actions</h2><p>The host may have received these commands before the response was lost. Pixice never replays them.</p></div></header>
    {!records.length && <p className="settings-footnote">No pending outcomes need checking.</p>}
    <div className="connect-recovery-list">{records.map((record) => {
      const status = statuses[record.key] ?? { state: 'pending' };
      const label = { pending: 'Needs checking', completed: 'Command returned', failed: 'Command failed', unknown: 'Unknown', 'older-host-unsupported': 'Older host cannot report this', offline: 'Host offline' }[status.state] ?? status.state;
      return <article className="connect-recovery-item" key={record.key}>
        <div><strong>{record.operation}</strong><small>{record.hostId} · device {record.deviceId} · issued {new Date(record.issuedAt).toLocaleString()}</small><small>Status: {label}{status.message ? ` · ${status.message}` : ''}</small></div>
        <div className="connect-actions"><button type="button" className="settings-action primary" onClick={() => void onCheck?.(record)} disabled={status.busy}>{status.busy ? 'Checking…' : 'Check outcome'}</button>{record.threadId && <button type="button" className="settings-action" onClick={() => onOpen?.(record)}>Open task</button>}<button type="button" className="settings-action" onClick={() => onDismiss?.(record)}>Dismiss</button></div>
      </article>;
    })}</div>
  </section>;
}
