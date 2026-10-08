import { randomUUID } from "node:crypto";

// Schema evidence lives in work/voice-implementation/protocol-0.159.0.json.
// This is a version-specific adapter contract, not an account entitlement claim.
export const CODEX_0159_VOICE_CAPABILITIES = Object.freeze({
  schemaVersion: "0.159.0", experimentalApi: true,
  transports: Object.freeze(["webrtc", "websocket"]),
  versions: Object.freeze(["v1", "v2", "v3"]),
  outputModalities: Object.freeze(["audio", "text"]),
});

export class VoiceSessionError extends Error {
  constructor(code, message) { super(message); this.name = "VoiceSessionError"; this.code = code; }
}
function fail(code, message) { throw new VoiceSessionError(code, message); }
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("voice_invalid_request", `${name} must be a nonempty string`);
  return value;
}
function scopeKey(scope) {
  return JSON.stringify([requiredString(scope?.projectId, "projectId"), requiredString(scope?.threadId, "threadId")]);
}
function publicError(error, fallback = "voice_runtime_error") {
  return { code: error?.code ?? fallback, message: String(error?.message ?? error)
    .replace(/\b(?:sk-|eyJ)[\w.-]+/g, "[redacted]")
    .replace(/(bearer\s+)[\w.-]+/gi, "$1[redacted]") };
}
export function normalizeVoiceCatalog(response) {
  const voices = response?.voices;
  if (!voices || !["v1", "v2"].every((key) => Array.isArray(voices[key]) && voices[key].every((v) => typeof v === "string" && v))) {
    fail("voice_catalog_invalid", "Codex returned an invalid voice catalog");
  }
  for (const [list, key] of [["v1", "defaultV1"], ["v2", "defaultV2"]]) {
    if (!voices[list].includes(voices[key])) fail("voice_catalog_invalid", `Codex returned an invalid ${key}`);
  }
  return { v1: [...new Set(voices.v1)], v2: [...new Set(voices.v2)], defaultV1: voices.defaultV1, defaultV2: voices.defaultV2 };
}

/** Inject the existing native CodexRuntime, never a new API client or credential.
 * resolveScope MUST validate project ownership, provider, current authoritative
 * thread and renewal admission. It returns {projectId, threadId, provider:"codex"}.
 * Call prepare inside the same host admission gate used by session renewal.
 */
