import { useCallback, useEffect, useRef, useState } from 'react';
import { WidgetRenderer, isRenderableWidget } from '../widgets/widget-renderer.jsx';
import './WidgetShelf.css';

const SIZES = new Set(['small', 'medium', 'large']);
const sizeKey = (projectId, widgetId) => `pixice:widget-size:v1:${encodeURIComponent(projectId)}:${encodeURIComponent(widgetId)}`;
function defaultSize(widget) { return SIZES.has(widget.spec.size) ? widget.spec.size : 'medium'; }
function storedSize(storage, key) {
  try { const value = storage?.getItem(key); return SIZES.has(value) ? value : null; } catch { return null; }
}
function browserStorage() {
  try { return globalThis.window?.localStorage; } catch { return null; }
}

// Mount in a positioned overlay layer with a definite height spanning the chat area.
// CSS anchors the grid above the composer; className/style may adjust placement for task rails.
export default function WidgetShelf({ projectId, widgets, api = globalThis.window?.pixice, onWidgetsChange, onClose, className = '', style, storage, hideWhenEmpty = false, reloadToken = 0 }) {
  const [items, setItems] = useState(Array.isArray(widgets) ? widgets : []);
  const [sizeOverrides, setSizeOverrides] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controlled = Array.isArray(widgets);
  const widgetApi = api?.widgets ?? api;
  const sizeStorage = storage === undefined ? browserStorage() : storage;
  const activeProjectRef = useRef(projectId);
  const listRequestRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const notifyMutationRef = useRef(null);
  const stateSavesRef = useRef(new Map());
  activeProjectRef.current = projectId;

  useEffect(() => { if (controlled) setItems(widgets); }, [controlled, widgets]);
  useEffect(() => {
    if (notifyMutationRef.current !== projectId) return;
    notifyMutationRef.current = null;
    onWidgetsChange?.(items);
  }, [items, onWidgetsChange, projectId]);

  const refresh = useCallback(async () => {
    if (!projectId || controlled || !widgetApi?.list) return;
    const request = ++listRequestRef.current;
    const epoch = mutationEpochRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await widgetApi.list({ projectId });
      if (request === listRequestRef.current && epoch === mutationEpochRef.current && projectId === activeProjectRef.current) setItems(Array.isArray(result?.data) ? result.data : []);
    } catch (cause) {
      if (request === listRequestRef.current && epoch === mutationEpochRef.current && projectId === activeProjectRef.current) setError(cause?.message || 'Could not load widgets.');
    } finally {
      if (request === listRequestRef.current && projectId === activeProjectRef.current) setLoading(false);
    }
  }, [projectId, controlled, widgetApi]);

  useEffect(() => { void refresh(); return () => { listRequestRef.current += 1; }; }, [refresh, reloadToken]);
  useEffect(() => {
    if (controlled || !api?.events?.subscribe) return undefined;
    return api.events.subscribe((event) => {
      if (event?.type === 'WidgetUpdated' && event.payload?.projectId === projectId) void refresh();
    });
  }, [api, controlled, projectId, refresh]);

  async function update(widget, spec, expectedRevision) {
    if (!widgetApi?.update) throw new Error('Widget updates are unavailable.');
    mutationEpochRef.current += 1;
    try {
      const saved = await widgetApi.update({ projectId, widgetId: widget.id, spec, expectedRevision });
      if (projectId !== activeProjectRef.current) return saved;
      mutationEpochRef.current += 1;
      notifyMutationRef.current = projectId;
      setItems((current) => projectId === activeProjectRef.current ? current.map((item) => item.id === widget.id ? saved : item) : current);
      return saved;
    } catch (cause) {
      if (!controlled) await refresh();
      throw cause;
    }
  }

  function updateUserState(widget, userState) {
    if (!widgetApi?.updateUserState) throw new Error('Widget state updates are unavailable.');
    const key = `${projectId}:${widget.id}`;
    const previous = stateSavesRef.current.get(key) ?? Promise.resolve(widget);
    const pending = previous.catch(() => widget).then(async (latest) => {
      if (projectId !== activeProjectRef.current) return latest;
      mutationEpochRef.current += 1;
      const saved = await widgetApi.updateUserState({ projectId, widgetId: widget.id, userState, expectedRevision: latest.revision });
      if (projectId === activeProjectRef.current) {
        mutationEpochRef.current += 1;
        notifyMutationRef.current = projectId;
        setItems((current) => current.map((item) => item.id === widget.id && item.revision < saved.revision ? saved : item));
      }
      return saved;
    }).catch(async (cause) => { if (!controlled && projectId === activeProjectRef.current) await refresh(); throw cause; });
    stateSavesRef.current.set(key, pending);
    void pending.finally(() => { if (stateSavesRef.current.get(key) === pending) stateSavesRef.current.delete(key); }).catch(() => {});
    return pending;
  }

  function readSource(widget, source) {
    if (!widgetApi?.readSource) throw new Error('Widget sources are unavailable.');
    return widgetApi.readSource({ projectId, widgetId: widget.id, source });
  }

  async function deleteWidget(widget) {
    if (!widgetApi?.delete) throw new Error('Widget deletion is unavailable.');
    mutationEpochRef.current += 1;
    await widgetApi.delete({ projectId, widgetId: widget.id });
    if (projectId !== activeProjectRef.current) return;
    mutationEpochRef.current += 1;
    const key = sizeKey(projectId, widget.id);
    try { sizeStorage?.removeItem(key); } catch {}
    setSizeOverrides((current) => { const next = { ...current }; delete next[key]; return next; });
    notifyMutationRef.current = projectId;
    setItems((current) => projectId === activeProjectRef.current ? current.filter((item) => item.id !== widget.id) : current);
  }

  function changeSize(widgetId, size) {
    if (!SIZES.has(size)) return;
    const key = sizeKey(projectId, widgetId);
    try { sizeStorage?.setItem(key, size); } catch {}
    setSizeOverrides((current) => ({ ...current, [key]: size }));
  }

  const visible = items.filter((item) => item.projectId === projectId && isRenderableWidget(item));
  if (hideWhenEmpty && !visible.length && !error) return null;
  return <aside className={`widget-shelf ${className}`.trim()} style={style} aria-label="Live widgets">
    {(onClose || !controlled) && <div className="widget-shelf-actions">
        {!controlled && <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh widgets" title="Refresh widgets">↻</button>}
        {onClose && <button type="button" onClick={onClose} aria-label="Close widgets" title="Close widgets">×</button>}
    </div>}
    <div className="widget-shelf-content">
      {loading && !visible.length && <p className="widget-shelf-status" role="status">Loading widgets…</p>}
      {error && <p className="widget-shelf-error" role="alert">{error}</p>}
      {!loading && !error && !visible.length && <p className="widget-shelf-status">No live widgets yet.</p>}
      {visible.map((widget) => {
        const key = sizeKey(projectId, widget.id);
        const size = sizeOverrides[key] ?? storedSize(sizeStorage, key) ?? defaultSize(widget);
        return <WidgetRenderer key={widget.id} widget={widget} api={api} size={size} onSizeChange={(next) => changeSize(widget.id, next)} onUpdate={widgetApi?.update ? (spec, revision) => update(widget, spec, revision) : undefined} onStateChange={widgetApi?.updateUserState ? (state) => updateUserState(widget, state) : undefined} onSourceRead={widgetApi?.readSource ? (_declaration, context) => readSource(widget, context.source) : undefined} onDelete={widgetApi?.delete ? () => deleteWidget(widget) : undefined} />;
      })}
    </div>
  </aside>;
}
