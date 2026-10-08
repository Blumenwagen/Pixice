import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getPixiceApi } from "../../connect/client.js";
import { useConnect } from "../../connect/ConnectRoot.jsx";
import { Stack } from "../icons/index.jsx";
import { CanvasWorkspace } from "./CanvasWorkspace.jsx";
import { createCanvasStore } from "./canvas-store.js";
import styles from "./Canvas.module.css";

export function CanvasHost({ children }) {
  const connect = useConnect();
  const api = getPixiceApi();
  const hostId = api?.remote?.hostId ?? "local";
  const store = useMemo(() => createCanvasStore(hostId), [hostId]);
  const [targets, setTargets] = useState({ nav: null, app: null });
  const [active, setActive] = useState(() => import.meta.env.DEV && new URLSearchParams(location.search).has("canvas-preview"));
  useEffect(() => {
    const sync = () => {
      const nav = document.querySelector("[data-workflow-nav-slot]");
      const app = document.querySelector("[data-workflow-workspace-slot]");
      setTargets(current => current.nav === nav && current.app === app ? current : { nav, app });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !targets.app) return;
    const app = targets.app.closest(".pixice-app");
    if (!app) return;
    app.dataset.canvasActive = "true";
    const covered = [...app.children].filter(node => node !== targets.app && !node.classList.contains("window-drag-region"));
    const previous = covered.map(node => [node, node.inert, node.getAttribute("aria-hidden"), node.style.visibility]);
    covered.forEach(node => { node.inert = true; node.setAttribute("aria-hidden", "true"); node.style.visibility = "hidden"; });
    return () => {
      delete app.dataset.canvasActive;
      previous.forEach(([node, inert, hidden, visibility]) => { node.inert = inert; hidden === null ? node.removeAttribute("aria-hidden") : node.setAttribute("aria-hidden", hidden); node.style.visibility = visibility; });
      targets.nav?.querySelector(".pixice-canvas-nav")?.focus();
    };
  }, [active, targets.app]);
  useEffect(() => {
    const open = () => setActive(true);
    window.addEventListener("pixice:open-canvas", open);
    return () => window.removeEventListener("pixice:open-canvas", open);
  }, []);
  // Reading Connect keeps this host in step with environment switching without
  // mutating the project/thread selection owned by App.
  void connect;
  return <>{children}
    {targets.nav && createPortal(<button type="button" className="rail-nav-item pixice-canvas-nav" aria-label="Canvases" title="Canvases" onClick={() => setActive(true)}><span className="rail-icon"><Stack size={17} /></span><span className="rail-label">Canvases</span></button>, targets.nav)}
    {targets.app && createPortal(<div className={styles.host} data-active={active} data-native-preview-occluder={active ? "true" : undefined} hidden={!active}>
      <CanvasWorkspace key={hostId} api={api} hostId={hostId} store={store} active={active} onBack={() => setActive(false)} />
    </div>, targets.app)}
  </>;
}
