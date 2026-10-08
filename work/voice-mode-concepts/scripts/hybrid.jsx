// Hybrid — the ACTUAL incumbent VoiceBeam component (from the installed
// `voice-glow` npm package, the same one src/App.jsx's composer renders)
// integrated at the base of an organic aura core, inside a slow, legible
// constellation halo.
//
// Two corrections from the previous build of this file, both from direct
// pixel review:
//  1. The aura core had been dropped entirely in favor of a flat, empty
//     rounded panel holding VoiceBeam — this restores a recognizable
//     organic aura (same layered-noise-blob technique as the Aura Field
//     concept) and positions VoiceBeam's host so its native bottom-edge
//     bloom rises up through the aura's base, instead of sitting in its
//     own empty card.
//  2. `useSessionState` passed state.js's mutable, always-same-reference
//     state object straight into `setState`. React's `Object.is` bail-out
//     then silently dropped every re-render after the first, so the
//     `level` getter and `active` prop were frozen at mount-time values
//     forever (this is why the beam read as "almost invisible" — it was
//     stuck near its idle floor, never actually reacting to state).
//     Fixed below: a ref is updated on every single emission (so the
//     per-frame `level` getter VoiceBeam samples is always current,
//     exactly like src/App.jsx's `dictationLevelRef` pattern), and React
//     `setState` — an actual state re-render — only fires when a
//     structural field (voiceState/muted/ended/reducedMotion/
//     motionIntensity) genuinely changed, not on every 60fps amplitude
//     tick.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceBeam } from "voice-glow";

// Exact incumbent default palette — src/App.jsx L160-163,
// VOICE_GLOW_ACCENT_PALETTES.coral (accentColor defaults to "coral").
const VOICE_GLOW_CORAL = {
  colors: ["#ff5364", "#4ed6e5", "#9a7cf6", "#ffb44f", "#e56f9d", "#6f95ff", "#55d097"],
  bandColors: { core: "#fff4f5", above: "#ff5364", mid: "#55d097", below: "#6f95ff" },
};

const STATE_COLORS = {
  listening: { core: "#fff4f5", mid: "#ff5364", edge: "#3cbeff" },
  thinking: { core: "#fff6dc", mid: "#dca650", edge: "#9a7cf6" },
  speaking: { core: "#ffffff", mid: "#ff7a86", edge: "#ff5364" },
  error: { core: "#fff0f0", mid: "#ef6b72", edge: "#7a2a30" },
};
const STATE_RGB = {
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
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

// --- fixed reactive bridge to the vanilla state.js session -----------------
// levelRef is written on every emission (every ~60fps tick), read by
// VoiceBeam's getter without ever causing a React re-render. `setSnapshot`
// only fires — with a genuinely new object — when a structural field
// actually differs from last time, so React re-renders stay rare and
// intentional instead of firing 60 times a second.
function useVoiceBandState(session) {
  const levelRef = useRef(session.getState().amplitude);
  levelRef.current = session.getState().amplitude;

  const snapshotOf = (s) => ({
    voiceState: s.voiceState,
    muted: s.muted,
    ended: s.ended,
    transcribing: s.transcribing,
    reducedMotion: s.settings.reducedMotion,
    motionIntensity: s.settings.motionIntensity,
  });

  const [snapshot, setSnapshot] = useState(() => snapshotOf(session.getState()));
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    return session.subscribe((s) => {
      levelRef.current = s.amplitude;
      const next = snapshotOf(s);
      const prev = snapshotRef.current;
      if (
        next.voiceState !== prev.voiceState ||
        next.muted !== prev.muted ||
        next.ended !== prev.ended ||
        next.transcribing !== prev.transcribing ||
        next.reducedMotion !== prev.reducedMotion ||
        next.motionIntensity !== prev.motionIntensity
      ) {
        snapshotRef.current = next;
        setSnapshot(next);
      }
    });
  }, [session]);

  return { snapshot, levelRef };
}

