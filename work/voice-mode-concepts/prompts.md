# Pixice Focus voice-mode — imagegen prompts

Three independent, ready-to-run ImageGen prompts for Focus voice-mode concept exploration. Produced by the design worker (Claude runtime, no `image_gen` tool available); intended for the coordinator's Codex runtime to execute via the built-in `image_gen` tool, one independent call per prompt (no `Promise.all`, no batching, no multi-idea collage).

Grounding image for every call: `/Users/blumenwagen/Developer/Loom/work/design-qa/focus-rail-1600.png` — attach the actual file to each `image_gen` call as **Image 1: reference** (current Pixice Focus layout: dark canvas, top-left "Pixice / Focus project" breadcrumb, top-right icon buttons, a "Work in flight" card rail top-right with per-task progress bars, centered conversation text, bottom-centered pill composer "Ask, decide, or start something"). Do not generate from the text description alone — use the actual image.

Design tokens (read from `src/styles.css`, `src/voice-glow-preview.jsx/.css`, `src/focus-appearance.js` — reuse verbatim, do not invent new colors):
- Background canvas `#171717`, surface `#222222`, raised surface `#2b2b2b`, popover `#303030`.
- Foreground text `#f0f0f0`, muted `#a2a2a2`, quiet `#858585`.
- Primary accent `#ff5364` (thread-bright `#ff7a86`, glow `rgba(255,83,100,.35)`) — the shipped default; alternate accents exist (blue/rose/amber/green/teal/violet/graphite) but default to the red/coral original for these concepts.
- Borders `rgba(255,255,255,.085)`, restrained — no heavy strokes.
- Radii: small 12px, medium 16px, large 22px, extra-large 28px.
- Typeface: Manrope Variable (body/UI), JetBrains Mono Variable (only for any monospace/code-like labels, unlikely needed here).
- Voice visualization reference: the app's `VoiceBeam` component renders a soft animated glow/waveform band inside the composer — colors cycle through an accent-led palette with a bright core; use this as the visual language for listening/speaking states, not a generic waveform or equalizer bar cliché.

