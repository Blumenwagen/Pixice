import { Fragment, useEffect, useRef, useState } from "react";
import styles from "./StreamingTextVariants.module.css";

export const STREAMING_VARIANTS = [
  {
    id: "fade",
    name: "Word fade",
    description: "Each new word fades into place. The text stays still.",
    detail: "Opacity only · 240 ms",
  },
  {
    id: "focus",
    name: "Soft focus",
    description: "Words resolve from a light blur with a small upward settle.",
    detail: "1.5 px blur · 8 px rise · 320 ms",
  },
  {
    id: "fluid",
    name: "Fluid typing",
    description: "Incoming chunks become a continuous flow of characters.",
    detail: "Smoothed delivery · slim caret",
  },
];

export const FOCUS_VARIANTS = [
  {
    id: "crisp",
    name: "Crisp focus",
    description: "A quicker, lighter version. Words sharpen and settle promptly.",
    detail: "1 px blur · 8 px rise · 240 ms",
  },
  {
    id: "dissolve",
    name: "Focus dissolve",
    description: "A softer blur resolves in place, with no vertical movement.",
    detail: "2 px blur · no travel · 380 ms",
  },
  {
    id: "cascade",
    name: "Gentle cascade",
    description: "Words arrive with a slight stagger for a flowing, softer rhythm.",
    detail: "1.5 px blur · 8 px rise · 340 ms + stagger",
  },
];

export function useStreamingReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return undefined;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function characters(text) {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment) : Array.from(text);
}

function useFluidText(text, disabled, paused) {
  const [shown, setShown] = useState(disabled ? text : "");
  const shownRef = useRef(shown);
  const targetRef = useRef([]);
  const positionRef = useRef(0);

  useEffect(() => {
    targetRef.current = characters(text);
    if (disabled) {
      shownRef.current = text;
      positionRef.current = targetRef.current.length;
      setShown(text);
    } else if (!text.startsWith(shownRef.current)) {
      shownRef.current = "";
      positionRef.current = 0;
      setShown("");
    }
  }, [text, disabled]);

  useEffect(() => {
    if (disabled || paused || shownRef.current === text) return undefined;
    let frame;
    let previous;
    let credit = 0;
    const tick = (now) => {
      const elapsed = previous === undefined ? 0 : Math.min(now - previous, 48);
      previous = now;
      const remaining = targetRef.current.length - positionRef.current;
      if (remaining > 0) {
        // Drain bursts promptly rather than adding a long typewriter queue.
        credit += elapsed / 1000 * Math.max(85, remaining / 0.2);
        const count = Math.min(remaining, Math.floor(credit));
        if (count > 0) {
          credit -= count;
          positionRef.current += count;
          shownRef.current = targetRef.current.slice(0, positionRef.current).join("");
          setShown(shownRef.current);
        }
      } else credit = 0;
      if (positionRef.current < targetRef.current.length) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [text, disabled, paused]);

  return disabled ? text : shown;
}

export function StreamingTextVariant({ text, variant = "fade", active = false, paused = false, reducedMotion = false, onSettled }) {
  const systemReduced = useStreamingReducedMotion();
  const reduced = reducedMotion || systemReduced;
  const shown = useFluidText(text, variant !== "fluid" || reduced, paused);
  const settled = !active && shown === text;

  useEffect(() => { onSettled?.(settled); }, [settled, onSettled]);

  const classes = [styles.text, styles[variant], reduced && styles.reduced, paused && styles.paused].filter(Boolean).join(" ");
  return (
    <div className={classes} data-variant={variant} data-settled={settled}>
      {variant === "fluid" || reduced ? shown : (text.match(/\S+|\s+/g) ?? []).map((token, index) => (
        /^\s+$/.test(token) ? <Fragment key={index}>{token}</Fragment> : <span className={styles.word} key={index} style={variant === "cascade" ? { "--word-stagger": `${Math.floor(index / 2) % 4 * 24}ms` } : undefined}>{token}</span>
      ))}
      {variant === "fluid" && !settled && !reduced && <span className={styles.caret} aria-hidden="true" />}
    </div>
  );
}
