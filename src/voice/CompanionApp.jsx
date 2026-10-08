import { useEffect, useRef, useState } from 'react';
import { VoiceOrb } from '../components/VoiceOrb.jsx';
import { CodexVoiceConnection } from '../lib/codex-voice.js';
import './companion.css';

const labels = { connecting: 'Connecting Voice', connected: 'Listening', 'playback-blocked': 'Enable audio to hear Voice', stopping: 'Ending Voice', ended: 'Voice ended', error: 'Voice could not continue', 'cleanup-failed': 'Retry ending Voice' };

// This root is never mounted inside the main App or StrictMode. It owns one call.
export function CompanionApp({ api = window.pixiceVoiceCompanion }) {
  const [state, setState] = useState({ phase: 'connecting', micLevel: 0, speakerLevel: 0, muted: false });
  const [context, setContext] = useState(null);
  const [labelsForContext, setLabelsForContext] = useState({});
  const [notice, setNotice] = useState('');
  const connection = useRef(null);
  useEffect(() => {
    let alive = true;
    let client;
    const report = (patch) => { if (alive) void api.report(patch).catch(() => {}); };
    const unsubscribe = api.events.subscribe((event) => {
      if (event.type === 'VoiceCompanionState') {
        setState(event.payload);
        client?.mute(event.payload.muted);
      }
      if (event.type === 'Mute') client?.mute(event.payload.muted);
    });
    void api.configuration().then(({ context: pinned, state: initial, labels }) => {
      if (!alive) return;
      setContext(pinned); setState(initial); setLabelsForContext(labels ?? {});
      if (initial.phase === 'cleanup-failed' || initial.phase === 'stopping') return;
      client = new CodexVoiceConnection({ api: { events: api.events, voice: { start: ({ sdp }) => api.voice.start({ sdp }), stop: () => api.voice.stop() } }, context: pinned, deviceId: pinned.deviceId,
        onState: (phase, error) => report({ phase, ...(error ? { error } : {}) }),
        onNotice: (message) => { if (alive) setNotice(message); }, onLevels: report });
      client.mute(initial.muted);
      connection.current = client;
      return client.open();
    }).catch((error) => { if (alive) { setNotice(error.message); report({ phase: 'error', error: error.message }); } });
    return () => { alive = false; unsubscribe(); connection.current = null; void client?.close().catch(() => {}); };
  }, [api]);
  const act = (method, payload) => { void api[method](payload).catch((error) => setNotice(error.message)); };
  const orbPhase = state.phase === 'connected' ? state.speakerLevel > 0.04 ? 'speaking' : 'listening' : state.phase === 'cleanup-failed' ? 'error' : state.phase;
  const needsAttention = Boolean(state.needsApproval || state.error || notice || state.phase === 'cleanup-failed' || state.phase === 'playback-blocked');
  const projectLabel = labelsForContext.projectName ?? `Project ${state.projectId?.slice(0, 8) ?? '...'}`;
  const threadLabel = labelsForContext.threadName ?? `Thread ${state.threadId?.slice(0, 12) ?? '...'}`;
  const status = state.phase === 'connected' && state.muted ? 'Muted' : orbPhase === 'speaking' ? 'Speaking' : labels[state.phase] ?? state.phase;
  return <main className={`voice-companion${needsAttention ? ' needs-attention' : ''}${state.muted ? ' is-muted' : ''}`} aria-label="Pixice Voice companion" style={{ '--companion-accent': context?.accent?.startsWith('#') ? context.accent : '#f08f70' }}>
    <header className="voice-companion-drag voice-companion-chrome" title={`${projectLabel} · ${threadLabel} · ${state.detached ? 'Floating' : 'Attached'}`}>
      <span className="voice-companion-context" aria-label={`Pinned conversation: ${projectLabel}, ${threadLabel}`}>{projectLabel} <span aria-hidden="true">·</span> {threadLabel}</span>
      <span className="voice-companion-mode">{state.detached ? 'Floating' : 'Attached'}</span>
    </header>
    <div className="voice-companion-orb" title="Drag Voice companion"><VoiceOrb phase={orbPhase} muted={state.muted} micLevel={state.micLevel} speakerLevel={state.speakerLevel} accent={context?.accent} size={needsAttention ? 144 : 176} /></div>
    <p className="voice-companion-status" role="status">{state.muted && <CompanionIcon name="muted" />}<span>{status}</span></p>
    <div className="voice-companion-attention">
      {state.needsApproval && <button className="voice-companion-approval" onClick={() => act('returnToPixice')}>Review approval in Pixice</button>}
      {(state.error || notice) && <p className={`voice-companion-notice${state.needsApproval || state.phase === 'playback-blocked' ? ' visually-hidden' : ''}`} role="alert" title={state.error || notice}>{state.error || notice}</p>}
      {state.phase === 'playback-blocked' && <button title={notice || state.error || 'Enable audio to hear Voice'} onClick={() => { void connection.current?.play()?.then(() => setNotice('')).catch((error) => setNotice(error.message)); }}>Enable audio</button>}
    </div>
    <nav className="voice-companion-controls voice-companion-chrome" aria-label="Voice controls">
      <button disabled={state.phase === 'cleanup-failed' || state.phase === 'stopping'} aria-pressed={state.muted} aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'} title={state.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => act('mute', { muted: !state.muted })}><CompanionIcon name={state.muted ? 'muted' : 'mic'} /></button>
      <button className={`voice-companion-end${state.phase === 'cleanup-failed' ? ' retry' : ''}`} aria-label={state.phase === 'cleanup-failed' ? 'Retry ending Voice' : 'End Voice conversation'} title={state.phase === 'cleanup-failed' ? 'Retry ending Voice' : 'End Voice conversation'} onClick={() => act('end')}>{state.phase === 'cleanup-failed' ? 'Retry End' : <CompanionIcon name="end" />}</button>
      <button aria-label="Return to pinned conversation in Pixice" title="Return to Pixice" onClick={() => act('returnToPixice')}><CompanionIcon name="return" /></button>
      <button className="voice-companion-placement" aria-label={state.detached ? 'Attach to Pixice' : 'Detach companion'} title={state.detached ? 'Attach to Pixice' : 'Detach companion'} onClick={() => act(state.detached ? 'attach' : 'detach')}><CompanionIcon name={state.detached ? 'attach' : 'detach'} /></button>
    </nav>
  </main>;
}

function CompanionIcon({ name }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    muted: <><path d="M9 5a3 3 0 0 1 6 0v4M9 9v3a3 3 0 0 0 5 2M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8M3 3l18 18" /></>,
    end: <rect x="6" y="6" width="12" height="12" rx="3" />,
    return: <><path d="M13 5h6v14h-6M4 12h11M8 8l-4 4 4 4" /></>,
    detach: <><path d="M13 4h7v7M20 4l-9 9M9 5H5v14h14v-4" /></>,
    attach: <><path d="M4 4l9 9M13 6v7H6M16 5h3v14H5v-3" /></>
  };
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
