import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./PromptPreviewRail.module.css";

const ITEM_SIZE = 13;
const HOVER_DISMISS_SLOP = 8;
const SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 };

export function PromptPreviewRail({ items, activeId, onItemSelect, className = "" }) {
  const rootRef = useRef(null);
  const lastPointerType = useRef(null);
  const prefersReducedMotion = useReducedMotion();
  const appReducesMotion = typeof document !== "undefined"
    && document.querySelector(".loom-app")?.dataset.reduceMotion === "true";
  const reduceMotion = prefersReducedMotion || appReducesMotion;
  const [hoveredId, setHoveredId] = useState(null);
  const [focusedId, setFocusedId] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);
  const [itemSize, setItemSize] = useState(ITEM_SIZE);
  const displayedId = hoveredId ?? pinnedId ?? focusedId;
  const highlightedId = displayedId;
  const highlightedIndex = items.findIndex((item) => item.id === highlightedId);
  const displayedItem = useMemo(
    () => items.find((item) => item.id === displayedId) ?? null,
    [displayedId, items],
  );
  const displayedIndex = displayedItem ? items.indexOf(displayedItem) : -1;

  useEffect(() => {
    if (!pinnedId) return undefined;
    const dismiss = (event) => {
      if (!rootRef.current?.contains(event.target)) setPinnedId(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pinnedId]);

  useEffect(() => {
    if (pinnedId && !items.some((item) => item.id === pinnedId)) setPinnedId(null);
  }, [items, pinnedId]);

  useEffect(() => {
    if (!hoveredId) return undefined;
    const dismissOutsideRail = (event) => {
      if (event.pointerType === "touch") return;
      const rail = rootRef.current?.querySelector("nav");
      if (!rail) return;
      const bounds = rail.getBoundingClientRect();
      const outside = event.clientX < bounds.left - HOVER_DISMISS_SLOP
        || event.clientX > bounds.right + HOVER_DISMISS_SLOP
        || event.clientY < bounds.top - HOVER_DISMISS_SLOP
        || event.clientY > bounds.bottom + HOVER_DISMISS_SLOP;
      if (outside) setHoveredId(null);
    };
    const dismissOnWindowBlur = () => setHoveredId(null);
    window.addEventListener("pointermove", dismissOutsideRail, { passive: true });
    window.addEventListener("blur", dismissOnWindowBlur);
    return () => {
      window.removeEventListener("pointermove", dismissOutsideRail);
      window.removeEventListener("blur", dismissOnWindowBlur);
    };
  }, [hoveredId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.height;
      if (available > 0) setItemSize(Math.min(ITEM_SIZE, Math.max(7, Math.floor(available / items.length))));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [items.length]);

  const select = (event, item) => {
    const pointerType = lastPointerType.current;
    lastPointerType.current = null;
    if (pointerType && pointerType !== "mouse" && pinnedId !== item.id) {
      event.preventDefault();
      setPinnedId(item.id);
      return;
    }
    if (pointerType && pointerType !== "mouse") setPinnedId(item.id);
    onItemSelect?.(item);
  };

  if (items.length < 2) return null;

  return (
    <div
      className={`${styles.root}${className ? ` ${className}` : ""}`}
      ref={rootRef}
      data-prompt-preview-rail="true"
      data-expanded={Boolean(displayedId)}
    >
      <nav
        className={styles.rail}
        aria-label="Prompts in this thread"
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setHoveredId(null);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinnedId(null);
            setFocusedId(null);
            event.currentTarget.querySelector('[aria-current="location"]')?.focus();
          }
        }}
      >
        {items.map((item, index) => {
          const distance = highlightedIndex < 0
            ? Number.POSITIVE_INFINITY
            : Math.abs(index - highlightedIndex);
          const scale = distance === 0 ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.28;
          const selected = item.id === activeId;
          return (
            <button
              className={styles.item}
              type="button"
              aria-label={`Jump to prompt ${index + 1}: ${item.label}`}
              aria-current={selected ? "location" : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") {
                  setFocusedId(null);
                  setHoveredId(item.id);
                }
              }}
              onPointerDown={(event) => {
                lastPointerType.current = event.pointerType;
                setFocusedId(null);
              }}
              onPointerCancel={() => { lastPointerType.current = null; }}
              onFocus={(event) => {
                if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id);
              }}
              onClick={(event) => select(event, item)}
              style={{ height: itemSize }}
              key={item.id}
            >
              <motion.span
                className={`${styles.tick}${selected ? ` ${styles.selected}` : ""}`}
                aria-hidden="true"
                animate={{ scaleX: scale }}
                transition={reduceMotion ? { duration: 0 } : SPRING}
              />
            </button>
          );
        })}

        <AnimatePresence initial={false} mode="wait">
          {displayedItem ? (
            <motion.div
              className={styles.preview}
              style={{ top: displayedIndex * itemSize + itemSize / 2 }}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "calc(-50% + 5px)", filter: "blur(6px)" }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: "-50%", filter: "blur(0px)" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: "calc(-50% - 3px)", filter: "blur(4px)" }}
              transition={{ duration: reduceMotion ? 0 : 0.17, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden="true"
              key={displayedItem.id}
            >
              <strong>{displayedItem.label}</strong>
              {displayedItem.description ? <p>{displayedItem.description}</p> : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </nav>
    </div>
  );
}
