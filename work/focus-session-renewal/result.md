# Focus reliability and session renewal result

Work `36115ebb-f615-42db-9960-977fba34dfee` continues in its existing worker thread. Directions r11, r5 and r1 apply; revision 11 is acknowledged. This result is for coordinator review. This worker does not call `complete_work`.

The implementation includes a stable managed Focus role, fresh durable state briefs, persisted coordinator generations, safe automatic and manual renewal, retained history and authoritative client routing. The latest r11 change deliberately gates protected Focus-context forks before native creation, removes provider-wide holding, and retains protection for recorded unverified candidates. See [fork-gate-fix.md](fork-gate-fix.md) for current evidence and the unsupported-operation boundary. Earlier review/fix documents remain historical snapshots.

## Behavior

The stable role distinguishes managed `dispatch_work` authority from unmanaged spawning and defers to provider security policy. It keeps small answers and bounded integration checks with the coordinator while directing substantial work into supervised outcomes. It preserves full-access workers and explicit permission errors. Memory contains project facts and preferences, not role instructions.

Starts refresh the loaded coordinator role through supported `thread/resume`, then submit a separate bounded brief. Active steering submits fresh mutable state without resuming or disposing the active provider query. Pending reviews come from database work status, irrespective of event delivery. Brief omission counts include initial slices and records beyond the bounded database reads. Final JSON serialization, including escaping and its prefix, stays within 24,000 characters and below the database's 24,500-character handoff capacity.

Normal turns, Instrument interactions, bridge completions, tray follow-ups and worker update delivery validate current Focus authority. Starts and steers share the project admission gate with renewal. Retired coordinators reject input before provider submission. Automatic delivery respects Stop. Explicit user input can resume the coordinator, while renewal preserves Stop and worker pause/cancel state.

Automatic renewal uses a safe boundary between turns. Current-turn input at 75 percent of the provider's reported context window is the primary signal. Cumulative billing totals are ignored. Without current measurements, 24 coordinator inputs and 160,000 transcript characters trigger the bounded-history fallback. Measured low input takes precedence over large historical storage. Compaction does not prove role loss.

Focus `/new` uses the existing Pixice command picker and keyboard submission. It calls `focus.refresh` with the displayed generation. It preserves project memory, work, Stop, the draft remainder and history, and displays busy, voice and stale-generation errors. It never sends a Focus reset as the provider's `/new` command. IPC and Connect use the same generation API; clients follow `FocusUpdated` authority. The conversation and Work in flight rail retain their existing layout.

Renewal creates an idle candidate before a database transaction updates authority and generation history with generation/revision CAS. Failure retains the previous authority. An unsuccessful candidate remains idle and available for diagnosis. No old session is deleted. Existing worker identities, event state and pending question response generations remain unchanged. Worker routing resolves durable project ownership before ancestry.

Provider context stays in the provider transcript. The renderer removes only a proven leading context insertion using persisted fingerprints. It preserves user-authored marker-like text and exact pasted prior briefs after that insertion. Worker lifecycle updates render as the existing compact notice. The same projection applies to start responses, live events, snapshots, retired history and history indexing.

Forking a prefix containing a proven internal Focus insertion rejects before native `thread/fork` on both current adapters. The actionable error offers continuing Focus, `/new`, or a normal task with the visible request. Current/retired generations and inherited copies are gated. Ordinary forks and selected prefixes with no protected insertion remain supported. Recorded successful copies retain exact message-bound projection, with fresh user text and legitimate pasted briefs preserved.

The provider-wide reservation and its broad admission/release writers are removed. Unsupported attempts create no operation/quarantine rows. Unrelated existing, external and newly created sessions remain usable across projects, providers and restart. Existing failed/unresolved candidate rows remain protected by exact ID; legacy operation metadata is retained without extending it to new identities. Provider sessions and raw diagnosis snapshots remain available. No automatic release or recovery UI was added.

Historical conversation images use only generations registered to the project. Staging retains the original session ID and directory; foreign message IDs fail without altering saved visuals. Current input capture remains available before the provider has reflected a tool-calling turn into its snapshot.

## Verification

The latest targeted runs passed 211 distinct tests: 36 context/session regressions, 132 existing runtime/provider/persistence tests and 43 Focus/command/fork component tests. The UI filter skipped 142 unrelated tests. Superseded broad-reservation tests were replaced with gate tests; the previous 212-test count is a historical snapshot. The final UI run passed on its first attempt in this continuation. One intermediate fixture used a noncanonical temporary path; correcting it resolved that test failure before the final run. The independent 198-test review included one initial UI timeout followed by a complete filtered passing rerun without source changes. The original independent review count was 157, not 158.

The regressions use temporary databases and fake providers with the real backend service, application handlers, transport and Connect facade. They cover loaded/resumed role refresh, compaction/reconnect calls, active steering without resume, automatic boundaries, manual renewal, failure rollback, races/CAS, Stop races, pending questions/events/reviews, paused/cancelled work, old history, stale Instrument/bridge input, escaped memory, upstream omission counts, unknown/active voice guards and historical visual origins. Keyboard reset, rejection display and compact worker notices have component regressions.

Vite production build passed into `/tmp/pixice-focus-fork-gate-build`. It reported the existing mixed static/dynamic App import and large chunk warnings. Eleven JavaScript syntax checks and `git diff --check` passed. No Electron package, install or relaunch was run. The session declarations now use `FocusSession` and typed refresh/history results; no TypeScript compiler is installed in this project, so a compiler check was not run.

## Remaining integration limits

The production voice bridge remains deliberately separate. [voice-integration.md](voice-integration.md) describes the guard and shared admission hooks. Only explicit `false` permits renewal; unknown or throwing guard state blocks it before candidate creation and publication. Combined production voice protection requires coordinator wiring and verification after both foundations are reviewed. No final voice UI has been selected or edited.

These fixtures and supported-method checks do not establish that real-provider delegation drift is empirically solved. The source of the audit's generic no-proactive instruction remains untraced. No provider security policy is overridden. Full provider restarts still invalidate native questions that the provider no longer owns rather than replaying lost native request IDs.

Large work/decision/event sets require durable-tool inspection of the recorded omissions. History remains stored and searchable, while new sessions receive only the bounded brief and current input. No numeric worker execution cap was introduced.

Copied-context proof requires exact copied message content and supported leading-prefix layouts. Arbitrary provider rewriting and legacy copies without proof do not gain inferred authority. Protected native forks are deliberately unsupported because neither adapter has a verified creation identity guarantee on failure. Existing unverified candidate records remain protected. Artifact inspection supports the no-install/no-live-fork premise; production storage was not inspected or mutated. See the gate handoff for concrete evidence and limitations.

No live/development coordinator was rotated, no production database was used as a fixture, and no unrelated stopped feature was resumed. Concurrent voice/prototype modules remain untouched. No nested workers, commit, push, install, relaunch or media tests occurred.
