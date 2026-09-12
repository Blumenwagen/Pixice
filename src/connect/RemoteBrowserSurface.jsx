import { useCallback, useEffect, useRef, useState } from 'react';
import './remote-browser.css';
import {
  browserFrameLayout,
  browserPoint,
  clampQuality,
  clampZoom,
  createFrameTimingTracker,
  FRAME_EXPIRY_MS,
  isUsableBrowserFrame,
  nextFrameDelay,
  QUALITY_MODES,
  supportsFrameQuality,
  ZOOM_LEVELS
} from './remote-browser-utils.js';

export { browserPoint } from './remote-browser-utils.js';

const modifiers = (event) => [['alt', event.altKey], ['control', event.ctrlKey], ['meta', event.metaKey], ['shift', event.shiftKey]].filter(([, held]) => held).map(([name]) => name);
const keys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const clamp = (n) => Math.max(-2000, Math.min(2000, n));
const clampViewportDimension = (value) => {
  const dimension = Number(value);
  return Number.isFinite(dimension) ? Math.max(1, Math.min(4096, Math.round(dimension))) : 1;
};
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const errorMessage = (cause) => cause instanceof Error ? cause.message : String(cause || 'The host browser did not respond. Refresh the preview.');

function formatFrameAge(age) {
  if (age === null) return 'waiting';
  if (age < 1000) return 'less than 1s';
  return `${Math.floor(age / 1000)}s`;
}

