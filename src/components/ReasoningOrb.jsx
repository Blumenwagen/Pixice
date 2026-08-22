import { useEffect, useRef, useState } from "react";
import styles from "./ReasoningOrb.module.css";

const STAGE = 28;
const SIZE = 20;
const N = 3;
const PITCH = 6;
const MID = (N - 1) / 2;
const SWIRL = 1.05;
const SPREAD = 1.6;
const MORPH_MS = 520;
const MIN_HOLD_MS = 1800;
const MAX_HOLD_MS = 3400;
const GLOBE_R = 8.5;
const GLOBE_TILT = (14 * Math.PI) / 180;
const FRAME_RATE = 24;
const FRAME_MS = 1000 / FRAME_RATE;

export const REASONING_ORB_VARIANTS = ["S1", "S2", "S3", "S4", "S5", "G1"];

const GLOBE_RINGS = [52, 26, 0, -26, -52].map((lat) => ({ lat, count: 8 }));

const RING = (() => {
  const ring = [];
  for (let x = 0; x < N; x += 1) ring.push([x, 0]);
  for (let y = 1; y < N; y += 1) ring.push([N - 1, y]);
  for (let x = N - 2; x >= 0; x -= 1) ring.push([x, N - 1]);
  for (let y = N - 2; y >= 1; y -= 1) ring.push([0, y]);
  return ring;
})();

const RING_INDEX = new Map(RING.map(([x, y], index) => [`${x},${y}`, index]));

// All visible orbs share one deliberately low-frequency clock. The old DOM
// implementation gave every dot its own infinite compositor animation, which
// kept Chromium producing frames even while the rest of Loom was idle.
const frameSubscribers = new Set();
let frameTimer = null;
let frameRequest = null;

function stopFrameClock() {
  if (frameTimer !== null) window.clearTimeout(frameTimer);
  if (frameRequest !== null) window.cancelAnimationFrame?.(frameRequest);
  frameTimer = null;
  frameRequest = null;
}

function scheduleFrame() {
  if (!frameSubscribers.size || frameTimer !== null || frameRequest !== null) return;
  frameTimer = window.setTimeout(() => {
    frameTimer = null;
    if (!frameSubscribers.size) return;
    frameRequest = window.requestAnimationFrame((timestamp) => {
      frameRequest = null;
      frameSubscribers.forEach((draw) => draw(timestamp));
      scheduleFrame();
    });
  }, FRAME_MS);
}

function subscribeToFrameClock(draw) {
  frameSubscribers.add(draw);
  scheduleFrame();
  return () => {
    frameSubscribers.delete(draw);
    if (!frameSubscribers.size) stopFrameClock();
  };
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
}

function easeInOut(value) {
  const t = clamp(value);
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function cycle(elapsed, duration, delay = 0) {
  const shifted = elapsed - delay;
  if (shifted < 0) return 0;
  return (shifted % duration) / duration;
}

function cellDelay(variant, x, y) {
  const dx = x - MID;
  const dy = y - MID;

  switch (variant) {
    case "S1":
      return Math.hypot(dx, dy) * 700 - (dx === 0 && dy === 0 ? 180 : 0);
    case "S2":
      return ((x + y) / (2 * (N - 1))) * 1500;
    case "S3": {
      const index = RING_INDEX.get(`${x},${y}`);
      return index === undefined ? 0 : -(((RING.length - index) % RING.length) / RING.length) * 1700;
    }
    case "S4":
      return (x / (N - 1)) * 1100;
    case "S5": {
      const index = RING_INDEX.get(`${x},${y}`);
      return index === undefined ? 0 : -(((index * 3) % RING.length) / RING.length) * 1700;
    }
    default:
      return 0;
  }
}

function swirl(x, y, angle) {
  const dx = x - MID;
  const dy = y - MID;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    ((dx * cos - dy * sin) * SPREAD - dx) * PITCH,
    ((dx * sin + dy * cos) * SPREAD - dy) * PITCH,
  ];
}

const LATTICE_CELLS = Object.fromEntries(REASONING_ORB_VARIANTS.filter((variant) => variant !== "G1").map((variant) => [
  variant,
  Array.from({ length: N * N }, (_, index) => {
    const x = index % N;
    const y = Math.floor(index / N);
    const [ax, ay] = swirl(x, y, -SWIRL);
    const [bx, by] = swirl(x, y, SWIRL);
    return {
      x: 8 + x * PITCH,
      y: 8 + y * PITCH,
      ax,
      ay,
      bx,
      by,
      delay: cellDelay(variant, x, y),
      still: (variant === "S3" || variant === "S5") && !RING_INDEX.has(`${x},${y}`),
      mid: x === MID && y === MID,
    };
  }),
]));

const GLOBE_DOTS = GLOBE_RINGS.flatMap((ring) => {
  const latitude = (ring.lat * Math.PI) / 180;
  const y = Math.sin(latitude) * GLOBE_R;
  const radius = Math.cos(latitude) * GLOBE_R;
  return Array.from({ length: ring.count }, (_, index) => {
    const longitude = (index / ring.count) * Math.PI * 2;
    return { x: Math.cos(longitude) * radius, y, z: Math.sin(longitude) * radius };
  });
});

