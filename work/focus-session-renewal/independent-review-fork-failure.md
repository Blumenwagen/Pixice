# Fork failure-path re-review

Review work `d5a03108-0a5b-46cf-a11d-52624ef38f30`, original outcome `36115ebb-f615-42db-9960-977fba34dfee`. Direction r1 was reread and acknowledged. Review performed with disposable databases and fake providers. No implementation edits.

Recommendation: request changes. Both earlier reproductions now pass, but the durable provider-wide unresolved guard introduces a material usability regression. Documentation alone does not make that tradeoff acceptable under the user's preference for minimal friction and actionable failures.

## P2 blocker: one failed fork indefinitely hides unrelated external conversations

The guard in [provider-registry.mjs](/Users/blumenwagen/Developer/Loom/electron/providers/provider-registry.mjs:289) persists by provider, without a project boundary or expiry. After a failure before an authoritative response ID, an unknown identity from another project enters the original operation's quarantine. This also happens after service restart. The identity has no content-based connection to the fork.

Independent probe used the actual service and ApplicationClient with fixture providers:

1. Create project A, submit and complete a Focus turn.
2. Make its protected fork throw before returning or announcing any candidate.
3. Stop and reopen the service with the same disposable database.
4. Add an unrelated external provider conversation in project B's different folder and emit its thread announcement.
5. List and read project B, then create ordinary new conversations through Pixice on both providers.

Observed output:

```text
fork error: Independent fixture failure before identity Unknown provider identities remain quarantined for diagnosis because the fork returned no authoritative candidate ID.
unrelated external listed after restart: false
quarantine belongs to original project: true
external read error: This Focus fork candidate is quarantined. Its provider session is retained for diagnosis.
external announcement published: false
diagnostic event count for external: 0
raw external preserved: true
new host-created codex usable: true
other provider usable: true
provider guard still present: true
```

The probe remains at `/tmp/pixice-fork-failure-independent-probe.mjs`; its temporary service data was removed. An initial variant first attempted listing and then reading without an announcement. Its read also quarantined the external ID, before retrieving any provider snapshot. The final variant above uses an announcement and confirms raw snapshot preservation.

This is narrower than a complete provider outage. Previously known identities bypass holding, and successful independent `thread/start` or ordinary `thread/fork` responses add their IDs to the known set. The fixture confirms host-created new conversations remain usable. Another provider remains usable. Previously unknown external/imported conversations on the affected provider are the casualty, including ones from unrelated projects. Further protected forks on that provider reject with `A prior Focus fork has no authoritative candidate identity. Diagnose its retained provider sessions before another protected fork.`

### What the user sees and can recover

The original fork error reaches the renderer's `setError` in [App.jsx](/Users/blumenwagen/Developer/Loom/src/App.jsx:9830). A direct read returns the quarantine error above. A list instead returns success with the conversation omitted. The renderer uses that returned list without quarantine information. Late quarantine in `#quarantineFocusForkIdentity` emits no diagnostic. Registry diagnostic emissions at initial failure are not wired to an application diagnostic event in the inspected runtime listeners, and the fixture observed no application notification for the later unrelated quarantine.

I inspected the exposed thread APIs in `electron/connect/protocol.mjs`, `electron/preload.cjs`, `src/pixice-api.d.ts` and the Connect facade. There is no quarantine inspection, resolution or recovery action. `getProviderThreadSnapshotForDiagnosis` is internal. A read/resume cannot release an ID; the registry rejects it before the provider request. Restart preserves the guard. Creating a different conversation is a workaround for new work, not recovery of the hidden conversation. Direct SQL editing is not a supported user recovery path and I did not perform it.

### Safest narrow remediation

Until the provider adapter can establish trustworthy creation identity on failure, gate protected forks before issuing the provider RPC for paths lacking that guarantee. Return an actionable unsupported-operation error there, while retaining protection for already quarantined candidates. This avoids creating new provider-wide unresolved incidents without releasing unverified context.

A fuller solution needs a persisted, visible incident with a supported reconciliation path based on trusted provider identity evidence. Resolve confirmed independent identities separately and terminate the operation only when the actual candidate or absence of creation is established. Add cross-project and restart regressions for that recovery path. Do not clear quarantine merely because time elapsed, a user clicked through, the folder differs, or the text looks harmless. Existing ambiguous incidents still need safe diagnosis; this review does not authorize releasing their transcripts.

## Earlier defects now pass

The actual submitted regressions reproduce both previous fixtures and passed in this review:

- `fails an unverifiable fork without publishing copied private history` covers rejection followed by read/list, summary/overview, later item/thread events, snapshot writes, search and reopened storage. The candidate remains failed and the provider session plus diagnosis snapshot remain recoverable.
- `delivers an unrelated exact-paste event during a fork that fails before returning any target identity` asserts the known unrelated thread's event arrives unchanged while the RPC is pending, exactly once. Read and subsequent event preserve it. The former content-based discard is gone.

Source inspection confirms response identity upgrades the candidate before copy validation. Copy proof, copied-thread manifest and candidate removal commit in the same database transaction. Internal operation authority is not accepted through renderer/Connect arguments. Other queued identities release once a target ID is established, even if its validation fails. Successful copied-message projection remains message-bound; this change adds no broad fingerprint inheritance.

The focused suite also exercises failure before response, early and late unidentified announcements, discovery by a concurrent list, summary hydration, current/retired/fork-of-fork history, spoof rejection, cross-project copy restrictions and accepted events during naming. Provider scoping of the unresolved guard is established in source and the independent probe; its lack of project scoping is the blocker above.

The queue enforces 64 events and 512 KiB of serialized event data. Count and byte overflow fixtures both reject the candidate and retain its protection. This is a bound on queued payloads, not all reservation state: known/identity/overflow sets, durable candidate rows and diagnosis snapshots have no corresponding count/size bound. In particular, an unresolved operation can keep accumulating newly observed identities. That reinforces the need to end incidents through supported reconciliation rather than treating this as a complete bounded recovery design.

## Verification performed

All current runs passed on their first execution in this continuation:

```sh
pnpm exec vitest run --config work/focus-session-renewal/vitest.config.mjs
pnpm exec vitest run tests/focus-store.test.js tests/focus-supervisor.test.js tests/focus-coordination-tools.test.js tests/focus-visuals.test.js tests/pixice-focus-memory.test.js tests/thread-session-registry.test.js tests/database.test.js tests/provider-registry.test.js tests/claude-provider.test.js tests/codex-provider.test.js tests/renderer-thread-projection.test.js tests/bridge-parent-continuation.test.js
pnpm exec vitest run tests/focus-coordination.test.jsx tests/focus-coordinator-questions.test.jsx tests/app.test.jsx -t 'Focus|slash|commands|fork'
pnpm exec vite build --outDir /tmp/pixice-focus-failure-review-build
git diff --check
```

Results: 37 + 132 + 43 = **212 distinct passing tests**, 142 unrelated UI tests skipped. Vite production build passed. Existing Motion opacity, mixed App import and large chunk warnings remain. The independent service probe above was additional to these tests. Passing tests establish the covered behavior; they do not establish acceptable recovery for unrecognized external sessions.

The verified core renewal foundation was not reopened beyond regression checks. Production voice remains unwired, and real-provider fork, delegation and voice behavior remain unproven. No live provider turn, rotation, media, nested worker, publication, commit, install or relaunch occurred. Acceptance and `complete_work` remain coordinator-only.
