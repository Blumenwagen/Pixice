import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Warning, X } from "./icons/index.jsx";
import { MorphText } from "./MorphText.jsx";
import { OPERATION_EVENT } from "../state/operation-events.js";

const MOTION_EASE = [0.22, 1, 0.36, 1];

function OperationCapsule({ operation, onDismiss }) {
  const reducedMotion = useReducedMotion();
  const progress = Number.isFinite(operation.progress)
    ? Math.max(0, Math.min(100, operation.progress))
    : null;
  const label = operation.label ?? (operation.tone === "success" || operation.tone === "error"
    ? `${operation.status} · ${operation.title}`
    : `${operation.title} · ${operation.status}`);

  return (
    <motion.article
      layout="position"
      className="operation-capsule"
      data-tone={operation.tone ?? "working"}
      role={operation.tone === "error" ? "alert" : "status"}
      aria-live={operation.tone === "error" ? "assertive" : "polite"}
      initial={reducedMotion ? false : { opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: MOTION_EASE }}
    >
      <div className="operation-capsule-main" title={operation.tone === "error" ? undefined : operation.detail}>
        {operation.tone === "error" && <Warning className="operation-capsule-warning" size={14} />}
        <span className="operation-capsule-copy">
          <strong><MorphText value={label} duration={340} /></strong>
          {operation.tone === "error" && operation.detail && <small><MorphText value={operation.detail} duration={360} /></small>}
        </span>
        <span className="operation-capsule-actions">
          {operation.actionLabel && <button type="button" className="operation-capsule-action" onClick={operation.onAction}>{operation.actionLabel}</button>}
          {operation.dismissible !== false && <button type="button" className="operation-capsule-dismiss" aria-label={`Dismiss ${operation.title}`} onClick={() => onDismiss(operation)}><X size={13} /></button>}
        </span>
      </div>
      {(progress !== null || operation.indeterminate) && operation.tone !== "error" && (
        <span
          className="operation-capsule-track"
          data-indeterminate={operation.indeterminate || undefined}
          role="progressbar"
          aria-label={`${operation.title} progress`}
          aria-valuemin={progress !== null ? 0 : undefined}
          aria-valuemax={progress !== null ? 100 : undefined}
          aria-valuenow={progress !== null ? Math.round(progress) : undefined}
        >
          <motion.i
            initial={false}
            animate={operation.indeterminate ? undefined : { width: `${progress}%` }}
            transition={{ duration: reducedMotion ? 0 : 0.44, ease: MOTION_EASE }}
            style={operation.indeterminate ? undefined : { width: `${progress}%` }}
          />
        </span>
      )}
    </motion.article>
  );
}

export function OperationCapsuleStack({ operations = [], taskOffset = false }) {
  const [transientOperations, setTransientOperations] = useState([]);
  const [dismissedSystem, setDismissedSystem] = useState({});
  const timersRef = useRef(new Map());

  useEffect(() => {
    const receive = (event) => {
      const operation = event.detail;
      if (!operation?.id) return;
      window.clearTimeout(timersRef.current.get(operation.id));
      timersRef.current.delete(operation.id);
      if (operation.dismiss) {
        setTransientOperations((current) => current.filter((candidate) => candidate.id !== operation.id));
        return;
      }
      setTransientOperations((current) => [
        operation,
        ...current.filter((candidate) => candidate.id !== operation.id)
      ].slice(0, 4));
      if (operation.autoDismiss) {
        const timer = window.setTimeout(() => {
          setTransientOperations((current) => current.filter((candidate) => candidate.id !== operation.id));
          timersRef.current.delete(operation.id);
        }, operation.autoDismiss);
        timersRef.current.set(operation.id, timer);
      }
    };
    window.addEventListener(OPERATION_EVENT, receive);
    return () => {
      window.removeEventListener(OPERATION_EVENT, receive);
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const visible = useMemo(() => {
    const items = new Map(transientOperations.map((operation) => [operation.id, operation]));
    operations.forEach((operation) => {
      const signature = `${operation.status}|${operation.detail ?? ""}|${operation.progress ?? ""}`;
      if (dismissedSystem[operation.id] !== signature) items.set(operation.id, operation);
    });
    return [...items.values()].slice(0, 4);
  }, [dismissedSystem, operations, transientOperations]);

  const dismiss = (operation) => {
    operation.onDismiss?.();
    setTransientOperations((current) => current.filter((candidate) => candidate.id !== operation.id));
    if (operations.some((candidate) => candidate.id === operation.id)) {
      setDismissedSystem((current) => ({
        ...current,
        [operation.id]: `${operation.status}|${operation.detail ?? ""}|${operation.progress ?? ""}`
      }));
    }
    window.clearTimeout(timersRef.current.get(operation.id));
    timersRef.current.delete(operation.id);
  };

  return (
    <aside className="operation-capsule-stack" data-task-offset={taskOffset || undefined} aria-label="Background operations">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((operation) => <OperationCapsule operation={operation} onDismiss={dismiss} key={operation.id} />)}
      </AnimatePresence>
    </aside>
  );
}
