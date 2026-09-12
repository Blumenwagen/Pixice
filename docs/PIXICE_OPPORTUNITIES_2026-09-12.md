Pixice opportunity map, 12 September 2026

I would invest in making agent work easier to inspect, reference, and redirect. Pixice already has side threads, answer forks, agent activity, task receipts, model replay, native visualizations, Instruments, previews, and background execution. The next gains can come from connecting those capabilities around the user's actual work.

This exploration brief combines source inspection, the current project Board, and a look at the running interface. Performance items are hypotheses to measure. No benchmarks or product tests were run for this review.

**The first investments I would choose.**

| Order | Investment | Smallest useful release | Why it comes first |
| --- | --- | --- | --- |
| 1 | Precise references between Preview and chat | Select a file range or diff hunk and attach it to a prompt with its resource identity and revision | Makes everyday requests shorter and gives agents better inputs. Extend later to page elements and image regions. |
| 2 | Cross-provider agent coordination | Inspect, message, follow up with, and interrupt a bridge child through a durable job handle | Makes a lead agent able to manage ongoing work across connected providers. |
| 3 | Structured verification evidence | Register checks against the workspace revision they tested, with captured output and a link to the originating run | Makes task receipts useful for acceptance and for other agents. |
| 4 | Visual progress and an artifact shelf | Show the current activity, latest meaningful update, pending decision, and outputs beside the conversation | Reduces the need to read a long tool log to understand what is happening. |
| 5 | Long-thread performance | Measure long histories and multiple active agents, then address the largest measured cost | Visual features will add content. The conversation needs to remain responsive as it grows. |

Browser target reliability and contradictory execution status deserve investigation alongside these investments. They are correctness concerns that can undermine richer agent interactions.

**Agent capabilities.** These proposals extend the native Pixice tools. They do not assume the underlying providers lack their own collaboration or history tools.

| ID | Opportunity | Concrete first version |
| --- | --- | --- |
| A1 | Manage bridge children | Return a handle immediately when requested. Add inspect, message, follow-up, interrupt, and wait operations, scoped to the owning thread and its descendants. |
| A2 | Deliver child progress to the parent agent | Give updates an event ID and delivery state. Distinguish display in the UI from delivery to the parent's runtime. Let a child flag a blocker before it finishes. |
| A3 | Structured delegation briefs | Attach objective, acceptance criteria, relevant message references, resources, file ownership, and an expected output format to an assignment. Keep a readable prompt representation. |
| A4 | Detect overlapping assignments | Show which agents intend to edit which files. Warn on overlaps and offer an isolated worktree where appropriate. File ownership is a coordination aid unless enforcement is explicitly implemented. |
| A5 | Durable handoffs | Save the accepted decisions, current state, evidence, and remaining work for a child or replacement agent. Include source links and let the user inspect what will transfer. |
| A6 | Query task evidence | Let agents read receipts, check records, captured changes, and artifact metadata without scraping the conversation or database. |
| A7 | Register artifacts | Give generated files, images, reports, previews, and builds stable IDs, types, versions, and originating task references. Agents can update or compare them without relying on prose paths. |
| A8 | Bounded event subscriptions | Let agents wait for a build, child task, browser condition, or user decision through an event handle. Support timeout and cancellation so waiting does not require repeated polling. |
| A9 | Reusable verification sessions | Expose a bounded way to start a project preview, inspect its readiness and logs, capture evidence, and stop only the processes created for that session. |
| A10 | Explain available capabilities | Return what this particular agent can use now, including provider support, project boundaries, missing dependencies, and why an operation is unavailable. |
| A11 | More reliable browser actions | Tie an action to the inspected page and element identity. Reject a stale target, then offer a fresh inspection. Add keyboard, hover, drag, and wait-for-state operations after that foundation. |
| A12 | Project decisions agents can retrieve | Store user-approved decisions with scope, source messages, superseded state, and optional expiry. Distinguish an accepted preference from an agent's assumption. |

**Visual conversations and threads.** Use views of the same underlying work so users can change presentation without losing provenance.

