# Independent Focus renewal review

Review work d5a03108-0a5b-46cf-a11d-52624ef38f30, reviewing outcome 36115ebb-f615-42db-9960-977fba34dfee. Reviewed 2026-09-29 in the existing working tree. Scoped direction r1 was read, applied and acknowledged through Focus. No implementation files were edited. This report is evidence for coordinator review, not acceptance.

Recommendation: request changes before accepting reliable session renewal. The targeted tests and build pass, but additional isolated fixture checks reproduced an authoritative-routing bypass and other gaps.

## Implementation defects

### P1: An Instrument can start the retired coordinator after renewal

[electron/backend/application.mjs:1951](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:1951) sends Instrument agent events directly through `runtime.request("turn/start")` or `turn/steer`. It does not use the new project admission gate, reject retired Focus generations, refresh the managed role, or attach a current brief. The handler remains reachable through `instruments:event` at line 2607. Instrument access validation checks project and ownership, not current Focus authority.

Executed reproduction against `startService` with `BackendFixtureProvider`, an isolated temporary database and an authenticated local `ApplicationClient`:

1. Create a fixture Focus coordinator and a thread-owned Instrument with a `sendAgentEvent` action.
2. Call `focus.refresh` with generation 1.
3. Call `instruments.event` for the Instrument using the original coordinator thread ID.
4. Observe event status `sent`, a provider `turn/start` addressed to the old thread, and a different current authoritative thread in the database.

Observed output:

```text
retiredInstrumentEvent {
  status: 'sent',
  oldThreadStarted: true,
  authoritativeThreadDifferent: true
}
```

This contradicts the general claim that stale clients cannot submit to retired coordinators. Normal `turns:start` is guarded, but all Focus input entry points need the same authority and admission checks. `startBridgeParentTurn` at line 1998 is another direct start path identified by inspection; I did not execute its completion route. The Instrument reproduction used only the fake provider and never started a real agent.

### P2: Internal state briefs become visible user-message text

The new [startTrackedTurn insertion](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:1043) prepends the state brief as a normal text part of provider input. [ConversationItem](/Users/blumenwagen/Developer/Loom/src/App.jsx:2201) joins all user text parts and only strips Preview context. [stripPreviewContext](/Users/blumenwagen/Developer/Loom/src/state/runtime.js:9) does not strip Focus briefs. The existing worker-update notice relies on the message starting with the old worker-update prefix, which the new brief now precedes.

I captured actual fixture `turn/start` input and ran the renderer's text-filter function against its joined text parts. The result still started with `[Pixice Focus state brief]`. Source inspection establishes that the user-message branch renders that result. This was not a live browser screenshot or a real-provider transcript test.

When a provider reflects input into its transcript, ordinary messages therefore show internal JSON containing memory, work, questions and event IDs. Worker update turns also miss their compact notice branch. Keep the provider context while projecting only the intended message into the conversation. The new App test uses an empty replacement transcript and does not test this behavior.

### P2: Steering bypasses context freshness and retired-session validation

[turns:steer](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:3025) calls `ensureThreadLoaded`, then sends ordinary input directly to the provider. The loaded registry skips resume. It does not attach a current durable brief or reject a retired generation, unlike `turns:start`. Active worker-update delivery also goes through `steerBridgeParentTurn` without the new brief.

Executed fixture check: start a coordinator turn, change durable project memory, then steer. The only subsequent provider method was `turn/steer`; its input contained no Focus brief. After interruption and renewal, a stale steer still reached the provider. My fixture's added active-turn validation rejected it with `No active fixture turn`; the application itself did not reject retired ownership. I am not claiming that a real provider accepts a steer to an inactive turn.

Freshness during steering remains undelivered and untested in the submitted suite. Update mutable context safely. Do not blindly resume an active Claude query to change its role: the inspected Claude adapter disposes its query when instructions change. Role changes should respect a safe turn boundary.

### P2: The bounded brief can exceed the handoff limit

[focusStateBrief](/Users/blumenwagen/Developer/Loom/electron/runtime/focus-coordinator-context.mjs:23) clips raw string lengths, then removes work, decisions, questions and review IDs. It never enforces the final serialized limit after those collections are empty. JSON escaping, fixed fields and pending events can exceed the budget.

Executed input within the actual memory limits: project memory of 6,000 backslashes, user memory of 2,000 backslashes, current and previous requests of 2,000 backslashes each, a short policy and 12 pending event records. The brief measured 25,992 characters. Passing it to the actual database replacement method returned `Focus handoff exceeds its bounded capacity.` The original session remained authoritative. A first exploratory probe used 3,000 user-memory characters; the reported reproduction above corrected that to the supported 2,000 limit.

This can prevent renewal indefinitely for the retained state. The fix needs a final JSON-aware budget that always fits, including fields outside the removable arrays.

The omission metadata is also inaccurate. A separate executed probe with 13 decisions and 13 questions retained 12 of each but reported `omittedDecisions: 0` and `omittedQuestions: 0`. Initial slicing happens before omission accounting. The database's 200-record coordinator-work limit likewise supplies no total to the brief, so the counts cannot describe records excluded by that query. These defects weaken the promised guidance to inspect omitted durable state.

