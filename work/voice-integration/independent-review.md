# Independent review of native voice integration

Review work `dfb5f327-bcad-45d5-aafe-bb30825c38dc`, reviewing outcome `74b6938b-8f0c-40a7-97b5-bc4775e6f533`. Reviewed 2026-09-30 in the existing thread. Direction r1 acknowledged. Full-access runtime; no permission failures, delegation or implementation edits.

Recommendation: **request changes before accepting the integration**. The submitted 228 tests pass, but an independent real-service fixture reproduced a bypass of desktop voice ownership. A second probe and version-matched Electron source inspection found an inconsistent speaker-selection permission boundary. Fixture acceptance would still not approve final UI or establish live entitlement/media.

## Findings requiring correction

### P1: An ordinary local API client can acquire desktop voice authority

Relevant paths: [native-bridge.mjs:20](/Users/blumenwagen/Developer/Loom/electron/backend/native-bridge.mjs:20), [native-bridge.mjs:64](/Users/blumenwagen/Developer/Loom/electron/backend/native-bridge.mjs:64), [service.mjs:166](/Users/blumenwagen/Developer/Loom/electron/backend/service.mjs:166), [service.mjs:173](/Users/blumenwagen/Developer/Loom/electron/backend/service.mjs:173).

`service.status` exposes the registered helper's `clientId`. `native.register` accepts that same public ID and returns the existing `leaseId`, without proving possession of a helper-only credential. The new `native.voiceAttach` accepts that lease and mints a voice owner. `native.voiceCall` converts this into the trusted application context. The Electron sender/frame/origin checks in `main.mjs` are therefore bypassable through the ordinary authenticated local API.

I reproduced this with actual `startService`, `ApplicationClient`, native bridge and application handlers, fake providers/native responses, and a disposable database. No Electron window or sender participated. After registering a fixture helper, the client read its ID from service status, registered with that ID, prepared and started voice, and polled a fake private SDP answer. All temporary service data was deleted.

```text
public clientId permits reacquiring existing helper lease: true
ordinary local client without Electron sender prepared voice: true
ordinary local client received private SDP: true
native registration response cached: true
```

Reproduction: `node /tmp/pixice-voice-independent-probe.mjs`, retained at [probe](/tmp/pixice-voice-independent-probe.mjs), with [output](/tmp/voice-review-probe.log). It uses only local fixture credentials and fake SDP. This is a same-OS-user authenticated-client boundary violation, not a demonstrated unauthenticated or remote Connect exploit. It matters because the requested boundary explicitly excludes CLI voice and requires actual local renderer ownership. With no helper registered, ordinary local registration also needs no desktop proof.

The submitted negative test rejects direct `voice.prepare` and guessed leases; it does not test obtaining a legitimate lease through registration. `native.register` also remains a cached mutation, retaining the now voice-authorizing lease in the in-memory command recovery records. I did not find or claim disk persistence of this result cache.

Required correction: establish a helper/desktop authority that ordinary local RPC registration cannot mint or recover from a public client ID. Bind voice ownership to that authority, retain the Electron sender checks, and exclude authority-bearing responses from recovery caches. Add service-level negative coverage for an ordinary local client both with and without an existing helper. A capability restriction only on direct `voice.*` calls is insufficient.

### P2: Speaker-selection permission checks grant access without checking ownership

Relevant path: [desktop-permissions.mjs:21](/Users/blumenwagen/Developer/Loom/electron/native/desktop-permissions.mjs:21).

The check handler returns `true` for everything except `media`, including `speaker-selection`. The request handler applies the trusted-window check to speaker selection, but permission checks themselves can establish granted status. A direct invocation of the installed callbacks using foreign contents and `https://foreign.invalid` returned:

```text
foreign speaker-selection check: true
foreign speaker-selection request: false
```

