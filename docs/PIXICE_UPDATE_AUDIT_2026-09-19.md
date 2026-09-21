# Pixice in-app update audit

Date: 19 September 2026. Source baseline: `7e97815`, package `0.1.0-beta.4`, Electron `38.7.2`, electron-updater `6.8.9`. The working tree was clean at audit start.

**Decision: do not sign off on update reliability yet.** The code has useful safeguards, but failures after backend shutdown lack recovery, and database health checks are too weak to justify automatic restoration. Passing the current tests would not establish that a signed, installed application can update and restart safely.

This is an audit, not an implementation. No product code, installed application, running user service, or release assets were changed. All corruption and lock probes used synthetic files. Findings below distinguish code evidence from isolated reproductions and remaining verification work. Remediation is recorded in the high-priority Board task "Harden in-app update recovery", ID `9caae1e9-4775-44ed-a782-b3c255d1246a`.

## Update path reviewed

The desktop checks GitHub after ten seconds and every six hours. The user starts the download and then requests installation. The desktop requests a backend backup, stops the backend, sets its quitting flag, and calls electron-updater. The replacement backend attempts version-triggered recovery, takes a pre-migration backup, opens the stores, and records the new data version.

On macOS with `autoInstallOnAppQuit = false`, electron-updater's initial `update-downloaded` event means the ZIP is available to its local proxy. Native Squirrel staging starts later, when `quitAndInstall()` calls the native updater. This distinction is visible in the installed dependency, `node_modules/electron-updater/out/MacUpdater.js:218` and `:240`. The audit uses this pinned implementation, rather than assuming current online documentation exactly matches it.

## Findings

### F1. P1: native installation failure leaves the backend stopped

Evidence: `electron/main.mjs:307`, `electron/updater/app-updater.mjs:107`, and `node_modules/electron-updater/out/MacUpdater.js:240`.

The preparation callback backs up data, awaits `stopService`, and sets `quitting = true` before native staging starts. `quitAndInstall()` returns without awaiting native success. A subsequent native error reaches the generic `error` listener, not the installation catch block. There is no corresponding restart of the old backend, reset of the quitting flag, or bounded staging timeout. Even a synchronous exception after successful preparation leaves the backend stopped.

User impact: a signature, staging, permissions, or disk failure can leave the old desktop visible but disconnected from its backend. The method has already returned `{ ok: true }`. An install retry also depends on reading a service descriptor that successful shutdown removed.

Required change: give installation an explicit lifecycle, preserve its target and recovery information, handle native failure and timeout, and restore the existing service and desktop state whenever handoff fails. Avoid starting native staging early without accounting for Squirrel's own install behavior. Verify the actual signed macOS path.

### F2. P1: database health classification can silently lose or revert active data

Evidence: `electron/persistence/update-data-backup.mjs:31`, `:64`, `:135`, and `electron/persistence/database.mjs:154`.

Recovery accepts a current database when `PRAGMA quick_check` returns `ok`. It never checks the expected tables, a schema identity, or whether a previously populated database has become empty. Store constructors then create missing tables. A structurally valid but empty or unrelated SQLite database can bypass an available backup and become a fresh workspace.

Isolated reproduction confirmed that a zero-byte current file returns `quick_check: ok`, recovery returns `[]` despite a verified populated backup, and `PixiceDatabase` initializes an empty projects table. The backup remains available, but the application does not restore it automatically.

The opposite classification error also exists: every exception is treated as corruption. An isolated DELETE-journal database held under an exclusive lock returned `database is locked`; recovery renamed that valid live file and replaced it with an older snapshot, dropping a newer row from the active file. This reproduction uses a synthetic external lock, not normal Pixice WAL operation. It establishes unsafe error classification, not that routine updates encounter that lock.

Required change: validate each store's identity and supported schema before accepting it. Treat busy, locked, permission and I/O failures as unavailable data, not proof of corruption. Distinguish a legitimate first run from unexpected loss of an existing store using durable installation and backup metadata. Preserve the damaged files and require an explicit recovery decision when validity is uncertain.

### F3. P1: backup and recovery do not preserve a consistent set of stores

Evidence: `electron/main.mjs:309`, `electron/backend/service.mjs:129`, `:134`, and `electron/persistence/update-data-backup.mjs:133`, `:196`.

The backup runs before the backend freezes new work or drains pending operations. It snapshots the databases one at a time while writes remain possible. SQLite online backup protects each database's internal consistency, but it does not make all Pixice stores a single snapshot.

Recovery independently selects a backup for each unhealthy file and keeps every file it considers healthy. It ignores the manifest's source and target versions when choosing candidates. This can combine a recent main database with old workflows or Instruments, or a credential store with a key from another snapshot. The caller discards the list of restored files, so users receive no notice that their data was reverted.

