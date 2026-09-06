# Independent Pixice backend

- Status: implemented
- Date: 2026-09-06
- Extends: Connect 02

One standalone Node process owns providers, tasks, workflow scheduling, approvals, persistent data, simulator tools, and the public Connect listener. The desktop is a client of the same application operation registry and event protocol as the web client. Its privileged local operations use a separate authenticated loopback listener and are not exported to paired remote devices.

Electron remains the native helper for browser views and OS facilities. The same helper process can display the desktop interface; quitting that interface unloads its renderer while preserving browser pages and leaving the Node service alive. The helper's lease and fixed capability list are private to the OS owner's connection. Native actions are never automatically retried after a helper disconnect.

An OS-managed exclusive ownership lock precedes database migration or access. Updates and intentional backend stops freeze new work, reject implicit interruption, drain pending application operations, close owned runtimes, and release the lock only after storage closes. Explicit forced shutdown cancels workflows and provider turns. Recovery preserves existing data and does not resubmit interrupted provider work.

The default local experience retains native browser views and existing UI. CLI hosts can run without Electron; OS browser and credential functions become available when a configured helper connects. Optional start-at-login starts the helper and backend in the background. A permanent tunnel address and any managed identity/relay service remain separate concerns.

See [remote and service operations](../REMOTE.md) for configuration, recovery, encryption-key handling, and limits.
