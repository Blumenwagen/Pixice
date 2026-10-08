import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import './MessageQueue.css';

export function latestEditableQueuedMessage(entries = []) {
  return entries.findLast(entry => entry.source === 'user' && ['queued', 'failed'].includes(entry.state)) ?? null;
}

export function MessageQueuePanel({ api, projectId, threadId, activeTurnId, revision = 0, onError = () => {}, onEdit, onQueueChange, controlRef, editingId = null }) {
  const [queue, setQueue] = useState({ entries: [], held: false });
  const [editing, setEditing] = useState(null); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const queueChangeRef = useRef(onQueueChange);
  queueChangeRef.current = onQueueChange;
  useEffect(() => { queueChangeRef.current?.(queue); }, [queue]);
  useEffect(() => {
    let current = true;
    let receivedUpdate = false;
    setQueue({ entries: [], held: false }); setEditing(null);
    if (api?.turns?.queueList && projectId && threadId) api.turns.queueList({ projectId, threadId }).then(value => { if (current && !receivedUpdate) setQueue(value); }).catch(error => { if (current) onError(error.message); });
    const listener = event => {
      if (current && event.type === 'MessageQueueUpdated' && event.payload?.threadId === threadId && event.payload?.projectId === projectId) { receivedUpdate = true; setQueue(event.payload); }
    };
    const off = typeof api?.events?.subscribe === 'function' ? api.events.subscribe(listener) : api?.onEvent?.(listener);
    return () => { current = false; if (typeof off === 'function') off(); };
  }, [api, projectId, threadId, revision]);
  const act = async (method, payload = {}) => {
    setBusy(true);
    try { setQueue(await api.turns[method]({ projectId, threadId, ...payload })); setEditing(null); return true; }
    catch (error) { onError(error.message); return false; } finally { setBusy(false); }
  };
  const editEntry = async entry => {
    if (!entry || busy || !['queued', 'failed'].includes(entry.state)) return false;
    if (onEdit) {
      try { return await onEdit(entry) !== false; }
      catch (error) { onError(error.message); return false; }
    }
    setEditing(entry.id); setText(entry.text); return true;
  };
  useImperativeHandle(controlRef, () => ({
    editLatest: () => editEntry(latestEditableQueuedMessage(queue.entries)),
    promoteFirst: () => {
      const entry = queue.entries[0];
      if (busy || !entry || entry.state !== 'queued') return false;
      return activeTurnId ? act('queueSteer', { id: entry.id, turnId: activeTurnId }) : act('queueResume');
    }
  }));
  if (!queue.entries.length) return null;
  return <section className="message-queue" aria-label="Queued messages">
    <header><span>{queue.entries.length} queued {queue.entries.length === 1 ? 'message' : 'messages'}{queue.held ? ' · paused' : ''}</span>
      <button type="button" disabled={busy} onClick={() => act(queue.held ? 'queueResume' : 'queueHold')}>{queue.held ? 'Resume queue' : 'Pause queue'}</button>
    </header>
    <ol>{queue.entries.map((entry, index) => <li key={entry.id} className={editingId === entry.id ? 'message-queue-editing' : undefined}>
      {editing === entry.id ? <form onSubmit={event => { event.preventDefault(); void act('queueEdit', { id: entry.id, text }); }}>
        <textarea aria-label="Edit queued message" value={text} onChange={event => setText(event.target.value)} />
        <button disabled={busy || !text.trim()} type="submit">Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button>
      </form> : <><p>{entry.text || 'Attached files'}{entry.attachments?.length > 0 && <small> · {entry.attachments.length} attachments</small>}</p>
        {entry.error && <small role="status">{entry.error}</small>}
        <div className="message-queue-actions">
          {entry.source === 'user' && <button type="button" disabled={busy || !['queued', 'failed'].includes(entry.state)} onClick={() => void editEntry(entry)}>{editingId === entry.id ? 'Editing in composer' : 'Edit'}</button>}
          <button type="button" disabled={busy || index === 0 || entry.state === 'dispatching'} onClick={() => { const ids = queue.entries.map(item => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void act('queueReorder', { ids }); }}>Move up</button>
          {activeTurnId && entry.state === 'queued' && <button type="button" disabled={busy} onClick={() => act('queueSteer', { id: entry.id, turnId: activeTurnId })}>Steer now</button>}
          {entry.state === 'uncertain' && <button type="button" disabled={busy} onClick={() => act('queueResume', { retryUncertain: true })}>Retry after checking conversation</button>}
          <button type="button" disabled={busy || entry.state === 'dispatching'} onClick={() => act('queueRemove', { id: entry.id })}>Remove</button>
        </div></>}
    </li>)}</ol>
  </section>;
}
