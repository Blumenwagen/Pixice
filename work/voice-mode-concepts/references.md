# Voice-mode motion concepts — research references

Sandbox code prototypes at `work/voice-mode-concepts/index.html`. Four coded, animated, interactive concepts (three original directions plus a user-requested Hybrid, opened by default) — not final production UI. No microphone, no audio APIs, no network calls; all voice/amplitude data is locally simulated.

## Sources actually opened and inspected

### 1. LiveKit — "Design voice AI interfaces with Agents UI" (blog, official, 03 Mar 2026)
<https://livekit.com/blog/design-voice-ai-interfaces-with-agents-ui>

Fetched and read directly (no access issue). Key details extracted:
- The headline visual is **Aura**, a shader-based audio visualizer built with Unicorn Studio: "more expressive than generic volume bars," responds smoothly to live audio, state-aware (listening/speaking).
- Component architecture: `AgentControlBar` (mic/camera/chat controls), `AgentChatTranscript` (message history + agent state), `AgentSessionProvider` (session lifecycle).
- Built on shadcn/ui + Tailwind; the pattern that "repeats across every voice agent project" is: media controls, audio visualization, session management, chat/transcript.

**Borrowed into `aura-field` concept:** the idea of an expressive, continuously-reactive field standing in for the mic level (not a bar meter), and the transcript-alongside-controls pairing (captions panel + control dock). Reimplemented as layered Canvas 2D radial-gradient blobs with sine/noise-driven radius modulation — not a shader port, since no WebGL/shader dependency could be added to this sandbox.

### 2. ElevenLabs UI — `Orb` component docs
<https://ui.elevenlabs.io/docs/components/orb>

`WebFetch` returned a 403 here (likely bot-blocked). Opened successfully instead through the **Pixice in-app browser** (`pixice_browser`), which rendered and let me read the actual page content and component API.

Key details extracted:
- "A 3D animated orb with audio reactivity, custom colors, and agent state visualization built with Three.js."
- Live preview on the page cycles three named states: **Idle, Listening, Talking** (plus a documented `"thinking"` state in the prop API — four-state `AgentState` type: `null | "thinking" | "listening" | "talking"`).
- Props: `colors: [string, string]` (two-color gradient, default `["#CADCFC", "#A0B9D1"]`), `seed` ("Seed for consistent animation patterns across renders"), `volumeMode: "auto" | "manual"`, `getInputVolume`/`getOutputVolume` callbacks, `colorsRef`/`inputVolumeRef`/`outputVolumeRef` for imperative updates.
- Notes: "Uses WebGL shaders for smooth, fluid animations," "Performance-optimized with proper cleanup and requestAnimationFrame usage."

**Borrowed into `aura-field`:** the two-color radial gradient language and the state-driven color/motion mapping.
**Borrowed into `constellation`:** the seeded, audio-reactive 3D-orb concept itself — reimplemented as a seeded Canvas 2D particle/constellation system (deterministic LCG seed, matching the "seed" prop pattern) instead of adding Three.js as a dependency, since installing new packages was out of scope for this worker.

### 3. GMUNK — *Oblivion* GFX (film screen-graphics case study)
<https://gmunk.com/oblivion-gfx/>

The originally-cited URL, `gmunk.com/OBLIVION`, was unavailable. The Focus coordinator (running Codex, which could resolve and browse the source directly) then researched and supplied the corrected primary URL above (`/oblivion-gfx/`, lowercase) in its next work-request message — not a URL the user typed directly. This worker then opened that corrected URL through the Pixice in-app browser and read it in full — GMUNK's own case-study page for their work as Design Director/Lead Designer on the 2013 film *Oblivion*.

