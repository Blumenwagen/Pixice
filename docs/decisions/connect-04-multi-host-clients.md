# Connect 04: clients that use several hosts

Status: Implemented; automated and Preview verification complete.

This decision records the accepted multi-host behavior and current handoff boundaries. Implementation, automated checks, and Preview verification are complete. Physical-device and release validation remain deferred.

This decision extends Connect 02 and Connect 03. A client can keep one environment open while running a thread on another paired device. The environment dropdown remains available throughout Pixice, including while a host is unavailable.

## Workspace and execution

The environment selection determines the project catalog, settings, Board, and Workflows the user browses. A new thread has a separate execution target. The user chooses the target host and a project from that host's catalog before submitting. Pixice shows the target project's folder path. Matching project names or paths do not establish shared identity, and Connect does not synchronize project files.

A thread's execution target stays fixed after creation. A linked thread records its origin host and project, execution host and project, and the provider's thread ID. Cached names help identify an offline host. The link contains no credentials.

Every operation inside that thread uses its execution host. This includes follow-ups, interruptions, approvals, questions, model selection, receipts, file reads and writes, browser interaction, Instruments, and thread-related previews. A missing or forgotten host must never redirect an operation to the local host.

The origin project's task list retains the link across refreshes and reloads. Client storage uses host-qualified workspace keys. Browser tabs keep their environment selection independently. Drafts, request IDs, and preview IDs must not collide when two hosts return the same raw IDs.

## Connection recovery

An authenticated session response reports the host identity, backend generation, allowed operations, transfer limits, and supported transports. Public discovery remains small. A backend generation mismatch has a separate error from expired or revoked credentials.

Each command has a client-retained ID. After a lost response, a read-only lookup can report pending, completed, failed, or unknown. Unknown remains a valid result after a restart or expiry of retained outcomes. Clients do not resend uncertain commands automatically. Intervention cache writes require an open client, the same backend instance, the same attention revision, and the latest read sequence.

Unauthenticated requests and authenticated devices have separate request budgets. Polling and ordinary reads must leave capacity for answering requests and interrupting work. Long polling remains supported for proxies that cannot carry SSE.

## Phone clients and notifications

The installable web app may cache its static shell and unsent drafts. It does not cache authenticated API responses as an offline execution source. Opening an attention item fetches its current state before a response can be sent.

Push is optional and begins with a user action on the receiving device. Notifications use generic text and an opaque host, project, and thread reference. They do not include prompts, file contents, paths, or approval details. Subscription credentials remain on the host and are bound to the paired device and receiving client origin. Separate host subscriptions must not replace one another.

A cross-host overview uses bounded reads, without opening an event stream for every saved host. It reports the last successful contact and preserves visible partial failures. Cached status is labeled as last known.

## Files and remote browser

Before sending an inline attachment request, the client checks its encoded total size. Larger transfers use bounded staging associated with the paired device and project. Upload identifiers do not grant access to arbitrary paths. Cancellation, revocation, size limits, and expiry apply during transfer. Resuming bytes does not submit a thread or turn.

Artifact downloads resolve within the selected project's permitted roots and require current device authorization. Remote browser controls retain frame freshness checks. Zoom changes display scale; pointer coordinates still address the host frame. A stale image may remain visible, but it cannot accept input.

## Limited access

Existing paired operators retain their established permissions. Observer pairing has an explicit project allowlist and permits only supported reads. The host enforces this boundary on calls, returned collections, event streams, outcome lookups, files, and notifications. Browser sessions and execution controls are unavailable to observers.

Events whose project cannot be established are withheld from a restricted device. Filtered events must preserve transport sequencing without revealing their contents. UI capability checks explain unavailable actions, but the host remains responsible for authorization.

## Acceptance evidence

