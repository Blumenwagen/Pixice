import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./IosSimulatorPreview.module.css";

function firstRunnable(containers) {
  const container = containers.find((candidate) => candidate.schemes?.length);
  return container ? { containerPath: container.relativePath, scheme: container.schemes[0] } : { containerPath: "", scheme: "" };
}

function issueText(issue) {
  return [issue.message, issue.detail].filter(Boolean).join(" ");
}

export function IosSimulatorPreview({
  api,
  projectId,
  workspaceId,
  initialSession = null,
  onTitleChange = null,
  onSessionChange = null,
  onOpenResource = null
}) {
  const [environment, setEnvironment] = useState(null);
  const [containers, setContainers] = useState([]);
  const [selection, setSelection] = useState({ containerPath: "", scheme: "", simulatorUdid: "", configuration: "Debug" });
  const [session, setSession] = useState(initialSession);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [starterName, setStarterName] = useState("PixiceApp");
  const [appearance, setAppearance] = useState("light");

  const applySession = useCallback((next) => {
    setSession(next);
    onSessionChange?.(next);
    if (next) onTitleChange?.(`${next.deviceName || "iOS Simulator"} · ${next.status}`);
  }, [onSessionChange, onTitleChange]);

  useEffect(() => {
    if (!initialSession || initialSession.updatedAt === session?.updatedAt) return;
    setSession(initialSession);
  }, [initialSession, session?.updatedAt]);

  const selectedContainer = useMemo(
    () => containers.find((candidate) => candidate.relativePath === selection.containerPath) ?? null,
    [containers, selection.containerPath]
  );

  const refreshSession = useCallback(async () => {
    if (!session && !initialSession) return null;
    const next = await api.ios.state({ workspaceId });
    if (next) applySession(next);
    return next;
  }, [api, applySession, initialSession, session, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    Promise.all([
      api.ios.environment(),
      api.ios.discover({ projectId })
    ]).then(([nextEnvironment, nextContainers]) => {
      if (cancelled) return;
      const runnable = firstRunnable(nextContainers);
      setEnvironment(nextEnvironment);
      setContainers(nextContainers);
      setSelection((current) => ({
        ...current,
        ...runnable,
        simulatorUdid: current.simulatorUdid || nextEnvironment.simulators?.[0]?.udid || ""
      }));
      setBusy(false);
    }).catch((cause) => {
      if (!cancelled) {
        setError(cause.message);
        setBusy(false);
      }
    });
    return () => { cancelled = true; };
  }, [api, projectId]);

  useEffect(() => {
    if (!session || ["failed", "stopped"].includes(session.status)) return undefined;
    const timer = window.setInterval(() => void refreshSession().catch(() => {}), 1_000);
    return () => window.clearInterval(timer);
  }, [refreshSession, session]);

  const chooseContainer = (containerPath) => {
    const container = containers.find((candidate) => candidate.relativePath === containerPath);
    setSelection((current) => ({ ...current, containerPath, scheme: container?.schemes?.[0] ?? "" }));
  };

  const createStarter = async () => {
    setBusy(true);
    setError("");
    try {
      await api.ios.createStarter({ projectId, name: starterName.trim() });
      const nextContainers = await api.ios.discover({ projectId });
      const runnable = firstRunnable(nextContainers);
      setContainers(nextContainers);
      setSelection((current) => ({ ...current, ...runnable }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.ios.start({ workspaceId, projectId, ...selection });
      applySession(next);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    setBusy(true);
    setError("");
    try {
      await api.ios.stop({ workspaceId });
      const next = await api.ios.start({ workspaceId, projectId, ...selection });
      applySession(next);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.ios.stop({ workspaceId });
      applySession(next);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const action = async (name, argumentsValue = {}) => {
    setError("");
    try {
      await api.ios.action({ workspaceId, action: name, ...argumentsValue });
      await refreshSession();
    } catch (cause) {
      setError(cause.message);
    }
  };

  const toggleLogs = async () => {
    const nextOpen = !logsOpen;
    setLogsOpen(nextOpen);
    if (!nextOpen) return;
    setError("");
    try {
      const result = await api.ios.action({ workspaceId, action: "logs", limit: 200 });
      setLogText(result?.text ?? "");
    } catch (cause) {
      setError(cause.message);
    }
  };

  if (busy && !environment) return <div className={styles.empty}>Checking Xcode and Simulator</div>;

  const running = session && !["failed", "stopped"].includes(session.status);
  const diagnostics = session?.diagnostics?.diagnostics ?? [];
  const buildLogText = session?.diagnostics?.logText ?? "";

  return (
    <section className={styles.root} aria-label="iOS Simulator Preview">
      <header className={styles.toolbar}>
        {!running ? (
          <>
            <label>
              <span>Project</span>
              <select aria-label="Xcode project" value={selection.containerPath} onChange={(event) => chooseContainer(event.target.value)}>
                <option value="">Select project</option>
                {containers.map((container) => <option key={container.path} value={container.relativePath}>{container.relativePath}</option>)}
              </select>
            </label>
            <label>
              <span>Scheme</span>
              <select aria-label="Xcode scheme" value={selection.scheme} onChange={(event) => setSelection((current) => ({ ...current, scheme: event.target.value }))}>
                <option value="">Select scheme</option>
                {(selectedContainer?.schemes ?? []).map((scheme) => <option key={scheme} value={scheme}>{scheme}</option>)}
              </select>
            </label>
            <label>
              <span>Device</span>
              <select aria-label="iOS Simulator" value={selection.simulatorUdid} onChange={(event) => setSelection((current) => ({ ...current, simulatorUdid: event.target.value }))}>
                <option value="">Select device</option>
                {(environment?.simulators ?? []).map((device) => <option key={device.udid} value={device.udid}>{device.name}</option>)}
              </select>
            </label>
            <button type="button" className={styles.primary} disabled={busy || !environment?.ready || !selection.containerPath || !selection.scheme || !selection.simulatorUdid} onClick={() => void start()}>
              {busy ? "Starting" : "Run"}
            </button>
          </>
        ) : (
          <>
            <div className={styles.sessionName}>
              <strong>{session.deviceName || "iOS Simulator"}</strong>
              <span>{session.scheme} · {session.status}</span>
            </div>
            <button type="button" onClick={() => void action("button", { name: "home" })}>Home</button>
            <button type="button" onClick={() => void action("rotate", { orientation: "landscape_left" })}>Rotate</button>
            <button type="button" disabled={busy} onClick={() => {
              const theme = appearance === "light" ? "dark" : "light";
              setAppearance(theme);
              void action("appearance", { theme });
            }}>{appearance === "light" ? "Dark mode" : "Light mode"}</button>
            <button type="button" onClick={() => void action("screenshot")}>Screenshot</button>
            <button type="button" onClick={() => void toggleLogs()}>Logs</button>
            <button type="button" disabled={busy} onClick={() => void rebuild()}>{busy ? "Building" : "Rebuild"}</button>
            <button type="button" className={styles.stop} disabled={busy} onClick={() => void stop()}>Stop</button>
          </>
        )}
      </header>

      {environment && !environment.ready && (
        <div className={styles.issues} role="alert">
          <strong>iOS development is not ready on this Mac.</strong>
          {(environment.issues ?? []).map((issue) => <span key={issue.code}>{issueText(issue)}</span>)}
        </div>
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}

      {!running && !busy && environment?.ready && containers.length === 0 && (
        <div className={styles.starter}>
          <div><strong>No Xcode project found</strong><span>Create a SwiftUI app with previews and a UI test target.</span></div>
          <input aria-label="SwiftUI app name" value={starterName} onChange={(event) => setStarterName(event.target.value)} />
          <button type="button" className={styles.primary} disabled={!starterName.trim()} onClick={() => void createStarter()}>Create starter</button>
        </div>
      )}

      <div className={styles.content}>
        {session?.previewUrl ? (
          <iframe
            className={styles.frame}
            title={`${session.deviceName || "iOS"} Simulator`}
            src={session.previewUrl}
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        ) : (
          <div className={styles.empty}>
            <strong>{session ? `Simulator is ${session.status}` : "Choose a project, scheme, and device"}</strong>
            <span>{session?.phaseDetail || "Pixice will build, launch, and stream the app here."}</span>
          </div>
        )}

        {(logsOpen || diagnostics.length > 0) && (
          <aside className={styles.inspector} aria-label="iOS build output">
            {diagnostics.map((diagnostic) => (
              <button key={diagnostic.id || `${diagnostic.path}:${diagnostic.line}:${diagnostic.message}`} type="button" onClick={() => diagnostic.path && onOpenResource?.(diagnostic.path)}>
                <strong>{diagnostic.severity}</strong>
                <span>{diagnostic.message}</span>
                {diagnostic.path && <small>{diagnostic.path}:{diagnostic.line}</small>}
              </button>
            ))}
            {logsOpen && <pre>{logText || buildLogText || "No logs yet."}</pre>}
          </aside>
        )}
      </div>
    </section>
  );
}
