# Native voice production integration

Work `74b6938b-8f0c-40a7-97b5-bc4775e6f533`, project `acf157b1-b774-4c26-acf7-8ae4dd6a0a5c`. Implemented and corrected after independent review on 2026-09-30, in the same outcome/thread. Ready for another independent coordinator review, not self-accepted. Directions r1 and r12 were acknowledged; the worker ran full access with no permission failures. No worker delegation or `complete_work` call.

## Result and scope

The accepted native voice foundation is now connected to the existing CodexRuntime, backend application, authenticated desktop transport, Electron main process and typed preload/client contracts. Preparation shares the existing Focus admission gate. Voice events and SDP use a private ephemeral desktop-owner mailbox.

There are no edits to `src/App.jsx` or voice prototypes, and no final visual or settings UI. The existing text mode and accepted Focus renewal/fork policy remain in place. Neither this work nor either accepted foundation establishes live account entitlement or working microphone/WebRTC media.

Read the accepted voice handoff and all voice modules, plus renewal `voice-integration.md`, `result.md`, `independent-review-fork-gate.md` and the host APIs. No applicable AGENTS.md or CLAUDE.md was found in the workspace, ancestors or affected directories. The openai-docs skill and relevant Codex official-docs route were read fully, followed by official documentation search and fetch before implementation.

## Independent review corrections, direction r12

Read the complete [independent review](independent-review.md) and current direction before edits. The unchanged `/tmp/pixice-voice-independent-probe.mjs` reproduced the review against an actual disposable service and fake native runtime. Public client ID registration recovered the lease, ordinary RPC prepared voice and received fake SDP, the registration response entered command recovery, and one native start occurred while frozen. These were real integration defects, not live-provider observations. Exact evidence and continuation-owned paths are in [review-fixes.json](review-fixes.json).

P1 now uses a separate private OS bootstrap. Service ownership provisions a random credential in `service/desktop-authority.json`, with mode 0600 and the current service owner nonce. Electron main reads that file directly into the native helper. The credential is absent from the public descriptor, registration response and status. It is required for trusted registration and every operation of that trusted lease. Public ID re-registration without proof cannot recover the desktop lease. Ordinary nonvoice registration can retain legacy same-ID behavior, but cannot mint voice ownership or upgrade its lease. Expired/replaced leases and owners are rejected; service restart rotates proof and successful shutdown removes its file. No account authentication migration or new approval prompt.

All native operations now bypass command recovery records and cached responses because every trusted helper call can carry proof. The existing read classification also uses the read rate budget and throttled audit path; this is not merely a cache switch. Remote capabilities remain separate and exclude native/voice operations. Existing public client IDs remain public; hiding them was not the fix.

Application preview/read/write, workflow File/Skill readers and Review/Git diffs reject the credential inode before returning contents, including tested hardlink and symlink aliases. The existing backup whitelist excludes this file. Tests check public status, generic local/remote events, audit, descriptor and command records for absence of bootstrap proof, trusted lease/owner handles and fake SDP. The original success-oriented probe now aborts at the intended `native.voiceAttach` denial, then executes its disposable teardown. Both absent-helper and existing trusted-helper cases have actual service tests, including the real NativeHelperClient registration/poll/voice path.

This isolates possession of the ordinary local RPC token from desktop bootstrap authority. It does not resist arbitrary compromised OS-user processes that can read private files or process memory. APIs explicitly authorized to execute arbitrary OS commands/code also have that OS-user access. This work is not a sandbox or a general local administration authentication redesign.