### P2: Unknown voice state does not fail closed

[FocusSessionRenewal.assertSafe](/Users/blumenwagen/Developer/Loom/electron/runtime/focus-session-renewal.mjs:30) only rejects truthy guard results. The code comment and integration contract say unknown state fails closed.

Executed check: install `application.setFocusVoiceGuard(() => undefined)` and call `focus.refresh` on an idle fixture session. Renewal succeeded and published generation 2. Throwing guards do stop the operation by propagating their exception; an unknown falsey return does not. Require an explicit safe result or define and validate a narrower contract. This is a hook-contract defect, separate from the missing production hookup below.

## Missing scope and integration gaps

Manual session reset is not available to the user. [preload.cjs:75](/Users/blumenwagen/Developer/Loom/electron/preload.cjs:75), [protocol.mjs:38](/Users/blumenwagen/Developer/Loom/electron/connect/protocol.mjs:38) and [pixice-api.d.ts:486](/Users/blumenwagen/Developer/Loom/src/pixice-api.d.ts:486) expose `focus.refresh`. No application UI calls it. The Pixice slash-command list at [App.jsx:341](/Users/blumenwagen/Developer/Loom/src/App.jsx:341) contains `usage` and `settings`, and the submit path sends text to start/steer. There is no Focus `/new` handler or reset button. Provider-advertised Claude slash commands are not a durable Focus-generation reset. Given the requested Hermes-style manual reset plus automatic renewal, the manual feature remains incomplete.

Voice is not wired into the application. Searches found definitions of `setFocusVoiceGuard` and `withFocusSessionAdmission`, but no production registration or voice preparation caller. The explicit guard and admission fixture tests pass for their covered cases. They do not establish protection of active voice in an installed app. The coordinator must integrate the separate voice outcome and then verify preparation, active, stopping and failed-stop states.

Staged visuals preserve their origin and load after renewal. Historical conversation images that were not already staged have a narrower path: [the visual read callback](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:3408) reads only the current provider thread, while rendered history includes prior generations. Selecting an old message ID for a new dispatch therefore has no cross-generation lookup in this callback. This is a source-level continuity limitation; I did not run a separate historical-message selection test.

The new TypeScript API fields are present, but `focus.state` still omits the newly returned `session` from its declared return shape, and `refresh`/history session use `any`. Vite does not type-check those declarations. I did not run a TypeScript compiler or claim type-safety validation.

## What the executed suites support

The new tests exercise fresh role resume on ordinary starts, current durable memory/reviews, reconnection calls, mocked compaction notification, automatic fallback renewal, visible/searchable prior history, two local clients, failed creation, serialized racing refreshes, generation/revision CAS, transaction rollback, newer Stop preservation, paused/cancelled work, delivered-but-unreviewed results, pending worker question generations, voice guard/admission fixtures and reopened visual origins.

The inspected implementation resolves managed worker project ownership before ancestry, retains existing worker identity and original staged visual references, and retargets pending question display/reviewer context. Database replacement updates authority and generation history in one transaction. Review-state replay does not depend on event `deliveredAt`. Ordinary stale `turns:start` is rejected. The managed role distinguishes durable Focus delegation from unmanaged spawning and explicitly defers to provider security policy.

These are code and fixture results. They do not demonstrate that delegation drift has been empirically solved. Compaction did not prove role loss in the original audit, and the new fake-provider test does not establish real-provider instruction retention after compaction. The source of the previously observed generic no-proactive instruction remains untraced.

## Checks actually run

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t Focus
pnpm exec vite build --outDir /tmp/pixice-focus-independent-review-build
git diff --check
```

Results: 14 new tests passed; 117 existing unit tests passed; 26 component/App tests passed, with 154 App tests skipped by the Focus filter. Total independently observed: 157 passing tests. The submitted result says 158; I did not reproduce that count with the commands above.

Production Vite build passed. It reported mixed static/dynamic App imports and a large chunk warning. Generated build output is outside the project. This was not an Electron package/install build.

Individual `node --check` commands also passed for application.mjs, focus-coordinator-context.mjs, focus-session-renewal.mjs, database.mjs, focus-store.mjs, focus-supervisor.mjs, focus-visuals.mjs, preload.cjs and connect/protocol.mjs.

Two additional `node --input-type=module` fixture probes produced the observations described above. They used the existing backend fixture provider, actual service/client/database code and temporary directories removed in `finally`. No real provider login or turn was used. The UI text-filter and brief-budget checks called the actual exported functions.

I inspected the changed source, tests, preload, protocol, API declarations, provider resume behavior, renderer projection, runtime instructions and related admission paths. `src/bridge` does not exist in this checkout; transport inspection used `src/connect` and `electron/connect`.

No live or development coordinator rotation, mic use, voice connection, commit, push, install, relaunch, nested workers or implementation edits occurred. Only this review artifact and disposable check/build outputs were written. Final work context still shows direction r1 acknowledged. Acceptance remains with the coordinator.
