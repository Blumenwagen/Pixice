# Scoped fork remediation review

Reviewed 2026-09-30 under the existing review work `d5a03108-0a5b-46cf-a11d-52624ef38f30`, for outcome `36115ebb-f615-42db-9960-977fba34dfee`. Direction r1 was read and acknowledged. No implementation files were edited.

The original exact-copy fork leak is fixed. Message-bound proof and the normal copied-history paths pass their regressions and my reproduction. Two P2 failure-path defects remain, so I recommend changes before accepting this remediation as complete. This does not reopen the previously verified renewal foundation or claim production voice readiness.

## P2: Rejected candidates remain readable and emit unprojected context later

The [fork handler](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:2920) rejects a changed copy when `inheritFocusForkContext` cannot verify its content. Its `finally` block drops the queued candidate announcement, but no durable rejected-candidate state protects subsequent reads, listings or events. The provider has already created the thread. With no successful proof manifest, later projection treats its copied context as ordinary user text.

Executed reproduction used `BackendFixtureProvider`, actual service/ApplicationClient handlers and a disposable database:

1. Admit a Focus turn containing fixture memory `Internalneedleprivate` and complete its answer.
2. Fork an exact copy. Verify response and read exclude the inserted marker. This reproduces and clears the previous review's original defect.
3. Fork again with the same provider-side content modification used by the submitted rejection regression.
4. Observe `Cannot verify the copied Focus context in this fork.`
5. List threads and read the created candidate. It is listed and its read response contains the inserted marker.
6. Emit a later `item/started` for that candidate. A second probe observing the application's event emitter confirms the published event contains the marker.

```text
prior exact-copy fork response/read leak FIXED
changed-copy fork error Cannot verify the copied Focus context in this fork.
rejected candidate later read leaks true
rejected candidate present in list true
rejected candidate subsequent event leaks true
```

Rejecting changed copies is a reasonable documented compatibility policy. It is not sufficient if the rejected copy immediately remains available through ordinary reads and subsequent events. Preserve a failed-candidate disposition that prevents unverified copied content from being published. Do not solve this by granting broad fingerprint authority.

The first short transport observation did not see the later event within its wait. The subsequent independent application-emitter probe confirmed it; the read/list reproduction was already conclusive.

## P2: A failed reservation discards unrelated legitimate events

[sendRuntimeEvent](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:354) matches reservations across threads by source item ID, complete content, or a leading context-text match. It skips only the source thread. Therefore, a legitimate paste of a prior brief in a separate existing thread can be captured by an unrelated in-flight fork.

If `thread/fork` throws before returning a target ID, [reservation cleanup](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:2965) has `published === false` and no `targetThreadId`. It drops every captured event, including known unrelated threads.

Executed reproduction:

- Create a separate ordinary thread in the fixture project.
- During the fake provider's fork request, emit an `item/started` on that unrelated thread containing an exact prior-brief paste plus legitimate text. Allow event processing while the reservation is active, then throw before returning a fork response.
- Observe the application's published event emitter. The unrelated event never arrives.
- Emit the same content with a fresh item ID after the failed request. It arrives unchanged.

```text
provider failure observed Fixture fork failed before response
unrelated matching event delivered during failed fork false
same payload delivered after reservation true
```

This is event loss, not demonstrated deletion of the provider transcript. A later read may recover the message, but a fork failure must not silently consume another conversation's live update. Reserve candidate history without treating content resemblance as authority to discard unrelated thread events.

## What passed

The six additional fixture executions and inspected source support the following:

- Copy manifests and proof rows commit together. Proof binds destination thread, turn ID, item ID, complete message-content hash, inserted-context hash and registered origin generation.
- Protected messages must match at the corresponding source turn and user-message position. Remapped destination IDs and summary-only response hydration work in the tested layouts.
- Current and retired generations project correctly. Fork-of-fork inherits only proven copied messages, with no inherited thread-wide fingerprint allowlist.
- Normal fork response, read, early announcement, item event, search and reopened-database projection remove one host insertion. Exact pasted prior briefs and fresh authored tails remain visible and searchable.
- Project membership is checked before overlapping folder inference. Cross-project fork attempts fail; caller provenance fields are rejected; provider-supplied origin metadata does not grant projection authority.
- Earlier-answer boundaries, ordinary fork naming/source linkage and independent-thread semantics remain covered by existing UI/runtime checks.

My separate exact-copy reproduction against the new code passed for both fork response and subsequent read. I did not establish arbitrary provider transcript rewriting. Those copies intentionally reject, subject to the failed-candidate defect above.

Legacy forks without host-recorded proof do not receive inferred provenance. That is a documented limitation, not retroactive cleanup. Such legacy threads follow ordinary unproven projection; the implementation does not universally reject legacy forks. The documentation should continue to distinguish this from rejection of a newly attempted changed copy.

## Verification performed

Ran the three commands reported in `fork-projection-fix.md`:

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-fork-review-build
git diff --check
```

The first two suites passed 29 and 126 tests. The initial UI run passed 42 and failed one existing authoritative-renewal test at `tests/app.test.jsx:1855`, waiting for the mocked message submission. Rerunning the complete filtered UI suite alone passed all 43, with 142 skipped. Thus all **198 distinct tests have a passing result**, but the initial UI run was not clean. No source changes were made between runs, and the timeout is not established as an introduced product regression. The rerun log is `/tmp/pixice-fork-review-ui-rerun.log`.

Vite production build passed with the existing mixed-import and large-chunk warnings. UI runs emitted the Motion opacity warning. Diff check and individual syntax checks passed for the ten changed JavaScript modules. Additional Node fixture probes used isolated temporary storage and fake provider methods; their directories were removed after execution.

Production voice is still unwired. No real-provider fork/turn, live coordinator rotation, media, login, install, relaunch, commit, push or nested worker was used. No empirical claim about delegation drift is made. Only this review artifact and disposable verification outputs were written. Acceptance and `complete_work` remain with the coordinator.
