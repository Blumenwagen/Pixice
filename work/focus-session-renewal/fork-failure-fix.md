# Fork failure-path fix

Historical snapshot. The provider-wide unresolved reservation described here is superseded by [direction r11 and the protected fork gate](fork-gate-fix.md). It is not the current shipping policy.

Same outcome `36115ebb-f615-42db-9960-977fba34dfee` and worker thread `01a0eefb-ab97-7220-89e1-7219ff7969a6`. Read the full [final fork review](independent-review-fork-final.md). Directions r5 and r1 were reread, and r5 was acknowledged again. This continuation addresses its two failure-path P2 findings. The verified renewal foundation and successful exact-copy projection remain intact. Acceptance and `complete_work` belong to the coordinator.

| Review finding | Change and evidence |
| --- | --- |
| Rejected changed copies remain readable/listed and emit context later | A durable candidate disposition gates publication from first observed identity. The authoritative fork response confirms its identity before copy validation. A rejected candidate becomes `failed`. Reads fail explicitly; live/offline lists, summaries, normal snapshot access, overview records, events and search exclude it. The regression exercises the rejected copy, subsequent read/list/item and thread events, snapshot writes, then a full fixture service shutdown/restart and the same checks again. Raw provider data remains recoverable. |
| Content reservation consumes an unrelated exact-paste event when fork fails without an ID | Removed the application's content/item-ID reservation. Known existing thread identities bypass provider publication holding regardless of their text. The exact-paste regression asserts delivery during the pending failed RPC, before releasing that request, unchanged and exactly once. It also checks a later event and ordinary read. Unknown identities follow the explicit policy below; confirmed independent creation responses release their events. |

## Candidate disposition and recovery

The database records candidate identity, operation, provider, source project/thread and disposition. Pending candidates are protected before validation. Copy proof, copy manifest and removal of the pending disposition commit together. Failed candidates retain their disposition across process restart. A normal read or resume cannot clear it, and provider-origin metadata does not grant authority. Strict renderer/Connect arguments still cannot supply copy proof or publication tokens.

Provider snapshots remain stored without rewriting their content. Normal `getProviderThreadSnapshot` and summary/list methods exclude quarantined identities. The separate internal `getProviderThreadSnapshotForDiagnosis` accessor returns the preserved raw snapshot; it is not exposed through an IPC/Connect endpoint. The provider session itself is not archived or deleted. A failed candidate cannot start or steer ordinary turns through the provider boundary.

The application retains an additional publication check for directly supplied runtime payloads and rejects candidate reads before normal task observation. Search removes stale entries at quarantine admission, excludes dispositions in both FTS and fallback queries, and skips indexing subsequent candidate snapshots. Successful fork lists use the existing trusted projection.

## Early identity policy and protocol evidence

Pixice's current shared provider notification path supplies thread identities without a trusted association to the pending creation RPC. [CodexProvider](../../electron/providers/codex-provider.mjs) forwards native notifications and [CodexRuntime](../../electron/runtime/codex-runtime.mjs) normalizes notification callbacks separately from JSONL RPC replies. [ClaudeProvider](../../electron/providers/claude-provider.mjs) emits `thread/started` before returning its fork result. This inspection establishes the limitation of the path currently used by Pixice; no live protocol capability probe was run.

The implementation therefore uses an explicit conservative policy, not text resemblance:

- A protected Focus fork saves the identities already known to its provider, including ephemeral host-owned threads. Their events continue immediately, independent of message content.
- Previously unrecognized identities observed in notifications, list results or thread requests during that fork are temporarily quarantined as `uncorrelated`. They are not assumed to be the fork's authoritative target.
- The host's fork response identifies its actual candidate. Exact-copy proof must validate before its history is released. Queued identities different from that returned candidate are released as unrelated even if validation fails. A separate trusted start or ordinary fork response also identifies its own independent creation and releases that identity's events.
- If the protected fork fails without returning an authoritative target, a durable `unresolved` operation retains the known-identity set. A late notification or list result cannot expose an unannounced candidate after failure or restart. Existing known threads remain unaffected, and independently confirmed new creations remain usable. Another protected Focus fork fails explicitly until this ambiguity is diagnosed.

