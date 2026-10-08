import { createVoiceSession } from "./state.js";
import * as hybrid from "./hybrid.jsx";
import * as auraField from "./aura-field.js";
import * as signalRing from "./signal-ring.js";
import * as constellation from "./constellation.js";

const CONCEPTS = {
  hybrid: {
    label: "Hybrid",
    subtitle: "Organic aura core with the real VoiceBeam blooming from its base, inside a slow constellation halo.",
    module: hybrid,
    sources: [
      {
        title: "Correction #2 — real component was mounted but nearly invisible; aura core had been dropped",
        url: "(pixel review of the previous build, since fixed)",
        detail: "Coordinator pixel verification found the real VoiceBeam import in place but the render itself wrong on two counts. (1) A React bug: the hook passed state.js's mutable, always-same-reference state object straight into setState, so React's Object.is bail-out silently dropped every re-render after the first — the level getter and active prop were frozen at mount-time (near-zero) values forever, which is why the beam looked \"almost invisible.\" Fixed with a ref updated on every emission (so the per-frame getter VoiceBeam samples is always current) plus a shallow structural snapshot that only triggers a real React re-render when voiceState/muted/ended/reducedMotion/motionIntensity actually change — not 60 times a second. (2) The organic aura core from the first hybrid build had been dropped in favor of a flat bordered panel holding VoiceBeam, which read as \"a near-blank dark rectangular card.\" Restored: a layered noise-blob aura (same technique as Aura Field) is drawn behind an otherwise-invisible VoiceBeam host, positioned so the beam's own native bottom-edge bloom rises through the aura's base instead of sitting in its own empty card.",
      },
      {
        title: "Incumbent — composer VoiceBeam (src/App.jsx, src/styles.css, src/components/DictationButton.jsx, voice-glow-preview.jsx, node_modules/voice-glow)",
        url: "src/App.jsx (VoiceBeam usage ~L3609-3638, VOICE_GLOW_ACCENT_PALETTES ~L159-192); src/styles.css (.composer-voice-beam ~L1887-1888); src/components/DictationButton.jsx; voice-glow-preview.html; node_modules/voice-glow/dist/index.d.ts",
        detail: "Renders the ACTUAL `VoiceBeam` component from the `voice-glow` npm dependency — not a reimplementation. Props match the incumbent composer usage exactly: theme=\"dark\", the real default `coral` palette from VOICE_GLOW_ACCENT_PALETTES, hueRange=10, hueDuration=16, idle=0.12, attack=0.12, release=0.46, strength=0.82, distortion=0. `level` is a stable getter sampled once per frame (same pattern as App.jsx's `readDictationLevel`), driven by simulated amplitude, never a microphone `stream`. Sizing now also mirrors src/styles.css's `.composer-voice-beam { width:100%; height:100% }` explicitly, not just inset:0. `processing` is wired to a dedicated \"Simulate transcribing\" toggle, mirroring voice-glow-preview.jsx's own \"Show listening\"/\"Show transcribing\" pattern. `paused` is tied to Reduced motion, using the component's own documented freeze behavior.",
      },
      {
        title: "This sandbox — Constellation concept",
        url: "work/voice-mode-concepts/scripts/constellation.js",
        detail: "Particle/connection technique reused for the halo surrounding the aura+beam (105-280px radius), at the same ~0.3 rad/s baseline angular rate as the standalone Constellation tab, now with brighter/higher-contrast connections per direct feedback (alpha and white-blend both increased again from the prior pass).",
      },
    ],
  },
  "aura-field": {
    label: "Aura Field",
    subtitle: "Organic, audio-reactive canvas field — expressive over literal.",
    module: auraField,
    sources: [
      {
        title: "LiveKit — Design voice AI interfaces with Agents UI",
        url: "https://livekit.com/blog/design-voice-ai-interfaces-with-agents-ui",
        detail: "Borrowed the \"Aura\" idea directly: a shader-driven field that is \"more expressive than generic volume bars\" and reacts smoothly to live audio. This concept reimplements that spirit in Canvas 2D (no WebGL dependency added) as a layered, noise-modulated blob rather than a literal shader port.",
      },
      {
        title: "ElevenLabs UI — Orb component docs",
        url: "https://ui.elevenlabs.io/docs/components/orb",
        detail: "Borrowed the two-color radial-gradient language and the null/thinking/listening/talking agent-state model that drives color and motion.",
      },
    ],
  },
  "signal-ring": {
    label: "Signal Ring",
    subtitle: "Precise SVG scanner HUD — functional minimalism, one accent.",
    module: signalRing,
    sources: [
      {
        title: "GMUNK — Oblivion GFX (screen graphics for the 2013 film)",
        url: "https://gmunk.com/oblivion-gfx/",
        detail: "Borrowed the brief GMUNK describes for the film's own UI: \"functionality and minimalism\" with \"a bright, unified color palette\" that reads on dark or bright, plus the recurring radial scope/gauge language from the Light Table, Bubbleship hologram cockpit, and Gun HUD. Deliberately did not copy dense sci-fi greeble or invented technical jargon — copy stays short and legible per this work item's own direction.",
      },
    ],
  },
  constellation: {
    label: "Constellation",
    subtitle: "Seeded particle field orbiting a core — kinetic, not literal orb.",
    module: constellation,
    sources: [
      {
        title: "ElevenLabs UI — Orb component docs",
        url: "https://ui.elevenlabs.io/docs/components/orb",
        detail: "Borrowed the seeded, audio-reactive, WebGL-3D-orb concept (seed prop for consistent animation, getInputVolume/getOutputVolume-style reactivity, agentState-driven appearance) and reimplemented it as a seeded Canvas 2D particle/constellation system instead of importing Three.js, since no new dependency could be installed for this sandbox.",
      },
    ],
  },
};

