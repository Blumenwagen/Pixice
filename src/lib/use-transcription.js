import { useCallback, useEffect, useRef, useState } from "react";

// One subscription shared by the composer's dictation button and the Voice
// settings page. Both need the same installed-model list, and the host is the
// authority for it, so neither keeps its own copy.
export function useTranscription(api, { enabled = true } = {}) {
  const [state, setState] = useState(null);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!api?.transcription) { setState(null); return null; }
    try {
      const next = await api.transcription.state();
      if (mounted.current) { setState(next); setError(null); }
      return next;
    } catch (cause) {
      // A host that predates this feature simply has no transcription group.
      if (mounted.current) { setState(null); setError(cause.message); }
      return null;
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const unsubscribe = api?.events?.subscribe?.((event) => {
      if (event.type === "TranscriptionState") {
        if (mounted.current) setState(event.payload);
      } else if (event.type === "TranscriptionModelProgress") {
        const update = event.payload;
        if (!mounted.current) return;
        setProgress((current) => ({ ...current, [update.id]: update }));
        if (["installed", "failed", "cancelled"].includes(update.phase)) void refresh();
      }
    });
    return () => { unsubscribe?.(); };
  }, [api, enabled, refresh]);

  const install = useCallback(async (modelId) => {
    setProgress((current) => ({ ...current, [modelId]: { id: modelId, phase: "starting", receivedBytes: 0, totalBytes: 0, error: null } }));
    await api.transcription.install({ modelId });
  }, [api]);

  const cancelInstall = useCallback((modelId) => api.transcription.cancelInstall({ modelId }), [api]);

  const remove = useCallback(async (modelId) => {
    await api.transcription.remove({ modelId });
    setProgress((current) => { const next = { ...current }; delete next[modelId]; return next; });
    await refresh();
  }, [api, refresh]);

  const select = useCallback(async (modelId) => {
    setState(await api.transcription.select({ modelId }));
  }, [api]);

  const configure = useCallback(async (patch) => {
    setState(await api.transcription.configure(patch));
  }, [api]);

  return { state, progress, error, refresh, install, cancelInstall, remove, select, configure };
}

export function formatModelBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
