"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaretDown } from "./icons/index.jsx";
import { ThinkingState } from "./ThinkingState.jsx";
import styles from "./AgentActivity.module.css";

const EASE_OUT = [0.22, 1, 0.36, 1];
const SPRING_LAYOUT = { type: "spring", stiffness: 430, damping: 38, mass: 0.82 };
const SPRING_SWAP = { type: "spring", stiffness: 520, damping: 34, mass: 0.72 };

function formatDuration(duration) {
  const seconds = Math.max(0, Math.round(duration));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function useControllableOpen({ open, defaultOpen, onOpenChange }) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = open !== undefined;
  const currentOpen = open ?? internalOpen;
  const setOpen = useCallback((next) => {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange]);
  return [currentOpen, setOpen];
}

function getContentType(items) {
  const first = items[0]?.type;
  return first && items.every((item) => item.type === first) ? first : "mixed";
}

function getActiveLabel(type) {
  if (type === "search") return "Searching the web…";
  if (type === "tool") return "Running tools…";
  if (type === "trace") return "Working through the run…";
  if (type === "mixed") return "Working through it…";
  return "Thinking…";
}

function getSummary(type, items, duration) {
  if (type === "step" || type === "text") {
    return <>Thought for <span className={styles.tabular}>{formatDuration(duration)}</span></>;
  }
  if (type === "search") return "Searched the web";
  if (type === "tool") return `Ran ${items.length} ${items.length === 1 ? "tool" : "tools"}`;
  if (type === "trace") {
    const messages = items.filter((item) => item.kind === "thinking" || item.kind === "message").length;
    const tools = items.length - messages;
    return `${tools} ${tools === 1 ? "tool call" : "tool calls"}, ${messages} ${messages === 1 ? "message" : "messages"}`;
  }
  return `Completed ${items.length} ${items.length === 1 ? "step" : "steps"}`;
}

function AgentDisclosure({ id, labelledBy, open, openHeight, reduce, children }) {
  return (
    <motion.div
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={{ height: open ? openHeight : 0, opacity: open ? 1 : 0 }}
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      className={styles.disclosure}
    >
      {children}
    </motion.div>
  );
}

export function AgentActivity({
  items,
  contentType: initialContentType,
  status = "working",
  duration = 0,
  open,
  defaultOpen = false,
  onOpenChange,
  collapseOnComplete = true,
  activeLabel,
  summary,
  renderWorkingStatus,
  renderCompletedStatus,
  renderItem,
  maxHeight = 208,
  className = "",
  contentClassName = "",
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const contentRef = useRef(null);
  const viewportRef = useRef(null);
  const previousStatus = useRef(status);
  const [contentHeight, setContentHeight] = useState(0);
  const [currentOpen, setOpen] = useControllableOpen({ open, defaultOpen, onOpenChange });
  const working = status === "working";
  const expanded = working || currentOpen;
  const contentType = items.length ? getContentType(items) : (initialContentType ?? "mixed");
  const cappedHeight = Math.min(contentHeight, Math.max(0, maxHeight));
  const viewportHeight = working ? Math.max(0, maxHeight) : cappedHeight;
  const capped = contentHeight > maxHeight;
  const streamOffset = working ? Math.min(0, viewportHeight - contentHeight) : 0;

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => setContentHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousStatus.current === "working" && status === "complete") {
      setOpen(!collapseOnComplete);
    }
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  const toggle = () => {
    const next = !currentOpen;
    setOpen(next);
    if (next) requestAnimationFrame(() => viewportRef.current?.scrollTo?.({ top: 0 }));
  };

  const liveLabel = activeLabel ?? getActiveLabel(contentType);
  const completedSummary = summary ?? getSummary(contentType, items, duration);
  const maskImage = capped
    ? working
      ? "linear-gradient(to bottom, transparent, black 12px)"
      : "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)"
    : undefined;

  return (
    <section
      data-state={working ? "working" : expanded ? "open" : "closed"}
      data-content={contentType}
      data-working={working}
      aria-busy={working}
      className={`${styles.activity} ${className}`.trim()}
    >
      {working ? (
        <div id={triggerId} role="status" aria-live="polite" aria-label={liveLabel} className={styles.workingStatus}>
          {renderWorkingStatus ? renderWorkingStatus({ label: liveLabel, duration }) : <ThinkingState>{liveLabel}</ThinkingState>}
        </div>
      ) : (
        <button
          id={triggerId}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
          className={styles.completedStatus}
        >
          <span className={styles.summary}>
            {renderCompletedStatus ? renderCompletedStatus({ summary: completedSummary, duration }) : completedSummary}
          </span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className={styles.chevron}
          >
            <CaretDown size={14} />
          </motion.span>
        </button>
      )}

      <AgentDisclosure id={contentId} labelledBy={triggerId} open={expanded} openHeight={viewportHeight} reduce={reduce}>
        <div
          ref={viewportRef}
          className={`${styles.viewport} ${capped && expanded && !working ? styles.scrollable : ""}`.trim()}
          style={{ height: viewportHeight, maskImage, WebkitMaskImage: maskImage }}
        >
          <motion.div
            ref={contentRef}
            role="list"
            initial={false}
            animate={{ y: streamOffset }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className={`${styles.content} ${contentClassName}`.trim()}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item, index) => (
                <motion.div
                  layout="position"
                  key={item.id}
                  role="listitem"
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                  transition={reduce ? { duration: 0 } : {
                    opacity: { duration: 0.18, ease: EASE_OUT },
                    y: SPRING_LAYOUT,
                    layout: SPRING_LAYOUT,
                  }}
                >
                  {renderItem ? renderItem(item, index) : item.content}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </div>
      </AgentDisclosure>
    </section>
  );
}
