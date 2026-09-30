# Current DevDay integration

Coordinator accepted the local desktop implementation on 2026-09-30. Changes remain in the shared checkout; they have not been committed, pushed, installed or used to restart the running app.

## Voice and composer

Supported local Codex empty composers offer conversational Voice. Typing or attaching content switches the same primary button to Send. Existing Stop, steering, dictation and normal Claude sending remain available. A This computer / Cloud selector sits above the composer.

Voice opens a 224 × 240 transparent, draggable plasma companion. Its dedicated renderer owns one microphone and playback connection. Detaching, reattaching and closing the main window preserve that renderer. Controls appear on hover or keyboard focus; muted, approval and recovery indicators remain visible. End and companion close release capture immediately. Failed host cleanup reserves the session and offers Retry End. Approvals return to the existing Pixice approval UI. Blocked playback retains Enable audio until a successful explicit retry.

The plasma uses the selected accent and actual microphone/speaker levels. Reduced motion and WebGL fallback are supported. Native window lifetime was checked on macOS with synthetic microphone input and fake signaling. Live account audio, real autoplay, physical permission prompts and Windows/X11 behavior remain unverified. Wayland detachment is explicitly unsupported.

## Cloud and ChatGPT sign-in

Cloud uses normal Codex CLI authentication, saved project environment IDs and actual submission/status/diff operations. The composer sends Cloud prompts directly, without sending them to the local coordinator. Unsupported attachments or Preview context retain the draft and explain the limitation. Patch application requires a reviewed, project-bound snapshot and applies exactly those saved bytes locally.

Providers settings includes app-owned Continue with ChatGPT, protected token storage, account selection and sign-out revocation with truthful failure reporting. This account source covers eligible Responses inference; Voice and Cloud use normal Codex authentication. Environment discovery, live OAuth/plan inference, Cloud entitlement/submission and commercial eligibility are not established by fixtures.

## Evidence

- [Initial auth/Cloud/native protocol evidence](integration-report.md). Its original toolbar/dialog Voice presentation was superseded by the companion and composer outcomes.
- [Composer handoff](../voice-composer/result.md), including focused behavior checks and actual Task/Focus captures.
- [Native companion handoff](../voice-companion/README.md), including single-owner lifetime checks, transparent native captures and the narrow playback regression.
- [Plasma component handoff](../voice-orb/README.md), including WebGL fallback/recovery and reduced-motion checks.

Independent integration review found one blocked-playback overwrite, now corrected and checked. Coordinator inspected the fix, its focused regression and the compact native captures. No broad suite was repeated for the final presentation and availability corrections.
