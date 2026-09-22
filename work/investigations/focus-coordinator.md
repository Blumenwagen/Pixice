# Focus coordinator investigation — 2026-09-22

The reported device failure is not yet conclusively identified. The user remembers a thread-connection error on the first prompt in a previously unused Focus chat. A healthy first prompt succeeded through the actual local backend and Codex 0.153.0, without computer use. Separate deterministic backend checks reproduce a session-lifecycle defect that can fail that first prompt, plus two independent coordinator defects.

Following the investigation, the user authorized Sol to implement repairs. The changes are now present locally and reviewed. The findings below describe the original defects; line references refer to the original checkout. Existing unrelated edits to agent behavior and app tests have been preserved. `focus-coordinator-checks.mjs` now asserts repaired behavior through the real service and controlled provider fixtures.

## Repairs and current verification

The later approved coordinator feature implementation is documented in `focus-implementation.md`. The standalone service suite now contains 13 passing checks, including asynchronous dispatch/review, independent policies, and shared worker questions. The findings below retain the original investigation context.

- Invalidate sessions and pending state per provider, protect reconnects against stale in-flight resumes, and preserve work on the healthy provider. Pending approvals carry a distinct request generation so a response cannot answer a reused request ID after restart.
- Restore a provider-compatible coordinator model, reject mismatched model/provider combinations before dispatch, and permit an explicit provider change only for an unused coordinator. Protect replacement against a concurrent first submission.
- Preserve transcripts and searchable history when saving provider summaries; index actual Focus transcript reads and retain entries across partial reads.
- Retain the coordinator and draft on connection failure and offer an in-place retry. Add inspect/edit/clear controls for curated memory, with revision checks for both manual edits and background maintenance.
- Bound background question review and expose unresolved questions to the user.

The ten standalone service checks pass: first submission, reconnect after provider restart, model mismatch rejection, summary/history preservation, transcript indexing across partial reads, healthy-provider isolation, explicit empty-session replacement, stale memory rejection, recovery of a hidden worker question when its reviewer disconnects, and stale approval rejection. Focused unit/component checks and build results are recorded below. These repairs have not been deployed to the reported device, and the exact cause of its original error remains unconfirmed.

## 1. A provider restart can leave an empty coordinator incorrectly marked as loaded

**Reproduced using the real service and a controlled provider fixture.**

1. Open Focus, creating its persistent empty thread; send no messages.
2. Keep Claude ready and restart Codex, losing its in-process thread sessions.
3. Submit the first Focus prompt.
4. Pixice calls `turn/start` without `thread/resume`, producing the fixture's unloaded-thread error.

`ProviderRegistry.#handleStatus` (`electron/providers/provider-registry.mjs:413`) reports aggregate `ready` while any other provider is ready. The backend invalidates `threadSessions` only when that aggregate status becomes connecting, reconnecting, or stopped (`electron/backend/application.mjs:2977`). `ensureThreadLoaded` then trusts its stale cache (`:992`). This affects ordinary threads too, but opening Focus creates a thread before the first submission, exposing an empty coordinator to it.

**Recommended fix:** expose and consume per-provider lifecycle transitions; invalidate only that provider's loaded sessions and pending state. Make in-flight resumes generation-aware. Do not clear another provider's running work or automatically replay an ambiguously accepted turn. Separately, handle thread unload notifications and offer recoverable errors for genuinely missing saved threads.

This is compatible with the user's report but is not proof that a provider restart occurred on the tested device. Exact error text, provider/version, and logs around `focus:ensure`, `thread/resume`, and `turn/start` would distinguish this from an initial provider connection failure.

## 2. The selected model can belong to a different provider than the coordinator

**Reproduced at the provider boundary.** Create an empty Codex coordinator, then submit with `claude:sonnet`. The request reaches Codex with that unmodified model string. The fixture accepts it, so this check proves incorrect routing, not a particular real-provider error message.

Routing uses the persisted thread provider before the requested model (`electron/providers/provider-registry.mjs:264`). The Focus composer offers the shared model picker, while opening an existing coordinator ignores the requested model. On a client without saved thread configuration, `loadFocusSession` initializes its model from that client's defaults, rather than the returned thread's provider (`src/App.jsx:7523`). A provider switch before the first message can therefore be sufficient; previous conversation content is not required.