Global constraints for all three (repeat in every call):
- This is a **mocked, static concept screen** — no live microphone, no live network activity, no real transcript content. Do not render camera/mic permission prompts or OS-level dialogs.
- Voice picker must read **"Default voice"** — never invent a specific voice name. Do not label input devices, output devices, or captions options with fabricated brand/model names; use generic labels like "Default", "Built-in Microphone" is acceptable as a generic system default, but do not invent third-party product names.
- Preserve the incumbent dark charcoal design language, Manrope typography, and restrained border language from the grounding screenshot. Do not restyle into a different visual system or swap the accent palette.
- Every concept must clearly show: (a) a visible, distinguishable listening state vs. a speaking state (e.g. via the voice-beam glow's color/intensity/motion, not just a text label), (b) mute and end-call controls, (c) some caption/transcript affordance, (d) a settings entry point (e.g. a gear icon or "Settings" control).
- No device bezel, browser chrome, OS status bar, or window frame — content only, at the exact canvas size below.
- Anchor any visible date/time or activity text to **2026-09-29**; avoid inventing unrelated feature chrome not implied by this brief.
- Canvas size: exactly **1440×1024**, natural desktop-app framing, no stretching/cropping.

---

## Prompt 1 — name: `compact-dock`

Concept: a compact voice dock that preserves the existing text conversation and "Work in flight" rail, closest to a minimal evolution of the current composer.

```text
Use case: ui-mockup
Asset type: desktop Electron app screen — Pixice Focus voice-mode dock, mocked concept (no live mic/network)
Primary request: Show the existing Pixice Focus layout from the reference screenshot (dark canvas, top-left "Pixice / Focus project" breadcrumb, top-right icon buttons, top-right "Work in flight" rail card with 1-2 task rows and progress bars, centered conversation transcript) essentially unchanged, with the bottom composer pill replaced by a compact voice dock docked in the same position and width. The text conversation above and the Work in flight rail stay fully visible and legible; voice mode is an additive control, not a takeover.
Input images: Image 1: reference — actual current-app screenshot (work/design-qa/focus-rail-1600.png); match its layout, spacing, breadcrumb, rail card, and typography exactly, changing only the bottom composer area into the voice dock.
Scene/backdrop: dark charcoal desktop app window, background #171717, no bezel or window chrome
Subject: a single-row compact voice dock pill anchored bottom-center, similar footprint to the existing "Ask, decide, or start something" composer. Inside the dock, left-to-right: a small round listening/speaking indicator built from a soft animated accent-colored glow band (reference the app's VoiceBeam visual language — a bright core with colored gradient, not a generic equalizer icon), a short live caption/transcript snippet in muted gray text ("Default voice — listening…" state), then a tight cluster of small icon-only controls: mute (mic-off style), end call (red/accent), and a settings gear. Show the dock in an active "listening" state via the glow, with a second smaller inline label or subtle color variant illustrating how "speaking" would differ (e.g. a caption above the dock noting the alternate state, or a slightly different glow tone) so both states are visually distinguishable in one frame.
Style/medium: clean modern desktop product UI, screenshot-fidelity mockup, not illustration or 3D render
Composition/framing: exactly 1440x1024, dock centered near the bottom third, generous negative space above, conversation and rail untouched
Lighting/mood: dark mode, soft restrained accent glow only from the voice indicator, no heavy shadows
Color palette: background #171717, surface #222222, foreground text #f0f0f0, muted text #a2a2a2, accent #ff5364 with glow rgba(255,83,100,.35), borders rgba(255,255,255,.085)
Materials/textures: soft rounded pill (28px radius) for the dock, 12-16px radii for small controls, hairline restrained borders only, no drop shadows beyond a subtle ambient glow
Text (verbatim): "Default voice" · "Listening…" · "Mute" · "End" · caption line reading "Default voice — listening…"
Constraints: mocked concept only, no live mic/network, no invented voice/device names beyond "Default voice", keep existing breadcrumb/rail/conversation exactly as in the reference image, no device bezel, no browser chrome
Avoid: generic waveform/equalizer bar clichés, neon or sci-fi styling, invented extra panels or navigation, palette swap away from the reference accent
```

---

## Prompt 2 — name: `immersive-call`

Concept: an immersive full-canvas call view with expressive audio visualization, closer to a dedicated voice-call surface.

```text
Use case: ui-mockup
Asset type: desktop Electron app screen — Pixice Focus voice-mode immersive call view, mocked concept (no live mic/network)
Primary request: Design a focused, full-canvas voice call screen for talking to the persistent Focus coordinator. This is a distinct mode entered from the base app (reference screenshot shows the base state to derive visual language from, not to replicate directly here) — a large expressive audio visualization dominates the center as the hero element, with call controls below and minimal supporting chrome. Do not recreate the base conversation/rail layout in this frame; this is its own immersive surface.
Input images: Image 1: reference — actual current-app screenshot (work/design-qa/focus-rail-1600.png); use only for exact background color, border treatment, typography, and corner-radius language, not for layout.
Scene/backdrop: dark charcoal full-canvas surface, background #171717, no bezel or window chrome, small top-left minimal label such as "Focus · Voice" and a small top-right close/minimize affordance to imply this overlays the base app
Subject: a large centered expressive audio visualization built from the app's VoiceBeam language (a soft animated glow band/orb with accent-colored gradient and a bright core), rendered big and prominent as the focal point, shown in a clearly "listening" state (calm, slow pulse). Directly below it, a short live caption line in muted gray showing a mocked transcript snippet. Below that, a horizontal cluster of large, clearly-tappable circular controls: mute, end call (accent-colored, most prominent), and settings (gear icon). Add one small secondary text label near the visualization illustrating how a "speaking" state would look different (brighter, faster motion, or shifted color band) so listening vs. speaking is visually explained within the single frame without duplicating the whole layout.
Style/medium: clean modern desktop product UI, screenshot-fidelity mockup, not illustration or 3D render
Composition/framing: exactly 1440x1024, visualization centered in the upper-middle two-thirds, controls anchored lower third, generous negative space, no crowding
Lighting/mood: dark mode, the visualization is the only strong light source, soft ambient glow falloff into the dark background, otherwise restrained
Color palette: background #171717, foreground text #f0f0f0, muted text #a2a2a2, accent #ff5364 with glow rgba(255,83,100,.35) and bright core, borders rgba(255,255,255,.085) used sparingly on control chrome only
Materials/textures: large soft-edged glow orb/band with no hard geometric shape, circular control buttons with 16-22px radius pill/circle treatment, no drop shadows beyond the visualization's own glow
Text (verbatim): "Focus · Voice" · "Default voice" · caption line reading "Default voice — listening…" · small secondary label "Speaking sounds brighter and faster" (small, muted, clearly a UI annotation style, not a system alert)
Constraints: mocked concept only, no live mic/network, no invented voice/device names beyond "Default voice", no device bezel, no browser chrome, do not reproduce the base app's conversation transcript or Work in flight rail in this frame
Avoid: generic circular equalizer/Siri-orb cliché with rainbow noise, neon/sci-fi overstyling, extra navigation or feature chrome not described above
```

---

## Prompt 3 — name: `conversation-panel`

Concept: a conversation-led voice panel that keeps captions and worker/task context alongside voice controls, and is the concept that also shows the restrained settings panel open.

```text
Use case: ui-mockup
Asset type: desktop Electron app screen — Pixice Focus voice-mode conversation panel with live captions and worker context, mocked concept (no live mic/network)
Primary request: Show the existing Pixice Focus layout from the reference screenshot (dark canvas, top-left "Pixice / Focus project" breadcrumb, centered text conversation, top-right "Work in flight" rail card with task rows and progress bars) preserved as the base, with a voice-mode side panel or lower band added that keeps the conversation and Work in flight rail visible while voice is active. Inside that added voice area, show a running live-caption feed of the spoken exchange (a few short lines, alternating speaker labels "You" / "Coordinator", muted gray text, most recent line brightest) plus a compact status row with the listening/speaking indicator (VoiceBeam-style soft glow) and mute/end controls. Additionally, show a small settings popover/flyout open above or beside the settings gear, anchored to the voice area, containing exactly these controls: a voice picker row reading "Default voice", an input device row reading "Built-in Microphone", an output volume row with a simple horizontal slider, and a captions on/off toggle switch (shown on).
Input images: Image 1: reference — actual current-app screenshot (work/design-qa/focus-rail-1600.png); match its layout, spacing, breadcrumb, rail card, and typography exactly for the preserved base, and derive the popover's surface/border/radius treatment from the same design language.
Scene/backdrop: dark charcoal desktop app window, background #171717, no bezel or window chrome
Subject: base conversation + Work in flight rail unchanged from the reference; below or beside it, a voice panel band containing the live caption feed, the listening/speaking indicator with mute/end controls, and the open settings popover (surface #2b2b2b or popover #303030, restrained border rgba(255,255,255,.085), rounded 16px corners) listing voice picker, input device, output volume slider, and captions toggle
Style/medium: clean modern desktop product UI, screenshot-fidelity mockup, not illustration or 3D render
Composition/framing: exactly 1440x1024, base layout preserved at the same proportions as the reference, voice panel and settings popover fit within existing negative space without crowding or overlapping the Work in flight rail
Lighting/mood: dark mode, soft restrained accent glow only from the voice indicator, no heavy shadows, popover reads as a clearly elevated surface via a subtle raised background tone rather than a heavy shadow
Color palette: background #171717, surface #222222, raised surface #2b2b2b, popover #303030, foreground text #f0f0f0, muted text #a2a2a2, quiet text #858585, accent #ff5364 with glow rgba(255,83,100,.35), borders rgba(255,255,255,.085)
Materials/textures: rounded 12-16px radii for rows and controls, 22-28px for the outer panel, restrained hairline borders, simple horizontal slider track for output volume, simple pill toggle for captions
Text (verbatim): "Default voice" · "Built-in Microphone" · "Output volume" · "Captions" · caption feed lines such as "You: what's the status on the rail refinement task?" and "Coordinator: two of four steps done, want details?" · "Mute" · "End"
Constraints: mocked concept only, no live mic/network, no invented voice/device names beyond "Default voice" and the generic "Built-in Microphone", keep existing breadcrumb/rail/conversation from the reference image intact, no device bezel, no browser chrome, do not invent additional settings beyond the four listed
Avoid: generic waveform/equalizer bar clichés, neon or sci-fi styling, invented extra navigation, palette swap away from the reference accent, overcrowding the settings popover with unlisted options
```

---

## Execution notes for the coordinator

- Issue exactly 3 independent `image_gen` calls, one per prompt above — no `Promise.all`, no combined/batched call, no multi-idea collage in one image.
- Attach the actual file `/Users/blumenwagen/Developer/Loom/work/design-qa/focus-rail-1600.png` to every call as the reference image; do not rely on the text description of it alone.
- Size: exactly `1440x1024` for all three (desktop app default per the ideate skill; the reference screenshot is 1600px wide but not required to be replicated pixel-for-pixel — treat it as layout/style reference, not a crop target).
- Do not add planned numeric labels ("option 1/2/3") inside the prompt text itself — that's already respected above. Track results by the `name:` given to each prompt (`compact-dock`, `immersive-call`, `conversation-panel`) rather than submission order, since the ideate skill's own ordering rule (bind by displayed result order, not request order) applies once results return.
- Save the three resulting images under `work/voice-mode-concepts/` (e.g. `compact-dock.png`, `immersive-call.png`, `conversation-panel.png`) and return their paths to this worker/thread for visual critique and Preview presentation, per direction r6.
- No CLI/API credential setup, no dependency installs, no nested agent threads — this file is the complete handoff artifact.
