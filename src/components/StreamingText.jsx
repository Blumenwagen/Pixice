import { useEffect, useRef, useState } from "react";
import styles from "./StreamingText.module.css";

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const FRAME_MS = 16;
const TARGET_FRAMES = 36;
const MIN_CHUNK = 12;

function nextRevealLength(text, currentLength) {
  const chunk = Math.max(MIN_CHUNK, Math.ceil(text.length / TARGET_FRAMES));
  const target = Math.min(text.length, currentLength + chunk);
  if (target >= text.length) return text.length;

  const nearbyBreak = text.slice(target, target + 24).search(/\s/);
  return nearbyBreak === -1 ? target : Math.min(text.length, target + nearbyBreak + 1);
}

export function StreamingText({ text, children }) {
  const [shown, setShown] = useState(() => prefersReducedMotion() ? text : "");
  const shownRef = useRef(shown);

  useEffect(() => {
    if (prefersReducedMotion()) {
      shownRef.current = text;
      setShown(text);
      return undefined;
    }

    if (!text.startsWith(shownRef.current)) {
      shownRef.current = "";
      setShown("");
    }
    if (shownRef.current.length >= text.length) return undefined;

    const id = window.setInterval(() => {
      const next = text.slice(0, nextRevealLength(text, shownRef.current.length));
      shownRef.current = next;
      setShown(next);
      if (next.length >= text.length) window.clearInterval(id);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [text]);

  const streaming = shown.length < text.length;
  const caret = streaming ? (
    <span
      aria-hidden="true"
      className={styles.caret}
    />
  ) : null;

  if (typeof children === "function") {
    return <div className={styles.prose} data-streaming={streaming ? "true" : "false"}>{children(shown, caret)}</div>;
  }

  return <p className={styles.prose}>{shown}{caret}</p>;
}
