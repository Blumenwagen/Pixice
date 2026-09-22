# Focus coordinator implementation

Implemented locally, 22 September 2026. Sol implemented the supervisor; Terra implemented the durable store, activity UI, and shared-question helper. The lead agent integrated provider/runtime behavior, tools, policy enforcement, and service-level checks. Existing working-tree changes were preserved.

## Delivered experience

- **One available coordinator.** Dispatch records an outcome and returns without waiting for the worker. Durable events bring results back to the coordinator. Idle supervision runs no model polling loop.
- **Follow-ups stay with their work.** The coordinator can list and inspect outcomes, steer an active worker, continue an existing worker, pause, resume, or cancel. Conversation instructions require semantic reference resolution and checking existing work before dispatching a duplicate.
- **Changes of direction persist.** Scoped and project-wide decisions retain revisions and source task identity. Delivery and worker acknowledgement are separate. Results under unacknowledged directions cannot be accepted as complete.
- **Results require review.** Worker completion produces “Ready for review.” The coordinator must supply verification evidence or an explicit justification that checks are not required. Failed verification cannot complete an outcome. Independent read-only review can use a separate model. Final artifact paths/URLs are retained with the outcome.
- **Fewer repeated questions, durable continuity.** Structurally identical worker questions are grouped within the project and one response is mapped to every current request. Stale request generations cannot consume a later answer. The activity brief has a persisted seen cursor, so dismissed changes remain dismissed after reconnect.
- **Separate execution policies.** Coordinator, worker, and reviewer models persist independently, together with worker access and concurrency. Read-only work stays read-only. The scheduler enforces dependencies and serializes overlapping declared write resources. Unknown write scope reserves the entire workspace. A compact Activity disclosure exposes work controls and these policies.

The first-send repairs preserve empty coordinator sessions across provider reconnect, resume before submission, retain failed drafts, protect historical transcripts, and isolate provider failures. An unused coordinator can switch providers explicitly; an existing conversation cannot silently migrate providers.

## Coordinator-owned questions

Worker questions first go through a bounded background coordinator review using project context and earlier decisions. Routine reversible choices are answered automatically. Questions that require user judgment appear inline in the Focus conversation, preserving the main composer, its draft, keyboard focus, and reading position. They never open a separate decision screen or require visiting a worker.

The coordinator can retrieve pending questions with `list_questions` and forward a reply from the normal conversation with `answer_question`. Inline answer controls use the same generation-checked relay. Identical grouped questions receive the answer together. Accepted non-secret answers leave a durable receipt available to the coordinator and the conversation; secret answers are excluded from receipt persistence.

Question-flow validation: 186 App/Focus unit and component tests, 16 backend Focus lifecycle checks, 29 backend/connect checks, production build and 5 Sites checks pass. Coverage includes preserved composer focus/draft/scroll, automatic answers, provider-correct review, sparse-result hydration, coordinator-written escalation, normal-chat forwarding, grouped responses, and secret receipt redaction. The running `?focus-preview` fixture includes a working inline rollout question. It was checked through its API and automated tests, without computer-use visual inspection.

## Runtime and persistence

`FocusStore` adds project-scoped SQLite work, decision, event, policy, and seen-state tables. `FocusSupervisor` owns scheduling, recovery, result collection, and coordinator delivery. The `pixice_focus` tools expose the same coordination contract to Codex and Claude. Detached work uses the existing bridge and provider registry. IPC, connected-client operations, and remote events share the backend implementation.

Recovery reattaches to durable worker identities and checks runtime state. Ambiguous starts remain visible for recovery rather than automatically replaying a potentially accepted request. Paused/cancelled state must survive late events and concurrent recovery. Meaningful coordinator notifications are bounded and serialized; the conversation renders internal lifecycle prompts as quiet notices.

## Validation

- 16 service-level checks against the real HTTP backend and controlled provider fixtures, covering first send, reconnect, provider isolation, history, model policies, asynchronous dispatch/review, automatic answers, user escalation and forwarding, grouped questions, memory revisions, secret receipt redaction, and stale approvals.
- 149 App component checks plus renderer projection and Focus component checks passed during integration.
- Final targeted run: 98 passing tests across Focus store, supervisor, question grouping, coordination tools/UI, memory, thread sessions, database, bridge, and providers. These cover persistence, concurrency, dependencies, permissions, lifecycle races, and provider contracts. The two Focus App tests were rerun successfully after final integration.
- 29 backend/connect service tests passed using the Node-only service test configuration.
- Production Sites build, packaging preparation, and all 5 Sites worker checks passed. Build reports existing bundle-size/static-plus-dynamic-import warnings.

Commands: `node --test work/investigations/focus-coordinator-checks.mjs`; `vitest run tests/focus-*.test.*`; `vitest run --config work/investigations/vitest-service.config.mjs`; `npm run build`; `node --test tests/sites-worker.test.mjs`.

## Practical limits

Execution remains on the current project host. There is no new automatic host migration, unattended subscription system, cost estimator, or automatic worktree integration. Closing a connected client can leave the backend working; stopping or sleeping its host cannot.

Semantic routing and evidence assessment are model responsibilities backed by durable tools and state. Verification evidence is recorded, not independently proven by the storage layer. Question grouping compares structure and wording; differently worded questions are not automatically declared equivalent. Declared write resources reduce conflicts but do not establish filesystem locks for unrelated work outside the supervisor.

Automated tests use controlled provider fixtures for the new coordination flow. No computer-use or visual inspection was performed, and the new end-to-end experience has not been retested on the originally affected device. The original remembered connection error is consistent with the reproduced lifecycle bug, but its exact device-specific cause remains unconfirmed.