The last rule also applies to a pending operation left by a process interruption. It avoids guessing that an unknown late session is safe. Error messages and runtime diagnostics state this policy. No automatic inference, deletion or unquarantine operation was added. Diagnosing and resolving an ambiguous provider operation remains an operator/coordinator step; no user-facing recovery control was added in this narrow continuation.

Each operation holds at most **64 events and 512 KiB of serialized event data**. Overflow rejects its candidate explicitly. A failed operation retains at most that bounded queue while independent creation responses can still resolve unrelated identities. Publication tokens stay inside the host's registry and are never sent to the provider or accepted from the client.

## Changed paths

- [application.mjs](../../electron/backend/application.mjs): remove content reservations, run protected forks inside the registry publication boundary, reject quarantined reads, and project successful fork listings.
- [provider-registry.mjs](../../electron/providers/provider-registry.mjs): identity-based publication, persisted unresolved-operation handling, bounded queues, trusted independent creation release and explicit candidate errors.
- [database.mjs](../../electron/persistence/database.mjs): candidate/operation/known-identity records, atomic proof admission, protected read/list/search/overview access and a raw diagnosis accessor.
- [focus-session-renewal.test.js](../../tests/focus-session-renewal.test.js): extend the rejected-copy regression and add eight failure/publication fixture executions.
- Plan, result and verification artifacts under `work/focus-session-renewal`.

No voice/prototype files, final UI or core renewal implementation were changed in this continuation. Existing unrelated dirty work was preserved.

## Verification

All service regressions use disposable databases and fake providers with the real application handlers, ApplicationClient and transport. Besides both exact review reproductions, they cover a pre-response creation failure with an early candidate notification, a concurrent list discovering an unidentified candidate, a late unannounced candidate after restart, persisted known-thread paste delivery after restart, accepted copied events emitted during naming, independent creation event release, and count/byte queue bounds. Previous successful current/retired forks, remapped IDs, forks of forks, pasted briefs, project isolation, source linkage and independent-thread behavior still pass.

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/codex-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-fork-failure-build
git diff --check
```

Final current-tree runs passed **37 + 132 + 43 = 212 distinct tests**, with 142 unrelated UI tests skipped. The 132 includes six existing Codex adapter tests added to the previous 126-test command. Eight new fixture executions extend the previous 29 context/session tests to 37. Repeated runs are not counted again. The final UI command ran alone and passed on its first run in this continuation.

The independent review's earlier 198-test verification was not clean initially: its first UI run passed 42 and timed out in one existing authority-renewal test, then its complete filtered rerun passed all 43 without source changes. That historical result remains recorded in the review. In this continuation, one early new fixture attempted the unsupported `threads.start` operation; correcting it to the actual `threads.create` API resolved that fixture error before the final runs.

Vite build passed with the existing mixed static/dynamic App import and large chunk warnings. UI tests reported the existing Motion opacity warning. Eleven JavaScript modules passed individual `node --check` calls. Diff check passed. Final outputs are saved as `fork-failure-*` files under [verification](verification).

## Remaining limits

Uncorrelated provider identities are deliberately quarantined until an authoritative independent response or diagnosis resolves them. The failed-before-ID guard can affect previously unrecognized external sessions from that provider; it does not compare their contents or silently grant them fork provenance. No automatic recovery UI/API was added. Queue overflow is an explicit compatibility rejection, not a claim that arbitrarily large early transcripts can be buffered.

Copy proof still covers exact supported copied layouts, not arbitrary provider transcript rewriting. Legacy forks without recorded proof continue to receive no inferred authority, subject to the explicit unresolved-operation identity guard. Production voice registration and combined lifecycle verification remain separate. No empirical claim about delegation drift is added.

No live provider fork/turn, live/development coordinator rotation, production database fixture, media, nested worker, commit, push, installation or relaunch occurred. `complete_work` was not called.
