# Local release preparation

Focus work c26cf482-ab96-4313-83aa-ff2445d8a007. Direction 28 acknowledged. No nested workers.

The worker started through Focus supervision. Source inspection of FocusSupervisor.#drain confirms dependencies must have coordinator-completed status done before a queued worker starts; resolve requires coordinator verification evidence. Worker tools restrict direct reading of other outcomes.

Main and origin/main initially matched at ebf8cd1. No applicable AGENTS.md was found in the project, affected directories or ancestors. Product changes, tests and review harnesses, patches, screenshots and measurement artifacts are included. Generated release/dist outputs and unrelated temporary files are excluded. No credential-like contents were found by the targeted private-key/API-token scan of untracked text artifacts.

Final focused checks passed: settings-return-navigation hidden Preview save shortcut, one case with five skipped; inline-visualization fence rendering, timeline and calendar interactions, three cases with three skipped. No broad suites reran. The live development Preview rendered the mixed rich-content fixture, entered Settings and exposed Back to Focus.

GitHub CLI 2.98.0 was restored from its official pinned release after the local build input checksum failed. The restored input passes scripts/verify-github-cli.mjs --current. This build-input mutation is excluded from the product commit.

Signing is blocked. security find-identity reports zero valid signing identities. No CSC_LINK, CSC_KEY_PASSWORD or Apple signing/notarization environment credentials are available. The previous local bundle was ad-hoc signed with no TeamIdentifier. A fresh local packaging build can validate code and bundle contents but cannot satisfy the existing Apple-team signature installer requirement. Packaging evidence will be recorded separately after the commit, outside the tracked source tree.

No tag, publication, installation, running app restart, live OAuth, Cloud submission or microphone session is authorized for this worker. The coordinator owns installation after evidence review and shutdown of its active turn. Release remains incomplete until that installation.
