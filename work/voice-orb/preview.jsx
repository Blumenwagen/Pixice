import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceOrb } from '../../src/components/VoiceOrb.jsx';
import './preview.css';

function Preview() {
  const [accent, setAccent] = useState('coral'), [motion, setMotion] = useState(false), [light, setLight] = useState(false), [audio, setAudio] = useState(0.55);
  useEffect(() => { window.orbCheck = () => ({
    renderers: Array.from(document.querySelectorAll('.voice-orb')).map(e => ({ phase: e.dataset.phase, renderer: e.dataset.renderer, cssSize: e.getBoundingClientRect().width, buffer: e.querySelector('canvas').width })),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }); }, []);
  return <main className={light ? 'light' : ''}>
    <header><p>PIXICE / VOICE</p><h1>A presence, in motion.</h1><p className="intro">A fluid field of light. Quiet when waiting, expressive when you speak.</p></header>
    <nav aria-label="Preview controls">
      <button data-action="accent" onClick={() => setAccent(accent === 'coral' ? 'blue' : 'coral')}>Accent: {accent}</button>
      <button data-action="motion" onClick={() => setMotion(!motion)}>{motion ? 'Still' : 'Fluid'}</button>
      <button data-action="theme" onClick={() => setLight(!light)}>{light ? 'Light' : 'Dark'}</button>
      <label>Audio <input aria-label="Audio level" type="range" min="0" max="1" step="0.01" value={audio} onChange={e => setAudio(Number(e.target.value))} /></label>
    </nav>
    <section className="hero"><VoiceOrb phase="speaking" speakerLevel={audio} accent={accent} size={320} reducedMotion={motion} /><p>Speaking</p></section>
    <section className="phases" aria-label="Voice phases">{['idle', 'connecting', 'listening', 'speaking', 'muted', 'error'].map(phase => <figure key={phase}><VoiceOrb phase={phase} micLevel={audio} speakerLevel={audio} accent={accent} size={160} reducedMotion={motion} /><figcaption>{phase}</figcaption></figure>)}</section>
    <footer>Standalone visual preview. Audio levels are simulated. Native session behavior belongs to the companion.</footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Preview /></React.StrictMode>);