An isolated reproduction using real Pixice and Workflow store classes retained a Board binding to `workflow-new` while recovery restored a workflow database containing only `workflow-old`. Both resulting databases passed SQLite integrity checks.

Required change: freeze and drain mutations before taking the update snapshot, define which stores must remain consistent together, and validate references and credential compatibility during recovery. Make recovery resumable across crashes, record the chosen snapshot, and show the user what was restored. Do not blindly roll back healthy stores merely to match an old backup.

### F4. P2: scheduled checks can overwrite download and installation state

Evidence: `electron/updater/app-updater.mjs:72`, `:83`, `:107`.

`check()` blocks only `checking` and `downloading`. A scheduled check is therefore allowed while an update is `downloaded`, while backup preparation is awaiting completion, or after an install error. A downloaded update can become merely `available`, removing the install action. During preparation, checking can change the advertised version and permit another download to start. If that download completes, another install can enter while the first preparation is still pending.

The fake-updater reproduction confirmed loss of install readiness after a later `update-not-available` event, and a displayed target change from `0.2.0` to `0.3.0` while the pending backup still targeted `0.2.0`. An immediate second install after that check was correctly rejected because the state was `available`. The longer check/download/install overlap above is a source-level finding, not a completed double-install reproduction.

`stop()` also leaves the initial ten-second timeout armed and leaves all updater event listeners attached.

Required change: serialize update operations independently of the display state, pin the downloaded artifact and target version, and suspend checks through installation and recovery. Clear both timers and remove owned listeners when stopping.

### F5. P2: renderer errors erase the intended install retry state

Evidence: `electron/updater/app-updater.mjs:119`, `src/App.jsx:6360`, `:8964`.

When preparation fails, main emits `install-error` and rejects the IPC request. The renderer's catch handler then assigns generic `error`, overwriting the specialized state it just received. The About screen selects "Try again", which checks for updates, instead of "Retry install". This also occurs for the intentional refusal to stop active work.

Required change: preserve authoritative updater state on rejected actions, or return a structured failure state. Cover the actual IPC event and rejection ordering in a renderer test.

### F6. P2: release reruns can replace assets on an already public release

Evidence: `.github/workflows/release.yml:44`, `:100`, `:188`.

Preparation creates a draft only when the release does not exist. It does not reject an existing published release. Subsequent steps upload with `--clobber`. Rerunning a successful tag workflow can therefore replace ZIPs and blockmaps while users still see the previous metadata. Newly built or signed artifacts need not have the old hashes. Hash verification should reject a mismatch, but downloads fail during this window and the published version is no longer immutable.

Required change: fail before upload when a release is already public. Assemble and validate the complete artifact set in a draft, publish once, and use a new version for corrections. Validate metadata versions, filenames, architecture, sizes, and hashes against the actual artifacts before publication.

### F7. P2: large data and low disk capacity lack a bounded backup strategy

Evidence: `electron/backend/manager.mjs:41`, `electron/main.mjs:309`, `electron/persistence/update-data-backup.mjs:27`, `:189`, `:235`.

The backup RPC uses a fixed fifteen-second timeout. Database checking and SHA-256 hashing include synchronous work, and hashing reads each entire file into memory. A slow backup can outlive the client's request; the server operation has no corresponding cancellation. Retry can start another backup. Completed backups have no retention or size policy. Installation and first launch normally take separate full snapshots, and unsuccessful startup before recording the new version repeats the startup snapshot.

User impact: sufficiently large data can prevent installation through repeated timeouts or exhaust storage across retries and versions. A full disk after replacement can also prevent the required pre-migration snapshot, leaving the new backend unable to start. No size or latency benchmark was available to quantify the threshold.

Required change: serialize backups, expose progress, use an explicit operation lifetime rather than a short RPC deadline, stream hashes, budget disk usage, and retain a known-good rollback snapshot while pruning safely. Record in-progress and completed installation attempts so retries reuse valid work.

## Safeguards that are present

- Install-on-quit and automatic downloading are disabled.
- Backup failure prevents the direct call to `quitAndInstall`.
- SQLite snapshots use the online backup API, including live WAL contents. Snapshot integrity and file hashes are recorded, and incomplete backup directories are excluded from recovery.
- Main, workflow, and Instrument store migrations have transaction boundaries within their individual stores.
- Service shutdown refuses active turns, starting turns, and active workflows by default, then drains accepted local operations.
- Tag builds require signing and notarization inputs and run macOS signature and Gatekeeper checks before publication.
- The suspected beta channel filename mismatch is not a confirmed defect. The pinned GitHub provider requests a prerelease channel first and explicitly falls back to `latest-mac.yml`, which the workflow publishes. See `node_modules/electron-updater/out/providers/GitHubProvider.js:130`.

