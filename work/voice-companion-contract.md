# Parallel Voice work contract

GPT-6.1 Sol only. Existing broad outcome 90312b31-debf-4df9-9e2b-ced5fe8cae35 is paused while three disjoint workers implement remaining work. Preserve all uncommitted DevDay auth/cloud code. No nested workers, broad test reruns, commits, pushes or live-app replacement.

## Shared interfaces

- Visual worker exports `VoiceOrb` from `src/components/VoiceOrb.jsx` with props `{ phase, micLevel=0, speakerLevel=0, muted=false, accent, size=160, reducedMotion }`. Presentation only; no media capture or native lifecycle. The orb is a transparent fluid plasma canvas adapted from the referenced Pipecat shader, with a reduced-motion/WebGL fallback.
- Native worker exposes `api.voice.companion` methods `open(context)`, `state()`, `mute({muted})`, `end()`, `detach()`, `attach()`, `returnToPixice()`. `context` contains existing `{projectId, threadId, model?, effort?, permissionMode?, deviceId?, accent?}`. `open` is an explicit user action; returns public state. Existing backend `voice.start/stop` own Codex protocol; credentials never reach UI. A dedicated renderer owns the single microphone, WebRTC, audio playback and audio-level analysis for the lifetime of the companion.
- Public state/events contain `{phase, projectId, threadId, muted, detached, micLevel, speakerLevel, error?, needsApproval?}`. Native publishes a `VoiceCompanionState` event through existing subscriptions. Main app navigation must not kill the pinned session.
- Native renderer imports the visual `VoiceOrb`. Attached and detached presentations use the same media owner; main-window closure detaches/preserves an active visible companion. Explicit End and app Quit stop capture/runtime. The native worker owns its controls/layout and main-window close policy. It may choose a child native floating window for attached presentation if that meets dragging/no-overlap/continuity; verify actual native behavior rather than claiming browser fixtures prove it.
- Composer worker calls `api.voice.companion.open(context)` through the primary Voice action. Empty Codex draft uses Voice; text/attachments use Send; running turns retain Stop. Keep dictation separate. `VoiceConversation` becomes the composer launch adapter as needed; avoid the old duplicate toolbar button/modal. Browser fixture may simulate companion methods, but should label native limitations in evidence.
- Composer routes explicit Cloud destination through existing `api.cloud.submit({projectId, environmentId, prompt, attempts:1})`, never local chat/widget routing. Saved environments come from `api.cloud.state({projectId})`. Keep local behavior unchanged and show useful submission/status feedback. Attachments or unsupported provider modes need truthful behavior; no silently dropped files or fake Remote options.

## File ownership

Visual: `src/components/VoiceOrb.jsx`, `src/components/voice-orb.css`, `src/voice/plasma-shader.js`, `electron/voice/LICENSE.plasma`, `tests/voice-orb.test.jsx`, `work/voice-orb/`.

Native: `electron/main.mjs`, `electron/preload.cjs`, `electron/backend/application.mjs`, `electron/connect/application-protocol.mjs`, `electron/voice/codex-voice.mjs`, new `electron/voice/companion-*`, `src/lib/codex-voice.js`, `src/voice/CompanionApp.jsx`, `src/voice/companion.css`, `src/main.jsx`, `src/pixice-api.d.ts`, `tests/voice-companion-*`, `work/voice-companion/`.

Composer: `src/App.jsx`, `src/components/VoiceConversation.jsx`, `src/components/ComposerPrimaryAction.jsx`, `src/components/ComposerWorkLocation.jsx`, `src/components/composer-integration.css`, `src/devday-preview.js`, `tests/voice-composer-*`, `work/voice-composer/`.

Read other workers' files freely; do not edit them. Report missing contracts to coordinator. Each worker uses only narrow tests addressing its actual risks and provides evidence. Coordinator integrates and reviews once results arrive.