// --- aura core + constellation halo, one canvas, drawn every RAF frame -----
// This reads session.getState() directly inside its own RAF loop (not
// through React state), the same pattern the other three concepts already
// use successfully — it never had the reactivity bug described above.
function AuraHaloCanvas({ session }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas.parentElement;
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

    const rng = createSeededRng(5533);
    const COUNT = 56;
    const particles = Array.from({ length: COUNT }, () => ({
      orbitRadius: 105 + rng() * 175,
      angle: rng() * Math.PI * 2,
      speed: 0.15 + rng() * 0.5,
      depth: rng(),
      size: 0.9 + rng() * 1.7,
    }));

    const BASE_ANGULAR_RATE = 0.3; // rad/s — the requested ~1/4-speed baseline, unchanged
    const CONNECTION_DISTANCE = 60;

    let huePhase = 0;
    const HUE_DURATION = 16; // matches VoiceBeam's hueDuration

    function drawFrame(state, dtSeconds) {
      const { voiceState, muted, ended, settings } = state;
      const colors = STATE_COLORS[voiceState] || STATE_COLORS.listening;
      const [r, g, b] = STATE_RGB[voiceState] || STATE_RGB.listening;
      const cx = width / 2, cy = height * 0.46;
      const intensity = settings.motionIntensity;

      ctx.clearRect(0, 0, width, height);
      if (ended) return;

      const desat = muted ? 0.4 : 1;
      const amp = Math.max(0.12, state.amplitude);
      huePhase += dtSeconds / HUE_DURATION;

      // halo (behind)
      const spread = 1 + amp * intensity * 0.6;
      const positions = particles.map((p) => {
        const angle = p.angle + p.speed * BASE_ANGULAR_RATE * (0.3 + amp * 1.2) * dtSeconds;
        const radius = p.orbitRadius * spread * (0.78 + p.depth * 0.5);
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 0.62;
        if (!settings.reducedMotion) p.angle = angle;
        return { x, y, depth: p.depth, size: p.size };
      });
      ctx.lineWidth = 1.4;
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const a = positions[i], b2 = positions[j];
          const dx = a.x - b2.x, dy = a.y - b2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECTION_DISTANCE) {
            const proximity = 1 - dist / CONNECTION_DISTANCE;
            const mix = 0.45 * proximity;
            const cr = r + (255 - r) * mix, cg = g + (255 - g) * mix, cb = b + (255 - b) * mix;
            const alpha = proximity * 0.68 * desat; // brighter, clearly readable per feedback
            ctx.strokeStyle = `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b2.x, b2.y);
            ctx.stroke();
          }
        }
      }
      for (const p of positions) {
        const alpha = (0.4 + p.depth * 0.45) * desat;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fill();
      }

      // aura core (front) — the recognizable organic silhouette, restored
      const baseRadius = Math.min(width, height) * 0.2;
      const layers = 3;
      for (let layer = layers; layer >= 1; layer--) {
        const layerFrac = layer / layers;
        const wobble = amp * intensity * (20 + layer * 9);
        const points = 46;
        ctx.beginPath();
        for (let i = 0; i <= points; i++) {
          const theta = (i / points) * Math.PI * 2;
          const n =
            Math.sin(theta * 3 + huePhase * 7 * (0.6 + layer * 0.15)) * 0.5 +
            Math.sin(theta * 5 - huePhase * 5) * 0.3 +
            Math.sin(theta * 2 + huePhase * 2.4) * 0.2;
          const rad = baseRadius * (0.6 + layerFrac * 0.5) + n * wobble;
          const x = cx + Math.cos(theta) * rad;
          const y = cy + Math.sin(theta) * rad * 0.86;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 1.7);
        gradient.addColorStop(0, withAlpha(colors.core, (0.42 + amp * 0.3) * desat));
        gradient.addColorStop(0.55, withAlpha(colors.mid, (0.3 / layerFrac) * desat));
        gradient.addColorStop(1, withAlpha(colors.edge, 0));
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    }

    let rafId = null;
    let lastTime = performance.now();
    function loop(now) {
      const dtSeconds = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const state = session.getState();
      drawFrame(state, state.settings.reducedMotion ? 0 : dtSeconds);
      // Stop self-scheduling once ended instead of clearing an empty canvas
      // forever; ensureRunning() below resumes it exactly once on restart.
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

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      unsubscribe();
      resizeObserver.disconnect();
    };
  }, [session]);

  return <canvas ref={canvasRef} className="hybrid-aura-canvas" role="img" aria-label="Organic aura core with a slow particle network surrounding it" />;
}

function HybridVisualization({ session }) {
  const { snapshot, levelRef } = useVoiceBandState(session);
  // Lives on the shared session (state.transcribing), not component-local
  // useState — a component-local flag resets to false on every remount
  // (tab switch away-and-back, the reduced-motion toggle's forced
  // remount), which silently discarded the user's chosen preview mode.
  // The shared session only resets it on an explicit end()/restart().
  const transcribing = snapshot.transcribing;
  const getLevel = useMemo(() => () => levelRef.current, [levelRef]);
  const active = !snapshot.ended;

  return (
    <div className="hybrid-stage-inner">
      <AuraHaloCanvas session={session} />

      {/* VoiceBeam's own effect blooms upward from this host's bottom edge —
          the host is positioned so that edge sits at the aura's base, and is
          otherwise fully transparent (no card/background of its own), so the
          real beam reads as part of the aura rather than a separate panel. */}
      <div className="hybrid-band-host-wrap">
        <VoiceBeam
          level={getLevel}
          active={active}
          processing={transcribing}
          paused={snapshot.reducedMotion}
          theme="dark"
          colors={VOICE_GLOW_CORAL.colors}
          bandColors={VOICE_GLOW_CORAL.bandColors}
          hueRange={10}
          hueDuration={16}
          idle={0.12}
          attack={0.12}
          release={0.46}
          strength={0.82}
          distortion={0}
          borderRadius={22}
          className="hybrid-voice-beam"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        >
          <span className="hybrid-band-host" />
        </VoiceBeam>
      </div>

      <div className="hybrid-transcribe-control">
        <button
          type="button"
          className="hybrid-transcribe-toggle"
          aria-pressed={transcribing}
          onClick={() => session.setTranscribing(!transcribing)}
        >
          {transcribing ? "Transcribing (simulated)" : "Simulate transcribing"}
        </button>
        <p className="hybrid-transcribe-note">Real VoiceBeam component · level/processing are simulated, not live audio.</p>
      </div>
    </div>
  );
}

export function mount(container, session) {
  const root = createRoot(container);
  root.render(<HybridVisualization session={session} />);
  return function unmount() {
    root.unmount();
  };
}
