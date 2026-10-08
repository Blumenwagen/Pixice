# Third-party notices

Pixice is distributed without a product license at this time. This file applies only to third-party software included with Pixice. It does not grant rights to Pixice itself.

## T3 Code reference implementation

Pixice's native pull request watches adapt change evaluation and GitHub check/fingerprint selections from T3 Code, released as `v0.0.46-nightly.20261008.2813` (commit `30cc788975500a8c00d32a50f348174d1ce578d1`). Its managed task worktrees, rewind checkpoints, message queue, and HTML replies also use this release as a functional reference. T3 Code is available under the MIT License.

- Source: https://github.com/pingdotgg/t3code
- Reference modules: `apps/server/src/orchestration-v2/pullRequestWatch.ts`, `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts`, and `apps/server/src/pullRequest/gitHubPullRequestJson.ts`
- Other functional references: `apps/server/src/orchestration-v2/CheckpointService.ts`, `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts`, `apps/server/src/mcp/toolkits/worktree/`, `apps/server/src/htmlRender/HtmlRender.ts`, and the orchestration queue contracts
- Computer Use app permission choices and native persistence responses adapt `apps/server/src/provider/CodexMcpElicitation.ts` at the same reference commit.
- License: https://github.com/pingdotgg/t3code/blob/v0.0.46-nightly.20261008.2813/LICENSE

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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

## sherpa-onnx speech recognition

Pixice includes `sherpa-onnx-node` 1.13.8 and the prebuilt native library for the packaged platform. sherpa-onnx is Copyright the next-gen Kaldi team and is available under the Apache License 2.0. The bundled library embeds ONNX Runtime, Copyright Microsoft Corporation, available under the MIT License.

- Source and license: https://github.com/k2-fsa/sherpa-onnx
- ONNX Runtime license: https://github.com/microsoft/onnxruntime/blob/main/LICENSE

## Speech recognition models

Pixice ships no speech model. A user downloads one on request in Settings → Voice, from the sherpa-onnx `asr-models` release. Archive URLs, byte sizes, and SHA-256 digests are pinned in `electron/transcription/catalog.mjs`. Each model keeps its own license, and Pixice shows the required attribution in Settings → Voice for every installed model.

| Model | Copyright | License |
| --- | --- | --- |
| Parakeet TDT 0.6B v2 and v3 | NVIDIA | CC-BY-4.0 |
| Whisper Turbo, Whisper Tiny | OpenAI | MIT |
| Moonshine Base | Useful Sensors | MIT |
| SenseVoice | Alibaba | Apache-2.0 |

- Parakeet: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- Whisper: https://github.com/openai/whisper
- Moonshine: https://github.com/usefulsensors/moonshine
- SenseVoice: https://github.com/FunAudioLLM/SenseVoice

CC-BY-4.0 requires attribution to be carried with the work. Do not remove the attribution rows from the Voice settings page.

## Electron and JavaScript dependencies

Pixice includes Electron and the production dependencies listed in `package.json` and `pnpm-lock.yaml`. Those packages retain their own copyright notices and license terms. Electron is distributed under the MIT License. Package metadata inside the application identifies the installed versions.

- Electron license: https://github.com/electron/electron/blob/main/LICENSE
- Dependency lockfile: https://github.com/Blumenwagen/Pixice/blob/main/pnpm-lock.yaml

Before a public release, the release owner must review this notice against the final packaged dependency list and any updated provider terms.

## Optional Cloudflare tunnel

When explicitly started in Connections, Pixice downloads official cloudflared 2026.8.3, licensed under Apache-2.0. It is not included in the base application package. Release URLs and SHA-256 digests are pinned in `electron/connect/tunnel.mjs`.

- Source and license: https://github.com/cloudflare/cloudflared
- Release: https://github.com/cloudflare/cloudflared/releases/tag/2026.8.3


## T3 Code recorded provider replay fixture

The sanitized Codex transcript excerpt in `tests/fixtures/orchestrator-replay/codex-recorded-approval.ndjson` is adapted from [T3 Code](https://github.com/pingdotgg/t3code/blob/30cc788975500a8c00d32a50f348174d1ce578d1/apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/codex_transcript.ndjson). Its fixture metadata records the source commit, checksum, retained lines, and sanitization.

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