| ID | Opportunity | Concrete first version |
| --- | --- | --- |
| V1 | A compact live task overview | Show the goal, current activity, last meaningful progress update, and anything waiting for the user. Use observed states instead of invented percentage completion. |
| V2 | An artifact shelf | Collect this thread's outputs with thumbnails, version labels, open/compare actions, and links to the producing messages. |
| V3 | Visual decisions | Let an agent offer image alternatives, document excerpts, or diff hunks as selectable options. Preserve a free-text answer and show exactly what a choice approves. |
| V4 | Annotate what you mean | Select text, mark an image region, or point at a Preview element. The prompt shows a reference chip that can reopen the selected object. |
| V5 | Before-and-after comparison | Compare screenshots, image revisions, text revisions, and changed UI states in chat or Preview. Provide the source revision and capture time. |
| V6 | Navigable conversation chapters | Extend the existing prompt rail with decisions, milestones, outputs, and user bookmarks. Every entry jumps to the original message. |
| V7 | A map of related threads | Show why a thread exists, its parent or fork, its current assignment, and what it returned. Keep the existing list useful when the hierarchy is small. |
| V8 | A catch-up view | On demand, show what changed since the user last read the thread, unresolved decisions, and new outputs. Link each statement to its source. |
| V9 | Evidence in the answer | Render references to tests, files, screenshots, and citations as small inspectable cards. Separate a successful check from an agent's assertion. |
| V10 | Progress updates with stronger hierarchy | Make the latest outcome or blocker easy to spot while preserving expandable tool detail. The current live view gives a great deal of space to command rows. |

**How users work with agents.** These are interaction improvements, separate from the Workflows feature.

| ID | Opportunity | Concrete first version |
| --- | --- | --- |
| U1 | An editable follow-up queue | Offer explicit choices to steer now or send after the current turn. Show queued messages, allow reordering or removal, and confirm when the runtime has received them. |
| U2 | Pause at a useful boundary | Ask an agent to finish its current bounded operation, record a handoff, and stop before the next step. Keep immediate interruption available and show when a graceful pause is unsupported. |
| U3 | Search across project conversations | Start with local full-text search over messages and titles, with filters for files, errors, decisions, outputs, and dates. Add semantic retrieval only if it improves actual search tasks. |
| U4 | Bring a side-thread conclusion back | Preview a compact handoff into the main thread, including the source answer and relevant decisions. The user selects what to carry forward. |
| U5 | Show the context being sent | Display attached references, active Preview selection, project guidance sources, and explicit handoff material before submission. Avoid claiming visibility into hidden provider context. |
| U6 | Separate questions from permission decisions | Keep each interaction attached to its relevant evidence and show whether it blocks work. Offer a project-level list of pending questions without silently changing the current approval-only Attention policy. |
| U7 | Review selected changes | Select a diff hunk or file and send a targeted comment to the responsible thread. A later extension could propose a reversible restoration while preserving concurrent edits. |
| U8 | Task budgets and stopping rules | Let the user set time, spend, and escalation preferences. Label usage estimates and provider coverage clearly. Enforce hard limits only where the runtime can support them. |
| U9 | Distinguish run completion from acceptance | A stopped agent can still have unresolved work. Let the user accept the outcome, request a revision, or reopen the task with its evidence attached. |
| U10 | Keyboard access to the next useful action | Add predictable navigation among pending decisions, changed files, current agents, and outputs. Give icon-only actions discoverable labels and shortcuts. |

**Improvements to agent-created Tools and future directions.**

| ID | Opportunity | Concrete first version |
| --- | --- | --- |
| T1 | Live sources for agent work | Add bounded Instrument sources for thread status, child assignments, receipts, pending questions, usage, and diagnostics. Agents can then build useful project controls from current state. |
| T2 | Proposed revisions to pinned Tools | Let an agent prepare a new version and a readable diff for user acceptance. Preserve the current protection against silent changes to pinned definitions. |
| T3 | Turn an inline result into a Tool | Let the user promote a useful visualization or result view into a persistent Tool with explicit parameters and sources. Reuse its content instead of recreating it. |
| T4 | Model recommendations based on local outcomes | Extend existing replay and receipts with user acceptance, retries, duration, and cost for comparable tasks. Show sample sizes and uncertainty. Keep the user's model choice explicit. |
| T5 | Reusable working preferences | Save named combinations of model, effort, relevant Skills, review expectations, and stopping rules. Preserve permission boundaries and show what each preference changes. |
| T6 | A guided first real task | Help a new user complete a small task in their own project, find its output, and give a targeted revision. Contextual discovery can expose existing features at the moment they help. |

**Performance and reliability investigations.** These are source-backed candidates, not measured bottlenecks. Existing frame batching, projection caches, tool-result compaction, and Preview eviction should be preserved.

