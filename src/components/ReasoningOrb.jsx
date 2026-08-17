import { useEffect, useMemo, useState } from "react";
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
const GLOBE_STEPS = 8;

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
      if (index === undefined) return 0;
      return -(((index * 3) % RING.length) / RING.length) * 1700;
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

function latticeCells(variant) {
  const cells = [];
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const [ax, ay] = swirl(x, y, -SWIRL);
      const [bx, by] = swirl(x, y, SWIRL);
      cells.push({
        key: `${x},${y}`,
        left: x * PITCH,
        top: y * PITCH,
        delay: cellDelay(variant, x, y),
        ax,
        ay,
        bx,
        by,
        still: (variant === "S3" || variant === "S5") && !RING_INDEX.has(`${x},${y}`),
        mid: x === MID && y === MID,
      });
    }
  }
  return cells;
}

function projectGlobe(x, y, z, spin) {
  const spinCos = Math.cos(spin);
  const spinSin = Math.sin(spin);
  const spunX = x * spinCos - z * spinSin;
  const spunZ = x * spinSin + z * spinCos;
  const tiltCos = Math.cos(GLOBE_TILT);
  const tiltSin = Math.sin(GLOBE_TILT);
  return {
    x: spunX,
    y: y * tiltCos - spunZ * tiltSin,
    z: y * tiltSin + spunZ * tiltCos,
  };
}

function globeOpacity(z) {
  const depth = Math.max(0, Math.min(1, (z / GLOBE_R + 0.15) / 1.15));
  return 0.12 + 0.88 * depth * depth;
}

function globeKeyframeStyle(x, y, z) {
  const style = {};
  for (let step = 0; step < GLOBE_STEPS; step += 1) {
    const spin = (step / GLOBE_STEPS) * Math.PI * 2;
    const projected = projectGlobe(x, y, z, spin);
    style[`--g${step}x`] = `${projected.x.toFixed(2)}px`;
    style[`--g${step}y`] = `${(-projected.y).toFixed(2)}px`;
    style[`--g${step}o`] = globeOpacity(projected.z).toFixed(3);
  }
  return style;
}

function globeDots() {
  const dots = [];
  let key = 0;
  GLOBE_RINGS.forEach((ring) => {
    const latitude = (ring.lat * Math.PI) / 180;
    const y = Math.sin(latitude) * GLOBE_R;
    const radius = Math.cos(latitude) * GLOBE_R;
    for (let index = 0; index < ring.count; index += 1) {
      const longitude = (index / ring.count) * Math.PI * 2;
      dots.push({
        key,
        style: globeKeyframeStyle(
          Math.cos(longitude) * radius,
          y,
          Math.sin(longitude) * radius,
        ),
      });
      key += 1;
    }
  });
  return dots;
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

function Lattice({ variant, slot }) {
  const cells = useMemo(() => latticeCells(variant), [variant]);

  return (
    <span className={styles.layer} data-slot={slot} data-variant={variant}>
      <span className={styles.lattice}>
        {cells.map((cell) => (
          <span
            className={styles.cell}
            data-mid={cell.mid ? "" : undefined}
            data-still={cell.still ? "" : undefined}
            key={cell.key}
            style={{
              left: cell.left,
              top: cell.top,
              animationDelay: `${cell.delay}ms`,
              "--orb-ax": `${cell.ax}px`,
              "--orb-ay": `${cell.ay}px`,
              "--orb-bx": `${cell.bx}px`,
              "--orb-by": `${cell.by}px`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

function Globe({ slot }) {
  const dots = useMemo(() => globeDots(), []);

  return (
    <span className={styles.layer} data-slot={slot} data-variant="G1">
      <span className={styles.helix}>
        {dots.map((dot) => (
          <span className={styles.helixDot} key={dot.key} style={dot.style} />
        ))}
      </span>
    </span>
  );
}

function OrbLayer({ variant, slot }) {
  return variant === "G1"
    ? <Globe slot={slot} />
    : <Lattice variant={variant} slot={slot} />;
}

export function ReasoningOrb({ active = true, variant, size = SIZE, label = "Thinking…", pill = false, decorative = false, className = "", style }) {
  const reducedMotion = useReducedMotion();
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

  return (
    <span
      className={`${styles.root}${className ? ` ${className}` : ""}`}
      data-active={active ? "true" : "false"}
      data-pill={pill ? "" : undefined}
      data-reasoning-orb=""
      style={{ ...style, "--orb-size": `${size}px`, "--orb-k": size / STAGE }}
    >
      <span
        className={styles.glyph}
        role={pill || decorative ? undefined : "img"}
        aria-hidden={pill || decorative ? "true" : undefined}
        aria-label={pill || decorative ? undefined : label}
      >
        <span className={styles.stage}>
          {layers.previous && <OrbLayer variant={layers.previous} slot="previous" />}
          <OrbLayer variant={layers.current} slot="current" />
        </span>
      </span>
      {pill && <span className={styles.pillLabel} role="status">{label}</span>}
    </span>
  );
}
