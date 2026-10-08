# Independent review fixes

Read the complete [independent-review.md](independent-review.md) before implementation. The same outcome and worker thread continue. Direction r5 was reread and acknowledged. Coordinator acceptance remains pending.

| Review defect | Change and concrete verification |
| --- | --- |
| P1 Instrument and bridge bypasses | Shared authority/admission checks reject retired inputs before provider start/resume/steer. Fixture Instrument start uses fresh managed role, bounded brief and full access. The stale Instrument reproduction now rejects. Fixture bridge completion starts the current generation with role/brief; late completion cannot start its retired parent or clear Stop. |
| P2 internal brief shown as chat | Persist exact context fingerprints, remove one proven leading insertion in backend renderer projection. Cover separated and coalesced text, live transport events, start responses, history snapshots and indexing. Preserve user-authored JSON markers and pasted prior briefs. Component regression renders compact worker notices and hides internal fixture memory. |
| P2 steering freshness and stale authority | Normal, Instrument, tray and bridge steering use current mutable briefs and validate the active turn and current generation. Active worker result delivery includes the latest memory and direction with zero `thread/resume` calls after the active turn starts. No active Claude query resume or disposal is introduced. |
| P2 serialized limit and omissions | Enforce final serialized length including escaping and prefix. Supported 6,000/2,000-character escaped memories renew successfully. Initial 13-record slices and database reads beyond 200 record accurate exclusions. Verify retained plus omitted counts for work, decisions, questions and events. |
| P2 unknown voice guard | Explicit `false` only. Undefined, null, zero, empty string, true and throwing guards block before creation. Unknown state after candidate creation vetoes publication. No live bridge activation. |
| Manual reset missing | Focus-owned `/new` in existing keyboard command picker calls generation API. Busy/voice/stale errors stay visible. No provider command is sent. Connect's real API facade renews, retains Stop/work, receives authority events and rejects stale CAS. |
| Historical unstaged visuals | Traverse project-registered generation snapshots, overwrite origin metadata from trusted membership, preserve original directory and origin. Select an old unstaged image after renewal; reject a foreign project message without changing saved visuals. |
| Missing session types | `FocusSession`, typed ensure/refresh/history and `focus.state.session`. No new session `any`. Declarations inspected; no installed TypeScript compiler. |

## Changed paths

- `electron/backend/application.mjs`: coordinator input admission, role/brief refresh, event delivery, authority/history routing, visual history lookup and voice integration hooks.
- `electron/runtime/focus-coordinator-context.mjs`, `focus-session-renewal.mjs`, `renderer-thread-projection.mjs`: stable policy, bounded mutable state, safe CAS renewal and trusted chat projection.
- `electron/persistence/database.mjs`, `focus-store.mjs`: generations, handoff, Stop, persisted context fingerprints, history indexing and omission totals.
- `electron/runtime/focus-supervisor.mjs`, `focus-visuals.mjs`: current project routing and immutable visual origins.
- `electron/connect/protocol.mjs`, `electron/preload.cjs`, `src/pixice-api.d.ts`, `src/App.jsx`: shared refresh/history API, typed sessions, authoritative events and Focus `/new` command.
- `tests/focus-session-renewal.test.js`, `tests/focus-coordinator-context.test.js`, `tests/app.test.jsx`: isolated service/transport and component regressions.

The additional projection source path was announced before editing. `src/state/runtime.js`, voice modules and prototype files were not edited. No new workers were created. Fake provider bridge children exist only in disposable regression fixtures.

## Repeatable checks

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands'
pnpm exec vite build --outDir /tmp/pixice-focus-review-fixes-build
git diff --check
```

This review-fix snapshot passed 23 + 126 + 34 = 183 distinct tests, with 151 UI tests skipped, as independently confirmed in the follow-up review. Earlier exploratory failing tests were fixed before those final runs. Database/projection repeat checks passed 22 tests already counted within the 126. Syntax checks passed for ten changed JavaScript modules. Build succeeded with existing import/chunk warnings. The exact-copy fork defect is documented in [fork-projection-fix.md](fork-projection-fix.md); the final failure-path changes and latest 212-test verification are in [fork-failure-fix.md](fork-failure-fix.md).

Production voice hookup is still a coordinator integration step. Provider-role persistence and delegation behavior were exercised through mocks and inspected adapters, not paid/live turns. No live coordinator, production fixture, microphone, installation or relaunch was used.