**Recommended fix:** derive the picker from authoritative coordinator configuration and reject mismatched provider/model combinations before dispatch. For an unused coordinator, safely recreate it for the chosen provider. For a populated coordinator, define an explicit continuity/migration policy rather than silently forwarding an incompatible model.

## 3. Reading a Codex thread clears its searchable Focus history

**Reproduced with real persistence and service calls.** Seed a searchable Focus decision, then call `threads.read`. The returned conversation still contains the decision, but `searchProjectFocusHistory` changes from one result to zero.

The registry writes a summary without turns via `saveProviderThreadSnapshot` (`electron/providers/provider-registry.mjs:396`). That method reindexes Focus history; the indexer deletes old entries before inserting the new snapshot's entries (`electron/persistence/database.mjs:1501`). A summary has none. Actual Codex reads also pass through this summary writer, so simply opening/refreshing the conversation cannot populate a dependable history index through that path.

**Recommended fix:** separate summary updates from complete transcript snapshots. Only replace a history index from an authoritative complete snapshot; preserve/merge indexed turns when incoming history is partial or compacted. Add read/list/refresh and compaction regression coverage. This is an index/local-cache issue, not evidence of deletion from the provider's original conversation storage.

## Focus experience and coordinator improvements

- **Recover within Focus.** Show coordinator-specific Connecting / Ready / Reconnecting / Unavailable state, retain the draft, and offer Retry or a provider-settings action. Today the failure becomes a generic operation error and loading failure clears the displayed thread. Distinguish “not submitted” from “submission status unknown” to avoid duplicate work.
- **Make work in flight actionable.** The Focus progress rail renders static articles (`src/App.jsx:4446`), not task controls. Let a row open the worker, inspect its result, or stop/redirect it. Keep completed results briefly accessible. The current coordinator bridge exposes only model listing and spawning; it needs bounded inspect/follow-up/cancel capabilities to supervise existing workers across requests without spawning replacements.
- **Make memory reviewable and safe from stale writes.** Offer a small inspect/edit/clear memory surface with provenance. Automated maintenance currently writes without comparing the revision it originally read (`electron/runtime/pixice-focus.mjs:161`, `electron/backend/application.mjs:1080`), so a delayed review can overwrite newer curated decisions. Use revision checking and retry/merge, and bound background question-review duration so a hidden worker question cannot remain stuck indefinitely.
- **Expose the actual access mode quietly.** Focus forces full access for itself and descendants while hiding the permission picker. A persistent, restrained full-access indicator would make that behavior understandable; any selectable alternative must be enforced through worker inheritance as well.

## Verification and limits

- `node --test work/investigations/focus-coordinator-checks.mjs`: ten regression checks pass against repaired behavior.
- Actual temporary backend + installed Codex 0.153.0: a fresh Focus thread accepted its first prompt and returned `Focus connection OK.`; the diagnostic thread was archived and temporary backend data removed.
- Final focused unit suites (`thread-session-registry`, `provider-registry`, `database`, `pixice-focus-memory`): 42 tests passed across four files.
- Final Focus component regressions (`vitest run tests/app.test.jsx -t "Focus"`): 2 passed, 147 skipped. These cover StrictMode memory save and reopening, and first-send recovery with draft preservation and no automatic replay. An earlier broader focused run passed 190 tests before the final recovery refinements.
- `npm run build`: passed and produced the Sites artifacts. `git diff --check`: passed.
- The existing backend-service Vitest suite was blocked by its jsdom `AbortSignal` conflicting with Node fetch, before exercising application requests. The standalone diagnostic checks use Node's own test runner and real HTTP to avoid this test-environment issue.
- No affected-device logs, desktop UI inspection, real Claude turn, provider restart against a live model, or visual redesign was performed. The status lifecycle reproduction uses a controlled provider that models durable threads surviving while loaded sessions disappear.

The larger coordinator direction, including asynchronous worker supervision, is described in `focus-feature-direction.md`. Those proposals are separate from these reliability repairs. Worker controls remain a future feature: the current bridge waits for worker completion, and responsive inspection, redirection, and stopping need durable asynchronous supervision.
