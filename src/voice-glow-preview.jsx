import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceBeam } from "voice-glow";
import { Microphone, PaperPlaneTilt, Plus } from "./components/icons/index.jsx";
import "./styles.css";
import "./voice-glow-preview.css";

const ACCENT_PALETTES = [
  {
    value: "original",
    label: "Original spectrum",
    accent: "#ff5364",
    hueRange: 24,
    colors: ["#ff4678", "#3cbeff", "#af46ff", "#3cdc82", "#ff9628", "#5a64ff", "#28c8be"],
    bandColors: { core: "#ffffff", above: "#ff4650", mid: "#5aff96", below: "#508cff" }
  },
  {
    value: "coral",
    label: "Coral",
    accent: "#ff5364",
    colors: ["#ff5364", "#4ed6e5", "#9a7cf6", "#ffb44f", "#e56f9d", "#6f95ff", "#55d097"],
    bandColors: { core: "#fff4f5", above: "#ff5364", mid: "#55d097", below: "#6f95ff" }
  },
  {
    value: "rose",
    label: "Rose",
    accent: "#e56f9d",
    colors: ["#e56f9d", "#6fcbff", "#b47cff", "#58d6a3", "#ffb45c", "#6f95ff", "#4ed5c2"],
    bandColors: { core: "#fff0f6", above: "#e56f9d", mid: "#4ed5c2", below: "#6f95ff" }
  },
  {
    value: "amber",
    label: "Amber",
    accent: "#dca650",
    colors: ["#dca650", "#67b8ff", "#e56f9d", "#62cc7c", "#ff704f", "#9a7cf6", "#4ecfc1"],
    bandColors: { core: "#fff6dc", above: "#dca650", mid: "#e56f9d", below: "#6f95ff" }
  },
  {
    value: "green",
    label: "Green",
    accent: "#55b96f",
    colors: ["#55b96f", "#ff6b72", "#6f95ff", "#f5bd57", "#9a7cf6", "#4eb9aa", "#e56f9d"],
    bandColors: { core: "#effff3", above: "#f5bd57", mid: "#55b96f", below: "#6f95ff" }
  },
  {
    value: "teal",
    label: "Teal",
    accent: "#4eb9aa",
    colors: ["#4eb9aa", "#ff6b72", "#748fff", "#d8c153", "#b57bf5", "#55ca7c", "#e56f9d"],
    bandColors: { core: "#edfffc", above: "#ff6b72", mid: "#4eb9aa", below: "#748fff" }
  },
  {
    value: "blue",
    label: "Blue",
    accent: "#6f95ff",
    colors: ["#6f95ff", "#ff6674", "#aa76f4", "#4eb9aa", "#e0ad53", "#e56f9d", "#55c985"],
    bandColors: { core: "#f1f5ff", above: "#e56f9d", mid: "#6f95ff", below: "#4eb9aa" }
  },
  {
    value: "violet",
    label: "Violet",
    accent: "#9a7cf6",
    colors: ["#9a7cf6", "#50c8ba", "#e56f9d", "#6f95ff", "#e0ad53", "#55c985", "#ff6b72"],
    bandColors: { core: "#f7f2ff", above: "#e56f9d", mid: "#9a7cf6", below: "#4eb9aa" }
  },
  {
    value: "graphite",
    label: "Graphite",
    accent: "#a4a4aa",
    colors: ["#c0c0c5", "#6f95ff", "#e56f9d", "#55c985", "#e0ad53", "#9a7cf6", "#4eb9aa"],
    bandColors: { core: "#ffffff", above: "#e56f9d", mid: "#a4a4aa", below: "#6f95ff" }
  }
];

function ComposerSample({ palette, level, processing }) {
  return (
    <article className="palette-sample" style={{ "--sample-accent": palette.accent }}>
      <header className="palette-sample-header">
        <span>{palette.label}</span>
        <div className="palette-swatches" aria-label={`${palette.label} palette`}>
          {palette.colors.map((color, index) => <i key={`${color}-${index}`} style={{ background: color }} />)}
        </div>
      </header>
      <div className="composer palette-composer">
        <VoiceBeam
          className="composer-voice-beam"
          aria-hidden="true"
          level={level}
          active
          processing={processing}
          theme="dark"
          colors={palette.colors}
          bandColors={palette.bandColors}
          hueRange={palette.hueRange ?? 10}
          hueDuration={16}
          idle={0.12}
          attack={0.12}
          release={0.46}
          strength={0.82}
          distortion={0}
          borderRadius={18}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <span className="composer-voice-beam-host" />
        </VoiceBeam>
        <textarea aria-label={`${palette.label} task prompt`} value="Describe the next change…" readOnly />
        <div className="composer-controls">
          <div className="composer-primary-actions">
            <button type="button" className="icon-button composer-attach" aria-label="Attach files"><Plus size={18} /></button>
            <button type="button" className="picker-trigger"><span className="picker-trigger-label">Workspace access</span></button>
          </div>
          <div className="composer-actions">
            <button type="button" className="picker-trigger"><span className="picker-trigger-label">Astra</span></button>
            <button type="button" className="icon-button" aria-label="Dictate a message"><Microphone size={17} /></button>
            <button type="button" className="icon-button send" aria-label="Send message"><PaperPlaneTilt size={17} weight="fill" /></button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Preview() {
  const [processing, setProcessing] = useState(false);
  const level = useCallback(() => processing ? 0 : 0.18 + Math.sin(performance.now() / 240) * 0.08, [processing]);

  return (
    <main className="voice-palette-preview">
      <section className="voice-palette-study">
        <header className="voice-palette-heading">
          <div>
            <h1>Accent glow palette study</h1>
            <p>The original spectrum beside eight accent-led variations.</p>
          </div>
          <button type="button" className="settings-action palette-mode-toggle" onClick={() => setProcessing((value) => !value)}>
            {processing ? "Show listening" : "Show transcribing"}
          </button>
        </header>
        <div className="voice-palette-grid">
          {ACCENT_PALETTES.map((palette) => (
            <ComposerSample key={palette.value} palette={palette} level={level} processing={processing} />
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
