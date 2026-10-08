import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionApp } from '../../src/voice/CompanionApp.jsx';
// Presentation only. Initial recovery configuration bypasses media creation.
let listener;
const context = { projectId: 'compact-project', threadId: 'compact-thread', accent: 'coral' };
let state = { ...context, phase: 'cleanup-failed', detached: true, muted: false, micLevel: 0, speakerLevel: 0, needsApproval: false };
const fixture = {
  configuration: async () => ({ context, state, labels: { projectName: 'Pixice', threadName: 'Voice' } }),
  events: { subscribe: (fn) => { listener = fn; return () => { listener = null; }; } },
  report: async () => {}, voice: { start: () => { throw new Error('Presentation fixture must never start media.'); }, stop: async () => {} },
  mute: async ({ muted }) => update({ muted }), end: async () => {}, detach: async () => update({ detached: true }), attach: async () => update({ detached: false }), returnToPixice: async () => {}
};
function update(patch) { state = { ...state, ...patch }; listener?.({ type: 'VoiceCompanionState', payload: state }); return state; }
window.__compactPreview = { update };
createRoot(document.getElementById('root')).render(<CompanionApp api={fixture} />);
