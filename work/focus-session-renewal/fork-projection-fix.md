# Fork projection fix

This documents the earlier 198-test exact-copy fix. Its failure-path reservation/disposition behavior is superseded by [fork-failure-fix.md](fork-failure-fix.md), which addresses the final review's two P2 findings and records the latest verification.

Same outcome `36115ebb-f615-42db-9960-977fba34dfee` and worker thread `01a0eefb-ab97-7220-89e1-7219ff7969a6`. Read the full [follow-up independent review](independent-review-followup.md). Current directions r5 and r1 were reread; r5 was acknowledged again. This handoff addresses the remaining P2 only. Coordinator review and acceptance remain pending.

`threads:fork` now records trusted copied-message proof before publishing its response or copied-history events. Forks remain independent conversations with their existing source link, name, completed-answer boundary and goal-continuation behavior. No Focus Fork button was added or assumed.

## Proof and projection

The backend reads the provider source and validates the selected completed final answer. It enumerates proven leading internal insertions only inside that source prefix. The returned copy must match the protected source message's exact content at the corresponding turn and user-message position. Provider-remapped turn/item IDs are supported; summary-only fork responses are hydrated with `thread/read` before validation.

Two SQLite tables persist the host-validated copy manifest and proof. Each record binds the destination thread, turn and item to the complete copied-message hash, exact inserted-context hash and original project generation. Only IDs and hashes are stored, not duplicated private briefs. The manifest and proof rows commit together. A fork of a fork can inherit only source messages which still satisfy that recorded proof. It does not inherit the source's thread-wide fingerprint set.

Reads, fork responses, transport events and history indexing use the same proof predicate. They strip one leading insertion, either a separate text part or a context prefix joined to authored text by a newline. The rest of the message remains intact. Exact pasted prior briefs and fresh tail messages remain visible and searchable. Raw provider `focusOriginThreadId` metadata is ignored for proof; the backend explicitly supplies trusted origin resolution when rendering registered generation history. Strict API parsing rejects caller-provided provenance fields.

A provider can announce copied history before returning its new thread ID. A temporary reservation holds matching copied-message events until proof is persisted, then releases them through normal projection. An unverifiable copy fails explicitly and its queued candidate history is withheld. These reservations do not start turns or workers. Project ownership comes from registered generation/copy membership before folder matching, including overlapping project folders.

## Changed paths in this continuation

- [application.mjs](../../electron/backend/application.mjs): fork validation/publication, early copied-event handling, shared proof predicate and authoritative project routing.
- [database.mjs](../../electron/persistence/database.mjs): persistent copy manifest, message-bound proof, validated source-prefix inheritance and projected fork history indexing.
- [renderer-thread-projection.mjs](../../electron/runtime/renderer-thread-projection.mjs): pass trusted turn/item identity to the proof predicate and accept an explicit host origin resolver.
- [focus-session-renewal.test.js](../../tests/focus-session-renewal.test.js): six additional fixture executions covering this defect.
- This report, plan, result and verification logs under `work/focus-session-renewal`.

No voice/prototype source or UI code was changed in this continuation. Existing unrelated dirty work was preserved.

## Verification

The new tests use disposable databases, fake providers and the real backend service/ApplicationClient. They verify current and retired generation forks, fork-of-fork inheritance, remapped IDs, summary-response hydration, fork response/read/live announcement/item update, history search and persisted proof read through a reopened database connection. They also cover exact prior-brief pastes, separated/coalesced layouts, earlier-answer boundaries, fresh user tails, overlapping project ownership, caller/provider metadata spoof attempts and rejection of changed copies.

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-fork-fixes-build
git diff --check
```

Final results are **29 + 126 + 43 = 198 distinct passing tests**, with 142 unrelated UI tests skipped. This adds six fork fixture executions and includes nine existing fork UI checks beyond the previously reviewed 183 tests. Repeated runs are not added to the count. Passing logs are saved in [verification](verification). Ten JavaScript modules passed individual `node --check` calls. Vite build passed with the existing mixed static/dynamic App import and large chunk warnings. The UI tests reported an existing Motion opacity warning.

## Remaining limits

The proof covers exact copied content in the supported layouts. Arbitrary provider transcript rewriting is not established; changed copies reject instead of gaining broad fingerprint authority. Existing legacy forks without host-recorded proof do not gain inferred provenance from markers or provider metadata. No live-provider fork or turn was run.

Production voice registration and combined lifecycle verification remain a separate coordinator integration step after both foundations are reviewed. Final voice UI selection remains pending. This work makes no new empirical claim about delegation drift or the origin of the generic no-proactive instruction. No live/development coordinator was rotated, production database used as a fixture, nested worker spawned, media used, or commit/push/install/relaunch performed. `complete_work` was not called.