Installed Electron 38.7.2 declarations at `node_modules/electron/electron.d.ts:12734` explain that checks may precede requests and that a request may follow a denied check. The check-handler string union omits speaker selection, so declarations alone do not resolve this case. Version-matched [Electron permission-manager source](https://github.com/electron/electron/blob/v38.7.2/shell/browser/electron_permission_manager.cc#L368) routes current-document permission status through the check handler and turns true into granted. Its [permission converter](https://github.com/electron/electron/blob/v38.7.2/shell/common/gin_converters/content_converter.cc#L221) maps `SPEAKER_SELECTION` to `speaker-selection`.

The request handler therefore cannot be relied on as the only boundary. Apply trusted contents/frame/origin checks to speaker selection in both callbacks and test both. The executed evidence is callback behavior plus matching Electron source, not a live speaker/device-selection test. No Electron launch, OS prompt or media access occurred.

## Other observations and limits

### Read classification, admission and shutdown

The `APPLICATION_READ_OPERATIONS` additions in [application-protocol.mjs:27](/Users/blumenwagen/Developer/Loom/electron/connect/application-protocol.mjs:27) avoid voice command result caching. In `server.mjs:871`, authentication, allowed-operation/project checks, instance identity, request age and payload limits still run before the read branch. The classification also selects the read rate budget and throttled audit path; it is not solely a cache flag. Remote Connect has a separate operation map without voice/native-owner operations.

`native.voiceCall` still invokes `ApplicationRegistry`; a closed registry rejects all operations. Voice `stopAll` synchronously disables starts before awaiting cleanup. The actual service shutdown paths call it before draining the registry; the executed shutdown-failure regression checks that failed cleanup restores dispatch while retaining the renewal guard. I found no demonstrated shutdown bypass caused by the read classification itself. Cleanup polls/detach remain callable through the control registry by design.

One narrower inconsistency was reproduced: after an existing preparation, calling `application.freeze(true)` alone does not reject `voice.start`; the probe recorded one native start. `freeze` changes application text/workflow admission, whereas the voice module has its own accepting flag. Prepare is blocked by the shared application gate, but start/appends are not. The real shutdown path additionally calls `stopAll`, so this standalone host-API probe is not proof of a production shutdown race. Document or unify this contract before reusing freeze as a general admission barrier. The ownership finding above is independent of this observation.

### Process-wide loss of stderr diagnostics

[codex-runtime.mjs:110](/Users/blumenwagen/Developer/Loom/electron/runtime/codex-runtime.mjs:110) suppresses every child stderr chunk after the first attempted realtime start. Successful stop does not restore it; only a new process resets the flag. This includes unrelated later text, tool and provider diagnostic output across projects sharing that process. Structured events, status and explicit application-generated diagnostics still flow.

This is a broad, documented privacy-versus-diagnosability tradeoff, not proof that all voice data is private. It prevents this particular raw-stderr forwarding path from leaking late negotiation data, at the cost of losing useful text diagnostics for the rest of the process lifetime. The in-memory transport regression passed and tests late stderr suppression. No measured production diagnostic impact or upstream logging guarantee was established. A future structured diagnostic policy would need independent evidence before restoring raw output.

### Existing renewal UI test is reproducibly intermittent

The first complete filtered UI group passed all 44 selected tests. I then ran the exact test `follows authoritative Focus renewal while retaining the project draft and work rail` five times, unchanged. Run 1 failed with zero `turns.start` calls at `tests/app.test.jsx:1855`; runs 2 through 5 passed. See `/tmp/voice-review-renewal-1.log` through `-5.log`.

The test waits for an ensure-call count and retained draft, then clicks Send without explicitly waiting for composer readiness. `App.jsx:4980` disables the composer while loading; `loadFocusSession` has asynchronous loading state. This supports a fixture-readiness hypothesis, but I did not instrument the button at the failed click and have not established the cause. It is a test reliability concern, not a confirmed voice product defect, and should not be dismissed on the strength of a passing rerun. Neither App nor its test was edited in this review.

## Verified implementation behavior

Read the integration handoff, verification files, accepted voice handoff, renewal integration/result/fork-review artifacts, all `src/voice` modules and declarations, the bridge/application/protocol/permission modules, and the relevant actual service/helper/main/runtime/preload/application changes and tests. No applicable AGENTS.md or CLAUDE.md was found in project ancestors or affected source directories. Existing unrelated dirty changes remain; the whole HEAD diff is not the integration author's patch.

The production application installs its guard before publishing voice handlers and uses the existing `codexRuntime`, not a newly authenticated provider process. Prepare uses the same project gate as Focus renewal. Direct scope resolution checks persisted binding, current Focus identity, project authority and excluded fork candidates without reacquiring that gate. All public handle operations recheck scope, owner binding and handle. The executed tests cover stale generations, foreign handles, Claude, unknown provider ownership, active text turns, both renewal paths and metadata/renewal ordering.

Reservation expiration, starting/stopping guards, failed native stop and disconnect handling have passing fixtures. Owner disconnect cancels pending preparation and stops existing sessions. Failed teardown keeps rollover blocked. Project deletion stops before removing data; failed deletion preserves data. Account events and provider lifecycle wrappers stop voice. The shutdown retry fixture checks one attempted stop, restored service admission and later explicit cleanup. These guarantees depend on correcting the owner authentication finding.

Realtime notifications are separated from generic provider events in `CodexRuntime`. Service publication rejects voice/realtime envelopes. The bounded private mailbox is lease-scoped, cleared on detach and not replayed to replacement owners. Executed fixtures cover early SDP with an empty native response, foreign project/thread events, helper loss, mailbox overflow, and absence of fake SDP/transcripts in generic local/remote event arrays, provider snapshots and voice command caches. The P1 probe shows that the mailbox's intended principal can currently be impersonated by a local API client. No live upstream persistence behavior was tested.

The eight preload methods match `VoiceApi`; the client adapter supplies filtered event subscriptions. The controller remains connecting after native `started` and becomes active only on WebRTC connection. Defaults remain voice null, microphone/output device empty strings, mute false, volume 1 and captions true. Dynamic catalogs and native defaults are retained; v3 explicit voice selection is rejected, and unsupported speed/VAD/personality controls are absent. Websocket audio is a low-level opaque backend contract, not an implemented automatic renderer fallback. No final settings screen or product voice entry point is included, as required. Declarations were inspected, not compiler-checked.

Audio-only trusted request, denied OS status and delayed-origin recheck fixtures passed without calling actual microphone APIs. The macOS microphone usage string describes local dictation versus Codex voice. Packaged behavior remains unverified.

## Independently executed checks

| Check | Result |
| --- | --- |
| `pnpm exec vitest run --config work/voice-integration/vitest.config.mjs` | 65 passed, 4 files |
| Submitted 12-file voice/runtime/provider/native/service/preload/Connect command | 119 passed, 12 files |
| Submitted Focus/questions/app/desktop filter `Focus\|slash\|commands\|fork\|desktop` | 44 passed, 142 skipped, 4 files |
| Exact renewal UI test, five extra isolated executions | 1 failed, 4 passed; not added to distinct count |
| `pnpm exec vite build --mode desktop --outDir /tmp/pixice-voice-independent-review-build` | Passed, 801 modules |
| `node --check` on 23 integration executable/module/test/config paths | All passed |
| `git diff --check` and integration JSON parsing | Passed |
| Actual `inspectVoiceProtocol` on `/Users/blumenwagen/.local/bin/codex` | Passed pinned 0.159.0 schemas/descriptors |
| Independent service ownership and freeze probe | Reproduced observations above |
| Independent speaker check/request callback probe | Reproduced inconsistent decisions above |

Total submitted tests rerun: **228 distinct passing tests in 20 files**, including the 41 current foundation tests preserving the original 37. This does not erase the additional intermittent UI failure. Full suite commands remain in [verification.json](verification.json). Independent outputs are `/tmp/voice-review-integration.log`, `/tmp/voice-review-regressions.log`, `/tmp/voice-review-ui.log` and `/tmp/voice-review-build.log`.

Warnings remained SQLite experimental support, Motion undefined opacity, mixed static/dynamic App imports, large Vite chunks and external build-directory handling. No TypeScript compiler or packaged Electron check ran.

The OpenAI Docs skill and official-docs route were read, and official documentation was searched and fetched. The [app-server documentation](https://developers.openai.com/codex/app-server) establishes experimental opt-in and executable-specific schema generation, but does not document this realtime contract or establish entitlement. I ran the actual metadata inspector, which generated a temporary experimental schema and validated pinned hashes, and the regression checked the accepted protocol artifact. This started no authenticated app-server session and performed no catalog/account/media request against a live provider.

Only this review artifact and disposable verification files were written. No implementation/final UI changes, live provider turns or rotations, microphone recording, billed connection, production database access, install/relaunch, commit or push occurred. No `complete_work` call was made. Coordinator review and acceptance remain outstanding.
