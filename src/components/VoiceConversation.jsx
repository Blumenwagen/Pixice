import { useEffect, useRef, useState } from 'react';

// Launch adapter only. The native companion owns capture, playback and lifetime.
export function useVoiceConversation({ api, context, provider = 'codex', enabled = true, resolveContext }) {
  const [support, setSupport] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const identity = `${context?.projectId}:${provider}`;
  const currentIdentity = `${identity}:${context?.threadId}:${enabled}`;
  const identityRef = useRef(currentIdentity);
  identityRef.current = currentIdentity;
  useEffect(() => {
    const ticket = ++generation.current;
    let alive = true;
    setSupport(null); setState(null); setError(''); setOpening(false);
    pending.current = false;
    if (!enabled || provider !== 'codex' || !api?.voice?.companion?.open) return;
    if (api.voice.state) void api.voice.state().then((value) => { if (alive) setSupport(value); }).catch((cause) => { if (alive) setSupport({ available: false, reason: cause.message }); });
    if (api.voice.companion.state) void api.voice.companion.state().then((value) => { if (alive) setState(value); }).catch(() => {});
    const unsubscribe = api.events?.subscribe?.((event) => {
      if (event.type === 'VoiceCompanionState' && alive && event.payload?.projectId === context?.projectId && event.payload?.threadId === context?.threadId) setState(event.payload);
    });
    return () => { alive = false; if (generation.current === ticket) generation.current++; unsubscribe?.(); };
  }, [api, identity, enabled, context?.threadId]);
  const reason = provider !== 'codex' ? 'Conversational Voice is available for Codex tasks.'
    : !enabled ? 'Conversational Voice runs on this computer. Switch work location to This computer.'
      : !api?.voice?.companion?.open ? 'This Pixice host does not offer the native Voice companion.'
        : (api.voice.state && !support ? 'Checking Codex Voice…' : '') || (support?.available === false ? support.reason || 'Codex Voice is unavailable for this account.' : '')
          || (!context?.threadId && !resolveContext ? 'Open a Codex task before starting Voice.' : '');
  const open = async () => {
    if (reason || pending.current) return;
    const ticket = generation.current;
    const isCurrent = () => generation.current === ticket && identityRef.current === currentIdentity;
    pending.current = true; setOpening(true); setError('');
    try {
      const resolved = context?.threadId ? context : await resolveContext?.({ isCurrent });
      if (!isCurrent() || !resolved?.threadId) return;
      const next = await api.voice.companion.open(resolved);
      if (generation.current === ticket) { setState(next); if (next?.error) setError(next.error); }
    } catch (cause) { if (generation.current === ticket) setError(cause.message || 'Could not open Voice.'); }
    finally { if (generation.current === ticket) { pending.current = false; setOpening(false); } }
  };
  return { open, opening, reason, error, state, available: !reason && support?.available !== false };
}

// Embedders can consume the launch adapter without adding another Voice button.
export function VoiceConversation({ children, context, projectId, threadId, model, effort, permissionMode, deviceId, accent, ...options }) {
  const voice = useVoiceConversation({ ...options, context: context ?? { projectId, threadId, model, effort, permissionMode, deviceId, accent } });
  return typeof children === 'function' ? children(voice) : null;
}
