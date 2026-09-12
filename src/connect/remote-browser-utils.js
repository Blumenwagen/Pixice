export const FRAME_EXPIRY_MS = 4000;
export const MAX_FRAME_POLL_DELAY_MS = 12000;
export const HIDDEN_FRAME_POLL_DELAY_MS = 0;
export const DEFAULT_BROWSER_QUALITY = 72;
export const MIN_BROWSER_QUALITY = 35;
export const MAX_BROWSER_QUALITY = 90;

export const ZOOM_LEVELS = [1, 1.25, 1.5, 2];
export const QUALITY_MODES = Object.freeze({
  balanced: Object.freeze({ label: 'Balanced', quality: DEFAULT_BROWSER_QUALITY }),
  sharper: Object.freeze({ label: 'Sharper', quality: 88 }),
  data: Object.freeze({ label: 'Save data', quality: 48 })
});

export function clampQuality(value) {
  const quality = Number.isFinite(value) ? Math.round(value) : DEFAULT_BROWSER_QUALITY;
  return Math.max(MIN_BROWSER_QUALITY, Math.min(MAX_BROWSER_QUALITY, quality));
}

export function supportsFrameQuality(frame) {
  return frame?.supportedOptions?.includes?.('quality') === true || frame?.features?.quality === true;
}

export function isUsableBrowserFrame(frame) {
  return Boolean(
    frame &&
      typeof frame.frameId === 'string' &&
      frame.frameId.length > 0 &&
      Number.isInteger(frame.width) &&
      frame.width > 0 &&
      Number.isInteger(frame.height) &&
      frame.height > 0 &&
      typeof frame.image === 'string' &&
      frame.image.length > 0
  );
}

export function clampZoom(value) {
  return ZOOM_LEVELS.reduce((closest, option) =>
    Math.abs(option - value) < Math.abs(closest - value) ? option : closest
  , ZOOM_LEVELS[0]);
}

export function browserFrameLayout(viewport, frame, zoom = 1) {
  if (!viewport?.width || !viewport?.height || !frame?.width || !frame?.height) return null;
  const fitScale = Math.min(viewport.width / frame.width, viewport.height / frame.height);
  const scale = fitScale * clampZoom(zoom);
  return {
    fitScale,
    scale,
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale))
  };
}

export function browserPoint(rect, frame, clientX, clientY, options = {}) {
  if (!frame || !rect?.width || !rect?.height || !frame.width || !frame.height) return null;
  const view = options && typeof options === 'object' ? options : {};
  const zoom = typeof options === 'number' ? options : view.zoom ?? 1;
  const scale = view.scale ?? Math.min(rect.width / frame.width, rect.height / frame.height) * zoom;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const renderedWidth = frame.width * scale;
  const renderedHeight = frame.height * scale;
  const offsetX = view.offsetX ?? (rect.width - renderedWidth) / 2;
  const offsetY = view.offsetY ?? (rect.height - renderedHeight) / 2;
  const scrollLeft = view.scrollLeft ?? 0;
  const scrollTop = view.scrollTop ?? 0;
  const x = (clientX - rect.left - offsetX + scrollLeft) / scale;
  const y = (clientY - rect.top - offsetY + scrollTop) / scale;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x, y } : null;
}

export function nextFrameDelay({ rttMs = 0, lastInputAt = 0, now = Date.now(), failureCount = 0, hidden = false } = {}) {
  if (hidden) return HIDDEN_FRAME_POLL_DELAY_MS;
  if (failureCount > 0) {
    return Math.min(MAX_FRAME_POLL_DELAY_MS, Math.max(700, 700 * (2 ** Math.min(failureCount - 1, 4))));
  }
  const measuredRtt = Number.isFinite(rttMs) ? Math.max(0, rttMs) : 0;
  const active = lastInputAt > 0 && now - lastInputAt < 5000;
  const activeDelay = Math.max(280, Math.min(1800, Math.round(measuredRtt * 1.5 + 220)));
  const idleDelay = Math.max(1400, Math.min(5000, Math.round(measuredRtt * 2 + 1200)));
  return active ? activeDelay : idleDelay;
}

export function createFrameTimingTracker() {
  let lastCapturedAt = null;
  let lastRenderedAt = null;
  return {
    capture(at) {
      const intervalMs = lastCapturedAt === null ? null : Math.max(0, at - lastCapturedAt);
      lastCapturedAt = at;
      return { intervalMs };
    },
    render(at) {
      const intervalMs = lastRenderedAt === null ? null : Math.max(0, at - lastRenderedAt);
      lastRenderedAt = at;
      return { intervalMs };
    },
    snapshot() {
      return { lastCapturedAt, lastRenderedAt };
    }
  };
}
