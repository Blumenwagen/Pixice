import { useEffect, useMemo, useState } from 'react';
import { useConnect } from './ConnectRoot.jsx';
import { savedInstances } from './client.js';
import { collectUnifiedUsage, combineUsage } from './unified-usage.js';

export function useUnifiedUsage(enabled, days) {
  const connect = useConnect();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(null);
  const instancesKey = JSON.stringify(connect?.instances ?? savedInstances());
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let controller;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      controller = new AbortController();
      setLoading(true); setError(null);
      try {
        await collectUnifiedUsage({ instances: JSON.parse(instancesKey), localApi: window.pixice, days, signal: controller.signal, onEntries: (next) => {
          if (!disposed) setEntries(next);
        } });
      } catch (cause) { if (!disposed) setError(cause.message); }
      finally { busy = false; if (!disposed) setLoading(false); }
    };
    setEntries([]);
    void refresh();
    const timer = setInterval(refresh, 30_000);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, days, instancesKey, revision]);
  const summary = useMemo(() => combineUsage(entries, days), [entries, days]);
  return { entries, summary, loading, error, refresh: () => setRevision((value) => value + 1) };
}
