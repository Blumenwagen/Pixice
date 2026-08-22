import { useEffect, useRef, useState } from "react";
import styles from "./StreamingText.module.css";

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const FRAME_MS = 16;
export function StreamingText({ text, children }) {
  const [shown, setShown] = useState(() => prefersReducedMotion() ? text : "");
  const shownRef = useRef(shown);
  const pendingRef = useRef(text);
  const frameRef = useRef(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      pendingRef.current = text;
      shownRef.current = text;
      setShown(text);
      return undefined;
    }

    if (!text.startsWith(shownRef.current)) {
      shownRef.current = "";
      setShown("");
    }
    pendingRef.current = text;
    if (shownRef.current === text || frameRef.current !== null) return undefined;

    frameRef.current = window.setTimeout(() => {
      frameRef.current = null;
      const next = pendingRef.current;
      shownRef.current = next;
      setShown((current) => current === next ? current : next);
    }, FRAME_MS);
    return undefined;
  }, [text]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.clearTimeout(frameRef.current);
  }, []);

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