Key details extracted (GMUNK's own words):
- Brief: "stressed functionality and minimalism while utilizing a bright, unified color palette that would appear equally well on both a dark or bright backdrop."
- **Light Table UI** — Vika's four-screen console: a main map (Bubbleship/Drone/Scav positioning), a Drone Monitor (vitals/fuel), a Hydro Rig monitor (collection progress), a Weather Screen (Tet status + weather vitals). Built practically and shot largely in-camera.
- **Bubbleship UI** — a holographic cockpit interface researched against real flight-simulator and helicopter combat HUDs, "functionality" prioritized over decoration.
- **Drone and Scope UI** — machinery HUDs, gauges, and a gun HUD, again "stressed functionality over excess, keeping the Greeble under control."

**Borrowed into `signal-ring`:** the functional-minimalism brief itself (one bright accent on a dark ground, not a rainbow), the recurring radial scope/gauge/ring grammar across the Light Table, cockpit hologram, and gun HUD, and — importantly — GMUNK's own restraint principle ("keeping the Greeble under control"), which is why this concept uses a handful of clean labeled elements (state name, one numeric readout) rather than dense invented technical jargon or movie-HUD clutter.

## Access gap encountered and how it was resolved

- `WebFetch` on `ui.elevenlabs.io` returned HTTP 403 — likely bot/User-Agent filtering on that host. Resolved without blocking the work by using the Pixice in-app browser (`pixice_browser`) instead, which loaded and rendered the page normally; content above was read from that live render.
- `gmunk.com/OBLIVION` (the initially-cited URL) did not resolve. The user supplied the corrected working URL (`gmunk.com/oblivion-gfx/`); no further substitution was needed once given the right address.
- `pixice_browser__screenshot` returned a tool-level schema/validation error on both external pages (not a content or network error — the navigate/inspect calls on the same pages worked fine, only the screenshot capture call itself failed). No visual screenshots of the two external reference pages could be captured this way; grounding for this document is text/structure-based (via `inspect`), not a visual crop. This is a tool gap, not a fabricated substitute — flagged transparently rather than invented.

## Hybrid concept (added after user feedback, corrected after further user feedback)

The user liked **Aura Field** and **Constellation** specifically and asked for a combined direction, kept alongside the original three tabs for comparison, and set as the default tab.

**Correction:** the first version of this concept (`scripts/hybrid.js`, since deleted) only re-tuned a hand-drawn Canvas 2D blob's timing/hue to *resemble* VoiceBeam's attack/release/hueDuration curve. The user correctly rejected this — a lookalike animation is not "incorporating the transcription animation." `scripts/hybrid.jsx` replaces it: it imports and renders the **actual `VoiceBeam` component from the installed `voice-glow` npm package** (the same one `src/App.jsx`'s composer renders) as a substantial central band, not a description or a re-tuned substitute.

- **Source inspected (read-only):** `src/App.jsx` (composer `VoiceBeam` usage ~L3609-3638, and `VOICE_GLOW_ACCENT_PALETTES` ~L159-192 for the real default `coral` colors/bandColors), `src/components/DictationButton.jsx` + `.module.css`, `voice-glow-preview.html`/`.jsx` (rendered live at `http://127.0.0.1:5187/voice-glow-preview.html` in a separate browser tab, kept open alongside the prototype rather than replacing it), and `node_modules/voice-glow/dist/index.d.ts` (to confirm the real prop contract — `level` as a manual getter vs. `stream` for live mic analysis, `processing`, `active`, `paused`, `attack`/`release`/`idle`, `hueRange`/`hueDuration`, `colors`/`bandColors`).
- **What is actually reused, verbatim, not approximated:**
  - The component itself: `import { VoiceBeam } from "voice-glow"` — a real npm import, already a dependency, no install needed.
  - The real default palette: `VOICE_GLOW_ACCENT_PALETTES.coral` from App.jsx (`colors: ["#ff5364","#4ed6e5","#9a7cf6","#ffb44f","#e56f9d","#6f95ff","#55d097"]`, matching `bandColors`) — not the preview page's separate "original spectrum" swatch.
  - The exact prop values App.jsx passes for dictation: `theme="dark"`, `hueRange={10}`, `hueDuration={16}`, `idle={0.12}`, `attack={0.12}`, `release={0.46}`, `strength={0.82}`, `distortion={0}`.
  - The manual-drive pattern: a stable `level` getter sampled once per frame (`useMemo(() => () => levelRef.current, [])`), mirroring App.jsx's `readDictationLevel = useCallback(() => dictationLevelRef.current, [])` — never a microphone `stream`.
  - `voice-glow-preview.jsx`'s own "Show listening" / "Show transcribing" toggle idiom, reused directly as this tab's "Simulate transcribing" control, wired to the real `processing` prop.
  - The component's own documented `paused` prop, tied to this sandbox's Reduced motion setting, instead of inventing a separate freeze mechanism.
  - `DictationButton.module.css`'s stated principle — *"a single bar is enough to show the microphone is live without turning the composer into a visualizer"* — is why the surrounding constellation halo stays a secondary, dimmer layer: the real VoiceBeam band is now the one actual signal; the canvas halo's only job is slow ambient network context around it, not a competing "core."

**Correction #2 (pixel review):** the previous build above did mount the real component, but a coordinator screenshot showed it as "a near-blank dark rectangular card" with an almost-invisible beam and a dropped aura core. Two real bugs, fixed:

1. **React reactivity bug.** The subscription hook passed `state.js`'s mutable, always-same-object-reference state straight into `setState`. React's `Object.is` equality check then silently dropped every re-render after the first, so the `level` getter and `active` prop were frozen at whatever they were at mount — which is why the beam read as stuck near-idle rather than reacting to state. Fixed in `useVoiceBandState` (`scripts/hybrid.jsx`): a ref is written on *every* emission (so VoiceBeam's per-frame getter is always current, matching `src/App.jsx`'s `dictationLevelRef` pattern exactly), and `setState` only fires — with a genuinely new object — when a structural field (`voiceState`/`muted`/`ended`/`reducedMotion`/`motionIntensity`) actually changes, not on every ~60fps amplitude tick.
2. **Aura core had been dropped.** Restored the layered-noise-blob aura (same technique as the Aura Field concept, in `AuraHaloCanvas`) as a visible backdrop. VoiceBeam's host (`.hybrid-band-host-wrap`) is positioned so the component's own native "beam along the bottom edge of the wrapped element" rises through the aura's base, and is itself fully transparent (no card background/border) — the real glow now reads as part of the aura, not a separate flat panel. Sizing also now mirrors `src/styles.css`'s `.composer-voice-beam { width:100%; height:100% }` explicitly. Constellation connections were brightened again (alpha 0.68, wider stroke) per "brighter readable connections" feedback. The in-canvas label overlay and the long explanatory paragraph were removed from the focal visual area — the toggle now carries one short honest line instead.

**Correction #3 (independent read-only review, confirmed structural bug):** the End control appeared to do nothing — no "Ended" state, no "Call ended." overlay — on every tab, not just Hybrid. Root cause, confirmed by an independent reviewer: `hybrid.jsx`'s `mount()` called React's `createRoot()` directly on `#stage-visual`, the same container that also held the static `#state-dot`/`#state-name` status label and the `#ended-overlay` markup. `createRoot(node).render(...)` takes ownership of that node's *entire* subtree and clears whatever else lives inside it — so the moment Hybrid mounted (which happens immediately, since it's the default tab), those sibling nodes were silently destroyed. `shell.js`'s global state subscriber still held valid JS references to them (captured via `getElementById` before the destruction) and kept calling `.textContent =`/`.toggleAttribute(...)` on them without error — but on now-detached nodes no longer part of the visible page, so the mutations were real but invisible. Fixed with a dedicated mount target: `index.html` now has an empty `#concept-mount` div inside `#stage-visual`, a sibling of the status label and ended-overlay rather than their container, and every concept module (`shell.js`'s `mountConcept`) is handed that dedicated node instead of `#stage-visual` itself. Confirmed vanilla modules (`aura-field.js`/`constellation.js`/`signal-ring.js`) never had this bug — they only ever `appendChild`/`removeChild` their own single element, never clear the container.

Two further fixes landed in the same pass:
- **"Simulate transcribing" no longer resets on an implicit remount.** It lived in component-local `useState`, which resets to `false` on every remount — including the *implicit* remount `shell.js` triggers on the Reduced-motion toggle, or a tab-switch-away-and-back. Moved to the shared session (`state.transcribing` in `state.js`, `setTranscribing()` action); it now only resets on an explicit `end()`/`restart()`, never on a remount that wasn't asked for.
- **RAF loops now stop when ended, and resume exactly once on Restart.** Previously `state.js`'s own tick loop, and each concept's own canvas/SVG animation loop, kept scheduling `requestAnimationFrame` forever even while `ended` — animating/clearing a hidden or dimmed surface for no purpose. `state.js`'s `tick()` now stops rescheduling itself once `state.ended`, and `start()` is idempotent (guards against double-scheduling). Each concept module now uses an `ensureRunning()` pattern subscribed to session emissions: draw one static frame and skip the RAF chain while ended or reduced-motion, otherwise ensure exactly one chain is running — applied uniformly to `aura-field.js`, `constellation.js`, `signal-ring.js`, and `hybrid.jsx`'s `AuraHaloCanvas`.

## Constellation slowdown + contrast (user-requested refinement)

Per direct feedback, `constellation.js` (used by both the standalone Constellation tab and the Hybrid halo) now:
- Uses real elapsed time (`performance.now()` delta, clamped to 100ms) instead of a fixed per-frame angle step, so motion speed is frame-rate independent.
- Runs at `BASE_ANGULAR_RATE = 0.3` rad/s baseline — the previous build's fixed per-frame step was implicitly ~1.2 rad/s at 60fps, so this is the requested ~1/4 speed.
- Connection lines: distance threshold `52px` (was 46), alpha `0.5` (was 0.22), width `1.1px` (was 0.6), and now blend toward white as they get closer/brighter (`mix = 0.35 * proximity`) so they read clearly against the dark canvas instead of disappearing into a same-hue haze.

## Why these four directions, not "three colors of one orb"

The concepts differ in **topology and rendering technique**, not just palette:

1. **Hybrid** — the real `voice-glow` `VoiceBeam` component (React, actual npm import) as a central transcription band, plus a dimmer, slower Canvas 2D constellation halo (technique from #4) surrounding it. The only one of the four that renders a real production component rather than a Canvas/SVG reimplementation.
2. **Aura Field** — Canvas 2D, organic/blobby, continuous morphing silhouette (no hard geometry).
3. **Signal Ring** — SVG + CSS, precise circular/radial HUD geometry (rings, ticks, a rotating sweep, an arc-based level meter).
4. **Constellation** — Canvas 2D, discrete particle system with emergent connecting lines (points and edges, not a filled silhouette).

Each also carries a distinct color mapping across the same five simulated states (listening / thinking / speaking / muted / error) rather than reusing one asset with different `--primary` values.