function drawDot(context, x, y, radius, opacity, color) {
  if (opacity <= 0) return;
  const layerAlpha = context.globalAlpha;
  context.fillStyle = color;
  context.globalAlpha = layerAlpha * opacity * 0.22;
  context.beginPath();
  context.arc(x, y, radius + 1.25, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = layerAlpha * opacity;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = layerAlpha;
}

function sweepFrame(progress) {
  if (progress < 0.42) return { opacity: mix(0.12, 0.42, progress / 0.42), scale: mix(0.5, 0.72, progress / 0.42) };
  if (progress < 0.55) return { opacity: mix(0.42, 1, (progress - 0.42) / 0.13), scale: mix(0.72, 1.14, (progress - 0.42) / 0.13) };
  if (progress < 0.7) return { opacity: mix(1, 0.3, (progress - 0.55) / 0.15), scale: mix(1.14, 0.62, (progress - 0.55) / 0.15) };
  return { opacity: mix(0.3, 0.12, (progress - 0.7) / 0.3), scale: mix(0.62, 0.5, (progress - 0.7) / 0.3) };
}

function cometFrame(progress) {
  if (progress < 0.12) return { opacity: mix(0.12, 1, progress / 0.12), scale: mix(0.45, 1.2, progress / 0.12) };
  if (progress < 0.34) return { opacity: mix(1, 0.52, (progress - 0.12) / 0.22), scale: mix(1.2, 0.78, (progress - 0.12) / 0.22) };
  if (progress < 0.62) return { opacity: mix(0.52, 0.2, (progress - 0.34) / 0.28), scale: mix(0.78, 0.55, (progress - 0.34) / 0.28) };
  return { opacity: mix(0.2, 0.12, (progress - 0.62) / 0.38), scale: mix(0.55, 0.45, (progress - 0.62) / 0.38) };
}

function drawLattice(context, variant, elapsed, color, staticFrame) {
  LATTICE_CELLS[variant].forEach((cell) => {
    if (staticFrame) {
      drawDot(context, cell.x, cell.y, 1.5 * (cell.mid ? 1.05 : 0.68), cell.mid ? 1 : 0.28, color);
      return;
    }
    if (cell.still) {
      drawDot(context, cell.x, cell.y, 1.5 * 0.58, 0.24, color);
      return;
    }

    if (variant === "S1") {
      const progress = cycle(elapsed, 2800, cell.delay);
      let opacity;
      let scale;
      let x;
      let y;
      if (progress < 0.35) {
        const amount = easeInOut(progress / 0.35);
        opacity = mix(0.08, 0.94, amount);
        scale = mix(0.18, 1, amount);
        x = cell.x + mix(cell.ax, 0, amount);
        y = cell.y + mix(cell.ay, 0, amount);
      } else if (progress < 0.52) {
        const amount = easeInOut((progress - 0.35) / 0.17);
        opacity = mix(0.94, 0.72, amount);
        scale = mix(1, 0.82, amount);
        x = cell.x;
        y = cell.y;
      } else {
        const amount = easeInOut((progress - 0.52) / 0.48);
        opacity = mix(0.72, 0.08, amount);
        scale = mix(0.82, 0.18, amount);
        x = cell.x + mix(0, cell.bx, amount);
        y = cell.y + mix(0, cell.by, amount);
      }
      drawDot(context, x, y, 1.5 * scale, opacity, color);
      return;
    }

    const duration = variant === "S4" ? 1650 : variant === "S2" ? 2000 : 1700;
    const frame = variant === "S2" || variant === "S4"
      ? sweepFrame(cycle(elapsed, duration, cell.delay))
      : cometFrame(cycle(elapsed, duration, cell.delay));
    drawDot(context, cell.x, cell.y, 1.5 * frame.scale, frame.opacity, color);
  });
}

function projectGlobe(dot, spin) {
  const spinCos = Math.cos(spin);
  const spinSin = Math.sin(spin);
  const spunX = dot.x * spinCos - dot.z * spinSin;
  const spunZ = dot.x * spinSin + dot.z * spinCos;
  const tiltCos = Math.cos(GLOBE_TILT);
  const tiltSin = Math.sin(GLOBE_TILT);
  return {
    x: spunX,
    y: dot.y * tiltCos - spunZ * tiltSin,
    z: dot.y * tiltSin + spunZ * tiltCos,
  };
}

function drawGlobe(context, elapsed, color, staticFrame) {
  const spin = staticFrame ? 0 : (elapsed % 4500) / 4500 * Math.PI * 2;
  GLOBE_DOTS.map((dot) => projectGlobe(dot, spin))
    .sort((a, b) => a.z - b.z)
    .forEach((dot) => {
      const depth = clamp((dot.z / GLOBE_R + 0.15) / 1.15);
      const opacity = 0.12 + 0.88 * depth * depth;
      drawDot(context, STAGE / 2 + dot.x, STAGE / 2 - dot.y, 1, opacity, color);
    });
}

function drawLayer(context, variant, elapsed, color, staticFrame, transform) {
  context.save();
  context.translate(STAGE / 2, STAGE / 2);
  context.rotate(transform.rotation);
  context.scale(transform.scale, transform.scale);
  context.translate(-STAGE / 2, -STAGE / 2);
  context.globalAlpha = transform.opacity;
  if (variant === "G1") drawGlobe(context, elapsed, color, staticFrame);
  else drawLattice(context, variant, elapsed, color, staticFrame);
  context.restore();
}

function nextVariant(current) {
  const currentIndex = REASONING_ORB_VARIANTS.indexOf(current);
  const offset = 1 + Math.floor(Math.random() * (REASONING_ORB_VARIANTS.length - 1));
  return REASONING_ORB_VARIANTS[(currentIndex + offset) % REASONING_ORB_VARIANTS.length];
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

function useOrbCanvas(canvasRef, layers, active, reducedMotion) {
  const animationOrigin = useRef(performance.now());
  const transitionOrigin = useRef(performance.now());

  useEffect(() => {
    transitionOrigin.current = performance.now();
  }, [layers.current]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let context;
    try {
      context = canvas.getContext("2d");
    } catch {
      return undefined;
    }
    if (!context) return undefined;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(STAGE * ratio);
    canvas.height = Math.round(STAGE * ratio);
    const color = window.getComputedStyle(canvas).color || "#ff7a86";
    let intersecting = true;
    let unsubscribe = null;

    const draw = (timestamp = performance.now()) => {
      const elapsed = timestamp - animationOrigin.current;
      const morph = clamp((timestamp - transitionOrigin.current) / MORPH_MS);
      const staticFrame = reducedMotion || !active;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, STAGE, STAGE);

      if (layers.previous && !staticFrame) {
        const amount = easeInOut(morph);
        drawLayer(context, layers.previous, elapsed, color, false, {
          opacity: 1 - amount,
          scale: mix(1, 1.28, amount),
          rotation: mix(0, 24 * Math.PI / 180, amount),
        });
      }

      const arrive = layers.previous && !staticFrame ? easeInOut(morph) : 1;
      drawLayer(context, layers.current, elapsed, color, staticFrame, {
        opacity: arrive,
        scale: mix(0.66, 1, arrive),
        rotation: mix(-28 * Math.PI / 180, 0, arrive),
      });
    };

    const syncClock = () => {
      const shouldAnimate = active && !reducedMotion && intersecting && !document.hidden && typeof window.requestAnimationFrame === "function";
      if (shouldAnimate && !unsubscribe) unsubscribe = subscribeToFrameClock(draw);
      if (!shouldAnimate && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      draw();
    };

    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => {
        intersecting = entry?.isIntersecting ?? true;
        syncClock();
      })
      : null;
    observer?.observe(canvas);
    document.addEventListener("visibilitychange", syncClock);
    syncClock();

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", syncClock);
      unsubscribe?.();
    };
  }, [active, canvasRef, layers, reducedMotion]);
}