export function RemoteBrowserSurface({ api, workspaceId, tabId }) {
  const scrollWrapper = useRef(null);
  const surface = useRef(null);
  const frameRef = useRef(null);
  const pendingFrameRef = useRef(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const pausedRef = useRef(false);
  const errorRef = useRef('');
  const awaitingFreshRef = useRef(true);
  const zoomRef = useRef(1);
  const qualityRef = useRef(QUALITY_MODES.balanced.quality);
  const qualitySupportedRef = useRef(false);
  const requestFrameRef = useRef(null);
  const pollRef = useRef(null);
  const timingRef = useRef(createFrameTimingTracker());
  const pauseInitialized = useRef(false);
  const ageInvalidatedRef = useRef(false);
  const queue = useRef({ pending: Promise.resolve(), count: 0, generation: 0 });
  const touch = useRef(null);
  const ignoreClick = useRef(false);
  const [frame, setFrame] = useState(null);
  const [pendingFrame, setPendingFrame] = useState(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');
  const [paused, setPaused] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [sendingText, setSendingText] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [qualityMode, setQualityMode] = useState('balanced');
  const [qualitySupported, setQualitySupported] = useState(false);
  const [awaitingFresh, setAwaitingFresh] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  pausedRef.current = paused;
  errorRef.current = error;
  zoomRef.current = zoom;
  qualityRef.current = clampQuality(QUALITY_MODES[qualityMode]?.quality);

  useEffect(() => {
    mountedRef.current = true;
    const poll = {
      disposed: false,
      timer: null,
      inFlight: false,
      queued: false,
      generation: 0,
      failureCount: 0,
      rttMs: 0,
      lastInputAt: 0
    };
    pollRef.current = poll;
    queue.current = { pending: Promise.resolve(), count: 0, generation: queue.current.generation + 1, inputGeneration: 0 };
    qualitySupportedRef.current = false;
    setQualitySupported(false);
    frameRef.current = null;
    pendingFrameRef.current = null;
    ageInvalidatedRef.current = false;
    loadGenerationRef.current += 1;
    awaitingFreshRef.current = true;
    setAwaitingFresh(true);
    setFrame(null);
    setPendingFrame(null);
    setError('');
    setInputError('');
    setSendingText(false);

    const clearPollTimer = () => {
      if (poll.timer !== null) clearTimeout(poll.timer);
      poll.timer = null;
    };
    const schedule = (delay) => {
      clearPollTimer();
      if (poll.disposed || pausedRef.current || isHidden()) return;
      poll.timer = setTimeout(() => {
        poll.timer = null;
        void capture('poll');
      }, Math.max(0, delay));
    };
    const currentAttempt = (generation) => !poll.disposed && generation === poll.generation;
    async function capture(reason) {
      if (poll.disposed || pausedRef.current || isHidden()) return;
      const browserReadiness = api?.remote?.readiness?.browser;
      if (api?.remote && browserReadiness && browserReadiness.available !== true && browserReadiness.canStart !== true) {
        const message = browserReadiness.reason || 'The host browser is unavailable.';
        errorRef.current = message;
        setError(message);
        return;
      }
      if (poll.inFlight) {
        poll.queued = true;
        return;
      }
      const rect = scrollWrapper.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) {
        schedule(500);
        return;
      }
      const generation = poll.generation;
      const startedAt = Date.now();
      poll.inFlight = true;
      poll.queued = false;
      try {
        const payload = {
          workspaceId,
          tabId,
          width: clampViewportDimension(rect.width),
          height: clampViewportDimension(rect.height)
        };
        // The first request deliberately uses the old contract. A host may
        // opt into quality only after it advertises support in its response.
        if (qualitySupportedRef.current) payload.quality = qualityRef.current;
        const result = await api.browser.frame(payload);
        const receivedAt = Date.now();
        if (!currentAttempt(generation)) return;
        if (!isUsableBrowserFrame(result)) throw new Error('The host returned an invalid browser preview. Refresh the preview.');
        poll.rttMs = Math.max(0, receivedAt - startedAt);
        poll.failureCount = 0;
        if (supportsFrameQuality(result)) {
          qualitySupportedRef.current = true;
          setQualitySupported(true);
        }
        const captureTiming = timingRef.current.capture(receivedAt);
        const fresh = {
          ...result,
          receivedAt,
          rttMs: poll.rttMs,
          captureIntervalMs: captureTiming.intervalMs,
          reason
        };
        invalidateInputQueue(queue);
        const loadGeneration = ++loadGenerationRef.current;
        fresh.loadGeneration = loadGeneration;
        pendingFrameRef.current = fresh;
        setPendingFrame(fresh);
        // The network response is not usable for input until the image has
        // loaded and decoded in the actual preview surface.
        awaitingFreshRef.current = true;
        setAwaitingFresh(true);
        errorRef.current = '';
        setError('');
      } catch (cause) {
        if (!currentAttempt(generation)) return;
        const message = errorMessage(cause);
        poll.failureCount += 1;
        invalidateInputQueue(queue);
        ++loadGenerationRef.current;
        pendingFrameRef.current = null;
        setPendingFrame(null);
        errorRef.current = message;
        setError(message);
      } finally {
        poll.inFlight = false;
        if (poll.disposed) return;
        if (poll.queued) {
          poll.queued = false;
          if (!pausedRef.current && !isHidden()) schedule(0);
          return;
        }
        if (generation !== poll.generation) {
          if (!pausedRef.current && !isHidden()) schedule(0);
          return;
        }
        if (!pausedRef.current && !isHidden()) {
          schedule(nextFrameDelay({
            rttMs: poll.rttMs,
            lastInputAt: poll.lastInputAt,
            failureCount: poll.failureCount,
            hidden: isHidden()
          }));
        }
      }
    }
    requestFrameRef.current = () => {
      if (poll.disposed || pausedRef.current || isHidden()) return;
      if (poll.inFlight) {
        poll.queued = true;
        return;
      }
      clearPollTimer();
      void capture('requested');
    };
    const visibilityChange = () => {
      if (isHidden()) {
        clearPollTimer();
        poll.generation += 1;
        poll.queued = false;
        invalidateInputQueue(queue);
        ++loadGenerationRef.current;
        pendingFrameRef.current = null;
        setPendingFrame(null);
        awaitingFreshRef.current = true;
        setAwaitingFresh(true);
        return;
      }
      poll.failureCount = 0;
      requestFrameRef.current?.();
    };
    document.addEventListener('visibilitychange', visibilityChange);
    void capture('initial');
    return () => {
      poll.disposed = true;
      poll.generation += 1;
      poll.queued = false;
      clearPollTimer();
      document.removeEventListener('visibilitychange', visibilityChange);
      if (pollRef.current === poll) pollRef.current = null;
      requestFrameRef.current = null;
      mountedRef.current = false;
      ++loadGenerationRef.current;
      pendingFrameRef.current = null;
      frameRef.current = null;
      invalidateInputQueue(queue);
    };
  }, [api, tabId, workspaceId]);

  useEffect(() => {
    const element = scrollWrapper.current;
    if (!element) return undefined;
    let previous = '';
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = {
        width: Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0,
        height: Number.isFinite(rect.height) ? Math.max(0, rect.height) : 0
      };
      setViewport((current) => current.width === next.width && current.height === next.height ? current : next);
      const signature = `${next.width}x${next.height}`;
      if (previous && previous !== signature) requestFrameRef.current?.();
      previous = signature;
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [api, tabId, workspaceId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pauseInitialized.current) {
      pauseInitialized.current = true;
      return;
    }
    const poll = pollRef.current;
    if (poll) {
      poll.generation += 1;
      poll.queued = false;
      if (poll.timer !== null) clearTimeout(poll.timer);
      poll.timer = null;
    }
    invalidateInputQueue(queue);
    ++loadGenerationRef.current;
    pendingFrameRef.current = null;
    setPendingFrame(null);
    awaitingFreshRef.current = true;
    setAwaitingFresh(true);
    if (!paused) {
      if (poll) poll.failureCount = 0;
      requestFrameRef.current?.();
    }
  }, [paused]);

  const frameAge = frame ? Math.max(0, now - frame.receivedAt) : null;
  const canInteract = Boolean(frame && !paused && !error && !awaitingFresh && frameAge <= FRAME_EXPIRY_MS && !isHidden());

  useEffect(() => {
    if (!frame || frameAge <= FRAME_EXPIRY_MS) {
      ageInvalidatedRef.current = false;
    } else if (!ageInvalidatedRef.current) {
      ageInvalidatedRef.current = true;
      invalidateInputQueue(queue);
    }
  }, [frame, frameAge]);

  async function handleFrameLoad(event) {
    const candidate = pendingFrameRef.current;
    if (!candidate || !mountedRef.current) return;
    if (event.currentTarget.dataset.frameId !== candidate.frameId) return;
    const loadGeneration = candidate.loadGeneration;
    try {
      if (typeof event.currentTarget.decode === 'function') await event.currentTarget.decode();
    } catch (cause) {
      if (!mountedRef.current || loadGeneration !== loadGenerationRef.current || pendingFrameRef.current !== candidate) return;
      const message = `The host returned an image that could not be displayed. ${errorMessage(cause)}`;
      pendingFrameRef.current = null;
      setPendingFrame(null);
      ++loadGenerationRef.current;
      invalidateInputQueue(queue);
      awaitingFreshRef.current = true;
      setAwaitingFresh(true);
      errorRef.current = message;
      setError(message);
      return;
    }
    if (!mountedRef.current || loadGeneration !== loadGenerationRef.current || pendingFrameRef.current !== candidate || isHidden() || pausedRef.current) return;
    const renderedAt = Date.now();
    const renderTiming = timingRef.current.render(renderedAt);
    const displayed = {
      ...candidate,
      renderedAt,
      renderDurationMs: Math.max(0, renderedAt - candidate.receivedAt),
      renderIntervalMs: renderTiming.intervalMs
    };
    frameRef.current = displayed;
    setFrame(displayed);
    pendingFrameRef.current = null;
    setPendingFrame(null);
    awaitingFreshRef.current = false;
    setAwaitingFresh(false);
    errorRef.current = '';
    setError('');
    setInputError('');
  }

  function handleFrameError(event) {
    const candidate = pendingFrameRef.current;
    if (!candidate || !mountedRef.current || event.currentTarget.dataset.frameId !== candidate.frameId) return;
    const loadGeneration = candidate.loadGeneration;
    if (loadGeneration !== loadGenerationRef.current) return;
    const message = 'The host returned an image that could not be displayed. Refresh the preview.';
    pendingFrameRef.current = null;
    setPendingFrame(null);
    ++loadGenerationRef.current;
    invalidateInputQueue(queue);
    awaitingFreshRef.current = true;
    setAwaitingFresh(true);
    errorRef.current = message;
    setError(message);
  }

  const send = useCallback((input) => {
    const observed = frameRef.current;
    const age = observed ? Date.now() - observed.receivedAt : Infinity;
    if (pausedRef.current || isHidden() || errorRef.current || awaitingFreshRef.current || !observed || !isUsableBrowserFrame(observed) || age > FRAME_EXPIRY_MS) {
      setInputError(pausedRef.current ? 'Resume the preview before interacting.' : 'Wait for a fresh preview before interacting.');
      return Promise.resolve(false);
    }
    const current = queue.current;
    if (current.count >= 16) {
      setInputError('The connection is catching up. Wait before typing more.');
      return Promise.resolve(false);
    }
    const generation = current.generation;
    const inputGeneration = current.inputGeneration;
    const dispatchPoll = pollRef.current;
    current.count += 1;
    current.pending = current.pending.then(async () => {
      if (generation !== current.generation || inputGeneration !== current.inputGeneration) return false;
      const displayed = frameRef.current;
      const displayedAge = displayed ? Date.now() - displayed.receivedAt : Infinity;
      const dispatchable = mountedRef.current && !isHidden() && !pausedRef.current && !errorRef.current && !awaitingFreshRef.current && displayed === observed && isUsableBrowserFrame(displayed) && displayedAge <= FRAME_EXPIRY_MS;
      if (!dispatchable) {
        invalidateInputQueue(queue);
        setInputError(pausedRef.current ? 'Resume the preview before interacting.' : 'Wait for a fresh preview before interacting.');
        return false;
      }
      try {
        await api.browser.input({ workspaceId, tabId, frameId: displayed.frameId, input });
        const currentDispatch = mountedRef.current && pollRef.current === dispatchPoll && queue.current === current && generation === current.generation;
        if (!currentDispatch) return false;
        const poll = pollRef.current;
        if (poll) {
          poll.lastInputAt = Date.now();
          poll.failureCount = 0;
        }
        requestFrameRef.current?.();
        return true;
      } catch (cause) {
        const currentDispatch = mountedRef.current && pollRef.current === dispatchPoll && queue.current === current && generation === current.generation;
        if (!currentDispatch) return false;
        current.inputGeneration += 1; // Drop remaining unsent input; never replay an uncertain action.
        const message = errorMessage(cause);
        errorRef.current = message;
        setError(message);
        setInputError(message);
        requestFrameRef.current?.();
        return false;
      }
    }).finally(() => { current.count -= 1; });
    return current.pending;
  }, [api, tabId, workspaceId]);

  useEffect(() => {
    const element = surface.current;
    const wrapper = scrollWrapper.current;
    if (!element || !wrapper) return undefined;
    let timer;
    let pending;
    const wheel = (event) => {
      const at = browserPoint(element.getBoundingClientRect(), frameRef.current, event.clientX, event.clientY);
      const multiplier = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? frameRef.current?.height ?? 0 : 1;
      if (zoomRef.current > 1) {
        event.preventDefault();
        scrollBy(wrapper, event.deltaX * multiplier, event.deltaY * multiplier);
        return;
      }
      if (!at) return;
      event.preventDefault();
      pending = { type: 'scroll', ...at, deltaX: clamp((pending?.deltaX ?? 0) + event.deltaX * multiplier), deltaY: clamp((pending?.deltaY ?? 0) + event.deltaY * multiplier), modifiers: modifiers(event) };
      if (!timer) timer = setTimeout(() => { void send(pending); pending = null; timer = null; }, 100);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      clearTimeout(timer);
      element.removeEventListener('wheel', wheel);
    };
  }, [send, zoom]);

  function keyDown(event) {
    if (event.key === 'Escape' && event.shiftKey) { event.currentTarget.blur(); return; }
    if (event.isComposing || event.nativeEvent.isComposing) return;
    if (keys.has(event.key) || (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault(); void send({ type: 'key', key: event.key.toLowerCase() === 'a' ? 'a' : event.key, modifiers: modifiers(event) });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); void send({ type: 'text', text: event.key });
    }
  }

  function viewportKeyDown(event) {
    if (zoomRef.current <= 1 || event.target !== scrollWrapper.current) return;
    const amount = event.key === 'PageUp' || event.key === 'PageDown' ? Math.max(120, scrollWrapper.current.clientHeight || 400) : 64;
    const localKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    if (!localKeys.has(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return scrollTo(wrapperFor(surface), 0, 0);
    if (event.key === 'End') return scrollTo(wrapperFor(surface), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
    const dy = event.key === 'ArrowUp' || event.key === 'PageUp' ? -amount : event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ' ? amount : 0;
    scrollBy(wrapperFor(surface), dx, dy);
  }

  const point = (event) => {
    const rect = surface.current?.getBoundingClientRect();
    return rect ? browserPoint(rect, frameRef.current, event.clientX, event.clientY) : null;
  };
  const status = paused ? 'paused' : error ? 'error' : awaitingFresh || (frame && frameAge > FRAME_EXPIRY_MS) ? 'stale' : frame ? 'fresh' : 'stale';
  const statusLabel = status[0].toUpperCase() + status.slice(1);
  const layout = frame ? browserFrameLayout(viewport.width && viewport.height ? viewport : scrollWrapper.current?.getBoundingClientRect(), frame, zoom) : null;
  const surfaceStyle = layout ? { width: layout.width, height: layout.height } : { width: '100%', height: '100%' };

  function refresh() {
    setInputError('');
    awaitingFreshRef.current = true;
    setAwaitingFresh(true);
    invalidateInputQueue(queue);
    ++loadGenerationRef.current;
    pendingFrameRef.current = null;
    setPendingFrame(null);
    const poll = pollRef.current;
    if (poll) {
      poll.failureCount = 0;
      poll.generation += 1;
    }
    requestFrameRef.current?.();
  }

  function chooseQuality(mode) {
    if (!qualitySupportedRef.current) return;
    const next = QUALITY_MODES[mode] ? mode : 'balanced';
    qualityRef.current = clampQuality(QUALITY_MODES[next].quality);
    setQualityMode(next);
    requestFrameRef.current?.();
  }

  function chooseZoom(value) {
    const next = clampZoom(value);
    setZoom(next);
    requestAnimationFrame(() => {
      if (next === 1 && scrollWrapper.current) scrollTo(scrollWrapper.current, 0, 0);
    });
  }

  async function submitText(event) {
    event.preventDefault();
    if (!text || sendingText) return;
    setInputError('');
    setSendingText(true);
    const value = text;
    const dispatchQueue = queue.current;
    const dispatchPoll = pollRef.current;
    const sent = await send({ type: 'text', text: value });
    const sameLifecycle = mountedRef.current && pollRef.current === dispatchPoll && queue.current === dispatchQueue;
    if (!sameLifecycle) return;
    if (sent) setText((current) => current === value ? '' : current);
    setSendingText(false);
  }

  return <div className="connect-browser" data-status={status}>
    <div ref={scrollWrapper} className="connect-browser-scroll" tabIndex={0} role="region" aria-label="Scrollable remote browser viewport" aria-description="Focus here to pan when zoomed." title="Focus to pan when zoomed" onKeyDown={viewportKeyDown}>
      <div
        ref={surface}
        className="connect-browser-surface"
        style={surfaceStyle}
        tabIndex={0}
        role="application"
        aria-label="Remote browser page"
        aria-description="Click to control the host page. Type or paste text. Shift Escape releases keyboard control."
        aria-disabled={!canInteract}
        data-input-enabled={canInteract}
        data-zoom={zoom}
        onKeyDown={keyDown}
        onPaste={(event) => { const value = event.clipboardData.getData('text/plain'); if (value) { event.preventDefault(); void send({ type: 'text', text: value.slice(0, 10000) }); } }}
        onClick={(event) => { if (ignoreClick.current) { ignoreClick.current = false; return; } const at = point(event); if (at) { event.currentTarget.focus({ preventScroll: true }); setInputError(''); void send({ type: 'click', ...at, clickCount: Math.min(2, event.detail || 1), modifiers: modifiers(event) }); } }}
        onContextMenu={(event) => { event.preventDefault(); const at = point(event); if (at) void send({ type: 'click', ...at, button: 'right', modifiers: modifiers(event) }); }}
        onPointerDown={(event) => { if (event.pointerType === 'touch') touch.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }; }}
        onPointerMove={(event) => {
          const gesture = touch.current;
          if (!gesture || event.pointerType !== 'touch' || zoomRef.current <= 1) return;
          const dx = gesture.lastX - event.clientX;
          const dy = gesture.lastY - event.clientY;
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
          if (gesture.moved) { event.preventDefault(); scrollBy(scrollWrapper.current, dx, dy); }
          gesture.lastX = event.clientX;
          gesture.lastY = event.clientY;
        }}
        onPointerUp={(event) => {
          const gesture = touch.current;
          touch.current = null;
          if (!gesture) return;
          const dx = gesture.x - event.clientX;
          const dy = gesture.y - event.clientY;
          if (zoomRef.current > 1 && (gesture.moved || Math.hypot(dx, dy) > 12)) { ignoreClick.current = true; if (!gesture.moved) scrollBy(scrollWrapper.current, dx, dy); return; }
          const at = point(event);
          if (at && Math.hypot(dx, dy) > 12) { ignoreClick.current = true; void send({ type: 'scroll', ...at, deltaX: clamp(dx), deltaY: clamp(dy), modifiers: [] }); }
        }}
        onPointerCancel={() => { touch.current = null; ignoreClick.current = true; }}
      >
        {!paused && frame && pendingFrame && <>
          <img src={frame.image} alt="Live preview of the host browser tab" draggable={false} />
          <img key={pendingFrame.loadGeneration} className="connect-browser-pending-image" src={pendingFrame.image} data-frame-id={pendingFrame.frameId} alt="" aria-hidden="true" draggable={false} onLoad={handleFrameLoad} onError={handleFrameError} />
        </>}
        {!paused && !frame && pendingFrame && <img key={pendingFrame.loadGeneration} src={pendingFrame.image} data-frame-id={pendingFrame.frameId} alt="Live preview of the host browser tab" draggable={false} onLoad={handleFrameLoad} onError={handleFrameError} />}
        {!paused && frame && !pendingFrame && <img src={frame.image} alt="Live preview of the host browser tab" draggable={false} />}
        {(!frame && !pendingFrame || paused) && <div className="browser-mock-page"><strong>{paused ? 'Preview paused' : error ? 'Preview unavailable' : 'Connecting to the host browser…'}</strong><small>{error || 'The page and its signed-in session run on your host.'}</small></div>}
        {!paused && frame && error && <div className="connect-browser-stale-note">Last successful frame shown. Input is disabled until a fresh frame arrives.</div>}
      </div>
    </div>
    <div className="connect-browser-controls">
      <div className="connect-browser-status" data-status={status} aria-label={`Preview status: ${statusLabel}`}><i aria-hidden="true" /><span>{statusLabel}</span><small>Frame age {formatFrameAge(frameAge)}</small></div>
      <div className="connect-browser-control-group" role="group" aria-label="Preview zoom"><span>Zoom</span>{ZOOM_LEVELS.map((option) => <button key={option} type="button" aria-pressed={zoom === option} onClick={() => chooseZoom(option)}>{Math.round(option * 100)}%</button>)}</div>
      <div className="connect-browser-control-group connect-browser-quality" role="group" aria-label="Preview quality" aria-describedby={!qualitySupported ? 'connect-browser-quality-note' : undefined}><span>Quality</span>{Object.entries(QUALITY_MODES).map(([mode, option]) => <button key={mode} type="button" aria-pressed={qualityMode === mode} disabled={!qualitySupported} title={!qualitySupported ? 'The host does not advertise quality controls.' : undefined} onClick={() => chooseQuality(mode)}>{option.label}</button>)}{!qualitySupported && <small id="connect-browser-quality-note" className="connect-browser-control-note">Host controls quality automatically.</small>}</div>
      <button type="button" onClick={refresh}>Refresh</button>
      <button type="button" onClick={() => setTyping((value) => !value)} aria-expanded={typing}>Type text</button>
      <button type="button" disabled={!canInteract} onClick={() => void send({ type: 'key', key: 'Enter', modifiers: [] })}>Enter</button>
      <button type="button" disabled={!canInteract} onClick={() => void send({ type: 'key', key: 'Escape', modifiers: [] })}>Esc</button>
      <button type="button" onClick={() => setPaused((value) => !value)}>{paused ? 'Resume' : 'Pause'}</button>
    </div>
    {typing && <form className="connect-browser-typing" onSubmit={submitText}><textarea aria-label="Text to type on host page" value={text} onChange={(event) => setText(event.target.value)} maxLength={10000} disabled={!canInteract || sendingText} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="Click a field in the page, then type here" /><button className="settings-action" disabled={!text || !canInteract || sendingText}>Type</button></form>}
    {(error || inputError) && <div className="connect-browser-error" role="alert"><span>{error || inputError}</span>{error && <span className="connect-browser-error-detail">The last successful image remains visible while the host recovers.</span>}<button type="button" onClick={refresh}>Refresh preview</button></div>}
  </div>;
}

function invalidateInputQueue(queueRef) {
  queueRef.current.inputGeneration = (queueRef.current.inputGeneration ?? 0) + 1;
}

function wrapperFor(surfaceRef) {
  return surfaceRef.current?.parentElement;
}

function scrollBy(element, left, top) {
  if (!element) return;
  if (typeof element.scrollBy === 'function') element.scrollBy({ left, top, behavior: 'auto' });
  else {
    element.scrollLeft += left;
    element.scrollTop += top;
  }
}

function scrollTo(element, left, top) {
  if (!element) return;
  if (typeof element.scrollTo === 'function') element.scrollTo({ left, top, behavior: 'auto' });
  else {
    element.scrollLeft = left;
    element.scrollTop = top;
  }
}
