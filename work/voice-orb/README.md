# Voice orb handoff

Ready for coordinator review under Focus work `ef6b9817-f616-42d6-8abc-c54c33a693bc`. Directions 28 and 33 acknowledged. Visual files only; no native, composer, App, main, dependencies, commits, or running-app replacement.

```jsx
import { VoiceOrb } from '../../src/components/VoiceOrb.jsx';

<VoiceOrb
  phase="listening"
  micLevel={micLevel}
  speakerLevel={speakerLevel}
  muted={muted}
  accent="coral"
  size={160}
  reducedMotion={undefined}
/>
```

- Named and default exports are available. Props are `{ phase, micLevel=0, speakerLevel=0, muted=false, accent, size=160, reducedMotion }`.
- Supported phases are idle, connecting, listening, speaking, muted, error. Unknown phases use idle. Error takes precedence over mute. Muted suppresses audio response.
- Levels are normalized 0..1, clamped, and smoothed. Speaking responds to speakerLevel; listening responds to micLevel. No microphone, AudioContext, playback, transport, or native API calls.
- Accent accepts Pixice names coral, blue, rose, amber, green, violet, teal, graphite, or a CSS color. Omitted accent inherits `--primary`, then defaults to `#ff5364`.
- Numeric size means CSS pixels. CSS width values also work. The square fits within the parent's width. Visual diameter includes space for the glow, so use 160 for a compact companion and 320 for the large review hero.
- reducedMotion defaults to the OS preference. True freezes the real shader; audio updates do not animate or redraw that still. The phase and accent remain visible. False explicitly permits motion.
- Rendering is capped at 30fps, 1.5 DPR, and 768px framebuffer dimensions. Document-hidden, zero-size, and offscreen views suspend frames. ResizeObserver handles layout changes.
- WebGL setup/compile failure and context loss use a separate static 144px procedural 2D field. Restoration rebuilds WebGL resources. Unmount cancels frames, removes listeners, disconnects observers, deletes shaders/program/buffer, and releases backing stores. StrictMode remount is supported.
- The upstream shader noise/core/rings and `electron/voice/LICENSE.plasma` remain intact. The shader adds a soft circular alpha edge to the previous transparent adaptation. CSS contains layout and canvas visibility only.

## Verification

`tests/voice-orb.test.jsx`: 6 tests passed in a single focused run. Verified phase precedence, finite/clamped audio, DPR cap, persistent GPU resources across props, hidden/offscreen/zero-size suspension, reduced-motion redraw behavior, context recovery/disposal, and partial shader failure cleanup.

Executed through the installed Electron Node runtime because the worker shell has no standalone Node executable:

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron node_modules/vitest/vitest.mjs run tests/voice-orb.test.jsx
```

`capture.cjs` opened the reference and standalone Vite page in an isolated Electron renderer. All seven orbs used real WebGL. Forced WEBGL_lose_context switched all seven to fallback, then all seven restored WebGL. Desktop and 390px mobile had no horizontal overflow. No renderer console errors; one ordinary Electron development warning about the standalone fixture's missing CSP. See `browser-check.json` for measured buffers and states.

Inspected desktop, alternate accent, light background, mobile phase grid, static shader, and lost-context fallback captures. Compared the source and implementation in `comparison.png`. Design QA passed with intentional Pixice palette and phase-specific changes documented in `design-qa.md`.

Pixice's worker screenshot call returned an empty image, so captures use the isolated renderer rather than claiming the native app was visually verified. Pixice Preview navigation and the accent control were exercised through native browser tools. Native microphone/window continuity is outside this visual outcome. No broad suite, package build, or native session checks ran.

## Review artifacts

- `desktop.png`: coral, all phases, large speaking hero.
- `alternate-accent.png` and `light.png`: blue accent on dark and light.
- `mobile.png` and `mobile-phases.png`: responsive 390px layout and all phases.
- `reduced-motion.png`: frozen real shader.
- `context-loss.png`: procedural fallback after real GPU context loss.
- `reference.png` and `comparison.png`: reference and combined visual comparison.
- `browser-check.json`: actual renderer state, overflow, console evidence.

Preview is open at http://127.0.0.1:5193/work/voice-orb/ . The Vite server remains running for review. The fixture labels its simulated audio and native limitations.
