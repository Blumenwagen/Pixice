# Independent follow-up review of r12 voice fixes

Review work `dfb5f327-bcad-45d5-aafe-bb30825c38dc`, same thread and outcome, reviewing `74b6938b-8f0c-40a7-97b5-bc4775e6f533` on 2026-09-30. Direction r1 acknowledged; full-access runtime, no permission failures or delegation.

Recommendation: **accept the bounded backend integration and r12 corrections**. The original ownership and speaker-permission findings no longer reproduce. Frozen input admission is corrected, and the renewal fixture correction preserves its behavioral assertions. I found no remaining blocker in these reviewed paths. This supersedes the request-changes recommendation in [the first review](independent-review.md), while retaining its live-media, final-UI and diagnostic limitations. Only the coordinator can accept or complete the outcome.

## Desktop authority and the original P1 probe

Read the updated HANDOFF, review-fixes and verification JSON, and actual bootstrap, service, native bridge/helper, main, protocol and file-boundary source. The new [desktop-authority.mjs](/Users/blumenwagen/Developer/Loom/electron/backend/desktop-authority.mjs) provisions a random proof separately from the ordinary RPC descriptor. The file is created exclusively at mode 0600, atomically renamed, and bound to the service owner nonce. Its reader rejects nonregular/insecure files, symlinks through O_NOFOLLOW, oversized content, wrong nonce and malformed tokens. Successful shutdown removes the current file; a replacement service creates a new proof. Service startup failure also has disposal handling.

The native bridge requires proof for trusted registration and every operation on a trusted lease. A public client ID no longer recovers that lease. Legacy nonvoice registration remains supported but cannot mint voice ownership or upgrade an existing lease. Expiry is checked during authorization as well as maintenance. The executed service regressions cover expiry, owner replacement, no event replay, successful shutdown removal, restart rotation and rejection of old descriptors/proofs/leases.

I adapted the original actual-service probe into [pixice-voice-r12-review-probe.mjs](/tmp/pixice-voice-r12-review-probe.mjs). It starts only a disposable service with fake providers/native responses, then uses real ApplicationClient and NativeHelperClient transports. The real helper reads the private file using the same callback supplied by Electron main. The probe asserts:

- Without a trusted helper, ordinary registration cannot attach voice.
- With the trusted helper, registration using the public status client ID fails without proof.
- Even with a captured fixture lease and owner handle, proof-free poll/respond/event/disconnect, voice attach/poll/call/disconnect operations fail.
- The legitimate helper prepares and starts a fake session and receives its private SDP event.
- Public status, descriptor, generic local/remote events, audit and command records exclude the proof, trusted lease, owner handle and fake SDP.

All assertions passed. No secret values are printed. The probe closes the helper/service, asserts bootstrap removal and removes its disposable database and directory.

All native operations now bypass server command recovery, including ordinary registration. This prevents the proof-bearing helper traffic and lease responses from entering those records. Authentication, request identity/age, operation checks and application registry closure still apply before or beyond the read branch. The separate remote operation map does not advertise voice/native calls. The read classification continues to select the read rate budget and throttled audit path; it is not itself an authorization grant.

This meets the agreed boundary between ordinary RPC possession and private desktop authority. It does not sandbox arbitrary code, terminal commands, process-memory access or private-file access already granted to the same OS user. No broader authentication redesign is required by this review.

## Bootstrap file boundaries and shipping path

The service records the active credential inode. Application preview/read/write and Instrument text sources use the protected preview resolver. Workflow File reads/writes, Skill reads, and Review/Git diff content paths check the inode before returning content. Hardlinks retain the same protection; symlinks either resolve to the protected inode or fail the existing project boundary.

Submitted service fixtures passed direct, hardlink and symlink preview/write tests, project reads, workflow File/Skill reads and Review diff checks. My adapted probe independently checks hardlink/symlink application reads, workflow File read/write, Skill attachment and an actual workflow Git diff over a tracked empty-baseline hardlink. All denied access. The Git fixture used only an empty blob/tree and temporary index, with no commit. The original probe expectation initially required the credential-specific error for a symlink project read; that read correctly failed earlier as outside the project. I corrected the temporary probe to accept either denial and reran successfully. No implementation fix was needed.

The existing update backup whitelist excludes desktop-authority.json. Metadata-only file listing/stat and Git name/stat results are not treated as credential contents. No claim is made about defending against arbitrary OS-user file races or executing code, which are outside this boundary.

