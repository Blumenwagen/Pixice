# Loom

Loom is a cross-platform Electron client for orchestrating coding agents through a central lead-agent conversation and a live hierarchy of delegated agents.

## What is implemented

- RedThread-derived expandable navigation rail with persisted local Projects, real Codex task history, lead conversation, plans, tool activity, global attention, agent hierarchy, and task inspection.
- Working new/continued task flow, streaming assistant output, steering, interruption, approvals, real Git review, model selection, and live Skills, Apps, and MCP capability views.
- Provider-owned threads routed through one registry, with Codex app-server and an initial Claude Agent SDK adapter using long-lived sessions, resumable cursors, and native approval requests.
- Electron main/preload/renderer isolation with a narrow `window.loom` bridge and renderer sandboxing.
- One-session stdio JSONL app-server client with correlation, initialization, event normalization, capability gating, recoverable errors, and restart backoff.
- Loom-owned additive developer guidance for its private Codex app-server process, while preserving Codex defaults and project `AGENTS.md` instructions.
- Thread-isolated preview workspaces with separate browser tabs and persistent sessions, plus per-thread project-file editor tabs and unsaved drafts.
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

### Install a local macOS build

After `pnpm build:desktop`, install and relaunch the arm64 app with:

```bash
pnpm install:local:macos
```

The installer stages the new bundle, waits for the current Loom process to quit, preserves the installed app as a timestamped backup, swaps the bundle atomically, and relaunches Loom once. It uses a detached one-shot worker; do not replace it with `launchctl submit`, because macOS can infer `KeepAlive` for submitted script jobs and create a permanent relaunch loop.

## Codex runtime release gate

Development UI works without a bundled runtime and reports a recoverable runtime-unavailable state. A production release must place both the pinned `codex` binary and its sibling `codex-code-mode-host` under `resources/runtime/<platform>/`, update `resources/runtime/manifest.json` with their exact version and SHA-256 values, generate protocol bindings from that same runtime, and pass `pnpm runtime:verify`.

## Claude runtime

Packaged Loom builds can sign in to Anthropic from **Settings → Providers** or directly from the Claude tab in the model picker. Loom also reuses credentials from an installed Claude Code CLI. It resolves `claude` from `PATH` and the usual macOS and per-user install locations; `LOOM_CLAUDE_PATH` selects an explicit executable. When no external CLI is present, Loom falls back to the platform executable bundled and unpacked with the Claude Agent SDK.

## App updates

Packaged Loom builds check the `Blumenwagen/Loom` GitHub Releases feed in the background. Pushing a version tag that matches `package.json` (for example `v0.1.0`) builds all supported platforms, publishes the installer and electron-builder update metadata to a GitHub Release, and makes that version available from **Settings → Updates**. Signing credentials and a non-placeholder bundled Codex runtime are still required by the release gate.

In development, Loom automatically uses a `codex` executable found on `PATH`; `LOOM_CODEX_PATH` can still select an explicit binary. See [`PLAN.md`](PLAN.md) for the complete implementation and release roadmap.

The current manifest intentionally contains release-blocking placeholders so an unpinned or incomplete runtime cannot be published accidentally. Signing credentials, application icon assets, OpenAI app-server client registration, license notices, and platform update credentials are also release inputs rather than repository defaults.