The focused installed Vitest command was `/Users/blumenwagen/Developer/Loom/node_modules/.bin/vitest run tests/connect-client-request-cache.test.js tests/connect-client.test.jsx tests/connect-recovery.test.js tests/connect-live-protocol.test.js tests/connect-request-generation-ui.test.jsx --maxWorkers=4`, run under an external Python watchdog with `start_new_session=True`, a 120-second deadline, and timeout cleanup limited to the owned test process group. It ran from `2026-09-12T15:30:52.828778+00:00` to `2026-09-12T15:30:57.014659+00:00`, took 4.186 seconds, exited 0, and did not time out. It covered 5 test files and 56 tests, all passing.

The final installed Vitest command was `/Users/blumenwagen/Developer/Loom/node_modules/.bin/vitest run --maxWorkers=4`, run under an external Python watchdog with `start_new_session=True`, a 300-second deadline, and timeout cleanup limited to the owned test process group. It ran from `2026-09-12T15:31:26.376240+00:00` to `2026-09-12T15:32:12.705185+00:00`, took 46.328 seconds, exited 0, and did not time out. It covered 130 test files and 915 tests, all passing. Four workers were used.

The protocol suites passed: Connect server 17, recovery 17, security 6, file transfers 10, live protocol 6, and client request cache 6. These suites exercise temporary local `ConnectServer` HTTP/SSE and authorization paths, with `ApplicationClient` coverage where applicable. Renderer tests use test doubles, and browser-fixture tests use synthetic callbacks. The remote browser UI suite passed 19 tests and the local browser callback fixture passed 1.

The Preview review verified origin This device/Loom while running on Beacon and explicit Beacon mobile, a 37-byte attachment loss and resume with zero mutations before one explicit Send, origin preservation and untouched-draft clearing on close, observer Board 2/files 4/conversation/receipt and generated-file persistence through two manual refreshes, bounded cold/offline overview reads with Last known labeling, observer-to-operator task navigation and restoration, stale remote-frame input blocking, and the local Preview callback fixture. On Beacon project-b it also verified approval generation 1 was replaced by generation 2 before one Approve. A question with generation1 was replaced by generation2 before the user selected Safe path once; the current question then cleared without error. A fresh remote browser frame, text entry and clearing, and Pause/Resume state also passed manual Preview checks. Native helper behavior remains fixture-only.

The Sites chain passed with `/Users/blumenwagen/Developer/Loom/node_modules/.bin/vite build --mode sites`, `node scripts/prepare-sites-build.mjs`, and `node --test tests/sites-worker.test.mjs`. The commands ran sequentially under a real 300-second Python watchdog from `2026-09-12T15:32:54.065521+00:00` to `2026-09-12T15:32:56.571713+00:00`, took 2.506 seconds, exited 0, and did not time out. The worker reported 5 passed, 0 failed, 0 skipped. The desktop chain passed with `/Users/blumenwagen/Developer/Loom/node_modules/.bin/vite build --mode desktop` and `node scripts/verify-desktop-renderer.cjs`. It ran sequentially under a real 300-second Python watchdog from `2026-09-12T15:33:20.541070+00:00` to `2026-09-12T15:33:22.869821+00:00`, took 2.329 seconds, exited 0, and did not time out. The verifier confirmed `dist/client/index.html`.

The one allowed Impeccable detector pass remains recorded at `/tmp/pixice-connect-detector.json` with result `[]`; it was not rerun during this confirmation. `git diff --check` passed.

Logs are `/tmp/pixice-connect-cache-focused-tests.log`, `/tmp/pixice-connect-cache-focused-tests-progress.log`, `/tmp/pixice-connect-cache-confirmation-tests.log`, `/tmp/pixice-connect-cache-confirmation-tests-progress.log`, `/tmp/pixice-connect-cache-confirmation-sites.log`, `/tmp/pixice-connect-cache-confirmation-sites-progress.log`, `/tmp/pixice-connect-cache-confirmation-desktop.log`, and `/tmp/pixice-connect-cache-confirmation-desktop-progress.log`. Real-phone installation, suspension, Web Push delivery, network switching, and real native browser-helper behavior remain unverified. No performance measurements were recorded. Physical-phone follow-up is tracked as Board task `d819ae88-f1e3-4a61-b69d-637eb949ef55`.
