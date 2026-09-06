# Pixice Connect

Use Pixice from a web browser or connect one Pixice desktop to another. The host remains authoritative: projects, provider sessions, files, approvals, workflows, and agent execution stay on that machine. An independent Node backend owns this state. Closing or quitting the desktop interface leaves the backend running; native browser sessions remain in a separate Electron helper.

## Quick setup

1. Build/install the updated Pixice desktop. For source development, run `pnpm exec vite build --mode desktop` once so the host has a production web client, then `pnpm dev:electron`.
2. On the host, open **Settings → Connections → Enable remote access**.
3. Choose **Start tunnel** for a temporary HTTPS address, or enter your own HTTPS endpoint and save settings.
4. Choose **Create pairing link**. Open it in a browser on the other device, or paste it into **Settings → Connections → Add instance** in another Pixice desktop.
5. Name the receiving device and pair. The link expires in five minutes and works once. Use a new link for every device.

Remote access is off by default. Pairing authorizes the device as a trusted operator for every host project, including task creation, permission selection, file editing, and workflow execution. Pair only devices you control. The UI states this before pairing.

Paired access lasts 30 days. **Revoke** disconnects a device immediately; **Revoke all** also invalidates unused pairing links. Forgetting an instance removes its credential from that client but does not revoke it on the host. Revoke on the host if a device was lost or compromised.

## Background backend and lifecycle

The desktop starts or reconnects to one backend for its application-data directory. Both desktop and web clients use the same application operations and event transport. Local desktop administration uses a separate authenticated loopback listener; its private token and process descriptor stay in a user-only file and are never exposed to the renderer or remote sessions.

- Closing the window hides the interface. Quitting the interface unloads it and hides the dock/tray; tasks, workflows, remote access, and existing browser sessions continue.
- **Settings → Connections → Background backend** provides explicit restart and stop actions. They refuse to interrupt active turns or workflows. **Start at login** is available on macOS and Windows and starts the native helper and backend without opening the interface.
- Reopening Pixice reconnects to the existing backend. A lost connection never replays an action. After a backend restart, clients refresh against its current state.
- Only one process may own the databases. An OS-managed SQLite lock on a separate ownership file prevents concurrent backend starts; stale process metadata cannot grant ownership. Do not delete `service/owner.lock` while any backend is running.
- App installation and updates back up the durable data and stop the backend and native helper before replacing the bundle. Active work blocks the update. An unexpected backend crash marks unfinished work interrupted; it does not automatically resubmit a paid provider turn.

The Electron helper owns browser rendering, OS credential wrapping, notifications, dialogs, and keep-awake behavior. It reconnects across backend restarts. If the helper itself exits, tabs restore lazily from navigation metadata using their persistent cookie partition; in-memory page state and navigation history cannot survive a helper crash. Simulator processes and tools are owned by the backend and remain available through the local desktop API.

## Standalone Node commands

From a source checkout with dependencies installed and the desktop web client built:

```sh
node electron/backend/cli.mjs start --data-dir /path/to/pixice-data --no-native
node electron/backend/cli.mjs status --data-dir /path/to/pixice-data
node electron/backend/cli.mjs configure --data-dir /path/to/pixice-data --enable
node electron/backend/cli.mjs tunnel --data-dir /path/to/pixice-data
node electron/backend/cli.mjs pair --data-dir /path/to/pixice-data
node electron/backend/cli.mjs restart --data-dir /path/to/pixice-data --no-native
node electron/backend/cli.mjs stop --data-dir /path/to/pixice-data
```

`configure` accepts `--port`, `--host`, `--endpoint`, and `--name`; `--disable` turns remote access off. `tunnel --stop` stops the temporary endpoint. Network binds still require configured TLS.

Use `serve` instead of `start` to run in the foreground under a system service manager. `stop --force` explicitly interrupts active work. `pair` prints a one-use pairing link for an already-enabled remote listener. Without `--no-native`, a source checkout uses its Electron installation as the helper; `--native-executable PATH` configures an installed Pixice executable. The backend itself imports no Electron runtime. Use Node 22.20 or newer (the packaged app includes a compatible Node runtime).