export function createVoiceSessionBridge({ runtime, resolveScope, capabilities = {}, admitInput = () => {}, prepareTimeoutMs = 30000 }) {
  if (!runtime?.request || typeof resolveScope !== "function") throw new TypeError("runtime and resolveScope are required");
  const sessions = new Map();
  const listeners = new Set();
  let disposed = false;
  const support = () => typeof capabilities === 'function' ? capabilities() : capabilities;
  const snapshot = (entry) => ({ projectId: entry.projectId, threadId: entry.threadId, sessionHandle: entry.sessionHandle,
    state: entry.state, transport: entry.transport ?? null, version: entry.version ?? null,
    realtimeSessionId: entry.realtimeSessionId ?? null, voice: entry.voice ?? null });
  const publish = (entry, type, payload = {}) => {
    const event = { ...snapshot(entry), type, ...payload };
    // A failed UI subscriber cannot interrupt native stop or lease release.
    for (const listener of listeners) { try { listener(event); } catch { /* subscriber owns its errors */ } }
  };
  const release = (entry, reason) => {
    clearTimeout(entry.timer);
    if (sessions.get(entry.key) !== entry) return;
    entry.state = "closed";
    publish(entry, "closed", { reason });
    sessions.delete(entry.key);
  };
  function checkRuntime() {
    if (disposed) fail("voice_disposed", "Voice bridge is disposed");
    if (!runtime.connected) fail("voice_runtime_unavailable", "The native Codex runtime is disconnected");
    if (support().experimentalApi !== true || !support().schemaVersion) {
      fail("voice_unsupported", "Native voice protocol support has not been verified for this runtime");
    }
  }
  async function authorize(scope) {
    const key = scopeKey(scope);
    const current = await resolveScope({ projectId: scope.projectId, threadId: scope.threadId });
    if (current?.projectId !== scope.projectId || current?.threadId !== scope.threadId) {
      fail("voice_thread_changed", "The authoritative Focus thread changed. Start voice again on the current thread.");
    }
    if (current.provider !== "codex") fail("voice_provider_unsupported", "Native voice requires a Codex thread");
    return key;
  }
  async function availability(scope) {
    checkRuntime();
    await authorize(scope);
    const account = await runtime.request("account/read", { refreshToken: false });
    if (account?.account?.type !== "chatgpt") fail("voice_account_unavailable", "Native voice requires an existing signed-in ChatGPT Codex account");
    const catalog = normalizeVoiceCatalog(await runtime.request("thread/realtime/listVoices", {}));
    checkRuntime();
    await authorize(scope);
    return { catalog, capabilities: { schemaVersion: support().schemaVersion, experimentalApi: true,
      transports: [...(support().transports ?? [])], versions: [...(support().versions ?? [])],
      outputModalities: [...(support().outputModalities ?? [])] }, sessionAvailability: "unverified" };
  }
  function getEntry(scope) {
    const entry = sessions.get(scopeKey(scope));
    if (!entry || entry.sessionHandle !== scope.sessionHandle) fail("voice_session_stale", "This voice session is no longer current");
    return entry;
  }
  async function prepare(scope) {
    checkRuntime();
    const key = scopeKey(scope);
    if (sessions.has(key) || [...sessions.values()].some((s) => s.threadId === scope.threadId)) {
      fail("voice_session_busy", "Voice is already preparing or active on this thread");
    }
    // Reserve synchronously, before any async authorization or microphone work.
    const entry = { key, projectId: scope.projectId, threadId: scope.threadId, sessionHandle: randomUUID(), state: "preparing" };
    sessions.set(key, entry);
    entry.timer = setTimeout(() => release(entry, 'preparation_timeout'), prepareTimeoutMs);
    entry.timer.unref?.();
    try {
      await authorize(scope);
      checkRuntime();
      if (sessions.get(key) !== entry) fail("voice_session_stale", "Voice preparation was cancelled");
      publish(entry, "state");
      return snapshot(entry);
    } catch (error) { release(entry, "preparation_failed"); throw error; }
  }
  async function start(input) {
    admitInput();
    const entry = getEntry(input);
    if (entry.state !== "preparing") fail("voice_session_busy", "Voice has already started or is stopping");
    clearTimeout(entry.timer);
    entry.state = "starting";
    publish(entry, "state");
    entry.startTask = (async () => {
      const { catalog } = await availability(input);
      await authorize(input);
      admitInput();
      if (entry.cancelled || sessions.get(entry.key) !== entry) fail("voice_start_cancelled", "Voice start was cancelled");
      const type = input.transport?.type;
      if (!support().transports?.includes(type)) fail("voice_transport_unsupported", "This runtime does not support the requested voice transport");
      const transport = type === "webrtc" ? { type, sdp: requiredString(input.transport.sdp, "SDP offer") } : { type };
      const outputModality = input.outputModality ?? "audio";
      if (!support().outputModalities?.includes(outputModality)) fail("voice_invalid_request", "Unsupported output modality");
      const params = { threadId: entry.threadId, outputModality, transport };
      if (input.version != null) {
        if (!support().versions?.includes(input.version)) fail("voice_invalid_request", "Unsupported realtime version");
        params.version = input.version;
      }
      if (input.voice != null) {
        // listVoices has no v3 catalog. Do not invent a v3 -> v2 mapping.
        if (input.version === "v3") fail("voice_catalog_version_unknown", "Codex does not expose a v3 voice catalog. Use its configured default voice.");
        const voices = input.version ? catalog[input.version] : [...catalog.v1, ...catalog.v2];
        if (!voices.includes(input.voice)) fail("voice_selection_unavailable", "The selected voice is absent from the live Codex catalog");
        params.voice = input.voice;
      }
      entry.transport = type;
      entry.voice = params.voice ?? null;
      entry.version = params.version ?? null;
      entry.sessionRequested = true;
      // start responds with {}, SDP arrives separately and may precede response.
      await runtime.request("thread/realtime/start", params);
      return snapshot(entry);
    })();
    try { return await entry.startTask; }
    catch (error) {
      publish(entry, "error", { error: publicError(error) });
      try { await stop(input, "start_failed"); } catch { /* stop_failed remains a renewal blocker */ }
      throw error;
    }
  }
  async function stop(input, reason = "user_stop") {
    const entry = getEntry(input);
    if (entry.stopTask) return entry.stopTask;
    entry.cancelled = true;
    entry.state = "stopping";
    publish(entry, "state");
    entry.stopTask = (async () => {
      await entry.startTask?.catch(() => {});
      if (sessions.get(entry.key) !== entry) return { stopped: true };
      if (!entry.sessionRequested) { release(entry, reason); return { stopped: true }; }
      if (!runtime.connected) { release(entry, "runtime_disconnected"); return { stopped: true }; }
      try {
        await runtime.request("thread/realtime/stop", { threadId: entry.threadId });
        release(entry, reason);
        return { stopped: true };
      } catch (error) {
        if (sessions.get(entry.key) === entry) {
          entry.state = "stop_failed";
          publish(entry, "error", { error: publicError(error, "voice_stop_failed") });
        }
        throw error;
      }
    })();
    try { return await entry.stopTask; } finally { entry.stopTask = null; }
  }
  async function append(input, method, payload) {
    checkRuntime();
    const entry = getEntry(input);
    await authorize(input);
    admitInput();
    if (sessions.get(entry.key) !== entry || entry.state !== "active") fail("voice_not_active", "Voice is not active");
    try { await runtime.request(method, { threadId: entry.threadId, ...payload }); }
    catch (error) { publish(entry, "error", { error: publicError(error) }); throw error; }
    return { appended: true };
  }
  function appendText(input) {
    const role = input.role ?? "user";
    if (!["user", "developer", "assistant"].includes(role)) fail("voice_invalid_request", "Unsupported text role");
    return append(input, "thread/realtime/appendText", { text: requiredString(input.text, "text"), role });
  }
  function appendSpeech(input) {
    return append(input, "thread/realtime/appendSpeech", { text: requiredString(input.text, "text") });
  }
  function appendAudio(input) {
    const entry = getEntry(input);
    if (entry.transport !== "websocket") fail("voice_transport_unsupported", "WebRTC sends microphone audio over its media track");
    const source = input.audio;
    const audio = { data: requiredString(source?.data, "audio.data") };
    for (const [key, max] of [["sampleRate", 0xffffffff], ["numChannels", 0xffff]]) {
      if (!Number.isInteger(source[key]) || source[key] <= 0 || source[key] > max) fail("voice_invalid_request", `Invalid audio.${key}`);
      audio[key] = source[key];
    }
    if (source.samplesPerChannel != null) {
      if (!Number.isInteger(source.samplesPerChannel) || source.samplesPerChannel < 0 || source.samplesPerChannel > 0xffffffff) fail("voice_invalid_request", "Invalid samplesPerChannel");
      audio.samplesPerChannel = source.samplesPerChannel;
    }
    if (source.itemId != null) audio.itemId = requiredString(source.itemId, "audio.itemId");
    // Encoding is deliberately opaque. Schema specifies no PCM format.
    return append(input, "thread/realtime/appendAudio", { audio });
  }
  function onEvent(event) {
    const message = event?.payload ?? event;
    const method = message?.method;
    const params = message?.params ?? message;
    if (!method?.startsWith("thread/realtime/")) return;
    const entry = [...sessions.values()].find((s) => s.threadId === params.threadId && s.sessionRequested);
    if (!entry) return;
    if (params.projectId != null && params.projectId !== entry.projectId) return;
    switch (method.slice("thread/realtime/".length)) {
      case "started":
        if (!support().versions?.includes(params.version)) {
          publish(entry, 'error', { error: { code: 'voice_version_unsupported', message: 'Codex started an unverified native voice version. Stop this session.' } });
          break;
        }
        entry.version = params.version;
        entry.realtimeSessionId = params.realtimeSessionId ?? null;
        if (!entry.cancelled) entry.state = "active";
        publish(entry, "started"); break;
      case "sdp": if (typeof params.sdp === "string") publish(entry, "sdp", { sdp: params.sdp }); break;
      case "closed": release(entry, params.reason ?? "runtime_closed"); break;
      case "error": publish(entry, "error", { error: publicError({ message: params.message }) }); break;
      case "transcript/delta": case "transcript/done":
        publish(entry, method.endsWith("/delta") ? "transcript_delta" : "transcript_done", {
          role: params.role, ...(method.endsWith("/delta") ? { delta: params.delta } : { text: params.text }) }); break;
      case "item/transcript/delta": publish(entry, "item_transcript_delta", { itemId: params.itemId, delta: params.delta }); break;
      case "item/started": case "item/completed": {
        const item = params.item;
        if (typeof item?.id !== "string" || typeof item.realtimeSessionId !== "string") break;
        if (entry.realtimeSessionId == null) entry.realtimeSessionId = item.realtimeSessionId;
        if (item.realtimeSessionId !== entry.realtimeSessionId) break;
        const safe = { id: item.id, type: item.type, realtimeSessionId: item.realtimeSessionId };
        if (item.type === "transcriptSegment") { safe.role = item.role; safe.text = item.text; }
        else if (item.type === "realtimeSessionClosed") safe.outcome = item.outcome;
        else if (item.type !== "realtimeSessionStarted") break;
        publish(entry, method.endsWith("/started") ? "item_started" : "item_completed", { item: safe }); break;
      }
      case "outputAudio/delta":
        if (entry.transport === "websocket") {
          const { data, sampleRate, numChannels, samplesPerChannel, itemId } = params.audio ?? {};
          publish(entry, "audio_delta", { audio: { data, sampleRate, numChannels, samplesPerChannel, itemId } });
        }
        break;
      // itemAdded is explicitly untyped. Never relay arbitrary raw backend data.
    }
  }
  function onStatus(status) {
    if (status.provider && status.provider !== "codex") return;
    if (runtime.connected === false && ["connecting", "reconnecting", "stopped", "unavailable", "error"].includes(status.state)) {
      for (const entry of [...sessions.values()]) release(entry, "runtime_disconnected");
    }
  }
  runtime.on?.("event", onEvent);
  runtime.on?.("voice-event", onEvent);
  runtime.on?.("status", onStatus);
  return {
    availability, prepare, start, stop, appendText, appendSpeech, appendAudio,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot(scope) { const entry = sessions.get(scopeKey(scope)); return entry ? snapshot(entry) : null; },
    blocksRollover({ projectId, threadId } = {}) {
      return [...sessions.values()].some((s) => (!projectId || s.projectId === projectId) && (!threadId || s.threadId === threadId));
    },
    async stopProject(projectId, reason = "project_closed") {
      const results = await Promise.allSettled([...sessions.values()].filter((s) => s.projectId === projectId).map((s) => stop(s, reason)));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...sessions.values()].map((s) => stop(s, "bridge_disposed")));
      if (results.some((r) => r.status === "rejected")) fail("voice_stop_failed", "Native voice could not stop. Keep the renewal blocker and retry disposal.");
      runtime.off?.("event", onEvent); runtime.off?.("status", onStatus); listeners.clear();
      runtime.off?.("voice-event", onEvent);
    },
  };
}

/** Produces handlers only. The host registers them after installing the renewal
 * guard. authorizeInvoke enforces caller access; admitPrepare shares the renewal
 * mutex, e.g. (scope, run) => renewal.withProject(scope.projectId, run).
 */
export function createVoiceInvokeHandlers({ bridge, authorizeInvoke, admitPrepare }) {
  if (typeof authorizeInvoke !== "function" || typeof admitPrepare !== "function") throw new TypeError("Host authorization and prepare admission are required");
  const handlers = {};
  for (const operation of ["availability", "prepare", "start", "stop", "appendText", "appendSpeech", "appendAudio", "snapshot"]) {
    handlers[`voice:${operation}`] = async (event, payload, context) => {
      scopeKey(payload);
      await authorizeInvoke({ event, payload, context, operation });
      if (operation === "prepare") return admitPrepare(payload, () => bridge.prepare(payload));
      return bridge[operation](payload, payload.reason);
    };
  }
  return handlers;
}