const session = createVoiceSession({ seed: 42 });
session.start();

const stageVisual = document.getElementById("stage-visual");
const conceptMount = document.getElementById("concept-mount");
const stateDot = document.getElementById("state-dot");
const stateName = document.getElementById("state-name");
const capsPanel = document.getElementById("captions-panel");
const endedOverlay = document.getElementById("ended-overlay");
const subtitleEl = document.getElementById("concept-subtitle");
const sourcesList = document.getElementById("sources-list");
const sourcesDrawer = document.getElementById("sources-drawer");
const sourcesToggle = document.getElementById("sources-toggle");
const settingsPanel = document.getElementById("settings-panel");
const settingsButton = document.getElementById("settings-button");

let activeConceptId = "hybrid";
let unmountCurrent = null;

function mountConcept(id) {
  if (unmountCurrent) {
    unmountCurrent();
    unmountCurrent = null;
  }
  stageVisual.setAttribute("data-concept", id);
  const concept = CONCEPTS[id];
  subtitleEl.textContent = concept.subtitle;
  // Concept modules only ever own #concept-mount, never #stage-visual
  // itself — see the comment on #concept-mount in index.html.
  unmountCurrent = concept.module.mount(conceptMount, session);
  renderSources(id);
}

function renderSources(id) {
  const concept = CONCEPTS[id];
  sourcesList.innerHTML = "";
  for (const source of concept.sources) {
    const entry = document.createElement("div");
    entry.className = "source-entry";
    const isLink = /^https?:\/\//.test(source.url);
    const urlMarkup = isLink
      ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>`
      : `<code class="mono">${escapeHtml(source.url)}</code>`;
    entry.innerHTML = `
      <h3>${concept.label} — ${escapeHtml(source.title)}</h3>
      ${urlMarkup}
      <p>${escapeHtml(source.detail)}</p>
    `;
    sourcesList.appendChild(entry);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
function escapeAttr(text) {
  return text.replace(/"/g, "&quot;");
}

const stagePanel = document.getElementById("panel-stage");
document.querySelectorAll(".concept-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".concept-tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    stagePanel.setAttribute("aria-labelledby", tab.id);
    activeConceptId = tab.dataset.concept;
    mountConcept(activeConceptId);
  });
});

document.querySelectorAll(".state-button").forEach((button) => {
  button.addEventListener("click", () => {
    session.setAutoDemo(false);
    document.getElementById("auto-demo-toggle").setAttribute("aria-checked", "false");
    session.setVoiceState(button.dataset.state);
  });
});

document.getElementById("mute-button").addEventListener("click", () => session.toggleMute());
document.getElementById("end-button").addEventListener("click", () => session.end());
document.getElementById("restart-button").addEventListener("click", () => session.restart());
document.getElementById("restart-from-overlay").addEventListener("click", () => session.restart());

const captionsToggle = document.getElementById("captions-toggle");
captionsToggle.addEventListener("click", () => {
  const next = !session.getState().captionsVisible;
  session.setCaptionsVisible(next);
});

settingsButton.addEventListener("click", () => {
  const open = settingsPanel.hasAttribute("hidden");
  if (open) settingsPanel.removeAttribute("hidden");
  else settingsPanel.setAttribute("hidden", "");
  settingsButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!settingsPanel.hidden && !settingsPanel.contains(event.target) && event.target !== settingsButton && !settingsButton.contains(event.target)) {
    settingsPanel.setAttribute("hidden", "");
    settingsButton.setAttribute("aria-expanded", "false");
  }
});

document.getElementById("mic-select").addEventListener("change", (e) => session.updateSettings({ inputDevice: e.target.value }));
document.getElementById("volume-range").addEventListener("input", (e) => session.updateSettings({ outputVolume: Number(e.target.value) }));
document.getElementById("motion-range").addEventListener("input", (e) => session.updateSettings({ motionIntensity: Number(e.target.value) }));

const reducedMotionToggle = document.getElementById("reduced-motion-toggle");
reducedMotionToggle.setAttribute("aria-checked", String(session.getState().settings.reducedMotion));
reducedMotionToggle.addEventListener("click", () => {
  const next = !session.getState().settings.reducedMotion;
  reducedMotionToggle.setAttribute("aria-checked", String(next));
  session.updateSettings({ reducedMotion: next });
  mountConcept(activeConceptId); // remount so the active visualization switches motion mode cleanly
});

const autoDemoToggle = document.getElementById("auto-demo-toggle");
autoDemoToggle.addEventListener("click", () => {
  const next = autoDemoToggle.getAttribute("aria-checked") !== "true";
  autoDemoToggle.setAttribute("aria-checked", String(next));
  session.setAutoDemo(next);
});

sourcesToggle.addEventListener("click", () => {
  const open = sourcesDrawer.getAttribute("data-open") !== "true";
  sourcesDrawer.setAttribute("data-open", String(open));
  sourcesDrawer.setAttribute("aria-hidden", String(!open));
  sourcesToggle.setAttribute("aria-expanded", String(open));
});

const autoDemoToggleEl = document.getElementById("auto-demo-toggle");
let lastRenderedTranscript = null;
let lastRenderedCaptionsVisible = null;

session.subscribe((state) => {
  stateDot.setAttribute("data-state", state.voiceState);
  const label = state.ended ? "Ended" : state.voiceState[0].toUpperCase() + state.voiceState.slice(1);
  const showMuted = state.muted && !state.ended;
  // Explicit DOM text, not a CSS ::after — real, always-present content for
  // any text-based inspection or screen reader, not just a visual cue.
  stateName.textContent = showMuted ? `${label} · Muted` : label;
  stateName.setAttribute("data-muted", String(showMuted));

  document.getElementById("mute-button").setAttribute("aria-pressed", String(state.muted));
  document.getElementById("mute-button").setAttribute("aria-label", state.muted ? "Unmute" : "Mute");

  document.querySelectorAll(".state-button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.state === state.voiceState));
  });

  autoDemoToggleEl.setAttribute("aria-checked", String(state.autoDemo));

  endedOverlay.toggleAttribute("hidden", !state.ended);

  if (!state.captionsVisible) {
    capsPanel.setAttribute("hidden", "");
  } else {
    capsPanel.removeAttribute("hidden");
    // Only touch the DOM when the transcript itself or its visibility
    // actually changed, instead of rewriting innerHTML on every ~60fps tick.
    const transcriptChanged = state.transcript !== lastRenderedTranscript;
    const visibilityChanged = state.captionsVisible !== lastRenderedCaptionsVisible;
    if (transcriptChanged || visibilityChanged) {
      capsPanel.innerHTML = state.transcript.length
        ? state.transcript
            .slice(-3)
            // Each caption line already carries its real speaker as a "You:"/"Coordinator:" prefix
            // from CAPTION_SCRIPT in state.js — read that instead of re-deriving it from voiceState,
            // which previously mislabeled the "thinking" state's own line as "You".
            .map((line) => {
              const match = /^(You|Coordinator):\s*(.*)$/.exec(line.text);
              const speaker = match ? match[1] : "Coordinator";
              const text = match ? match[2] : line.text;
              return `<div class="caption-line"><b>${speaker}:</b> ${escapeHtml(text)}</div>`;
            })
            .join("")
        : `<div class="caption-line">Captions will appear here once the session speaks.</div>`;
      lastRenderedTranscript = state.transcript;
      lastRenderedCaptionsVisible = state.captionsVisible;
    }
  }
  captionsToggle.setAttribute("aria-pressed", String(state.captionsVisible));
  captionsToggle.setAttribute("aria-label", state.captionsVisible ? "Hide captions" : "Show captions");
});

mountConcept(activeConceptId);

window.addEventListener("beforeunload", () => {
  if (unmountCurrent) unmountCurrent();
  session.stop();
});
