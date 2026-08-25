# Pixice release runbook

Pixice 0.1.0-beta.1 uses the permanent application identifier `com.blumenwagen.pixice`. Changing it after users install the app would split application data, permissions, keychain entries, and updater identity.

Pixice disables install-on-quit. An in-app update first writes verified, consistent copies of the project, thread metadata, workflow, and Instrument databases under `update-data-backups` in the application's user-data directory. A failed integrity check or backup aborts installation. The first launch of a new version restores missing or corrupt durable files from the latest verified snapshot, takes another pre-migration snapshot, and only records the new data version after all persistent stores open successfully.

## One-time setup

1. Rename or create the GitHub repository as `Blumenwagen/Pixice`, then update local clones to `https://github.com/Blumenwagen/Pixice.git`.
2. Enable Git LFS for collaborators and CI. The four Codex runtime packages are stored through LFS.
3. Obtain a Developer ID Application certificate and Apple notarization credentials.
4. Obtain a Windows code-signing certificate. The current workflow accepts a base64 value or file URL through electron-builder's `WIN_CSC_LINK` support.
5. Add the repository secrets listed below.
6. Enable GitHub private vulnerability reporting and create an issue template before inviting beta users.

## Repository secrets

macOS packaging requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

Windows packaging requires `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

Do not put credential values in `.env.example`, workflow YAML, release notes, or issue reports.

## Preparing a version

1. Update `package.json` and any version-specific text in `THIRD_PARTY_NOTICES.md`, `PRIVACY.md`, and `SUPPORT.md`.
2. Run `node scripts/sync-codex-runtime.mjs` only when changing the pinned Codex channel. Review the new version and archive hashes in `resources/runtime/manifest.json`.
3. Run `pnpm github:sync` for the release platform when testing a local package. CI fetches GitHub CLI for each target and verifies `resources/runtime/<platform>/github-cli.json` before packaging.
4. Generate and test protocol bindings against the pinned app-server version when the protocol changes.
5. Run `pnpm check`, `pnpm runtime:verify`, and `pnpm release:preflight`.
6. Run a manual release workflow. It creates unsigned test packages when signing secrets are not required.
7. Install and smoke-test each package on a clean machine or virtual machine. Test provider sign-in, GitHub sign-in, a new thread, a tool approval, file editing, workflows, updates, and uninstall behavior.
8. Commit the release changes, then create and push the matching annotated tag, such as `v0.1.0-beta.1`.

Tag builds require Apple signing and notarization credentials. The macOS job verifies the packaged application's signature, application identifier, team identifier, entitlements, and Gatekeeper assessment before uploading the arm64 package, updater metadata, and `SHA256SUMS.txt`. A version containing a prerelease suffix is published as a GitHub prerelease. Manual workflow runs can also build unsigned Windows x64 and Linux packages for packaging checks when `include_portable` is selected; they are not included in tagged releases.

## Release decision

Do not publish if any platform package is unsigned where signing is required, macOS notarization fails, runtime verification fails, update metadata names collide, checksums are absent, or the smoke test finds data loss or a permission-boundary failure.

There is intentionally no Pixice product license in the repository for this beta. Third-party notices remain required because bundled dependencies keep their own terms.
