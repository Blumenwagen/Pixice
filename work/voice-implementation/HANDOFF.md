# Native voice implementation handoff

Focus work `f0469fc2-a48f-49fc-9064-2cf385285354`, project `acf157b1-b774-4c26-acf7-8ae4dd6a0a5c`.

The isolated native bridge, renderer controller, settings model and invoke adapters are implemented. They are not registered in the application, preload, provider or Focus UI. Final voice visuals remain pending the user's selection among the three Preview concepts. This work does not change the Focus conversation, Work in flight rail or dictation.

Direction r5 applies. No workers were spawned, dependencies added, commits made, applications relaunched, live coordinator sessions rotated, paid voice sessions opened or microphones recorded.

## Evidence and sources

The OpenAI Docs skill was read and its official search and fetch tools were used before local protocol verification. The fetched [Codex app-server documentation](https://developers.openai.com/codex/app-server) establishes the initialization handshake, experimental API opt-in and version-specific schema generation. It does not establish account-specific voice entitlement or prices.

The fetched [official WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) documents the browser audio-track, ICE and data-channel setup, including the `oai-events` label. Only these browser transport mechanics are used. The implementation does not use that guide's API-key endpoints, models, session commands or voice controls.

Local executable `/Users/blumenwagen/.local/bin/codex --version` returned `codex-cli 0.159.0`. A fresh `app-server generate-json-schema --experimental` run produced [protocol-0.159.0.json](./protocol-0.159.0.json). The retained artifact contains all 23 realtime schemas and the six request and eleven notification descriptors. SHA-256 is `259f95fb8307a7cded13d646fabfbae5cbe518af0db09c4a9d72d866dda95c00`.

[probe.mjs](./probe.mjs) creates a separate temporary app-server connection, performs initialize/initialized, `account/read` with `refreshToken: false`, and `thread/realtime/listVoices`, then terminates that process. It never invokes thread/start, realtime/start or media capture. [probe-result.json](./probe-result.json) records the successful ChatGPT account-mode and live catalog probe, with no account identifiers or tokens. The snapshot is evidence only. The application must fetch catalogs dynamically and must not copy these lists into UI code.

No applicable AGENTS.md was found in the workspace or its ancestor directories at implementation time. Only the assigned write resources were edited. Concurrent coordinator changes outside these resources were read for the integration contract, not modified here.

## Implemented paths

| Path | Responsibility |
| --- | --- |
| `electron/runtime/voice-session.mjs` | Injected Codex bridge, leases, catalog/account checks, RPC projections, scoped events, renewal guard and unregistered invoke handlers |
| `src/voice/controller.js` | Explicit-consent WebRTC media lifecycle, mute, device replacement, output, captions, disconnect and cleanup |
| `src/voice/settings.js` | Supported settings validation and source/capability descriptions |
| `src/voice/client.js` | Injected invoke and Pixice event-bus adapter |
| `src/voice/index.js` | Renderer exports |
| `tests/voice-session.test.js` | Protocol, ownership, admission, stop, failure and notification tests |
| `tests/voice-controller.test.js` | Consent, media races, settings, captions and adapter tests |
| `work/voice-implementation` | Exact schema, safe probe, result and this handoff |

## Settings matrix

| Setting | Verified mechanism | Availability and change behavior |
| --- | --- | --- |
| Voice | Native start parameter `voice`; live `listVoices` | No voice-update method. Changes set `restartRequired` and take effect on the next explicit start. Null preserves Codex's default. |
| Microphone | Browser `getUserMedia` with exact `deviceId`; active `RTCRtpSender.replaceTrack` | No permission request during construction, discovery or device enumeration. Start and active replacement require `userInitiated: true`. |
| Mute | Local microphone `MediaStreamTrack.enabled` | Applies immediately. It does not alter Codex VAD or revoke OS microphone permission. Stop releases the track. |
| Output volume | Local audio element `volume`, range 0 through 1 | Exposed only if the media element has the volume property. Runtime/browser behavior still requires a user-driven smoke test. |
| Output device | Local audio element `setSinkId` | Exposed only when that method exists. Permission and missing-device failures are surfaced. Empty identifier resets to browser default. |
| Captions | App-server flat transcripts and canonical realtime transcript items | Local display toggle, bounded to 200 entries and 16,000 characters per entry. Captions are not independently persisted. |
| Speech speed, interrupt VAD, personality | No matching native realtime start or update field | Rejected as unsupported settings. Preview mock controls must not be presented as verified features. |

Catalog response is `{voices: {v1: string[], v2: string[], defaultV1: string, defaultV2: string}}`. There is no advertised v3 catalog and no advertised version selector in `listVoices`. With no explicit protocol version, selection is checked against the union of the live lists, and the native start remains authoritative about compatibility. With explicit v1 or v2, selection is checked against that list. With explicit `version: "v3"`, the bridge rejects any non-null explicitly selected voice with `voice_catalog_version_unknown`, including a voice identifier matching a native default. Omitting `voice` or passing null leaves it out of the native start request and preserves Codex's configured default. The adapter does not invent a v3-to-v2 mapping. UI should retain the runtime default version unless product requirements and further verification justify overriding it.

## Exact native protocol

All methods are experimental and require `initialize.capabilities.experimentalApi: true`. Runtime start responses contain an empty object, not an SDP answer.

| Method | Params and response |
| --- | --- |
| `thread/realtime/listVoices` | Empty object params; catalog response above |
| `thread/realtime/start` | Required `threadId: string`, `outputModality: "text" | "audio"`; optional fields below; response `{}` |
| `thread/realtime/appendText` | Required `threadId: string`, `text: string`; optional `role: "user" | "developer" | "assistant"`, default user; response `{}` |
| `thread/realtime/appendSpeech` | Required `threadId: string`, `text: string`; response `{}` |
| `thread/realtime/appendAudio` | Required `threadId: string`, `audio: AudioChunk`; response `{}` |
| `thread/realtime/stop` | Required `threadId: string`; response `{}` |

`AudioChunk` requires `data: string`, `sampleRate: uint32`, `numChannels: uint16`. Optional `itemId` is string or null and `samplesPerChannel` is uint32 or null. Schema does not describe encoding, endianness or PCM format. The bridge validates and forwards opaque audio for websocket transport. It requires positive channel count and sample rate for usable audio, a stricter media constraint than the schema's zero minimum. The renderer does not assume a codec or implement an automatic websocket fallback.

Native start optional fields, exactly as generated:

| Field | Type or allowed values | Adapter exposure |
| --- | --- | --- |
| `transport` | Null, `{type:"websocket"}`, `{type:"webrtc",sdp:string}`, or `{type:"existingCall",callId:string}` | WebRTC and websocket. Existing-call adoption is intentionally not exposed. |
| `voice` | Runtime voice enum or null | Live catalog selection only; enum is not copied into implementation |
| `version` | `v1`, `v2`, `v3` or null | Optional host/controller configuration; not a visual setting |
| `model` | String or null | Not exposed; preserve native configured model |
| `prompt`, `realtimeSessionId`, `realtimeStartInstructions`, `realtimeEndInstructions` | String or null | Not accepted from renderer |
| `backendReasoningStatus` | Boolean, optional | Preserve native default |
| `clientManagedHandoffs`, `codexResponsesAsItems`, `delegationAckFiller`, `flushTranscriptTailOnSessionEnd`, `includeStartupContext` | Boolean or null | Preserve native defaults |
| `codexResponseHandoffMode` | `thinking`, `commentary`, `bemTags` or null | Preserve native default |
| `codexResponseHandoffChannelPrefixes` | Object of string-array values or null | Preserve native default |
| `codexResponseItemPrefix` | String or null | Preserve native default |
| `initialItems` | Array of `{role:"user"|"developer"|"assistant",text:string}` or null | Not exposed; schema restricts to v3, 128 items, 8,192 estimated text tokens |

Notifications use prefix `thread/realtime/` and a required `threadId: string`:

| Suffix | Remaining fields | Bridge handling |
| --- | --- | --- |
| `started` | Required version; optional string-or-null realtimeSessionId | Records native session, marks an uncancelled bridge session active and publishes `started`. Renderer intentionally does not use this event to become active. |
| `sdp` | Required sdp string | Emits SDP answer separately; renderer subscribes before start |
| `closed` | Optional string-or-null reason | Releases lease, emits `closed` |
| `error` | Required message string | Emits explicit error; renderer stops capture and requests native stop |
| `outputAudio/delta` | Required AudioChunk | Websocket-only projected audio event |
| `transcript/delta` | Required role string and delta string | Flat caption delta |
| `transcript/done` | Required role string and text string | Flat final caption text |
| `item/started`, `item/completed` | Required canonical realtime item | Projects transcript and session items only; canonical text replaces streamed deltas |
| `item/transcript/delta` | Required itemId string and delta string | Canonical caption delta |
| `itemAdded` | Required arbitrary JSON item | Deliberately not relayed to renderer |

Canonical items require `id` and `realtimeSessionId`, both strings. Types are `realtimeSessionStarted`, `transcriptSegment` with required user-or-assistant role and text, `bemItemPromoted` with item_id, turn_id and presentation, or `realtimeSessionClosed` with ended-or-failed outcome. Full promotion presentation fields are preserved in the schema artifact; this voice bridge leaves agent-item presentation to existing application event handling.

## Integration contract

Instantiate one bridge for the existing native CodexRuntime, not ProviderRegistry, an API client or a new logged-in process. Supply version-verified capabilities only after discovering the actual executable and its schema support. The exported `CODEX_0159_VOICE_CAPABILITIES` is the verified 0.159.0 adapter contract, not a claim that an arbitrary connected executable is compatible or that the account has live voice access.

```js
const voice = createVoiceSessionBridge({
  runtime: codexRuntime,
  capabilities: CODEX_0159_VOICE_CAPABILITIES,
  resolveScope: async ({ projectId, threadId }) => {
    const project = getProject(projectId);
    const session = database.getProjectFocusSession(project.id);
    return {
      projectId: project.id,
      threadId: session?.threadId,
      provider: session ? runtime.providerForThread(session.threadId) : null,
    };
  },
});

host.setFocusVoiceGuard((projectId, threadId) =>
  voice.blocksRollover({ projectId, threadId }));

const voiceHandlers = createVoiceInvokeHandlers({
  bridge: voice,
  authorizeInvoke: assertAuthorizedDesktopVoiceCaller,
  admitPrepare: (scope, operation) =>
    host.withFocusSessionAdmission(scope, () => operation()),
});
for (const [channel, handler] of Object.entries(voiceHandlers)) {
  host.handlers.handle(channel, handler);
}
const unsubscribeVoice = voice.subscribe((payload) =>
  sendToAuthorizedProjectRenderers("VoiceSessionEvent", payload));
```

This snippet is an integration recipe. The application-local `getProject`, database, runtime and sender must be supplied by the coordinator at wiring time. The currently available host hooks are `setFocusVoiceGuard` and `withFocusSessionAdmission`. Registration remains undone by design.

The scope resolver must read current authority without acquiring the admission lock. Do not implement it by nesting `withFocusSessionAdmission` inside prepare admission, which would deadlock the same project lock. That lock belongs around the preparation handler, while `resolveScope` is a read-only authority check. The host's admission method checks accepting work, authoritative thread identity, provider and active/starting turns. Installation order is guard, admission-backed prepare handler, then renderer access.

All invoke payloads include projectId and authoritative threadId. Calls after preparation also carry sessionHandle. Channels are `voice:availability`, `voice:prepare`, `voice:start`, `voice:stop`, `voice:appendText`, `voice:appendSpeech`, `voice:appendAudio` and `voice:snapshot`. `createVoiceInvokeHandlers` returns unregistered `(event, payload, context)` handlers and requires caller authorization for every operation. Host authorization should reject unapproved remote callers. Project deletion and host/window shutdown must call `stopProject` or `dispose`; native stop failures must stay visible and retain the guard.

Bridge subscription events have projectId, threadId, sessionHandle, state, transport, version, realtimeSessionId and voice, plus their typed payload. They do not include account details, bearer credentials, raw arbitrary items or raw request responses. Do not pass them through logging, notification history or an unscoped Connect broadcast. SDP is ephemeral negotiation data and should reach only its authorized renderer. Existing generic `TaskUpdated` handling must continue to process canonical native timeline events once, while the projected voice bus serves only voice media/display state.

`prepare` reserves synchronously before async ownership validation and expires an abandoned lease after 30 seconds. The renewal guard covers preparing, starting, active, stopping and stop_failed states. `stop_failed` retains authority until an explicit retry succeeds, a native closed notification arrives or the owning runtime disconnects. A start RPC rejection is followed by a stop attempt to resolve uncertain startup. Never auto-retry realtime/start after a timeout.

Renderer preload can expose a scoped voice method object directly or inject `createVoiceClient({invoke,subscribe})`. The latter forwards the existing event envelope `{type:"VoiceSessionEvent",payload}`. Invoke promises reject visibly; the existing transport must preserve their messages. If Electron drops custom error codes on rejected invoke promises, state events retain start/stop error codes, but discovery failures may only retain the rejection message until the coordinator adds its standard typed-error serialization.

```js
const client = createVoiceClient({ invoke: desktopInvoke, subscribe: pixice.events.subscribe });
const controller = createVoiceController({ bridge: client, scope: { projectId, threadId } });
const unsubscribe = controller.subscribe(renderSelectedVoiceConcept);
// Only a deliberate user interaction calls this:
await controller.start({ userInitiated: true });
// An authoritative Focus session update must feed its actual thread identifier:
await controller.setScope({ projectId, threadId: focusState.session.threadId });
// Explicit local settings and media controls:
await controller.updateSettings({ muted: true, outputVolume: 0.5, captions: true });
await controller.selectMicrophone(deviceId, { userInitiated: true });
await controller.stop();
await controller.dispose();
unsubscribe();
```

Controller construction, availability refresh and device enumeration never ask for microphone permission. The explicit action flag is a caller contract, not proof of a browser gesture. UI must call start from its selected voice control and must never restore a running voice session automatically from persisted state. Devices can have empty labels before permission. Track mute retains the microphone capture allocation; stop ends capture. Permission requests cannot always be cancelled by browsers, so capture returned after a stop is stopped immediately.

Controller states are idle, preparing, connecting, active, stopping, stop_failed, disconnected and error. The native bridge publishes `started` when startup is accepted. The renderer intentionally does not consume `started` as a transition to active; it remains connecting until `RTCPeerConnection.connectionState` reports connected. Native acceptance and media readiness are separate states. ICE gathering and connection negotiation have bounded timeouts. Autoplay failures expose outputBlocked and allow `resumeOutput({userInitiated:true})`. Caption selection does not mutate native history. One controller belongs to one project/thread scope; `setScope` stops the previous session before rebinding, never reconnects automatically and clears stale display data. Live device changes mark devicesChanged for an explicit enumeration refresh. Disposal removes device and bridge subscriptions.

No dictation service, microphone PCM recorder, transcription composer, model library or audio-input hotkey is altered. Future UI should keep Start voice distinct from dictation and ensure its media ownership rules prevent simultaneous unwanted capture.

## Verification and remaining work

Targeted command is `pnpm exec vitest run tests/voice-session.test.js tests/voice-controller.test.js`. Result is 37 passing tests in two files. Tests cover official-schema fields, live catalog projection, unsupported accounts/settings, admission reservation, multiple projects, stale handles and authoritative threads, early SDP, runtime shutdown, uncertain stop retry, explicit consent, permission denial, stop during permission and preparation, mic replacement failure, muted tracks, output support/autoplay, bounded captions, ICE/negotiation timeout and the real isolated bridge plus renderer controller using fake runtime and media.

Syntax checks passed for the bridge, all four renderer modules and both test files. Diff whitespace checks passed for the assigned artifacts. The read-only native catalog probe passed. No live voice connection or microphone smoke test was performed. No full app, build, packaging or broader suite result is claimed. These modules are currently unreachable from the running UI.

Remaining integration belongs to the coordinator:

1. Confirm/select the final Preview voice concept before UI work.
2. Bind existing CodexRuntime and current Focus authority, register handlers/event subscriptions, expose preload/types, and install the guard plus preparation admission lock. Keep all final generation checks in the same lock as renewal.
3. Wire the selected UI to the authoritative `focusState.session.threadId`, controller disposal, visible errors and real capability-based settings. Persist only settings after the persistence contract is approved; do not persist or restore an active mic/session.
4. Register Electron microphone permission handling, confirm macOS microphone usage description and renderer media access for the actual origin, and stop voice before provider/account replacement or shutdown. Keep guard failures visible.
5. Review canonical transcript timeline handling against the existing TaskUpdated pipeline. Do not double-render flat captions as durable chat items.
6. With an explicit user start action, verify actual account entitlement, SDP/media exchange, negotiated protocol version, catalog compatibility, transcripts, selected mic/speaker, autoplay and stop/renewal interaction. Do not rotate the development/live coordinator as a test.

Known protocol limits remain visible. `listVoices` success proves catalog support, not account voice entitlement. The schema offers no entitlement probe, hot voice update, speed/VAD/personality setting or documented PCM encoding. WebRTC is preferred and required by the renderer; no unverified codec fallback or existing-call adoption is included. Most native notifications lack a session generation identifier. Local handles reject stale renderer traffic, but same-thread rapid restarts still depend on native stop/closed ordering. Do not start another native session until the prior stop has been acknowledged; a user-driven runtime check is needed to verify late-notification ordering.
