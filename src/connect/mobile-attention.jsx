import './mobile-connect.css';

export function getMobileAttentionTasks(snapshot) {
  return (snapshot?.tasks || []).filter((task) => task.status === 'waiting');
}

function checkStatus(snapshot, loading) {
  if (loading) return 'Checking hosts…';
  if (!snapshot) return 'Waiting status has not been checked yet.';
  const hosts = Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
  const complete = hosts.length > 0 && !snapshot.partial && hosts.every((host) => host.state === 'ready');
  if (complete) return null;
  if (snapshot.partial) return 'Some host status is incomplete. Showing available and last-known tasks.';
  return hosts.length ? 'The latest host check is incomplete.' : 'No host check is available yet.';
}

export function MobileAttentionPanel({ snapshot, loading = false, onOpen } = {}) {
  const tasks = getMobileAttentionTasks(snapshot);
  const status = checkStatus(snapshot, loading);
  return <section className="connect-mobile-attention" aria-label="Waiting attention"><header><h2>Needs your attention</h2><p>{status || 'Waiting tasks from the latest complete host check.'}</p></header>{tasks.map((task) => {
    const host = snapshot?.hosts?.find((candidate) => candidate.hostId === task.hostId);
    const stale = host?.state === 'stale' || host?.stale;
    return <article key={`${task.hostId}:${task.projectId}:${task.threadId}`} data-state={stale ? 'stale' : 'current'}><div><strong>{task.title}</strong><small>{task.hostName} · {task.projectName}{stale ? ' · Last known' : ''}</small></div><button type="button" className="settings-action" disabled={stale} onClick={() => onOpen?.({ hostId: task.hostId, projectId: task.projectId, threadId: task.threadId })}>{stale ? 'Open unavailable' : 'Open current task'}</button></article>;
  })}{!tasks.length && !loading && snapshot && !status && <p className="settings-footnote">Nothing is waiting right now.</p>}</section>;
}
