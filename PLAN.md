# Pixice implementation plan

## Product outcome

Pixice is a local desktop control surface for Codex work. A user opens a local project, sees the real Codex tasks associated with that project, starts or continues work, follows live agent/tool/plan activity, resolves approvals, and reviews the resulting Git changes without leaving the app.

The lead conversation is the source of truth. Delegated agents appear as a hierarchy beneath it; Pixice does not invent a second orchestration model on top of Codex.

## Architecture contract

- **Renderer:** React presents projects, tasks, conversation history, plans, activity, approvals, agents, and Git review state. It never receives Node.js access.
- **Preload bridge:** `window.loom` is the only renderer-to-main boundary. Every privileged call is named and validated.
- **Electron main:** owns dialogs, local persistence, Git access, external app actions, and the Codex runtime lifecycle.
- **Codex runtime:** one `codex app-server` JSONL session is initialized at app startup. The installed Codex binary is used in development; signed, checksum-pinned `codex` and `codex-code-mode-host` binaries are bundled together for releases.
- **Persistence:** SQLite stores Pixice-owned project metadata and view state. Codex remains authoritative for thread and turn history.
- **Git:** Pixice reads status and diffs directly. Isolated worktrees are optional task execution environments and may only be removed when clean.

## Delivery phases

### Phase 1 — functional vertical slice

- Replace demo projects and tasks with SQLite projects plus `thread/list` results filtered by project working directory.
- Open projects through the native folder picker and persist them without duplicate-path failures.
- Create a real Codex thread, start turns with the selected model and effort, continue existing threads, and interrupt active turns.
- Read complete thread history and project user/assistant messages, plan items, tool activity, and delegated-agent activity into the UI.
- Stream app-server notifications into the active task, including assistant deltas, plan updates, item lifecycle, turn completion, thread status, and attention requests.
- Resolve command and file-change approvals through their original JSON-RPC request IDs.
- Read the real project Git diff and dirty-file state in Review.
- Load real models, skills, apps, and MCP server status where the runtime exposes them.
- Use a RedThread-derived expandable navigation rail: inset canvas, deep violet frame, warm red thread indicator, large radii, grouped hierarchy, clear hover/pinned expansion, and reduced-motion support.
- Provide loading, empty, disconnected, error, active, interrupted, and completed states.

### Phase 2 — resilient task workspace

- Persist selected project/task, unread counts, inspector state, and per-task review preferences.
- Add pagination, search, archive/unarchive, task naming, and recent/attention filters.
- Connect isolated-worktree creation to new-task setup with an explicit execution-mode choice.
- Track pre-existing dirty files at task start and distinguish them from agent changes.
- Add structured tool cards, command output streaming, file-change summaries, and user-input request forms.
- Restore active tasks after restart and reconcile interrupted runtime sessions.

### Phase 3 — full orchestration experience

- Render complete nested agent ancestry with live status, latest activity, model, effort, and handoff context.
- Add agent steering, targeted follow-ups, interrupt/resume, and selected-agent transcript inspection.
- Add task-map and timeline views derived from plans, tool calls, and collaboration events.
- Implement attention inbox, native notification routing, and unread state across projects.
- Finish Extensions management for skills, plugins/apps, MCP authentication, policy visibility, and safe enable/disable flows.
- Add integrated Codex review, per-file comments, and handoff/export flows.

### Phase 4 — release readiness

- Generate and commit protocol bindings from the exact pinned Codex runtime version.
- Bundle and checksum runtime binaries for every supported platform.
- Add database migrations, recovery tests, runtime compatibility tests, and Electron IPC integration tests.
- Add signing/notarization, updater credentials, license notices, crash diagnostics, and release-channel policy.
- Verify accessibility, keyboard operation, reduced motion, long-content behavior, and all supported viewport sizes.

## Phase 1 acceptance criteria

1. A fresh launch can open a local Git repository and show it in the sidebar after restart.
2. Selecting a project lists its real Codex threads; selecting a thread loads its real history.
3. New Task creates a real thread and the first message produces streamed Codex output.
4. Plan and delegated-agent activity update without refreshing the window.
5. Interrupt stops the active turn; approval decisions resume blocked work.
6. Review displays the repository's actual diff and dirty-file warning.
7. The app remains useful when Codex is unavailable, with a clear recovery state and no fabricated activity.
8. Unit tests, production renderer build, Sites packaging, and an Electron smoke path pass.

## Non-negotiable safety rules

- Never remove a dirty worktree.
- Never expose raw filesystem or process execution primitives to the renderer.
- Validate all IPC payloads and keep external-open targets scoped to a known project or task path.
- Never present demo data as real runtime state.
- Production packaging fails when runtime binaries or checksums are missing.
