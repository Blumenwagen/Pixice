# Pixice privacy notice

Effective August 22, 2026

Pixice is a local desktop application. It does not include Pixice-owned analytics or advertising trackers in version 0.1.0-beta.1.

## Data stored on the device

Pixice stores project paths, board tasks, thread metadata and snapshots, usage estimates, workflow definitions, browser workspace state, settings, and prompt attachments in the operating system's application-data directory. Workflow credentials are encrypted with Electron's operating-system-backed secure storage and saved in a user-only file. Provider command-line tools may keep their own credentials and history in their own storage locations.

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

## User control

Permission settings control what an agent may read, change, or execute. Workflow credentials stay scoped to their Pixice project. Users should review prompts, attachments, permission settings, and workflow destinations before running them.

Privacy questions and reports can be opened at https://github.com/Blumenwagen/Pixice/issues.
