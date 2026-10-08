# Voice glyph follow-up for coordinator review

Same Focus work 8d25369f-4cd5-4798-9afd-d9a648b41499 and thread. Direction 36 read and acknowledged. GPT-6.1 Sol only, no delegation.

Replaced the primary conversational Voice microphone with a 20px inline SVG containing five rounded currentColor bars of varied heights. Removed the Microphone import from ComposerPrimaryAction.jsx. The existing same-button Voice/Send transition, Stop, pending spinner, labels, theme and reduced-motion handling are unchanged. Existing dictation and native mute controls were not edited.

Source inspection and the actual isolated Electron capture passed. task-voice-waveform-with-dictation.png shows the real App composer with both the circular waveform Voice action and separate transcription microphone. glyph-capture-evidence.json records both DOM controls and their actual SVG markup. The optional dictation-ready-preview flag in the development fixture simulates a ready transcription model so its existing control is visible; capture/transcription actions remain blocked. No native recording or companion lifetime proof is claimed.

No tests, suites, builds, commits, pushes, installations or live-app restarts ran. Existing accepted captures and reports were not overwritten. voice-waveform-glyph.patch contains only this follow-up. Awaiting coordinator acceptance of the glyph correction.
