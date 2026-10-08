// Aura Field — organic, audio-reactive canvas blob.
// Inspired by LiveKit Agents UI's shader-based "Aura" visualizer (expressive,
// smooth response to live audio) and ElevenLabs UI's Orb two-color gradient
// language. Built with plain Canvas 2D (no WebGL/Three.js dependency added).

const STATE_COLORS = {
  listening: { core: "#fff4f5", mid: "#ff5364", edge: "#3cbeff" },
  thinking: { core: "#fff6dc", mid: "#dca650", edge: "#9a7cf6" },
  speaking: { core: "#ffffff", mid: "#ff7a86", edge: "#ff5364" },
  error: { core: "#fff0f0", mid: "#ef6b72", edge: "#7a2a30" },
};

export function mount(container, session) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Animated voice activity field");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let width = 0, height = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const rect = container.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  let rafId = null;
  let phase = 0;

  function drawFrame(state) {
    const { voiceState, amplitude, muted, ended, settings } = state;
    const colors = STATE_COLORS[voiceState] || STATE_COLORS.listening;
    const cx = width / 2;
    const cy = height / 2;
    const baseRadius = Math.min(width, height) * 0.16;
    const intensity = settings.motionIntensity;

    ctx.clearRect(0, 0, width, height);
    if (ended) return;

    const desat = muted ? 0.35 : 1;
    const layers = 3;
    for (let layer = layers; layer >= 1; layer--) {
      const layerFrac = layer / layers;
      const wobble = amplitude * intensity * (22 + layer * 10);
      const points = 48;
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const theta = (i / points) * Math.PI * 2;
        const n =
          Math.sin(theta * 3 + phase * (0.6 + layer * 0.15)) * 0.5 +
          Math.sin(theta * 5 - phase * (0.4 + layer * 0.1)) * 0.3 +
          Math.sin(theta * 2 + phase * 0.25) * 0.2;
        const r = baseRadius * (0.6 + layerFrac * 0.5) + n * wobble;
        const x = cx + Math.cos(theta) * r;
        const y = cy + Math.sin(theta) * r * 0.86;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 1.6);
      gradient.addColorStop(0, withAlpha(colors.core, (0.5 + amplitude * 0.4) * desat));
      gradient.addColorStop(0.55, withAlpha(colors.mid, (0.32 / layerFrac) * desat));
      gradient.addColorStop(1, withAlpha(colors.edge, 0));
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * (0.32 + amplitude * 0.18), 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(colors.core, 0.9 * desat);
    ctx.shadowColor = withAlpha(colors.mid, 0.8);
    ctx.shadowBlur = 30 * intensity + 6;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  }

  function loop() {
    const state = session.getState();
    phase += 0.02 * (state.settings.reducedMotion ? 0 : 1);
    drawFrame(state);
    // Stop self-scheduling once ended instead of clearing an empty canvas
    // forever; ensureRunning() resumes it exactly once on restart.
    rafId = state.ended ? null : requestAnimationFrame(loop);
  }

  function ensureRunning() {
    const state = session.getState();
    if (state.ended || state.settings.reducedMotion) {
      drawFrame(state); // one static redraw (also clears the canvas on end), no RAF chain
      return;
    }
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  // subscribe() invokes ensureRunning() once immediately with current state.
  const unsubscribe = session.subscribe(ensureRunning);

  return function unmount() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (unsubscribe) unsubscribe();
    resizeObserver.disconnect();
    container.removeChild(canvas);
  };
}