| ID | Candidate | Source evidence | Measurement and likely benefit |
| --- | --- | --- | --- |
| P1 | Window or progressively mount old turns | The conversation maps all turns to components in [App.jsx](/Users/blumenwagen/Developer/Loom/src/App.jsx:3859). | Compare scrolling, typing latency, DOM size, and memory at increasing history sizes. Preserve selection, search, anchors, and scroll position. |
| P2 | Reduce scroll-related geometry reads | Active prompt detection walks prompt anchors and calls `getBoundingClientRect`; layout effects also follow streaming changes in [App.jsx](/Users/blumenwagen/Developer/Loom/src/App.jsx:3711). | Measure layout time while streaming and scrolling. Consider observed/cached positions and recompute them only when content geometry changes. |
| P3 | Narrow subscriptions and render boundaries | Runtime deltas commit to the top-level thread state in [App.jsx](/Users/blumenwagen/Developer/Loom/src/App.jsx:5906). The same file contains conversation, settings, review, and coordination code. | Use React profiling to find unrelated rerenders during several concurrent agents. Extract cohesive modules and subscribe consumers to stable slices where evidence warrants it. File length alone is not a performance diagnosis. |
| P4 | Avoid full history reads for simple status | Child monitoring can request full turns in [application.mjs](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:1741). | Measure request count, payload bytes, and hydration time for many children. Prefer summary/status data and fetch transcript pages when the provider supports it. |
| P5 | Bound receipt loading and storage growth | `records()` reads and parses every receipt in [task-results.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/task-results.mjs:98). [The result guide](/Users/blumenwagen/Developer/Loom/docs/task-results.md) documents retained snapshots and attachments without automatic cleanup. | Measure opening and listing results at realistic scale. Query summaries by project and page; load evidence on demand. Offer explicit retention and storage inspection with protection for active/referenced data. |
| P6 | Read independent Instrument sources concurrently | Instrument hydration awaits sources one by one in [instrument-service.mjs](/Users/blumenwagen/Developer/Loom/electron/instruments/instrument-service.mjs:437). | Compare total refresh latency for independent delayed sources. Use bounded concurrency and preserve per-source errors and freshness. |
| P7 | Persist and reconcile child delivery state | Bridge pending jobs and parent continuation state live in memory in [pixice-bridge.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/pixice-bridge.mjs:128) and [bridge-parent-continuation.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/bridge-parent-continuation.mjs:21). | Exercise backend restart and reconnect during child work. Recover ownership and delivery state without duplicate messages or automatically starting new paid work. |
| P8 | Keep run and node status consistent | During this review, the background review run appeared as failed with a running agent node. It later returned completed output with the old shutdown error still attached. [workflow-store.mjs](/Users/blumenwagen/Developer/Loom/electron/workflows/workflow-store.mjs:141) marks running runs failed during startup. | Reproduce with UI/backend reconnects and establish the owning process before marking work abandoned. Clear obsolete errors when a run completes successfully. The observed transitions do not establish the triggering cause. |
| P9 | Batch high-frequency progress updates | [Backend batching](/Users/blumenwagen/Developer/Loom/electron/backend/application.mjs:285) and [renderer batching](/Users/blumenwagen/Developer/Loom/src/App.jsx:5915) cover assistant text deltas. Other event types flush immediately. | Count progress events and React commits during reasoning/tool-heavy work. Coalesce updates only where their semantics allow it; retain lifecycle boundaries and all required output. |
| P10 | Avoid reparsing settled messages in an active turn | [MarkdownMessage](/Users/blumenwagen/Developer/Loom/src/App.jsx:1838) parses its content during render. [TurnConversation](/Users/blumenwagen/Developer/Loom/src/App.jsx:2647) already skips unchanged turns, but the active turn changes during streaming. | Profile parse and render time by active-turn length. Memoize unchanged messages or isolate the live message while preserving Markdown correctness during partial output. |
| P11 | Reduce history-wide snapshot reconciliation | [mergeThreadSnapshot](/Users/blumenwagen/Developer/Loom/src/state/runtime.js:225) scans turns and may search by content fingerprint when IDs do not match. | Measure merge duration and allocations as histories grow. Prefer stable IDs and explicit revisions; preserve recovery behavior for optimistic messages and provider ID changes. |
| P12 | Cache renderer projections at a useful boundary | [Renderer projection](/Users/blumenwagen/Developer/Loom/electron/runtime/renderer-thread-projection.mjs:36) scans and maps tool-bearing snapshots. Existing guards already leave many non-tool items untouched. | Measure projection time and bytes for item, turn, and full-thread events. Cache immutable projections or project changed objects rather than repeating full snapshot work. |
| P13 | Compare streaming delivery with current remote polling | [ApplicationClient](/Users/blumenwagen/Developer/Loom/electron/connect/application-client.mjs:58) uses long polling. The [Connect server](/Users/blumenwagen/Developer/Loom/electron/connect/server.mjs:273) already offers an SSE endpoint. | Compare event latency, request count, CPU, and reconnect behavior. Preserve authentication, event ordering, cursor recovery, and a fallback for networks that buffer streams. Long polling already waits for events, so any latency gain must be measured. |
| P14 | Reduce persistence work as active turns grow | [Provider persistence](/Users/blumenwagen/Developer/Loom/electron/persistence/database.mjs:1310) serializes full snapshots or active turns into synchronous SQLite writes. | Measure serialization time, write duration, and backend event-loop lag. Consider smaller records or adjusted checkpointing without weakening crash recovery. |
| P15 | Aggregate usage without rereading every event | [getUsageSummary](/Users/blumenwagen/Developer/Loom/electron/persistence/database.mjs:1442) loads the entire usage table and computes several totals in JavaScript. | Measure summary time as event count grows. Use indexed range aggregates and cached daily/all-time totals while retaining exact unpriced-event and timezone behavior. |