## Release requirements still missing

A backup is not a tested rollback. There is no application-level record of successful post-update health, no recovery coordinator for a failed migration across several stores, and no demonstrated rollback procedure that preserves newer user data. Structurally healthy SQLite files can still have incompatible schemas or incorrect application data.

The backup allowlist is also narrower than all durable Pixice state. It includes three databases, workflow credentials, and the encryption key record. It excludes Connect pairing and configuration, push keys and subscriptions, attachment and task-result files, and browser-session metadata. Application replacement should normally leave those files alone, but this backup cannot establish their recovery. Provider-owned conversation data is another explicit boundary.

Before calling updates release-ready, require evidence from two signed packaged versions on a disposable macOS installation:

| Scenario | Required result |
| --- | --- |
| Previous supported release to candidate | Candidate opens, backend becomes ready, existing projects, threads, Board, workflows, Instruments and credentials remain usable |
| Network interruption, sleep and restart during download | Installed application stays usable; retry verifies the complete artifact |
| Incorrect checksum, signature, application identity or signing team | Candidate is rejected; the old application and backend remain usable |
| Low disk during download, backup, staging and startup | No silent data loss; clear recovery path; old or new version remains launchable |
| Active turn, starting turn, workflow, pending write | Update refuses or waits safely; no accepted work disappears |
| Kill at each backup, shutdown, staging and migration boundary | Restart resumes safely or gives an actionable recovery choice |
| Empty, corrupt, locked and incompatible database | No silent fresh workspace or unintended stale restore |
| Failed migration and failed backend readiness | Recoverable failure with a verified path back to a usable application |
| Repeated clicks, timer checks and retries | One installation operation, one pinned target and stable progress state |
| Published release rerun | Public assets remain unchanged |

Signing verification currently checks that a team identifier exists, not that it matches the team of previously shipped installations. Add an identity-continuity check and an actual previous-version upgrade test. Current tagged releases cover macOS arm64 only; Windows and Linux packaging checks must not be presented as validated in-app update support.

Official context: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) describes native update events and restart behavior; [electron-builder auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) describes macOS ZIP metadata and update testing. Exact dependency behavior above was checked against installed source.

## Verification evidence

The recovery reproduction worker completed successfully. I reviewed its script and output. It used the production recovery function and actual Pixice/Workflow store classes against temporary data. Its command was `node /tmp/pixice-update-recovery-audit-2026-09-19/audit.mjs`, with stdout and stderr captured in [audit.log](/tmp/pixice-update-recovery-audit-2026-09-19/audit.log). The script is [audit.mjs](/tmp/pixice-update-recovery-audit-2026-09-19/audit.mjs), with a separate [lock child](/tmp/pixice-update-recovery-audit-2026-09-19/lock-child.mjs). The run exited successfully and established all three recovery behaviors described in F2 and F3. It did not launch the Electron application.

The general verification worker reported 55 passing tests across seven files:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/app-updater.test.js tests/update-data-backup.test.js tests/release-scripts.test.js` | Exit 0, 14 passed |
| `pnpm exec vitest run tests/backend-service.test.js tests/connect-server.test.js tests/connect-tunnel.test.js tests/provider-runtime-lifecycle.test.js` | Tunnel and provider lifecycle tests passed, 19 tests; 22 listener-dependent tests initially failed because the sandbox rejected localhost binds |
| `pnpm exec vitest run tests/backend-service.test.js tests/connect-server.test.js` with approved local-bind escalation | Exit 0, all 22 previously blocked tests passed |

Evidence: [requested test summary](/tmp/pixice-update-audit-2026-09-19/requested-tests.log), [lifecycle test summary](/tmp/pixice-update-audit-2026-09-19/lifecycle-tests.log), and [worker report](/tmp/pixice-update-audit-2026-09-19/AUDIT.md). These are bounded summaries, not full raw suite transcripts.

The [updater reproduction script](/tmp/pixice-update-audit-2026-09-19/update-repros.mjs) confirmed F4's state changes and F1's early success followed by generic native error. It uses an EventEmitter fake, so it does not prove a real Squirrel installation failure or exercise actual backend shutdown. Separate installed-dependency probes confirmed GitHub metadata generation and channel fallback. The existing updater suite has only three tests and the backup suite four; their passing results coexist with the reproduced defects.

No signed application-to-application update, power-loss experiment, large-data benchmark, or production release mutation was performed. No product changes were made. The final source inspection found only this audit document from the audit and unrelated untracked design work, which was left untouched.
