# Pixice Connect remote workspace

- Status: implemented
- Date: 2026-09-05
- Supersedes: the capability/scope restrictions in Connect 01

The owner requested full remote project/task work from browsers and other Pixice instances. Connect now reuses the existing Pixice application UI and a curated set of validated host application services. It includes task creation, project selection/creation, permission choices, file editing, review, boards, workflows, and Tools, beyond the earlier monitoring-only companion proposal.

The desktop host remains the system of record. A separately paired, expiring and revocable device represents a trusted operator of the entire host. There is no guest role or implicit team-sharing model. New local capabilities are not exported automatically. Direct file operations remain project-scoped; native account, credential, update, and connection administration remain local. The owner explicitly approved native browser/session previews and controls. These now use authenticated, on-demand frame capture and a fixed set of validated input actions; arbitrary scripts, CDP method names, cookies, and credential APIs are not exposed. Simulator previews remain local.

Reachability is explicit: local listener plus an HTTPS proxy, direct trusted TLS, or an opt-in temporary Cloudflare tunnel. This implementation does not create a managed Pixice identity/relay service. TLS-terminating intermediaries are trusted with traffic; no end-to-end-encryption claim is made.

See [the remote access guide](../REMOTE.md) for supported behavior, security boundaries, recovery, and setup.
