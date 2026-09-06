# Pixice

Pixice is a cross-platform Electron client for orchestrating coding agents through a central lead-agent conversation and a live hierarchy of delegated agents.

## What is implemented

- RedThread-derived expandable navigation rail with persisted local Projects, real Codex task history, lead conversation, plans, tool activity, global attention, agent hierarchy, and task inspection.
- Working new/continued task flow, streaming assistant output, steering, interruption, approvals, real Git review, model selection, and live Skills, Apps, and MCP capability views.
- Provider-owned threads routed through one registry, with Codex app-server and an initial Claude Agent SDK adapter using long-lived sessions, resumable cursors, and native approval requests.
- Electron main/preload/renderer isolation with a narrow `window.pixice` bridge and renderer sandboxing.
- One-session stdio JSONL app-server client with correlation, initialization, event normalization, capability gating, recoverable errors, and restart backoff.
- Pixice-owned additive developer guidance for Codex and Claude, including optional Agent Behavior packs, while preserving each runtime's defaults and native project instructions.
- Thread-isolated preview workspaces with separate browser tabs and persistent sessions, plus per-thread project-file editor tabs and unsaved drafts.
- Native Instruments authored by Codex or Claude as strict JSON, with persistent Preview tabs, typed launch inputs, event-refreshed project data, agent events, and a searchable Project Tools library with narrowed grants, revision restore, and confirmed board or workflow actions.
- SQLite storage for Pixice-owned Project, Task, and TaskViewState metadata.
- Git repository inspection, safe worktree helpers, clean-only worktree removal, and read-only diff access.
- Tray lifecycle, native notifications, quit warning, external-open actions, packaged-build configuration, release matrix, and checksum enforcement.
- Pixice's coral pixel-crystal application icon wired into the renderer and desktop packaging.

## Remote access

Open **Settings → Connections** to enable Pixice Connect, create an HTTPS tunnel or configure a permanent endpoint, and pair browsers or other Pixice desktops. Remote clients use Pixice’s existing project, task, approval, board, workflow, review, and file-editing interfaces. See [the remote access guide](docs/REMOTE.md) for setup and boundaries.

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

The installer stages the new bundle, refuses to interrupt active backend work, backs up durable data, stops the backend and native helper, waits for the current Pixice process to quit, preserves the installed app as a timestamped backup, swaps the bundle atomically, and relaunches Pixice once. It uses a detached one-shot worker; do not replace it with `launchctl submit`, because macOS can infer `KeepAlive` for submitted script jobs and create a permanent relaunch loop.

## Provider runtime release gate

Pixice does not bundle Codex or Claude Code. Desktop builds discover external provider executables, persist their absolute paths, and keep a missing or broken provider isolated from the rest of the app. Release packages retain the Claude Agent SDK JavaScript files but exclude its platform runtime packages. Clean-machine release testing must cover provider installation, locate, repair, authentication, and startup with neither provider present.

## Claude runtime

Packaged Pixice builds can sign in to Anthropic from **Settings → Providers** or directly from the Claude tab in the model picker. Pixice reuses an external Claude Code installation and its credentials. It checks a saved absolute path, `PIXICE_CLAUDE_PATH`, per-user and package-manager locations, then the inherited `PATH`. Pixice does not fall back to the platform executable shipped as an optional Claude Agent SDK dependency.

## GitHub access

Packaged builds include GitHub CLI. Users connect it from **Settings → GitHub** with GitHub's browser sign-in. Pixice puts the bundled `gh` executable on the agent runtime's `PATH`, which lets Codex and Claude agents work with pull requests, issues, releases, and authenticated Git remotes without a separate install. Workflow Git nodes remain local and read-only, so they do not require an account.

Run `pnpm github:sync` before a local desktop build to fetch GitHub CLI for the current platform. The release matrix fetches its target automatically and verifies the downloaded executable against the generated metadata before packaging.

## App updates

Packaged Pixice builds check the `Blumenwagen/Pixice` GitHub Releases feed in the background. Pushing a version tag that matches `package.json`, such as `v0.1.0-beta.1`, builds the signed and notarized Apple Silicon package, update metadata, and checksums. Manual workflow runs can also build unsigned Windows and Linux packages. Tag builds require signing credentials. Versions with a prerelease suffix become GitHub prereleases and remain visible to installed beta builds.

In development, Pixice automatically uses a `codex` executable found on `PATH`; `PIXICE_CODEX_PATH` can still select an explicit binary. See [`RELEASE.md`](RELEASE.md) for the release runbook and [`PLAN.md`](PLAN.md) for the implementation roadmap.

Pixice has no product license in this beta. Bundled dependencies retain their own terms, recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Pixice runs its application core in an independent Node backend. Closing or quitting the interface leaves tasks and remote access running. Use **Settings → Connections → Background backend** for explicit stop, restart, and login controls, or see [standalone service commands](docs/REMOTE.md#standalone-node-commands).
