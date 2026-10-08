# Protected fork gate, direction r11

Work `36115ebb-f615-42db-9960-977fba34dfee` remains in its existing thread. Read the full [failure review](independent-review-fork-failure.md), current work and scoped directions r11, r5 and r1. Acknowledged revision 11. This is evidence for coordinator review; this worker does not accept the outcome or call `complete_work`.

## Current behavior

The application builds the existing trusted copied-message plan for the selected answer boundary. If it contains any proven internal Focus insertion, the provider registry rejects before `thread/fork`. Both current adapters are gated. This covers current and retired Focus generations, recorded protected copies and copies of copies. The error names the provider, explains the unsupported operation, states that no fork was created, and suggests continuing Focus, renewing with `/new`, or creating a normal task with the visible request.

This is a deliberate limitation. Codex forwards native `thread/fork` and receives its identity through the successful response; notifications do not establish creation-request correlation on failure. Claude receives the native session ID only after `sessionFork` returns, then hydrates/maps the copy before returning its host ID. Neither adapter has an established failure-identity guarantee. No positive capability flag, mock success or provider security override claims otherwise. A future protected-fork implementation needs a verified creation/failure identity contract before lifting this gate.

Ordinary forks remain native operations. A Focus answer boundary whose copied prefix contains no protected insertion also remains supported, even if later turns contain internal context. Exact user-authored pasted briefs do not gain protection through content resemblance. Ordinary forks preserve naming, source linkage, independent parent semantics and continued user turns on both fixture adapters. `/new` and the verified renewal implementation were not edited.

## Removed broad holding

Removed active/unresolved provider reservations, identity/known/overflow sets, content-independent unknown-identity admission, event queues and release logic. Removed the database methods that created operations, expanded candidate quarantine and automatically cleared uncorrelated identities. A failed unsupported attempt creates no operation, known-thread or quarantine row, and issues zero native fork calls.

Existing candidate rows still gate reads, live/offline lists, summaries, snapshots, overview, events and search by their exact recorded ID. A normal creation response cannot clear those rows. Raw snapshots remain accessible through the existing internal diagnosis accessor; provider sessions are retained. Exact copied-message manifests and proof are unchanged for already recorded successful copies. Their fixture setup does not imply current native protected forks are supported.

Legacy operation/known-thread tables and existing rows are retained without migration or deletion. Operation metadata is inert and does not capture new identities after restart. Existing failed, pending or unresolved candidate rows are not released. No inference from text, folders, time or provider resemblance decides candidate authority. No recovery UI or product was added.

## Regression evidence

All service tests use real application handlers, ApplicationClient and transport with disposable storage and fixture providers. Covered behavior includes:

- Both adapters reject current, retired, inherited and second-generation protected copies before a spy for the failing native creation method can execute. No operation/quarantine rows exist before or after service restart.
- Existing, newly host-created and previously unknown external sessions across projects A/B and Codex/Claude remain listed, readable and event-visible. Their exact pasted Focus text arrives unchanged and once. External Codex reads and provider-list discovery of unbound Claude IDs are both exercised.
- A historical unresolved project-A operation and candidate are seeded directly into disposable storage. After restart the records remain unchanged and the candidate stays protected. A previously unknown external project-B announcement, list and read remain usable without expanding the old incident.
- A historical failed changed-copy candidate stays excluded from read/list/summary/overview/snapshot/events/search after restart. Raw diagnosis content survives and copy-proof registration cannot release it.
- Recorded exact/remapped/coalesced copies, project isolation, caller spoof rejection, forks of recorded copies, fresh tails, pasted briefs, events and reopened search retain message-bound proof.
- Ordinary native forks on both providers and a Focus prefix with no protected insertion remain usable. Existing renewal, Stop, questions, reviews, permissions and `/new` regressions still pass.

Final commands and saved outputs:

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/codex-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-fork-gate-build
```

Results are **36 + 132 + 43 = 211 distinct passing tests**, with 142 unrelated UI tests skipped. The session suite has 31 tests and the context suite has five. Superseded reservation-behavior tests were replaced with pre-execution gate regressions, so the prior 212-test snapshot is not the current count. [Context/session log](fork-gate-context-session.log), [runtime log](fork-gate-runtime.log), [UI log](fork-gate-ui.log) and [build log](fork-gate-build.log) preserve final output. Eleven implementation modules and the regression file passed `node --check`; `git diff --check` passed. Build warnings about mixed App imports and large chunks, and the UI Motion opacity warning, remain.

One intermediate fixture run failed because its fake provider compared a noncanonical temporary path with the project's canonical folder. Correcting the fixture path resolved it; the final 36-test run passed. The final UI command passed on its first run in this continuation. The historical independent 198-test review had one initial UI timeout followed by a complete 43-test passing rerun without source changes. The subsequent failure review passed 212 tests on first attempts. Earlier initial audit count remains 157, not 158. Repeated tests are not counted twice.

## Changed paths and scope

- [application.mjs](../../electron/backend/application.mjs): pre-execution gate using the selected boundary's trusted proof; ordinary fork flow remains.
- [provider-registry.mjs](../../electron/providers/provider-registry.mjs): unsupported protected-fork error; remove provider-wide holding; retain exact candidate exclusion.
- [database.mjs](../../electron/persistence/database.mjs): remove broad admission/release writers; preserve legacy rows and exact proof structures; disallow proof registration from releasing an existing candidate.
- [focus-session-renewal.test.js](../../tests/focus-session-renewal.test.js): isolated gate, cross-project/provider/restart, legacy record protection, ordinary fork and retained proof regressions.
- This handoff, [result](result.md), [plan](plan.md) and final verification logs.

No voice/prototype file or core renewal source was edited in this continuation. The other dirty files belong to earlier authorized implementation or concurrent work and were preserved.

## Installation and remaining limits

Checked the implementation handoffs and all independent review artifacts against the current fixture configuration. They consistently report disposable databases, fake providers, no real-provider fork/turn, and no application installation/relaunch. Current checks use explicit temporary data directories and build outside the project; no package/install command was run. There is no unexpected production impact in this evidence. This is an artifact-based verification, not an examination or mutation of the user's production database. No destructive data migration was performed.

Protected native forks remain unsupported until a trustworthy provider identity contract is established. Historical unverified candidates stay protected without a new recovery product. Production voice hookup remains a separate coordinator integration step after both foundations are reviewed. Real-provider delegation drift and role retention remain unproven by these fixtures. No live provider/rotation/media, nested worker, commit, push, install or relaunch occurred. Acceptance stays coordinator-only.