export function ReasoningOrb({ active = true, variant, size = SIZE, label = "Thinking…", pill = false, decorative = false, className = "", style }) {
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef(null);
  const [layers, setLayers] = useState({ current: variant ?? "S1", previous: null });

  useEffect(() => {
    if (variant || !active || reducedMotion) {
      setLayers({ current: variant ?? "S1", previous: null });
      return undefined;
    }

    let timer;
    const schedule = () => {
      const hold = MIN_HOLD_MS + Math.random() * (MAX_HOLD_MS - MIN_HOLD_MS);
      timer = window.setTimeout(() => {
        setLayers((state) => ({ current: nextVariant(state.current), previous: state.current }));
        schedule();
      }, hold);
    };

    schedule();
    return () => window.clearTimeout(timer);
  }, [active, reducedMotion, variant]);

  useEffect(() => {
    if (!layers.previous) return undefined;
    const timer = window.setTimeout(() => {
      setLayers((state) => ({ ...state, previous: null }));
    }, MORPH_MS);
    return () => window.clearTimeout(timer);
  }, [layers.current, layers.previous]);

  useOrbCanvas(canvasRef, layers, active, reducedMotion);

  return (
    <span
      className={`${styles.root}${className ? ` ${className}` : ""}`}
      data-active={active ? "true" : "false"}
      data-pill={pill ? "" : undefined}
      data-reasoning-orb=""
      data-renderer="canvas"
      data-frame-rate={FRAME_RATE}
      style={{ ...style, "--orb-size": `${size}px`, "--orb-k": size / STAGE }}
    >
      <span
        className={styles.glyph}
        role={pill || decorative ? undefined : "img"}
        aria-hidden={pill || decorative ? "true" : undefined}
        aria-label={pill || decorative ? undefined : label}
      >
        <span
          className={styles.stage}
          data-current-variant={layers.current}
          data-previous-variant={layers.previous ?? undefined}
          data-dot-count={layers.current === "G1" ? GLOBE_DOTS.length : N * N}
        >
          <canvas className={styles.canvas} ref={canvasRef} />
        </span>
      </span>
      {pill && <span className={styles.pillLabel} role="status">{label}</span>}
    </span>
  );
}
