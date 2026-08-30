# iOS Preview beta architecture

## Product boundary

Pixice supports SwiftUI application development on Apple Silicon Macs with full Xcode and at least one iOS Simulator runtime. A user can open a supported Xcode project or create a deterministic Pixice starter, select a shared scheme and Simulator, build and launch the app, interact with it through Preview, inspect build diagnostics and logs, and stop the session without leaving helper processes behind.

The beta does not rewrite arbitrary Xcode project settings. Physical devices, signing identities, provisioning profiles, archives, and App Store submission remain outside this milestone.

## Runtime modules

- `electron/ios/ios-environment.mjs` reports host, Xcode, and Simulator readiness.
- `electron/ios/ios-session-registry.mjs` owns one cancellable session per Preview workspace and one workspace per Simulator UDID.
- `electron/ios/xcode-projects.mjs` discovers supported projects, workspaces, shared schemes, build settings, app products, and bundle identifiers.
- `electron/ios/ios-build-diagnostics.mjs` converts streaming build output into bounded progress, warnings, errors, and log tails.
- `electron/ios/serve-sim-manager.mjs` owns a scoped `serve-sim` process for one explicit UDID and returns its verified local URL.
- `electron/ios/swiftui-starter.mjs` creates deterministic projects without overwriting existing files.
- `electron/ios/ios-runtime-service.mjs` coordinates boot, build, install, launch, stream, actions, logs, cancellation, and cleanup.
- `electron/ios/ios-tools.mjs` exposes bounded thread-scoped agent tools backed by the runtime service.

No module may run `serve-sim --kill` without a UDID. Every spawned process belongs to an `IosSessionRegistry` record and registers a cleanup before the next lifecycle phase starts.

## Session lifecycle

1. `preparing`: validate the project root, selected project or workspace, shared scheme, Simulator UDID, and environment.
2. `booting`: run `simctl boot` if needed and wait with `simctl bootstatus`.
3. `building`: run a cancellable `xcodebuild` with a session-specific DerivedData directory and stream structured diagnostics.
4. `installing`: resolve the app product and use `simctl install`.
5. `launching`: launch the bundle identifier and capture its PID.
6. `streaming`: start `serve-sim` for the same explicit UDID and verify a real frame before reporting readiness.
7. `ready`: accept bounded user and agent interactions.
8. `stopping`: abort active commands, terminate the stream, run scoped helper cleanup, and release Simulator ownership.
9. `stopped` or `failed`: return final evidence and remove the live registry record.

Draft Preview workspaces adopt their session when Pixice creates the real thread. Closing or archiving a thread, discarding a retained Preview workspace, quitting Pixice, or starting a replacement session triggers the same idempotent stop path.

## Main-process API

Renderer IPC lives under `window.pixice.ios`:

- `environment()` returns readiness, Xcode metadata, devices, and actionable issues.
- `discover({ projectId })` returns supported project containers and shared schemes inside project roots.
- `createStarter({ projectId, name, relativeDirectory, organizationIdentifier })` creates a new starter without overwrite.
- `start({ workspaceId, projectId, containerPath, scheme, simulatorUdid, configuration })` starts or returns the owned session.
- `state({ workspaceId })` returns a public session snapshot and bounded diagnostics.
- `stop({ workspaceId })` performs idempotent cleanup.
- `action({ workspaceId, action, ...arguments })` performs a validated Simulator action.

The main process emits `IosSessionUpdated` with a public snapshot. It never sends child-process handles, environment variables, unbounded logs, or filesystem content to the renderer.

## Agent tools

The `pixice_ios` namespace is thread-scoped. Tool calls resolve the calling thread to a project and its owned session.

- `environment`: inspect prerequisites and available Simulators.
- `discover`: list supported containers and schemes.
- `create_starter`: create a deterministic SwiftUI starter inside the current project.
- `start`: build and open an interactive Simulator Preview.
- `status`: read lifecycle state and bounded diagnostics.
- `stop`: stop only the calling thread's session.
- `inspect`: return normalized accessibility elements when an accessibility backend is available, plus current screenshot evidence.
- `tap`, `type`, `swipe`, `button`, `rotate`, and `appearance`: perform bounded interaction against an explicit session and return action evidence.
- `screenshot`: capture the current Simulator frame.
- `logs`: return a bounded application or Simulator log tail.

Coordinates use normalized values from `0` through `1`. Text, log limits, gesture duration, and screenshot size are capped by schemas. Element references are session and revision scoped. Stale references fail instead of falling back to guessed coordinates.

## Preview representation

Preview adds the `simulator` tab kind. Its context contains only session identity, project ID, device label, UDID, scheme, status, and whether interaction is available. Deeper inspection uses `pixice_ios.status` or `pixice_ios.inspect`.

The tab has device and scheme selectors before launch. During a session it has Run or Rebuild, Stop, appearance, rotate, Home, screenshot, and logs controls. The `serve-sim` page stays isolated from the Pixice renderer. Closing the tab stops its session unless another visible tab in the same workspace owns it.

## Process and filesystem ownership

- Each session gets a stable scratch root under Pixice user data, keyed by project and workspace hashes.
- Xcode DerivedData, logs, screenshots, generated preview hosts, and temporary manifests stay under that scratch root.
- Starter projects are the only iOS files written inside a user's chosen project directory, and creation fails if the target exists or escapes project roots.
- `xcodebuild`, `xcrun`, and `serve-sim` launch without a shell. Arguments remain arrays.
- Stop sends `SIGTERM`, waits a bounded interval, sends `SIGKILL` if required, then performs an explicit UDID-scoped helper cleanup.
- A Simulator UDID cannot belong to two Preview workspaces at once.

## File ownership during implementation

- Runtime worker owns `electron/ios/ios-runtime-service.mjs`, project discovery, and runtime tests.
- Streaming worker owns `electron/ios/serve-sim-manager.mjs` and streaming tests.
- Diagnostics worker owns `electron/ios/xcode-diagnostics.mjs` and diagnostics tests.
- Starter worker owns `electron/ios/swiftui-starter.mjs`, starter resources, and starter tests.
- Agent-tools work owns `electron/ios/ios-tools.mjs` and tool tests.
- Preview integration owns `src/components/ios/`, narrow changes in `src/App.jsx`, `src/styles.css`, and renderer tests.
- Main integration owns narrow changes in `electron/main.mjs`, `electron/preload.cjs`, `src/pixice-api.d.ts`, Preview context, packaging configuration, and integration tests.

Workers must not edit files owned by another active worker. The integrating thread resolves shared-file changes only after focused tests pass.

## Verification gates

1. Pure unit tests run without Xcode, network access, or a listening port.
2. The full Vitest suite and desktop renderer verification pass.
3. Packaged macOS verification confirms bundled resources and helper launch paths.
4. A live Apple Silicon Mac with full Xcode builds a generated starter, boots the selected Simulator, shows a real streamed frame in Preview, accepts input, reports a deliberate compiler error with a clickable source location, rebuilds after the fix, and leaves no helper after Stop or app quit.
5. Package-backed `#Preview` hot reload remains follow-up work. The beta rebuilds the selected app scheme and relaunches it in the same Simulator.