The bootstrap is production wiring, not just test injection. `service.mjs:startService` provisions it before service setup and passes it to NativeBridge. `main.mjs:connectService` supplies `readDesktopAuthority(dataDirectory, descriptor)` to NativeHelperClient; startup and service start/restart handlers use that connection function. The helper reads the current descriptor and proof on each registration attempt and carries proof on subsequent native operations. Voice itself is not automatically resumed.

`electron-builder.config.cjs` includes `electron/**/*`, which includes the new backend module and its relative imports. The after-pack checks do not exclude it. This confirms source/configuration inclusion and the executed real helper transport path. No packaged app was built or launched, so this is not a claim of inspected installed-package contents or an Electron launch smoke test.

## Speaker permission and frozen admission

Both speaker callbacks now require the actual owning contents, top-frame details, trusted requesting URL, current contents URL and current main-frame URL. The check callback additionally validates the requesting security origin, distinguishing packaged file origin from the full requesting URL. This matches the Electron 38.7.2 details semantics inspected in the first review. Installed declarations and the version-matched Electron source remain the basis; no new Electron version assumption was introduced.

The submitted tests cover foreign/null contents, subframes, foreign origin, navigation, exact packaged file frame, audio-only requests and delayed permission revalidation. My callback probe independently accepts the trusted speaker case and rejects foreign contents/origin in both callbacks. No OS permission or device API was called.

Voice admission now consults the application's actual accepting-work state. Prepared frozen sessions reject start and all three appends before native calls; snapshot and stop remain available. I also probed an active websocket fixture while frozen: all append methods reject without increasing native call count, and stop succeeds. The pending native catalog test passed, confirming freeze prevents a start that was waiting on metadata. Bridge start and append repeat admission checks after asynchronous work immediately before native input. Existing failed-shutdown and conservative failed-stop tests also pass.

## Renewal fixture correction

The patch to `tests/app.test.jsx` supplies `threads.read` with the actual `renewed-focus` replacement when requested, retaining the original fixture for other IDs. It then waits for that read, the selected thread and enabled composer/Send. The exact final assertion still requires `turns.start` with `renewed-focus` and the unchanged retained draft. Work-rail and draft assertions remain.

This corrects a concrete mismatch in the fixture instead of weakening the test or changing App behavior. I ran the complete filtered UI group and five additional serial executions of the exact test. All passed without retries or edits between runs. These are my five executions, separate from the author's reported ten. The earlier failure evidence remains in the original review; this finite rerun does not claim that all UI timing is universally deterministic.

## Independent verification

| Check | Result |
| --- | --- |
| Isolated integration/security/renewal/context configuration | 74 passed, 4 files |
| Voice/runtime/provider/native/service/preload/Connect/preview/workflow/Git regressions | 147 passed, 17 files |
| Focus/questions/app/desktop filtered group | 44 passed, 142 unrelated tests skipped, 4 files |
| Exact corrected renewal regression, five additional serial runs | 5 passed, no failures |
| Adapted actual-service, alias, frozen-input and speaker probes | Passed |
| Desktop Vite build to `/tmp/pixice-voice-r12-independent-build` | Passed, 801 modules |
| 29 JavaScript syntax checks, integration JSON parsing, `git diff --check` | Passed |

The suite total is **265 distinct passing tests in 25 files**. Repeated UI executions are not added to that count. The 147-test command is verification.json's 16-file 143-test group plus `tests/worktrees.test.js`. All test/build processes exited zero. Logs are `/tmp/voice-r12-review-integration.log`, `voice-r12-review-regressions.log`, `voice-r12-review-ui.log`, `voice-r12-review-build.log`, and `voice-r12-review-renewal-1.log` through `-5.log`.

Warnings remain SQLite experimental support, Motion opacity, Vite mixed App imports, large chunks and external output-directory handling. JSX was parsed through tests/build. No TypeScript compiler check or packaged Electron check ran. The unchanged native protocol metadata inspector was already independently verified in the first review; I did not repeat a live account/catalog or native media probe here.

## Retained limitations

Process-wide raw stderr suppression after the first attempted voice start remains a deliberate loss of later text/tool diagnostics until process replacement. Structured events and explicit application diagnostics still work. This tradeoff is not a substitute for the ownership and data-routing checks above.

Final visual/settings UI and product entry points remain unapproved. Account entitlement, OS microphone behavior, real WebRTC negotiation, speaker output and live cleanup still require separately authorized user-started testing. Fixture acceptance establishes none of those.

Only this follow-up review and disposable verification files were written. No source edits, final UI, live provider turns/rotation/voice, microphone recording, production database access, install/relaunch, commit/push or nested workers occurred. No complete_work call was made.
