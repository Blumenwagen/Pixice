# Follow-up independent review

Reviewed 2026-09-30 for the same durable review work, `d5a03108-0a5b-46cf-a11d-52624ef38f30`, and original outcome `36115ebb-f615-42db-9960-977fba34dfee`. Direction r1 was reread and acknowledged. I read `result.md`, `review-fixes.md`, the earlier independent review and the actual changes and tests. No implementation edits were made.

The core renewal foundation passes the reported checks and the added probes below. The earlier admission, steering, budget, voice-guard and manual-reset findings are fixed in the tested paths. One P2 projection defect remains through the supported fork API. Do not describe projection across all responses/history as complete until that path is handled. Production voice integration remains separate and unwired. These findings are for coordinator review, not acceptance.

## Remaining P2: Forks expose copied internal Focus briefs

The `threads:fork` handler reads the raw provider conversation and copies its turns into an independent thread. Its [return projection](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:2929) calls `projectRendererThread` without a context predicate. Subsequent reads use the new thread's ID, but [fingerprints](/Users/blumenwagen/Developer/Loom/electron/persistence/database.mjs:686) belong only to the original Focus thread. No copied-turn provenance or fingerprint migration is recorded by the fork path.

I reproduced this with the real backend service, ApplicationClient and a temporary database. A fake provider echoed the actual admitted text and implemented `thread/fork` by copying the source turns into a fresh fixture thread. After a completed Focus turn containing a private fixture-memory marker, I called `threads.fork` with its valid final answer ID, then `threads.read` for the fork.

Both responses included `[Pixice Focus state brief]` and `Internalneedleprivate` in the first user message. The normal Focus response for that same turn contained only `Hello`.

```text
fork first user text [Pixice Focus state brief]
{"projectId":"…","generation
fork leaks injected memory true
fork read leaks injected memory true
```

This is a supported backend/Connect API gap, not a claim that the main Focus conversation currently exposes a Fork button. Its `TurnConversation` does not receive `onFork`. The API nevertheless accepts the operation and returns the copied internal data. Preserve trusted provenance for copied turns, or explicitly disallow this operation for Focus. Broad marker stripping would reintroduce the legitimate-user-text problem.

## Earlier findings rechecked

| Area | Evidence and result |
| --- | --- |
| Retired Instrument input | The new service regression rejects the old Instrument before provider start, steer or resume. Current Instrument starts receive managed role, current brief and full access. Passed. |
| Bridge completion | Fixture regression admits a current coordinator with role/brief and rejects a retired parent after Stop and renewal. Passed. No real child agents were spawned. |
| Normal start/steer and tray | Shared authority checks and project admission guard normal, Instrument, bridge and tray inputs. My additional service probe confirmed tray steering carries current memory with no `thread/resume`. Stale start and steer rejected before any provider start/steer/resume. |
| Worker updates | Active delivery calls the shared steering path with fresh memory/directions and no active resume. Idle delivery holds the same project gate and rechecks current authority and Stop before `startTrackedTurn`. The new active-update regression passed. |
| Active Claude safety | `steerTrackedTurn` performs no ensure/resume. Role refresh stays in turn start. Adapter inspection confirms this avoids the instruction-change disposal path during steering. This is source/fixture evidence, not a live Claude test. |
| Brief bound and omissions | The escaped-memory renewal regression passed. An additional direct probe tested backslashes, quotes, newlines, control characters and emoji. Every serialized brief stayed within 24,000 characters. Retained plus omitted counts equalled supplied totals for work, reviews, decisions, questions and events. |
| Unknown voice guard | The new service regression rejects undefined, null, zero, empty string, true and throwing guards before creation, and unknown state after creation before publication. Explicit false allows renewal. Passed. |
| Normal context projection | Service regressions cover start responses, live events, reads and renewed history. My additional service probe preserved an exact pasted prior brief plus a trailing user string through start response, read and renewal. No repeated prefix stripping occurred. |
| Persisted projection/search | A separate temporary database probe stored exact fingerprints and split/coalesced messages, closed and reopened storage, then projected and searched. The exact pasted prior brief and legitimate tail survived. The host-inserted private marker was absent from search. Passed after correcting my fixture setup, as noted below. |
| Manual `/new` | Keyboard/component checks prove Focus-owned reset invokes `focus.refresh` with generation, sends no provider command and follows the replacement. Busy, voice and stale errors remain visible. Existing Composer command handling retains the draft remainder. Passed. |
| Stop, questions, reviews and history | Existing and new regressions passed for Stop races, CAS/transaction rollback, stopped renewal, paused/cancelled work, response generations, delivered-but-unreviewed results and retained/searchable history. |
| Historical visuals | Service regression stages an old unstaged image after renewal in its original directory and rejects a foreign message without changing saved visuals. The callback enumerates project generations, validates snapshot identity and overwrites origin metadata from trusted membership. Passed. |
| API declarations | `FocusSession` and typed ensure/refresh/history results are present; `focus.state` includes its session. Inspected declarations, preload and protocol. No TypeScript compiler check was run. |

The projection result is limited to supported layouts tested here: one leading inserted context, either its own text part or joined to user text by a newline. The fingerprint is exact text provenance within a thread, not evidence about arbitrary provider transcript rewriting. I did not establish behavior for provider transformations outside those layouts.

## Commands and outcomes

All requested targeted commands were rerun, with a separate temporary output directory for the build:

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands'
pnpm exec vite build --outDir /tmp/pixice-focus-followup-review-build
git diff --check
```

Results were 23 + 126 + 34 = **183 distinct passing tests**, with 151 UI tests skipped. Vite build passed with mixed static/dynamic App import and large chunk warnings. Diff check passed. Individual `node --check` commands passed for the ten changed JavaScript modules: application, coordinator context, session renewal, renderer projection, database, Focus store, supervisor, visuals, preload and Connect protocol.

Additional isolated checks ran through `node --input-type=module`. The service probe covered tray steering, exact prior-brief paste preservation, fork projection, renewed history/search and stale start/steer rejection. The reopened-database probe and five escaped-text budget cases passed. My first two database-probe attempts failed because the probe used the wrong close method and omitted a required provider binding. I corrected the fixture only and reran successfully; these were not application test failures. Disposable fixtures never used the production database.

## Production limits

The application still only exposes the `setFocusVoiceGuard` and `withFocusSessionAdmission` hooks. Source searches found no production voice-bridge registration or preparation caller. Passing explicit-guard fixtures does not protect active voice in an installed app by itself. Integration and combined lifecycle verification remain with the coordinator.

No real-provider turn, login, live/development coordinator rotation, media use, install, relaunch, commit, push or nested worker was used. No claim is made that delegation drift is empirically solved, that compaction lost the role, or that the origin of the generic no-proactive instruction has been traced. Only this report and disposable verification outputs were written. I did not call `complete_work`.
