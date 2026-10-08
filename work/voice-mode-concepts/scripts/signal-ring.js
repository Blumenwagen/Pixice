// Signal Ring — precise, cinematic scanner HUD.
// Inspired by GMUNK's Oblivion GFX (Light Table + Bubbleship + Gun-HUD
// language: functional minimalism, a bright unified accent on dark, radial
// scope/gauge readouts, restrained greeble) rather than a literal movie HUD.
// Built with SVG + CSS/JS, deliberately keeping copy short and legible.

const SVG_NS = "http://www.w3.org/2000/svg";

const STATE_ACCENT = {
  listening: "#ff5364",
  thinking: "#dca650",
  speaking: "#ff7a86",
  error: "#ef6b72",
};

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export function mount(container, session) {
  const wrap = document.createElement("div");
  wrap.className = "signal-ring-wrap";

  const size = 320;
  const svg = el("svg", {
    viewBox: `0 0 ${size} ${size}`,
    width: "100%",
    height: "100%",
    role: "img",
    "aria-label": "Signal ring voice activity scanner",
  });
  const cx = size / 2, cy = size / 2;

  const outerRing = el("circle", { cx, cy, r: 120, fill: "none", stroke: "currentColor", "stroke-width": 1, class: "ring-static" });
  const midRing = el("circle", { cx, cy, r: 96, fill: "none", stroke: "currentColor", "stroke-width": 1, class: "ring-static ring-faint" });

  const ticksGroup = el("g", { class: "ring-ticks" });
  const tickCount = 48;
  for (let i = 0; i < tickCount; i++) {
    const angle = (i / tickCount) * Math.PI * 2;
    const long = i % 4 === 0;
    const r1 = 120;
    const r2 = long ? 108 : 114;
    const x1 = cx + Math.cos(angle) * r1, y1 = cy + Math.sin(angle) * r1;
    const x2 = cx + Math.cos(angle) * r2, y2 = cy + Math.sin(angle) * r2;
    ticksGroup.appendChild(el("line", { x1, y1, x2, y2, stroke: "currentColor", "stroke-width": long ? 1.4 : 0.8, class: "ring-faint" }));
  }

  const sweepGroup = el("g", {});
  const sweep = el("path", { d: describeArc(cx, cy, 108, -90, -40), fill: "none", stroke: "currentColor", "stroke-width": 2.4, "stroke-linecap": "round", class: "ring-sweep" });
  sweepGroup.appendChild(sweep);

  const levelArc = el("path", { d: describeArc(cx, cy, 132, -90, -90), fill: "none", stroke: "currentColor", "stroke-width": 3, "stroke-linecap": "round", class: "ring-level" });

  const core = el("circle", { cx, cy, r: 46, fill: "currentColor", class: "ring-core" });
  const coreRim = el("circle", { cx, cy, r: 46, fill: "none", stroke: "currentColor", "stroke-width": 1.5, class: "ring-core-rim" });

  svg.append(midRing, outerRing, ticksGroup, levelArc, sweepGroup, coreRim, core);
  wrap.appendChild(svg);

  const readout = document.createElement("div");
  readout.className = "signal-readout mono";
  readout.innerHTML = `<span class="readout-state">LISTENING</span><span class="readout-amp">00%</span>`;
  wrap.appendChild(readout);

  container.appendChild(wrap);

  let rafId = null;
  let sweepAngle = -90;

  function render(state) {
    const { voiceState, amplitude, muted, ended, settings } = state;
    const accent = STATE_ACCENT[voiceState] || STATE_ACCENT.listening;
    wrap.style.color = accent;
    wrap.style.opacity = ended ? "0.25" : muted ? "0.55" : "1";

    const levelSweep = 40 + amplitude * 260 * settings.motionIntensity;
    levelArc.setAttribute("d", describeArc(cx, cy, 132, -90, -90 + Math.min(300, levelSweep)));

    const coreScale = 1 + amplitude * 0.22 * settings.motionIntensity;
    core.setAttribute("r", 46 * coreScale * (muted ? 0.85 : 1));
    core.setAttribute("opacity", 0.14 + amplitude * 0.5);

    readout.querySelector(".readout-state").textContent = ended ? "ENDED" : muted ? `${voiceState.toUpperCase()} · MUTED` : voiceState.toUpperCase();
    readout.querySelector(".readout-amp").textContent = `${Math.round(amplitude * 100).toString().padStart(2, "0")}%`;

    sweep.style.opacity = voiceState === "error" ? "0.35" : "1";
  }

  function loop() {
    const state = session.getState();
    if (!state.settings.reducedMotion) {
      const speed = 0.6 + state.amplitude * 2.2;
      sweepAngle = (sweepAngle + speed) % 360;
      sweep.setAttribute("d", describeArc(cx, cy, 108, sweepAngle, sweepAngle + 50));
    }
    render(state);
    // Stop self-scheduling once ended instead of animating an ended,
    // dimmed dial forever; ensureRunning() resumes it exactly once on restart.
    rafId = state.ended ? null : requestAnimationFrame(loop);
  }

  function ensureRunning() {
    const state = session.getState();
    if (state.ended || state.settings.reducedMotion) {
      render(state); // one static redraw (also reflects ENDED immediately), no RAF chain
      return;
    }
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  sweep.setAttribute("d", describeArc(cx, cy, 108, -90, -40));
  // subscribe() invokes ensureRunning() once immediately with current state.
  const unsubscribe = session.subscribe(ensureRunning);

  return function unmount() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (unsubscribe) unsubscribe();
    container.removeChild(wrap);
  };
}

function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = polar(cx, cy, r, endDeg);
  const end = polar(cx, cy, r, startDeg);
  const largeArc = Math.abs(endDeg - startDeg) <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
