# Third-party notices

Pixice is distributed without a product license at this time. This file applies only to third-party software included with Pixice. It does not grant rights to Pixice itself.

## OpenAI Codex

Pixice 0.1.0-beta.1 bundles the official Codex 0.149.0 app-server packages for its supported operating systems. Codex is Copyright OpenAI and contributors and is available under the Apache License 2.0.

- Source and license: https://github.com/openai/codex
- Release files: https://releases.openai.com/codex/releases/0.149.0/
- License text: https://www.apache.org/licenses/LICENSE-2.0

The exact archive URLs and SHA-256 digests used by Pixice are recorded in `resources/runtime/manifest.json`.

## GitHub CLI

Pixice release builds include the official GitHub CLI for the packaged operating system. GitHub CLI is Copyright GitHub and contributors and is available under the MIT License.

- Source and license: https://github.com/cli/cli
- Releases: https://github.com/cli/cli/releases

The packaged version, official archive URL, and SHA-256 digests are recorded in `resources/runtime/<platform>/github-cli.json`.

## Anthropic Claude Agent SDK

Pixice includes `@anthropic-ai/claude-agent-sdk` 0.3.234 and its platform package. Anthropic states that use of the SDK is governed by its Commercial Terms of Service. Anthropic's terms and privacy policy apply when a user connects Claude.

- Package source: https://github.com/anthropics/claude-agent-sdk-typescript
- Commercial terms: https://www.anthropic.com/legal/commercial-terms
- Privacy policy: https://www.anthropic.com/legal/privacy

## Electron and JavaScript dependencies

Pixice includes Electron and the production dependencies listed in `package.json` and `pnpm-lock.yaml`. Those packages retain their own copyright notices and license terms. Electron is distributed under the MIT License. Package metadata inside the application identifies the installed versions.

- Electron license: https://github.com/electron/electron/blob/main/LICENSE
- Dependency lockfile: https://github.com/Blumenwagen/Pixice/blob/main/pnpm-lock.yaml

Before a public release, the release owner must review this notice against the final packaged dependency list and any updated provider terms.
