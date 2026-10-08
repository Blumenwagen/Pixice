// Constellation — kinetic particle field orbiting a core.
// Inspired by ElevenLabs UI's WebGL Orb (seeded, audio-reactive, agent-state
// aware, "more expressive than generic volume bars"). Reimplemented as a
// seeded Canvas 2D particle system — no Three.js/WebGL dependency added.

const STATE_COLOR = {
  listening: [255, 83, 100],
  thinking: [220, 166, 80],
  speaking: [255, 122, 134],
  error: [239, 107, 114],
};

function createSeededRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function mount(container, session) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Animated particle constellation voice activity");
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

  const rng = createSeededRng(7321);
  const COUNT = 90;
  const particles = Array.from({ length: COUNT }, () => ({
    orbitRadius: 40 + rng() * 120,
    angle: rng() * Math.PI * 2,
    speed: 0.15 + rng() * 0.5,
    depth: rng(),
    size: 1 + rng() * 2,
  }));

  let rafId = null;

  // Angular rate in radians/second. The previous build advanced angle by a
  // fixed 0.02 rad *per frame*, which was implicitly ~1.2 rad/s at 60fps and
  // sped up or slowed down with the actual frame rate. This uses a real
  // elapsed-time delta so motion speed is frame-rate independent, tuned to
  // ~1/4 of that original effective rate per the requested slowdown.
  const BASE_ANGULAR_RATE = 0.3; // rad/s baseline (was ~1.2 rad/s)
  const CONNECTION_DISTANCE = 52;
  const CONNECTION_ALPHA = 0.5; // was 0.22 — clearly visible on dark canvas
  const CONNECTION_WIDTH = 1.1; // was 0.6

  function drawFrame(state, dtSeconds) {
    const { voiceState, amplitude, muted, ended, settings } = state;
    ctx.clearRect(0, 0, width, height);
    if (ended) return;

    const [r, g, b] = STATE_COLOR[voiceState] || STATE_COLOR.listening;
    const cx = width / 2, cy = height / 2;
    const desat = muted ? 0.35 : 1;
    const spread = 1 + amplitude * settings.motionIntensity * 0.9;

    const positions = particles.map((p) => {
      const angle = p.angle + p.speed * BASE_ANGULAR_RATE * (0.3 + amplitude * 1.4) * dtSeconds;
      const radius = p.orbitRadius * spread * (0.7 + p.depth * 0.6);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.7;
      if (!settings.reducedMotion) p.angle = angle;
      return { x, y, depth: p.depth, size: p.size };
    });

    ctx.lineWidth = CONNECTION_WIDTH;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i], b2 = positions[j];
        const dx = a.x - b2.x, dy = a.y - b2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECTION_DISTANCE) {
          // Blend toward white as lines get closer/brighter so the network
          // reads clearly against the dark canvas instead of disappearing
          // into a same-hue haze.
          const proximity = 1 - dist / CONNECTION_DISTANCE;
          const mix = 0.35 * proximity;
          const cr = r + (255 - r) * mix, cg = g + (255 - g) * mix, cb = b + (255 - b) * mix;
          const alpha = proximity * CONNECTION_ALPHA * desat;
          ctx.strokeStyle = `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b2.x, b2.y);
          ctx.stroke();
        }
      }
    }

    for (const p of positions) {
      const alpha = (0.35 + p.depth * 0.5 + amplitude * 0.15) * desat;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.8 + p.depth * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.fill();
    }

    const coreRadius = 20 + amplitude * 18 * settings.motionIntensity;
    const coreGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * 2.2);
    coreGradient.addColorStop(0, `rgba(255, 255, 255, ${0.75 * desat})`);
    coreGradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${0.55 * desat})`);
    coreGradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = coreGradient;
    ctx.fill();
  }

  let lastTime = performance.now();

  function loop(now) {
    const dtSeconds = Math.min(0.1, (now - lastTime) / 1000); // clamp to avoid a huge jump after a tab is backgrounded
    lastTime = now;
    const state = session.getState();
    drawFrame(state, state.settings.reducedMotion ? 0 : dtSeconds);
    // Stop self-scheduling once ended instead of clearing an empty canvas
    // forever; ensureRunning() resumes it exactly once on restart.
    rafId = state.ended ? null : requestAnimationFrame(loop);
  }

  function ensureRunning() {
    const state = session.getState();
    if (state.ended || state.settings.reducedMotion) {
      drawFrame(state, 0); // one static redraw (also clears the canvas on end), no RAF chain
      return;
    }
    if (rafId === null) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    }
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