The default data directory is `~/Library/Application Support/Pixice` on macOS, `%APPDATA%/Pixice` on Windows, and `${XDG_CONFIG_HOME:-~/.config}/pixice` on Linux. `PIXICE_DATA_DIR` or `--data-dir` overrides it. Service logs are in `service/service.log`. Keep all files in this directory when moving a host, including Connect identities and the workflow encryption-key record.

On a host without an OS credential helper, set `PIXICE_CREDENTIAL_KEY` to a securely managed base64-encoded 32-byte key before creating workflow credentials. Supply the same key on every run. The backend stores a key verifier, not the key. Existing OS-encrypted credentials require their original OS key store and the helper; there is no plaintext fallback. With a helper, an envelope key is wrapped by the OS key store and new credential values use AES-256-GCM in the backend. Legacy records remain readable and unchanged until edited.

## Permanent HTTPS endpoints

Temporary Cloudflare URLs change when the tunnel stops or restarts. Create a new pairing link to update the saved address. A temporary tunnel survives closing or reopening the interface. It does not restart automatically after the backend stops. Its executable is downloaded on first use from the official Cloudflare GitHub release, checked against pinned SHA-256 digests, and stored in Pixice's application-data directory.

For a stable address, run an HTTPS reverse proxy or a user-managed Tailscale/Cloudflare endpoint in front of `http://127.0.0.1:43187`. Enter the public **origin** in Connections, for example `https://pixice.example.com`. Serve Pixice at the origin root, not a subpath. Preserve the browser's Host and Origin headers, Authorization, and JSON bodies; allow 30-second requests and disable buffering/caching for `/api/connect/*`. Only the configured hostname, loopback aliases, and explicitly allowed client origins are accepted. Forwarded headers do not grant trust.

For TLS terminated directly by Pixice, launch it with `PIXICE_CONNECT_TLS_CERT` and `PIXICE_CONNECT_TLS_KEY` pointing to PEM certificate and private-key files. Select **Network (TLS required)** and save your HTTPS endpoint. Clients must trust the certificate. Pixice never disables certificate checks, and refuses to bind a non-loopback plaintext listener if TLS configuration disappears after a restart.

A browser hosted on a different origin needs its own origin added to **Additional web clients** on each target host. Pixice desktops use the isolated Electron renderer origin and need no extra origin entry. HTTPS pages cannot connect to an HTTP host; plain HTTP is accepted only for loopback development or an SSH port forward on the receiving machine.

## Working remotely

- Projects and new tasks, history, follow-ups, steering, interruption, model/effort/permission selection, questions, approvals, and elicitations use the existing Pixice UI.
- Board, plans, agent activity, task results, Git review, project file previews and editing, Tools, and workflows use the host's existing validated application services.
- Remote file reads/writes are constrained to selected project roots and resolve symlinks. Saving requires the file's current modification timestamp, preserving the existing conflict check.
- Native browser sessions are available in the existing Preview tabs: navigate, open/close tabs, click, double-click, scroll, use keyboard keys, and paste text. The host's existing session stays on the host, including signed-in pages. Use **Type text** for mobile or composed text; use **Shift+Escape** to release keyboard control. **Pause** stops receiving frames.
- Browser frames are captured on demand while visible, at up to two frames per second. Hidden host tabs render in hidden windows, without focusing the desktop. Remote input requires a recent frame of the same tab and viewport; navigation, resizing, expiration, or device revocation invalidates it. Screenshots and typed input are not stored in the audit log. File-picker dialogs, native menus, audio/video streaming, and drag gestures are not mirrored.
- Simulator previews, desktop external-app actions, provider/GitHub sign-in, credential administration, host settings, and updates remain local. Existing authenticated host workflows can run remotely; their secret values are never returned by a credential API.
- Task defaults and visual preferences can be changed on the client. Host-wide settings are read-only remotely. Phone-width navigation uses Pixice's existing sidebar as a drawer.
- Use Connections or the instance name above the remote workspace to switch hosts. Drafts, selected projects, and preview caches are stored separately for each instance.

This is direct, single-owner access. It does not include a Pixice-operated cloud account service, automatic account-based host discovery, multi-user roles, push delivery to closed browsers. A standalone Node backend is supported; native browser and OS features require the optional Electron helper.

## Unified Usage

In **Settings → Usage**, choose **Unified Usage** to combine this desktop and every instance paired on the receiving device. Web browsers include their paired hosts. The same host is counted once even if the desktop is also saved as a remote connection. Usage stays attributed to the machine that executed it.

