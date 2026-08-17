# Loom

Loom is a cross-platform Electron client for orchestrating Codex through a central lead-agent conversation and a live hierarchy of delegated agents.

## What is implemented

- RedThread-derived expandable navigation rail with persisted local Projects, real Codex task history, lead conversation, plans, tool activity, global attention, agent hierarchy, and task inspection.
- Working new/continued task flow, streaming assistant output, steering, interruption, approvals, real Git review, model selection, and live Skills, Apps, and MCP capability views.
- Electron main/preload/renderer isolation with a narrow `window.loom` bridge and renderer sandboxing.
- One-session stdio JSONL app-server client with correlation, initialization, event normalization, capability gating, recoverable errors, and restart backoff.
- SQLite storage for Loom-owned Project, Task, and TaskViewState metadata.
- Git repository inspection, safe worktree helpers, clean-only worktree removal, and read-only diff access.
- Tray lifecycle, native notifications, quit warning, external-open actions, packaged-build configuration, release matrix, and checksum enforcement.
- Original rounded Loom Observatory application icon wired into the renderer and desktop packaging.

## Local development

```bash
pnpm install
pnpm dev
```

Use `pnpm dev:electron` to run the renderer inside Electron. `pnpm check` runs unit tests, the production renderer build, and Sites packaging checks.

## Codex runtime release gate

Development UI works without a bundled runtime and reports a recoverable runtime-unavailable state. A production release must place the pinned Codex binaries under `resources/runtime/<platform>/`, update `resources/runtime/manifest.json` with the exact version and SHA-256 values, generate protocol bindings from that same binary, and pass `pnpm runtime:verify`.

In development, Loom automatically uses a `codex` executable found on `PATH`; `LOOM_CODEX_PATH` can still select an explicit binary. See [`PLAN.md`](PLAN.md) for the complete implementation and release roadmap.

The current manifest intentionally contains release-blocking placeholders so an unpinned or incomplete runtime cannot be published accidentally. Signing credentials, application icon assets, OpenAI app-server client registration, license notices, and platform update credentials are also release inputs rather than repository defaults.