P2 now applies the actual trusted window, top-frame and URL checks to `speaker-selection` in both check and request callbacks. Checks also validate the requesting security origin, with packaged file origin handled separately from the full requesting file URL. Electron 38.7.2 installed declarations and version-matched [permission-manager source](https://github.com/electron/electron/blob/v38.7.2/shell/browser/electron_permission_manager.cc#L289) establish `requestingUrl`/`isMainFrame` details and check-to-granted behavior. Its [permission converter](https://github.com/electron/electron/blob/v38.7.2/shell/common/gin_converters/content_converter.cc#L221) maps speaker selection to the callback string even though the installed check-handler TypeScript union omits it. Tests cover trusted and foreign contents/origins, null contents, subframes, navigated owners and packaged origins without actual devices.

Voice input admission now consults the host's actual `acceptingWork` state. Frozen prepare/start/append operations return a visible error; start and append admission also repeats after asynchronous work before native effects. Stop, snapshot and lifecycle cleanup remain callable. A prepared frozen-session fixture checks all start/append handlers and zero native calls. A pending-start metadata fixture confirms freeze prevents native start. Existing failed-shutdown retry, stop guard and renewal/fork tests still pass.

The renewal UI fixture was instrumented before its final correction. Two of eight unchanged instrumented executions failed; both had the renewed thread selected but disabled prompt and Send. The loading indicator was already absent, so a specific loading-state cause was not established. An enabled-state wait alone failed all ten diagnostic executions. Read instrumentation then showed `threads.read("renewed-focus")` returning the unrelated active `ongoing-worker`. The test now supplies the authoritative replacement thread on that read, waits for the read and actual selected thread, and requires an enabled prompt and Send. The original exact renewed-thread/text-send assertion is unchanged. Ten serial executions after this complete correction all passed, followed by the full 44-test filtered group. No retries, weakened assertions or App.jsx edits.

## Protocol evidence

The [official app-server documentation](https://developers.openai.com/codex/app-server) describes initialization, experimental API opt-in and generation of the executable's version-specific protocol schema. Those facts establish the integration contract, not an account's voice entitlement.

The installed executable is Codex 0.159.0. Fresh experimental schema generation matched all 23 realtime schemas, six realtime request descriptors and eleven realtime notification descriptors in `work/voice-implementation/protocol-0.159.0.json`. See [protocol-verification.json](protocol-verification.json) for exact canonical hashes. The actual production metadata inspector also passed against this executable. These calls generated metadata only; they did not launch an authenticated app-server session.

Production verifies the pinned version and canonical schemas/descriptors lazily for the actual existing runtime. It checks executable identity against the launched process before and after inspection and caches verification for that process. A different version, modified schema, changed executable or inspection failure fails visibly. There is no model-name inference, catalog-only availability claim, new authenticated provider process, API-key fallback, new billing path or auth migration.

Protocol support is explicit and experimental. The schema supports WebRTC and websocket transports, v1/v2/v3 and audio/text output modalities. A signed-in ChatGPT account plus a valid dynamic catalog still returns `sessionAvailability: "unverified"`. A user-started native session and renderer connection must establish actual availability later.

## Focus admission and authority

`installVoiceApplication` installs `application.setFocusVoiceGuard` before publishing voice handlers. Prepare runs through `application.withFocusSessionAdmission`, the same project mutex used by /new and automatic context-pressure renewal. The scope resolver performs direct authoritative checks and never acquires admission recursively.

Authority requires the actual project, current Focus thread, persisted thread/provider binding, Codex ownership and current generation. Registry default-provider fallback is insufficient. Active text turns prevent prepare. Every operation validates current authority and authenticated owner; operations after prepare also require the exact current handle. Supplied stale generations fail, and owner bindings retain the authoritative generation.

Preparation reserves synchronously before asynchronous authorization and expires after 30 seconds. Preparing, starting, native-active, stopping and failed native stop all block rollover and text admission. A failed stop keeps protection until explicit successful cleanup or confirmed runtime disconnection. A runtime status error alone does not release a still-connected session. Native `started` is not renderer active; the controller waits for WebRTC connection state `connected`.

Tests exercise /new and actual automatic renewal, prepare waiting behind renewal, pending metadata, reservation expiry, stale authority, unknown binding, cross-project handles and active text turns. Existing renewal/fork tests remain passing.

## Local desktop ownership and privacy

Main process IPC checks the actual sender, owning main window, top frame and trusted URL. Development uses the existing `http://127.0.0.1:5173` origin. Packaged operation requires the exact application index file. Other windows, frames and remote origins cannot claim ownership. Renderer-supplied owner IDs are never authority.

The native bridge issues a private owner handle tied to the authenticated native helper lease. Dedicated `native.voiceAttach`, `native.voiceCall`, `native.voicePoll` and `native.voiceDisconnect` operations carry ownership internally. The handle does not reach renderer state. Ordinary CLI callers and remote Connect cannot invoke production voice. Remote capabilities do not advertise it.

The private mailbox is bounded to 200 events and 2 MiB. Voice owner activity expires after the existing 45-second lease interval even if general helper polls continue. Expiry is checked on authorization as well as periodic maintenance. Voice polling is bounded to 20 seconds with a 25-second client timeout. Detach destroys pending events; replacement owners receive no replay.

Native realtime notifications leave CodexRuntime through a dedicated voice event channel before generic provider forwarding or registry snapshots. Application and service publishing defensively reject voice/realtime events. Foreign project/thread notifications are dropped. SDP, audio and transcripts are not published to Connect, other projects/windows, thread history or generic event streams. Voice and owner-control results bypass durable command recovery/idempotence caches. There are no hidden retry or media-resume paths.

Malformed native JSON errors use a static safe message. After the first native realtime start, CodexRuntime suppresses stderr diagnostics for that process, including late stderr after stop, until a new process starts. This deliberately sacrifices later stderr diagnostics to avoid storing voice-related payloads. Normal text events still flow. Native failures returned through production handlers use safe fixed messages rather than raw credential-bearing error bodies.

## Cleanup and failure behavior

Owner disconnect, window navigation/crash/destruction and helper transport loss revoke local ownership and clean up media. Renderer owner-disconnect events release media immediately and show failure if native teardown remains uncertain. Reconnection does not resume or automatically attach a session.

Project deletion closes admission before stopping native voice and deleting project data. Closed events still reach the authorized owner while the project exists. Failed stop leaves the project intact, preserves the guard and returns a visible safe error. An explicit deletion retry can finish cleanup.

Account updates stop voice. Provider login, logout, install, locate, repair and update stop voice before changing the account/runtime. Failed native stop blocks the lifecycle action. Service shutdown and forced quiescence stop voice before drain/teardown. Failed shutdown restores service admission and leaves handlers available for explicit cleanup retry; no hidden retry occurs. The service push channel closes only after voice cleanup succeeds.

## Preload and settings contract

The preload exposes availability, prepare, start, stop, appendText, appendSpeech, appendAudio and snapshot under `voice`. The existing client adapter supplies typed subscriptions. Scope, handle, availability, snapshot, discriminated event, settings and audio contracts are declared in `src/pixice-api.d.ts`, with client/settings declarations alongside the existing modules.

Exact defaults are:

| Setting | Default | Contract |
| --- | --- | --- |
| voice | null | Omit native selection and preserve its configured default. Dynamic v1/v2 catalogs only; changes require restart. v3 has no exposed catalog, so explicit selection fails. |
| microphoneDeviceId | empty string | Browser default input. Replacement requires explicit user action. |
| muted | false | Local browser track enable/disable. |
| outputVolume | 1 | Range 0 to 1, only where browser media volume is supported. |
| outputDeviceId | empty string | Browser default output. Selection requires supported sinkId capability. |
| captions | true | Ephemeral local display setting. |

No guessed speed, VAD, personality or prompt controls. No new preference persistence was needed or introduced. No final settings screen was built.

Electron permission checks accept media/speaker selection only for the trusted owning desktop window. Audio requests reject video, mixed or unknown media before OS access. On macOS, checking uses granted OS status; a trusted actual audio request can invoke the OS prompt only when status is not determined. The delayed decision rechecks window/origin. Other permission defaults retain existing behavior.

The existing macOS audio input entitlement was already present. The microphone usage description now explains local dictation and user-started audio sent to signed-in Codex. Tests mock permission APIs and media; none requested actual microphone access. Electron 38.7.2's installed declarations informed the permission APIs; the Electron web documentation fetch was unavailable.

## Verification

265 distinct tests passed across 25 files after the review corrections. All 37 original foundation voice tests remain, with four controller/bridge regressions bringing those two files to 41. Repeated executions count once.

| Command group | Passing tests | Files |
| --- | --- | --- |
| Isolated integration, native security, renewal and coordinator context | 74 | 4 |
| Voice foundation, runtime, provider, native backend, service, preload, Connect, preview, workflow and Git regressions | 147 | 17 |
| Focus coordination, questions, commands/fork and desktop UI regressions | 44 | 4 |

The filtered UI run skipped 142 unrelated tests. Exact reproducible commands are in [verification.json](verification.json). Fixtures use isolated fake providers/native transports, disposable DBs and mocked media. Coverage includes authenticated owner versus remote/cross-project spoofing, unknown/retired authority, early SDP with empty native start response, dynamic catalog and account failures, pinned-version failures, reservation expiry, prepare/renewal races, failed stop/disconnect, deletion, shutdown retry, account teardown and renderer connection state.

Desktop Vite build passed with 801 modules. JavaScript syntax checks passed for 29 affected executable files; whitespace diff and evidence JSON parsing passed. JSX parsing occurred through the executed Vitest/build commands. Review inspected the affected integration diffs and preserved unrelated dirty changes. The actual pinned metadata inspector was rerun successfully without an authenticated app-server session.

Warnings were Node SQLite experimental status, an existing Motion undefined-opacity warning in UI tests, Vite's existing mixed static/dynamic App import and large-chunk warning, and informational external-output-directory handling. Intermediate fixture issues were corrected before the passing final runs.

The first submission and independent review both found intermittent renewal UI failures. The r12 instrumentation and authorized fixture/readiness correction are described above and retained in verification evidence, including the unsuccessful enabled-wait-only experiment. Ten final serial exact-test runs and the full filtered group pass. Only that regression in tests/app.test.jsx was edited in this continuation.

No TypeScript compiler is installed in this checkout. Declarations were inspected and preload/runtime contracts tested, but no declaration compiler check ran. No packaged Electron build, install, relaunch or OS permission behavior was tested.

## Owned changed paths

These are this worker's additions or scoped edits. Several files already had unrelated dirty edits, particularly application, preload and API declarations. The full HEAD diff is not this worker's patch. The accepted foundations and existing renewal work were already present.

- `electron/backend/application.mjs`
- `electron/backend/service.mjs`
- `electron/backend/native-bridge.mjs`
- `electron/backend/paths.mjs`
- `electron/backend/desktop-authority.mjs`, new
- `electron/main.mjs`
- `electron/preload.cjs`
- `electron/runtime/codex-runtime.mjs`
- `electron/runtime/voice-session.mjs`
- `electron/runtime/voice-application.mjs`, new
- `electron/runtime/voice-protocol.mjs`, new
- `electron/runtime/preview-files.mjs`
- `electron/git/worktrees.mjs`
- `electron/workflows/workflow-node-executors.mjs`
- `electron/workflows/workflow-skill-node.mjs`
- `electron/native/helper-client.mjs`
- `electron/native/desktop-permissions.mjs`, new
- `electron/connect/application-protocol.mjs`
- `electron-builder.config.cjs`
- `src/pixice-api.d.ts`
- `src/voice/controller.js`
- `src/voice/client.d.ts`, new
- `src/voice/settings.d.ts`, new
- `tests/voice-application.test.js`, new
- `tests/voice-native-security.test.js`, new
- `tests/voice-runtime-transport.test.js`, new
- `tests/voice-session.test.js`
- `tests/voice-controller.test.js`
- `tests/app.test.jsx`, only the authorized renewal fixture regression
- `work/voice-integration/vitest.config.mjs`, new
- `work/voice-integration/HANDOFF.md`, new
- `work/voice-integration/verification.json`, new
- `work/voice-integration/protocol-verification.json`, new
- `work/voice-integration/review-fixes.json`, new

Additional service, native bridge/helper, permission/configuration, protocol, private bootstrap, file/workflow/Git boundaries and focused test scope was announced before edits. Source edits used apply_patch only. No edits to unrelated Connect protocol/server, provider registry, persistence, Focus supervisor/visuals/projection or App.jsx changes were made by this worker. The pre-existing tests/app.test.jsx edits remain; this worker added only the scoped renewal fixture/readiness correction.

## Remaining review and separate work

Independent review should assess ownership/privacy, actual admission/lifecycle paths, pinned protocol handling and conservative failure cleanup before acceptance.

Final visual design, settings UI and product entry points remain unapproved and outside this outcome. A separately authorized user-started live test must establish account entitlement, OS microphone permission, native negotiation/version/default voice, WebRTC connection, speaker output, ephemeral captions and explicit stop/disconnect behavior. No real provider voice, turn or coordinator rotation, microphone recording, billed API connection, production DB operation, install/relaunch, commit or push occurred here.
