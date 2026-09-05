# Third-party notices

Pixice is distributed without a product license at this time. This file applies only to third-party software included with Pixice. It does not grant rights to Pixice itself.

## GitHub CLI

Pixice release builds include the official GitHub CLI for the packaged operating system. GitHub CLI is Copyright GitHub and contributors and is available under the MIT License.

- Source and license: https://github.com/cli/cli
- Releases: https://github.com/cli/cli/releases

The packaged version, official archive URL, and SHA-256 digests are recorded in `resources/runtime/<platform>/github-cli.json`.

## Anthropic Claude Agent SDK

Pixice includes the JavaScript files from `@anthropic-ai/claude-agent-sdk` 0.3.234. Release packages exclude the SDK's optional platform runtime packages and require an external Claude Code installation. Anthropic states that use of the SDK is governed by its Commercial Terms of Service. Anthropic's terms and privacy policy apply when a user connects Claude.

- Package source: https://github.com/anthropics/claude-agent-sdk-typescript
- Commercial terms: https://www.anthropic.com/legal/commercial-terms
- Privacy policy: https://www.anthropic.com/legal/privacy

## Electron and JavaScript dependencies

Pixice includes Electron and the production dependencies listed in `package.json` and `pnpm-lock.yaml`. Those packages retain their own copyright notices and license terms. Electron is distributed under the MIT License. Package metadata inside the application identifies the installed versions.

- Electron license: https://github.com/electron/electron/blob/main/LICENSE
- Dependency lockfile: https://github.com/Blumenwagen/Pixice/blob/main/pnpm-lock.yaml

Before a public release, the release owner must review this notice against the final packaged dependency list and any updated provider terms.

## Optional Cloudflare tunnel

When explicitly started in Connections, Pixice downloads official cloudflared 2026.8.3, licensed under Apache-2.0. It is not included in the base application package. Release URLs and SHA-256 digests are pinned in `electron/connect/tunnel.mjs`.

- Source and license: https://github.com/cloudflare/cloudflared
- Release: https://github.com/cloudflare/cloudflared/releases/tag/2026.8.3
