import { useEffect, useRef } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import styles from "./Canvas.module.css";

// Deliberately a two-dimensional sphere: no ears, limbs, or extra silhouette.
export function CanvasAvatar({ size = 40, follow = true }) {
  const eyes = useRef(null);
  const eyelids = useRef(null);
  const sphere = useRef(null);
  useEffect(() => {
    if (!follow || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = null;
    let current = { x: 0, y: 0 };
    let target = { x: 0, y: 0 };
    let lastTime = 0;
    const settle = time => {
      const elapsed = lastTime ? Math.min(40, time - lastTime) : 16;
      lastTime = time;
      const smoothing = 1 - Math.exp(-elapsed / 85);
      current = { x: current.x + (target.x - current.x) * smoothing, y: current.y + (target.y - current.y) * smoothing };
      eyes.current?.setAttribute("transform", `translate(${current.x.toFixed(3)} ${current.y.toFixed(3)})`);
      if (Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > .015) frame = requestAnimationFrame(settle);
      else { frame = null; lastTime = 0; }
    };
    const move = event => {
      if (sphere.current?.closest(".pixice-app")?.dataset.reduceMotion === "true") return;
      const bounds = sphere.current?.getBoundingClientRect();
      if (!bounds || !eyes.current) return;
      const dx = event.clientX - bounds.left - bounds.width / 2;
      const dy = event.clientY - bounds.top - bounds.height / 2;
      const distance = Math.max(80, Math.hypot(dx, dy));
      target = { x: dx / distance * 4.5, y: dy / distance * 4.5 };
      if (frame === null) frame = requestAnimationFrame(settle);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); if (frame !== null) cancelAnimationFrame(frame); };
  }, [follow]);
  useEffect(() => {
    let timer;
    let blink;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches && sphere.current?.closest(".pixice-app")?.dataset.reduceMotion !== "true" && document.visibilityState !== "hidden") {
          blink = eyelids.current?.animate?.([{ transform: "scaleY(1)", offset: 0 }, { transform: "scaleY(.12)", offset: .42 }, { transform: "scaleY(1)", offset: 1 }], { duration: 180, easing: "cubic-bezier(.4,0,.2,1)" });
        }
        schedule();
      }, 2400 + Math.random() * 3200);
    };
    schedule();
    return () => { clearTimeout(timer); blink?.cancel(); };
  }, []);
  return <svg ref={sphere} className={styles.avatar} width={size} height={size} viewBox="0 0 80 80" role="img" aria-label="Pixice canvas companion">
    <circle cx="40" cy="40" r="36" fill="#080808" />
    <g ref={eyes} fill="#ffffff"><g ref={eyelids} style={{ transformOrigin: "40px 38.5px" }}><rect x="27" y="31" width="8" height="15" rx="4" /><rect x="45" y="31" width="8" height="15" rx="4" /></g></g>
  </svg>;
}

export function CanvasCompanionMenu({ point, options, onChoose, onClose }) {
  const menuRef = useRef(null);
  const present = useIsPresent();
  const reducedMotion = useReducedMotion() || document.querySelector(".pixice-app")?.dataset.reduceMotion === "true";
  useEffect(() => {
    menuRef.current?.querySelector("button")?.focus();
    const dismiss = event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);
  return <div className={styles.companionAnchor} style={{ left: point.x, top: point.y, pointerEvents: present ? "auto" : "none" }} inert={!present}><motion.div className={styles.companionMenu} ref={menuRef} role="menu" aria-label="Add to canvas" initial={{ opacity: 0, y: reducedMotion ? 0 : 8, scale: reducedMotion ? 1 : .96, filter: reducedMotion ? "none" : "blur(2px)" }} animate={{ opacity: 1, y: 0, scale: 1, filter: reducedMotion ? "none" : "blur(0px)" }} exit={{ opacity: 0, y: reducedMotion ? 0 : 4, scale: reducedMotion ? 1 : .98, filter: reducedMotion ? "none" : "blur(1px)" }} transition={{ duration: reducedMotion ? .1 : .24, ease: [.22, 1, .36, 1] }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Tab"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menuRef.current.querySelectorAll("button")];
    const direction = ["ArrowUp", "ArrowLeft"].includes(event.key) || event.key === "Tab" && event.shiftKey ? -1 : 1;
    buttons[(buttons.indexOf(document.activeElement) + direction + buttons.length) % buttons.length]?.focus();
  }}>
    <div className={styles.menuOrb}><CanvasAvatar /><span>Make room for an idea</span></div>
    {options.map(({ kind, label, icon: Icon }, index) => <button key={kind} role="menuitem" style={{ "--option": index }} onClick={() => onChoose(kind)}><Icon size={16} /><span>{label}</span></button>)}
    <small>esc to tuck me away</small>
  </motion.div></div>;
}