For a performance baseline, vary history length, concurrent agent count, open previews, and local versus remote connection. Record p50 and p95 time to an interactive thread, composer input latency, renderer commit time, process memory, event bytes, and lost or duplicated events. Define numerical targets after measuring the baseline. Do not optimize by dropping correctness-critical lifecycle events.

Electron's [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance) supports measuring work in each process, avoiding blocking work in the main process, and loading expensive code when needed. React's [external-store API](https://react.dev/reference/react/useSyncExternalStore) is one possible way to subscribe to stable external snapshots, not a guarantee of faster rendering. For browser interaction design, Playwright's [locators](https://playwright.dev/docs/locators) and [actionability checks](https://playwright.dev/docs/actionability) are useful references for target resolution and waiting for valid interaction states. Adopting Playwright itself is a separate implementation decision.

**What the source review actually established.**

- The native cross-provider bridge has model listing, synchronous-to-completion spawn, and progress update operations. It has no corresponding child inspection, message, follow-up, or interrupt operations in that tool schema. See [pixice-bridge.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/pixice-bridge.mjs:20).
- `send_update` reports delivery through its result, but its implementation publishes an activity event. Completed children have a separate parent continuation path. This makes delivery semantics an especially concrete improvement. See [the update implementation](/Users/blumenwagen/Developer/Loom/electron/runtime/pixice-bridge.mjs:287) and [parent continuation](/Users/blumenwagen/Developer/Loom/electron/runtime/bridge-parent-continuation.mjs:48).
- Preview context contains tab/resource metadata. It does not include a selected text range, image region, DOM element, or diff hunk in that metadata contract. See [preview-context.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/preview-context.mjs:42).
- Browser inspection enumerates current elements. Click and type independently enumerate the live DOM again and index into it. A changing page can therefore change what an index refers to. See [browser-workspace.mjs](/Users/blumenwagen/Developer/Loom/electron/browser/browser-workspace.mjs:426).
- Verification evidence identifies check-like commands through a regular expression. Compound commands are deliberately unconfirmed. See [task-results.mjs](/Users/blumenwagen/Developer/Loom/electron/runtime/task-results.mjs:41). A future registration API must preserve the difference between agent-submitted claims and independently captured execution evidence.
- Instruments already support local controls, graphs, tables, diffs, agent events, and bounded live sources. Current source types do not include thread/agent status, task receipts, or pending questions. See [instrument-model.mjs](/Users/blumenwagen/Developer/Loom/electron/instruments/instrument-model.mjs:66).
- Task receipts and model replay already exist. Their documented limits include concurrent edits in captured diffs, incomplete capture of environment state, and earlier checks that may predate current changes. See [task-results.md](/Users/blumenwagen/Developer/Loom/docs/task-results.md).
- The prompt rail and a task map already exist. The current task map presents plan and agent lists, which gives a starting point for richer relationships and navigation. See [PromptPreviewRail.jsx](/Users/blumenwagen/Developer/Loom/src/components/PromptPreviewRail.jsx:9) and [TaskMapPreview](/Users/blumenwagen/Developer/Loom/src/App.jsx:3552).

**A practical sequence.** Start with precise file/diff references, truthful bridge delivery status, a small artifact shelf, and the performance baseline. Then add child management and revision-aware evidence. Use those references and records to support visual decisions, handoffs, and richer task views. Memory, adaptive model recommendations, and automatic task routing need stronger evaluation because incorrect carryover or routing can cost more than the interaction they save.

I would keep visual additions selective. A decision, output, or comparison deserves a visual form when it reduces effort. Routine text can stay text. All presentations should point back to the same thread, resource, and execution records.
