import { useCallback, useEffect, useRef, useState } from 'react';

export function browserPoint(rect, frame, clientX, clientY) {
  if (!frame || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const x = (clientX - rect.left - (rect.width - frame.width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - frame.height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x, y } : null;
}
const modifiers = (event) => [['alt', event.altKey], ['control', event.ctrlKey], ['meta', event.metaKey], ['shift', event.shiftKey]].filter(([, held]) => held).map(([name]) => name);
const keys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const clamp = (n) => Math.max(-2000, Math.min(2000, n));

export function RemoteBrowserSurface({ api, workspaceId, tabId }) {
  const surface = useRef(null);
  const frameRef = useRef(null);
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');
  const [paused, setPaused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [sendingText, setSendingText] = useState(false);
  const [revision, setRevision] = useState(0);
  const queue = useRef({ pending: Promise.resolve(), count: 0, generation: 0 });
  const touch = useRef(null);
  const ignoreClick = useRef(false);
  useEffect(() => {
    let disposed = false;
    let timer;
    const currentQueue = queue.current;
    frameRef.current = null; setFrame(null); setError(''); setInputError('');
    async function refresh() {
      if (disposed || paused) return;
      if (document.visibilityState === 'hidden') { frameRef.current = null; timer = setTimeout(refresh, 1000); return; }
      try {
        const rect = surface.current?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) { timer = setTimeout(refresh, 500); return; }
        const result = await api.browser.frame({ workspaceId, tabId, width: Math.round(rect.width), height: Math.round(rect.height) });
        if (disposed) return;
        const fresh = { ...result, receivedAt: Date.now() };
        frameRef.current = fresh; setFrame(fresh); setError('');
      } catch (cause) {
        if (disposed) return;
        frameRef.current = null; setFrame(null); setError(cause.message);
      }
      if (!disposed) timer = setTimeout(refresh, 500);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); frameRef.current = null; currentQueue.generation++; };
  }, [api, workspaceId, tabId, paused, revision]);

  const send = useCallback((input) => {
    const observed = frameRef.current;
    if (!observed || Date.now() - observed.receivedAt > 4000) { setInputError('Wait for a fresh preview before interacting.'); return Promise.resolve(false); }
    const current = queue.current;
    if (current.count >= 16) { setInputError('The connection is catching up. Wait before typing more.'); return Promise.resolve(false); }
    const generation = current.generation;
    current.count++;
    current.pending = current.pending.then(async () => {
      if (generation !== current.generation) return false;
      try {
        await api.browser.input({ workspaceId, tabId, frameId: observed.frameId, input });
        return true;
      } catch (cause) {
        current.generation++; // Drop remaining unsent input; never replay an uncertain action.
        setInputError(cause.message);
        return false;
      }
    }).finally(() => { current.count--; });
    return current.pending;
  }, [api, workspaceId, tabId]);
  const point = (event) => browserPoint(surface.current.getBoundingClientRect(), frameRef.current, event.clientX, event.clientY);
  useEffect(() => {
    const element = surface.current;
    let timer;
    let pending;
    const wheel = (event) => {
      const at = browserPoint(element.getBoundingClientRect(), frameRef.current, event.clientX, event.clientY);
      if (!at) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? frameRef.current.height : 1;
      pending = { type: 'scroll', ...at, deltaX: clamp((pending?.deltaX ?? 0) + event.deltaX * multiplier), deltaY: clamp((pending?.deltaY ?? 0) + event.deltaY * multiplier), modifiers: modifiers(event) };
      if (!timer) timer = setTimeout(() => { send(pending); pending = null; timer = null; }, 100);
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => { clearTimeout(timer); element?.removeEventListener('wheel', wheel); };
  }, [send]);
  function keyDown(event) {
    if (event.key === 'Escape' && event.shiftKey) { event.currentTarget.blur(); return; }
    if (event.isComposing || event.nativeEvent.isComposing) return;
    if (keys.has(event.key) || (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault(); send({ type: 'key', key: event.key.toLowerCase() === 'a' ? 'a' : event.key, modifiers: modifiers(event) });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); send({ type: 'text', text: event.key });
    }
  }
  return <div className="connect-browser">
    <div ref={surface} className="connect-browser-surface" tabIndex={0} role="application" aria-label="Remote browser page" aria-description="Click to control the host page. Type or paste text. Shift Escape releases keyboard control."
      onKeyDown={keyDown}
      onPaste={(event) => { const value = event.clipboardData.getData('text/plain'); if (value) { event.preventDefault(); send({ type: 'text', text: value.slice(0, 10000) }); } }}
      onClick={(event) => { if (ignoreClick.current) { ignoreClick.current = false; return; } const at = point(event); if (at) { event.currentTarget.focus({ preventScroll: true }); setInputError(''); send({ type: 'click', ...at, clickCount: Math.min(2, event.detail || 1), modifiers: modifiers(event) }); } }}
      onContextMenu={(event) => { event.preventDefault(); const at = point(event); if (at) send({ type: 'click', ...at, button: 'right', modifiers: modifiers(event) }); }}
      onPointerDown={(event) => { if (event.pointerType === 'touch') touch.current = { x: event.clientX, y: event.clientY }; }}
      onPointerUp={(event) => { const start = touch.current; touch.current = null; if (!start) return; const dx = start.x - event.clientX; const dy = start.y - event.clientY; const at = point(event); if (at && Math.hypot(dx, dy) > 12) { ignoreClick.current = true; send({ type: 'scroll', ...at, deltaX: clamp(dx), deltaY: clamp(dy), modifiers: [] }); } }}>
      {frame ? <img src={frame.image} alt="Live preview of the host browser tab" draggable={false} /> : <div className="browser-mock-page"><strong>{paused ? 'Preview paused' : 'Connecting to the host browser…'}</strong><small>{error || 'The page and its signed-in session run on your host.'}</small></div>}
    </div>
    <div className="connect-browser-controls">
      <span>{paused ? 'Paused' : 'Host browser'}</span>
      <button type="button" onClick={() => setTyping((value) => !value)} aria-expanded={typing}>Type text</button>
      <button type="button" disabled={!frame} onClick={() => send({ type: 'key', key: 'Enter', modifiers: [] })}>Enter</button>
      <button type="button" disabled={!frame} onClick={() => send({ type: 'key', key: 'Escape', modifiers: [] })}>Esc</button>
      <button type="button" onClick={() => setPaused((value) => !value)}>{paused ? 'Resume' : 'Pause'}</button>
    </div>
    {typing && <form className="connect-browser-typing" onSubmit={async (event) => { event.preventDefault(); if (text && !sendingText) { setInputError(''); setSendingText(true); const value = text; const sent = await send({ type: 'text', text: value }); if (sent) setText((current) => current === value ? '' : current); setSendingText(false); } }}><textarea aria-label="Text to type on host page" value={text} onChange={(event) => setText(event.target.value)} maxLength={10000} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="Click a field in the page, then type here" /><button className="settings-action" disabled={!text || !frame || sendingText}>Type</button></form>}
    {inputError && <div className="connect-browser-error" role="alert">{inputError}<button type="button" onClick={() => { setInputError(''); setRevision((value) => value + 1); }}>Refresh preview</button></div>}
  </div>;
}
