# Focus: one conversation that runs the project

Research and proposals, 22 September 2026. The user subsequently approved the core coordinator features. They are now implemented locally; see `focus-implementation.md` for delivered behavior, validation, and limits. The proposal text below preserves the original direction, including later possibilities such as subscriptions and host migration that are not part of this implementation. Reliability repairs are documented separately in `focus-coordinator.md`.

## Product direction

Focus should let someone use Pixice entirely through one persistent project conversation. The coordinator understands new requests, chooses whether to answer, continue existing work, or delegate, and brings results back. Creating threads, assigning workers, transferring context, and collecting outputs are its responsibilities. Workspace remains available for people who want direct control. Opening a worker is optional inspection, never a required step to finish ordinary work.

The project conversation has no permanent single objective. Several requests can overlap, a short question need not become a task, and a completed request does not complete the project.

## What the recent references establish

Cursor introduced Projects on September 10. Its coordinator delegates execution while staying available for direction, with project context shared among agents. Its documentation also describes requested subscriptions with a visible list of events being watched. These are useful interaction references, rather than evidence that very large agent counts improve every task. [Cursor announcement](https://cursor.com/blog/projects), [Projects documentation](https://cursor.com/docs/agent/projects).

Claude announced redesigned Projects on September 17. It describes directing work through a main conversation, routing to new or existing threads, accumulating shared memory, and collecting inputs and outputs in a library. The announcement describes cloud execution, with local execution forthcoming at publication. [Claude announcement](https://claude.com/blog/projects-redesigned).

A Cursor community response identifies the lack of a separate enforced worker-model default at that time. Another discusses demand for a local coordinator. These are specific qualitative signals, not a representative measure of user demand. They support exploring Pixice's existing strengths: independent providers, local projects, and connected hosts. [Worker model discussion](https://forum.cursor.com/t/projects-allow-to-choose-the-model-for-the-planner-and-a-different-default-model-for-subagents/171652/5), [Local execution discussion](https://forum.cursor.com/t/projects-coordinator-that-dispatches-to-local-agents-by-default-not-cloud-agents/171423).

The sources document a common interaction direction; they do not establish who invented project coordination. No authenticated competitor UI was inspected. The Claude Projects documentation URL was unavailable during this scan, so the Claude comparison relies on its announcement and help material.

## Highest-value additions

### 1. Keep the coordinator available while work runs

**Example:** “Fix the export problem.” Then, while a worker investigates: “Also compare our hosting options.” Then: “What's causing the export issue?”

The coordinator should accept and classify all three messages without requiring the first worker to finish. It answers the status question from observed progress, delegates the independent comparison, and avoids starting another export investigation. For long work it dispatches, acknowledges the outcome being pursued, and becomes available again. Workers return events that trigger synthesis or follow-up.

This is the highest priority after the reliability fixes. The current bridge's `spawn_thread` waits on a completion promise (`electron/runtime/pixice-bridge.mjs`). Steering a busy provider turn is not sufficient evidence of a responsive coordinator. Build explicit asynchronous dispatch, durable work identifiers, and a completion inbox before promising this behavior. Event-driven supervision should have no continuous model loop while idle.

**Acceptance:** send an unrelated second request during a long worker run; it receives a useful response without stopping the worker. Reconnect mid-run; the coordinator reconnects to the same work and processes each completion once.

### 2. Route follow-ups to the right work automatically

**Example:** “Make the second option quieter,” “Continue yesterday's onboarding work,” or “Pause the export changes until I test them.”

Track each substantive request's intended outcome, related workers, latest artifact, current state, and next action. Resolve references using the conversation and the selected Preview, retrieving detail only when needed. Continue an existing worker when it is appropriate. If two interpretations would materially change the work, show one concise disambiguation; do not ask the user to find a thread ID.

An optional compact activity disclosure can group work by outcome: Export repair, Hosting comparison. It should not present the user with a required agent-management board. Reuse the current Board only for durable work that deserves tracking, rather than copying every conversational request onto it.

**Acceptance:** a follow-up to a finished artifact produces a revision associated with the original request, without opening a duplicate investigation or taking the user out of Focus.

### 3. Apply a change of direction to every affected worker

**Example:** “We are postponing subscriptions. Finish onboarding first.”

The coordinator identifies affected work, updates the relevant shared decision, redirects or pauses those workers, and reports a compact result: “Subscription work is paused; onboarding continues.” It distinguishes messages sent from directions acknowledged. Completed or already published work must be reported honestly rather than treated as automatically reversible.

This makes project memory operational. A decision needs a revision, scope, source, and superseded status. A worker result produced under an old decision should be flagged for reconciliation before the coordinator presents it as current.

**Acceptance:** two workers using the old brief both acknowledge the changed scope; the unaffected worker continues. A late result from the old brief does not overwrite the newer result.

### 4. Deliver a reviewed outcome rather than a pile of worker replies

**Example:** “The export fix is ready to try. CSV and XLSX pass; the large-file case still needs testing.” The preview, diff, or download opens from the same response.

The coordinator owns integration and verification. It checks whether worker outputs satisfy the user's request, resolves disagreements or delegates targeted review, and presents one coherent result with evidence and remaining uncertainty. Failed work leads to a bounded recovery attempt or a concrete question, not a silent disappearance from the activity rail.

Prevent conflicts before dispatch where possible: identify shared files or prerequisites, sequence dependent work, and isolate independent edits in worktrees when needed. The coordinator owns the integration step. The user should not have to decide which two agents may safely edit the same checkout.

Use existing task receipts, Review, and Preview tabs. Give related artifact versions stable identities so “the latest version” is reliable. The goal is easy reuse of results; a new permanent library pane is not required.

**Acceptance:** a successful worker message with failing validation cannot mark the request done. Two conflicting edits are reconciled and tested before the coordinator reports a combined result. Publishing or merging remains subject to the user's authority.

### 5. Ask only for decisions the user needs to make

**Example:** three workers need the same terminology decision. Focus asks once, explains the consequence, and shares the answer with all three.

Resolve routine implementation questions from project context and prior decisions. Deduplicate equivalent blockers and present a recommendation with a short reason when user judgment is required. Track where the decision is needed and retire obsolete questions if the work changes. The coordinator should distinguish waiting for the user, waiting for another task, and provider failure.

**Acceptance:** one answer unblocks all linked requests. A worker that disappears cannot leave an unresolvable input request. An expired question review becomes a visible, actionable state rather than an indefinite hidden wait.

### 6. Make effort and execution location intentional

**Example:** “Use Sol to implement it and Claude to critique the interaction,” or “Work locally; use at most two workers.”

Keep separate persisted policies for the coordinator and its workers. Choose execution hosts based on the tools and project access the work requires, within a user-approved set. Enforce concurrency limits in the scheduler rather than hoping the model follows a sentence. Offer a quiet project usage view and distinguish cost estimates from provider-reported usage.

Closing the client should not interrupt work on an available backend. A sleeping local host cannot promise continued execution; show where work runs and what happens when that host disconnects. Migration to another host requires actual context and file transfer, not a cosmetic host switch.

**Acceptance:** a concurrency limit of two holds even when several dispatches race. A failed provider does not take down healthy workers. Switching a coordinator model does not silently switch worker providers or permissions.

### 7. Give useful continuity when the user returns

**Example:** “Since you left: export is fixed, hosting research is ready, and onboarding needs one decision.”

Produce a short change summary from durable outcome and artifact state, only when something meaningful changed. Include links to the relevant result or decision in the existing conversation. A completion should not be announced again after every reconnect. “Why did we choose this?” should retrieve the actual decision and source, including what superseded an earlier choice.

This should work after a coordinator context reset as well as an app restart. Keep a bounded current brief and retrieve detailed history on demand rather than continually injecting every transcript into every worker.

**Acceptance:** the return summary is the same across devices and does not count already-seen results as new. The coordinator can cite an older decision after context compaction.

### 8. Turn explicit follow-through requests into visible subscriptions

**Example:** “Keep an eye on this PR until CI passes.”

Use Pixice Workflows and existing event infrastructure to define the trigger, allowed action, permission mode, duration, retry policy, and stop condition. Expose enabled watches in a quiet disclosure beside the conversation. A scheduled task or an interesting repeated pattern does not implicitly authorize unattended execution. Ask for creation/enabling authority through the existing reviewable workflow process when the user's request has not already supplied it.

This is a later layer, after dispatch, resumption, and outcome ownership are dependable. Avoid idle polling loops and duplicate subscription systems.

**Acceptance:** a repeated event cannot dispatch duplicate fixes; reaching the requested stop condition disables the watch; revoking it prevents future dispatches without pretending to undo completed external actions.

## Delivery sequence

1. **Reliability baseline:** first prompt, per-provider reconnect, valid model selection, preserved history, revision-safe memory, and actionable errors. Sol's local repairs establish this baseline; the reported device still needs a retest.
2. **Core Focus experience:** asynchronous supervision plus follow-up routing and scoped steering. A person can complete several overlapping requests entirely within one conversation.
3. **Trusted delivery:** integration/verification, decision deduplication, artifact continuity, and a return summary.
4. **Controlled autonomy:** provider/host/concurrency policies and explicitly enabled subscriptions.

The order is a product judgment grounded in the current implementation, not a claim of measured user demand. Do not begin with more chrome, agent personas, a new dashboard, or large autonomous fleets. The central acceptance test is whether the user can ask, redirect, decide, and receive completed work without organizing threads.

## Proposed measures

- Median and p95 time to a useful coordinator response while workers run.
- Fraction of multi-step requests completed without opening a worker thread; optional inspections should remain available.
- Incorrect follow-up routing and duplicate-dispatch rate.
- Worker continuation and completion-delivery success after reconnect.
- Time from a changed decision to acknowledgment by all affected workers.
- Fraction of reported completions with applicable verification evidence.
- User clarification burden, with wrong assumptions tracked alongside it.
- Provider usage per completed outcome, plus idle supervision usage.

These are measurement proposals. No baseline values or performance targets have been measured in this investigation.
