# Independent review of r11 protected-fork gate

Review work `d5a03108-0a5b-46cf-a11d-52624ef38f30`, outcome `36115ebb-f615-42db-9960-977fba34dfee`. Read the current work and `fork-gate-fix.md`; acknowledged direction r1 again. No implementation edits.

Recommendation: accept this scoped remediation. I found no remaining blocker within the simplified preflight-gate scope. The earlier provider-wide disappearance reproduction now passes. This recommendation does not establish production voice integration or real-provider behavior.

## Gate and retained protections

[application.mjs:2909](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:2909) builds the trusted copy plan for the selected answer boundary and invokes the gate when it contains protected insertions, before the native `thread/fork` call. [provider-registry.mjs:259](/Users/blumenwagen/Developer/Loom/electron/providers/provider-registry.mjs:259) unconditionally rejects that protected operation for current adapters. It names the provider, says no fork was created, and offers continuing Focus, `/new`, or a normal task with the visible request. The renderer's existing fork error handler displays the returned error.

Executed regressions cover current and retired Focus generations, proven inherited copies and second-generation copies on both fixture providers. They assert zero native creation calls and zero operation, known-thread and candidate rows, including after restart. Gate rejection leaves the Focus session unchanged; explicit renewal still works.

The provider registry no longer has active/unresolved reservation maps, event queues or unknown-identity admission. Searches found no remaining broad admission/release methods in production source. Legacy operation metadata remains readable but inert. Exact candidate-ID checks remain at request, response, event and list publication boundaries, with the application retaining its additional publication guard.

The historical failed-candidate regression verifies read/list/summary/overview/snapshot/events/search exclusion before and after restart, preserved raw diagnosis content and refusal to clear quarantine through proof registration. The unresolved-history regression preserves operation and candidate records unchanged while allowing unrelated external IDs. Source inspection confirms no migration clears these records and ordinary creation responses cannot remove candidate rows.

## Independent reproduction

I adapted the previous project-A/project-B service probe, retaining real application handlers and ApplicationClient with disposable storage and fake providers. A native fork method was set to fail if reached. After the protected attempt, I restarted storage and announced an unrelated external conversation in project B's canonical folder.

```text
native fork calls: 0
project_focus_fork_operations 0
project_focus_fork_known_threads 0
project_focus_fork_candidates 0
unrelated external listed after restart: true
external announcement published: true
raw external preserved: true
new host-created codex usable: true
other provider usable: true
provider guard still present: false
```

The external `threads.read` also succeeded. The returned error was:

> Forking protected Focus history is unsupported on codex: the provider cannot guarantee the created session identity if the fork fails. No fork was created. Continue in Focus, use /new to renew Focus, or create a normal task with the visible request.

Probe file: `/tmp/pixice-fork-gate-independent-probe.mjs`. Temporary service databases were removed. The submitted cross-project/provider regression additionally verifies exact pasted brief text remains unchanged in reads and events, with one item-event delivery, across existing, newly created and previously unknown conversations before and after restart.

## Regression checks

All checks passed on their first run in this continuation:

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/codex-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-gate-review-build
```

Results: **36 + 132 + 43 = 211 distinct passing tests**, with 142 unrelated UI tests skipped. Production build passed. Individual `node --check` calls passed for application, database, provider registry and session regression file. `git diff --check` passed. Existing SQLite experimental, Motion opacity, mixed App import and large chunk warnings remain.

Ordinary forks on both fixture adapters preserve naming/source linkage, independent continuation and pasted text. A selected Focus prefix without a protected insertion remains forkable even when later turns contain one. Existing `/new`, renewal, Stop, question and review regressions passed. Recorded copies retain message-bound projection, remapped/coalesced layouts, fresh tails and reopened history/search checks. These recorded-copy fixtures seed historical proof; they do not claim current protected native forks succeed.

## Limits

Protected native forks are intentionally unsupported on both current adapters. Existing explicitly recorded quarantines remain unavailable without a new recovery flow, which is outside this scoped fix. Legacy metadata is not retroactive proof for previously unidentified or unproven copies, and no production database audit or historical cleanup was performed.

Production voice remains unwired. Real-provider fork behavior, delegation drift and role retention remain unproven by fixture tests. No live provider turn, rotation, media, nested worker, installation, relaunch, commit or publication occurred. Only this review artifact and disposable verification outputs were written. Acceptance and `complete_work` remain coordinator-only.