The view combines measured tokens, API-equivalent costs, the spend calendar, date-range charts, and model breakdowns. An instance table shows each contribution and its last successful sync. Provider allowances remain separate: multiple machines can share the same provider account, so their quota percentages are never summed.

Snapshots are saved in the receiving browser/desktop’s local storage. Disconnecting, revoking access, or restarting Pixice does not remove previously synced usage. Offline instances keep contributing their last saved measurements, visibly marked **Saved · offline** or **Saved · pair again**. Newer activity may be missing until a successful refresh; instances that have never synced are explicitly excluded. The connection screen also offers **View Unified Usage** when no workspace is reachable. The web interface itself must already be loaded to use this offline view; Pixice does not install an offline web app.

While the view is visible it syncs every 30 seconds, and **Refresh** syncs immediately. Reconnection replaces each host’s snapshot instead of adding it twice. Current hosts provide daily model history so the 7/30/90-day charts and month boundaries continue working offline in each host’s time zone. Older hosts without this history may need updating for cached model breakdowns. Lifetime totals remain intact. Forgetting an instance removes its saved usage from this receiving device; clearing browser storage also removes snapshots. If storage is full or unavailable, the view reports that the new snapshot can only be retained for the current session.

## Recovery and security behavior

The host exposes an explicit capability registry, never arbitrary Electron IPC or provider method names. Adding a new local IPC method does not make it remotely callable.

Pairing offers and device tokens use 256-bit randomness. The host stores only their SHA-256 hashes in an atomic, user-only state file. Client tokens are stored in that browser/renderer's local storage; protect the browser profile and revoke lost devices. Tokens are not placed in API URLs. Pairing tokens use the URL fragment, which the client removes from history as soon as the pairing UI loads.

Commands carry a unique request ID, timestamp, and host process identity. Duplicate accepted commands return their recorded result instead of running again. A changed payload with the same ID is rejected. Pending questions and approvals also require the current runtime generation; steering and interruption require the current turn. A host restart invalidates old command envelopes.

Live events are ordered and bounded by both count and bytes. Clients resume a retained cursor, or remount against a fresh authoritative snapshot after a gap or restart. There is no offline command queue. If a command response is lost, the client reports that the action might have reached the host and does not resend it. Check current task state before retrying manually.

Authentication, origin and Host validation, body/connection/rate limits, static-path containment, a restrictive CSP, and a bounded metadata-only audit log apply at the host boundary. Normal reads are grouped in the audit log by capability/device to avoid flooding it during polling. The long-poll transport works through temporary tunnels that do not support SSE.

HTTPS protects transport. A reverse proxy or Cloudflare tunnel that terminates HTTPS can see application traffic; this implementation does not claim end-to-end encryption through that intermediary. Direct TLS or a proxy you control reduces that trust surface. Remote operators have agent/workflow execution authority; local-only login APIs are not a sandbox against an already-authorized operator asking an agent to access host data.

## Troubleshooting

| Symptom | Recovery |
| --- | --- |
| Pairing link expired or used | Create a fresh link on the host. |
| Instance offline | Keep the Pixice backend and its network endpoint running; check host sleep and firewall settings. |
| Temporary hostname does not resolve | New addresses may need time to propagate. If public DNS resolves the address but your local resolver does not, use a stable endpoint or a network that permits the tunnel hostname. |
| Temporary URL stopped working | Start a new tunnel and pair its fresh link, or configure a stable endpoint. |
| Client origin rejected | Add the exact hosted client origin in host Connections settings. |
| Different host identity | Verify the address, then pair again; saved credentials are not sent to an unexpected host. |
| Access expired/revoked | Pair again with a new host-generated link. |
| File changed on disk | Reopen the file before saving to avoid overwriting newer edits. |
| Listener cannot start | Correct the port or TLS configuration and save settings. Desktop operation remains available. |
| Incompatible protocol | Update host and client to compatible Pixice builds. |

## Design references

The implementation was designed around Pixice's existing service and renderer architecture after reviewing [T3 remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), [T3 Connect internals](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md), and its [authentication HTTP implementation](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/auth/http.ts). No T3 source was copied. Cloudflare's [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) informed the transport choice.
