# Pixice privacy notice

Effective September 6, 2026

Pixice is a local desktop application. It does not include Pixice-owned analytics or advertising trackers in version 0.1.0-beta.5.

## Data stored on the device

Pixice stores project paths, board tasks, thread metadata and snapshots, usage estimates, workflow definitions, browser workspace state, settings, and prompt attachments in the operating system's application-data directory. Workflow credentials use AES-256-GCM encryption with an envelope key wrapped by the operating system's secure storage, or an explicitly configured environment key on standalone hosts. Legacy OS-encrypted records remain readable. Key records and encrypted credentials are stored in user-only files. Browser navigation metadata and cookie partitions remain on the host; page frames and typed input are not saved in the connection audit. Provider command-line tools may keep their own credentials and history in their own storage locations.

The background backend continues tasks, workflows, and enabled remote access when the desktop interface is closed or quit. Stop it explicitly in Connections or with the service CLI.

Removing Pixice does not necessarily remove its application-data directory or data kept by Codex, Claude, Git, browsers, or operating-system credential stores.

## Data sent elsewhere

When a user submits a prompt, Pixice sends the prompt and the context selected by that user to the chosen provider, such as OpenAI or Anthropic. That context can include project files, images, repository details, tool results, and earlier conversation content. The provider's account terms and privacy policy govern its processing.

Pixice also makes network requests when it:

- checks GitHub Releases for application updates;
- signs in to GitHub or runs an authenticated GitHub CLI command requested by the user or an agent;
- opens a page in the preview browser;
- runs a workflow with an HTTP request, webhook, provider, or connected service;
- uses a capability, plugin, app, or MCP server configured by the user.

Those destinations receive the normal request data, including an IP address and any headers or credentials the user configured.

## Dictation

Dictation is off until a user downloads a speech model in Settings → Voice. Pixice ships without one. Downloading a model fetches a checksum-verified archive from the sherpa-onnx release on GitHub and stores it in the application-data directory, where Settings → Voice can remove it again.

Recording starts only while the microphone button is active and stops when the user stops or discards it. Audio is transcribed on the Pixice host by a local model. It is not sent to a speech service, a provider, or any Pixice-operated service, and the recording is discarded once the transcript is produced. The transcript is placed in the composer for editing and is submitted only if the user sends it.

One distinction matters for paired devices: when a phone or browser dictates through Pixice Connect, the audio is captured on that device and travels over the Connect link to the host that runs the model. That link is the user's own tunnel or endpoint, but the audio does leave the recording device. Dictating on the host machine itself keeps the audio on that machine.

## Optional remote access

Pixice Connect is off by default. When enabled, paired devices receive project and task data and can perform authorized agent, workflow, board, project-file, and native preview-browser actions. Paired devices can view signed-in pages in the host browser and interact with them. Page frames are transmitted on demand and are not saved in the connection audit; the audit records action names and results, never screenshot pixels or typed text. The host keeps device credential hashes and a bounded connection audit log; clients keep their device token, saved instance addresses, and separate workspace caches in browser/renderer local storage. Pairing links expire after five minutes, device access after 30 days, and the host can revoke either.

Unified Usage saves per-instance token and cost summaries, daily model history, and last-reported provider limits in the receiving browser/renderer’s local storage. These snapshots remain available after a host disconnects or access is revoked. Forgetting the instance or clearing that browser storage removes its saved usage; no separate Pixice analytics service receives it.

The optional temporary tunnel downloads a checksum-verified Cloudflare executable from GitHub and makes a Cloudflare-hosted HTTPS address available. Cloudflare terminates HTTPS and can process the transported application traffic and normal network metadata. Pixice does not claim end-to-end encryption through this service. A user-managed HTTPS endpoint is also supported. No Pixice-operated account or relay service is used.

## User control

Permission settings control what an agent may read, change, or execute. Workflow credentials stay scoped to their Pixice project. Users should review prompts, attachments, permission settings, and workflow destinations before running them.

Privacy questions and reports can be opened at https://github.com/Blumenwagen/Pixice/issues.
