import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FOCUS_VARIANTS, StreamingTextVariant, useStreamingReducedMotion } from "./components/StreamingTextVariants.jsx";
import "./streaming-text-preview.css";

const SAMPLES = {
  reply: {
    label: "Conversation",
    prompt: "Make the preview feel calmer while the agent is working.",
    text: "I'll keep the conversation steady as the response arrives. New words can ease into place without moving the text you've already read.\n\nThe preview stays open, your draft stays where you left it, and progress appears beside the work.\n\nSmall changes make the difference. A gentler arrival, a readable rhythm, and a clear moment when the response is complete.",
  },
  technical: {
    label: "Technical answer",
    prompt: "Explain how you would handle a temporary connection failure.",
    text: "The connection can recover without resetting the workspace.\n\n1. Keep the mounted view and unsent draft.\n2. Retry with a short, bounded backoff.\n3. Resume from the last received event.\n\nIf retries fail, show the actual error and a Retry action. The user should still be able to read the conversation and copy their work.\n\nA successful reconnect should feel like a brief pause.",
  },
};
const SPEEDS = { slow: 30, natural: 58, fast: 115 };
const UNITS = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const splitText = (text) => UNITS ? Array.from(UNITS.segment(text), ({ segment }) => segment) : Array.from(text);

function Preview() {
  const [sample, setSample] = useState("reply");
  const [custom, setCustom] = useState(SAMPLES.reply.text);
  const [speed, setSpeed] = useState("natural");
  const [bursty, setBursty] = useState(false);
  const [loop, setLoop] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const systemReduced = useStreamingReducedMotion();
  const [run, setRun] = useState(0);
  const [feed, setFeed] = useState({ text: "", phase: "waiting" });
  const progress = useRef({ position: 0, remainingWait: 450, phase: "waiting", chunk: 0 });
  const source = sample === "custom" ? custom : SAMPLES[sample].text;
  const motionOff = reduced || systemReduced;

  const replay = () => {
    progress.current = { position: 0, remainingWait: 450, phase: "waiting", chunk: 0 };
    setFeed({ text: "", phase: "waiting" });
    setRun((value) => value + 1);
    setPaused(false);
  };

  useEffect(() => {
    progress.current = { position: 0, remainingWait: 450, phase: "waiting", chunk: 0 };
    setFeed({ text: "", phase: "waiting" });
    setRun((value) => value + 1);
  }, [source]);

  useEffect(() => {
    if (paused) return undefined;
    const units = splitText(source);
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(now - last, 100);
      last = now;
      const state = progress.current;
      state.remainingWait -= elapsed;
      if (state.remainingWait > 0) return;
      if (state.phase === "complete") {
        if (!loop) return;
        progress.current = { position: 0, remainingWait: 450, phase: "waiting", chunk: 0 };
        setFeed({ text: "", phase: "waiting" });
        setRun((value) => value + 1);
        return;
      }
      state.phase = "streaming";
      const chunkSize = bursty ? [24, 9, 37, 14][state.chunk % 4] : 7;
      state.position = Math.min(units.length, state.position + chunkSize);
      state.chunk += 1;
      if (state.position >= units.length) {
        state.phase = "complete";
        state.remainingWait = 3200;
      } else state.remainingWait = 1000 * chunkSize / SPEEDS[speed];
      setFeed({ text: units.slice(0, state.position).join(""), phase: state.phase });
    }, 24);
    return () => window.clearInterval(timer);
  }, [source, speed, bursty, paused, loop, run]);

  const status = paused ? "Paused" : feed.phase === "complete" ? "Complete" : feed.phase === "waiting" ? "Ready" : "Streaming";
  const prompt = sample === "custom" ? "Preview this response as it streams." : SAMPLES[sample].prompt;

  return (
    <main className="stream-study" data-motion-off={motionOff}>
      <header className="study-heading">
        <div className="study-title">
          <p className="study-eyebrow">Pixice / Motion study / Round 02</p>
          <h1>Soft focus, three ways.</h1>
          <p>A crisper settle, a dissolve, and a gentle cascade. Same response, same pace.</p>
        </div>
        <button className="study-replay" onClick={replay}>Replay all <span aria-hidden="true">↻</span></button>
      </header>

      <section className="study-controls" aria-label="Streaming controls">
        <div className="study-control-group">
          <span id="pace-label">Pace</span>
          <div className="study-segmented" role="group" aria-labelledby="pace-label">
            {Object.keys(SPEEDS).map((value) => <button key={value} aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
          </div>
        </div>
        <label className="study-sample">Response <select value={sample} onChange={(event) => { setSample(event.target.value); setPaused(false); }}><option value="reply">Conversation</option><option value="technical">Technical answer</option><option value="custom">Your own text</option></select></label>
        <div className="study-options">
          <label><input type="checkbox" checked={bursty} onChange={(event) => { setBursty(event.target.checked); replay(); }} />Chunk bursts</label>
          <label><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />Loop</label>
          <button className="study-pause" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? "Resume" : "Pause"}</button>
        </div>
      </section>

      {sample === "custom" && <label className="study-custom">Response text<textarea value={custom} onChange={(event) => setCustom(event.target.value)} spellCheck={false} /></label>}

      <section className="study-comparison" aria-label="Three soft focus streaming variations">
        {FOCUS_VARIANTS.map((variant, index) => {
          const panelComplete = feed.phase === "complete";
          const panelStatus = paused ? "Paused" : panelComplete ? "Complete" : feed.phase === "waiting" ? "Ready" : "Streaming";
          return <article className="study-option" key={variant.id}>
            <header className="study-option-heading"><span className="study-option-number">0{index + 1}</span><h2>{variant.name}</h2></header>
            <p className="study-option-description">{variant.description}</p>
            <section className="study-conversation" aria-label={`${variant.name} conversation preview`}>
              <div className="study-conversation-top"><span>Conversation</span><span className="study-status" data-active={!panelComplete && feed.phase === "streaming" && !paused}><i />{panelStatus}</span></div>
              <div className="study-user-message">{prompt}</div>
              <div className="study-assistant-label">Pixice <span>Assistant</span></div>
              <StreamingTextVariant key={run} text={feed.text} variant={variant.id} active={feed.phase !== "complete"} paused={paused} reducedMotion={motionOff} />
            </section>
            <footer className="study-option-footer"><span>{variant.detail}</span><span>{motionOff ? "Motion off" : `Option 0${index + 1}`}</span></footer>
          </article>;
        })}
      </section>

      <footer className="study-footer">
        <p><span className="study-footer-dot" />{status} <span className="study-footer-separator">/</span> Same input in all three previews</p>
        <label><input type="checkbox" checked={motionOff} disabled={systemReduced} onChange={(event) => setReduced(event.target.checked)} />{systemReduced ? "Reduced motion from system" : "Reduce motion"}</label>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
