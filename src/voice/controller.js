import { describeVoiceSettings, normalizeVoiceSettings } from "./settings.js";

function errorInfo(error, fallback = "voice_media_error") {
  const codes = { NotAllowedError: "voice_microphone_denied", SecurityError: "voice_microphone_denied", NotFoundError: "voice_microphone_missing",
    OverconstrainedError: "voice_microphone_unavailable", NotReadableError: "voice_microphone_busy" };
  return { code: typeof error?.code === "string" ? error.code :
    (fallback === "voice_media_error" ? codes[error?.name] : null) ?? fallback, message: String(error?.message ?? error) };
}
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function validScope(scope) {
  if (![scope?.projectId, scope?.threadId].every((v) => typeof v === "string" && v.trim())) throw new TypeError("An authoritative projectId and threadId are required");
  return { projectId: scope.projectId, threadId: scope.threadId };
}
function stopStream(stream) { stream?.getTracks().forEach((track) => track.stop()); }

// No React or persistence dependency. Construction and catalog reads never use a mic.
export function createVoiceController({ bridge, scope: initialScope, settings: initialSettings = {}, version = null,
  mediaDevices = globalThis.navigator?.mediaDevices,
  peerConnectionFactory = globalThis.RTCPeerConnection ? () => new globalThis.RTCPeerConnection() : null,
  audioFactory = globalThis.Audio ? () => new globalThis.Audio() : () => null,
  mediaStreamFactory = globalThis.MediaStream ? (tracks) => new globalThis.MediaStream(tracks) : null,
  iceTimeoutMs = 10000, connectionTimeoutMs = 20000,
} = {}) {
  if (!bridge?.subscribe || !bridge.prepare || !bridge.start || !bridge.stop || !bridge.availability) throw new TypeError("A voice bridge client is required");
  let scope = validScope(initialScope);
  const audio = audioFactory();
  const outputCapabilities = { volume: Boolean(audio && "volume" in audio), outputDevice: typeof audio?.setSinkId === "function" };
  let settings = normalizeVoiceSettings(initialSettings, outputCapabilities);
  let current = null;
  let disposed = false;
  let deviceGeneration = 0;
  let settingsTask = Promise.resolve();
  const listeners = new Set();
  let state = { state: "idle", permission: "unknown", error: null, catalog: null, capabilities: null,
    sessionAvailability: "unverified", captions: [], restartRequired: false, outputBlocked: false };
  const snapshot = () => ({ ...state, scope: { ...scope }, sessionHandle: current?.handle ?? null,
    settings: { ...settings }, captions: settings.captions ? state.captions.map((c) => ({ ...c })) : [],
    catalog: state.catalog ? { ...state.catalog, v1: [...state.catalog.v1], v2: [...state.catalog.v2] } : null,
    settingsModel: describeVoiceSettings({ catalog: state.catalog, version, microphone: Boolean(mediaDevices?.getUserMedia), ...outputCapabilities }) });
  function update(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) { try { listener(snapshot()); } catch { /* UI owns subscriber errors */ } }
  }
  function isCurrent(run) { return current === run && !run.cancelled && !disposed; }
  function check(run) { if (!isCurrent(run)) throw problem("voice_start_cancelled", "Voice start was cancelled"); }
  function cleanMedia(run) {
    clearTimeout(run.connectionTimer);
    run.cancelIce?.();
    run.channel && (run.channel.onclose = null);
    run.channel && (run.channel.onerror = null);
    if (run.peer) { run.peer.ontrack = null; run.peer.onconnectionstatechange = null; }
    run.stream?.getTracks().forEach((track) => { track.onended = null; });
    stopStream(run.stream);
    for (const track of run.remoteTracks ?? []) track.stop();
    run.channel?.close(); run.peer?.close();
    if (current === run && audio) { audio.pause?.(); audio.srcObject = null; }
  }
  async function end(run, reason = "user_stop") {
    if (!run) return;
    if (run.endTask) return run.endTask;
    run.cancelled = true;
    deviceGeneration++;
    cleanMedia(run); // Always stop local capture immediately, even if native stop fails.
    if (current === run) update({ state: "stopping" });
    run.endTask = (async () => {
      // prepare may still be in flight. It must release its lease when it returns.
      if (run.prepareTask) await run.prepareTask.catch(() => {});
      if (run.handle && !run.nativeClosed) await bridge.stop({ ...run.scope, sessionHandle: run.handle }, reason);
      if (current === run) { current = null; update({ state: "idle", restartRequired: false }); }
    })();
    try { await run.endTask; }
    catch (error) {
      if (current === run) update({ state: "stop_failed", error: errorInfo(error, "voice_stop_failed") });
      throw error;
    } finally { run.endTask = null; }
  }
  async function terminate(run, error) {
    if (current !== run) return;
    update({ error: errorInfo(error) });
    try { await end(run, "media_or_runtime_error"); } catch { return; }
    if (!current) update({ state: "error" });
  }
  async function refreshAvailability() {
    if (disposed) throw problem("voice_disposed", "Voice controller is disposed");
    const requestedScope = scope;
    try {
      const result = await bridge.availability(requestedScope);
      if (disposed || scope !== requestedScope) throw problem("voice_thread_changed", "Focus thread changed during voice discovery");
      update({ ...result, error: null });
      return result;
    } catch (error) { if (scope === requestedScope) update({ error: errorInfo(error) }); throw error; }
  }
  function gatherIce(run) {
    const peer = run.peer;
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", changed);
        run.cancelIce = null;
        error ? reject(error) : resolve();
      };
      const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
      const timer = setTimeout(() => finish(problem("voice_ice_timeout", "WebRTC ICE gathering timed out")), iceTimeoutMs);
      run.cancelIce = () => finish(problem("voice_start_cancelled", "Voice start was cancelled"));
      peer.addEventListener("icegatheringstatechange", changed);
      changed();
    });
  }
  async function applyAnswer(run, sdp) {
    if (!isCurrent(run) || !run.peer || !run.localReady) { run.answer = sdp; return; }
    if (run.answerApplied) return;
    run.answerApplied = true;
    try { await run.peer.setRemoteDescription({ type: "answer", sdp }); check(run); }
    catch (error) { if (isCurrent(run)) await terminate(run, error); }
  }
  async function start({ userInitiated = false } = {}) {
    if (!userInitiated) throw problem("voice_user_action_required", "Start voice from an explicit user action");
    if (disposed) throw problem("voice_disposed", "Voice controller is disposed");
    if (current) throw problem("voice_session_busy", "Voice is already preparing, active, or stopping");
    const run = { scope: { ...scope }, handle: null, cancelled: false, remoteTracks: [], canonicalCaptions: false, captionSequence: 0 };
    current = run;
    update({ state: "preparing", error: null, captions: [], restartRequired: false, outputBlocked: false });
    try {
      const available = await refreshAvailability(); check(run);
      if (!available.capabilities?.transports?.includes("webrtc") || !peerConnectionFactory || !mediaDevices?.getUserMedia) {
        throw problem("voice_webrtc_unavailable", "Native WebRTC voice is unavailable. No microphone was opened.");
      }
      if (version && !available.capabilities.versions?.includes(version)) throw problem("voice_version_unsupported", "This runtime does not support the requested voice version");
      settings = normalizeVoiceSettings(settings, { catalog: available.catalog, version, ...outputCapabilities });
      run.voice = settings.voice;
      run.prepareTask = bridge.prepare(run.scope);
      const prepared = await run.prepareTask;
      run.handle = prepared.sessionHandle;
      check(run);
      update({ permission: "requesting" });
      const stream = await mediaDevices.getUserMedia({ audio: settings.microphoneDeviceId ? { deviceId: { exact: settings.microphoneDeviceId } } : true });
      if (!isCurrent(run)) { stopStream(stream); check(run); }
      run.stream = stream;
      update({ permission: "granted" });
      run.peer = peerConnectionFactory();
      for (const track of stream.getAudioTracks()) {
        track.enabled = !settings.muted;
        track.onended = () => { if (isCurrent(run)) void terminate(run, problem("voice_microphone_ended", "Microphone access ended")); };
        run.peer.addTrack(track, stream);
      }
      run.peer.ontrack = (event) => {
        if (!isCurrent(run)) return;
        run.remoteTracks.push(event.track);
        if (audio) {
          audio.srcObject = event.streams?.[0] ?? mediaStreamFactory?.([event.track]) ?? null;
          Promise.resolve(audio.play?.()).catch((error) => { if (isCurrent(run)) update({ outputBlocked: true, error: errorInfo(error, "voice_output_blocked") }); });
        }
      };
      run.peer.onconnectionstatechange = () => {
        if (!isCurrent(run)) return;
        if (run.peer.connectionState === "connected") {
          clearTimeout(run.connectionTimer); update({ state: "active" });
        } else if (["failed", "disconnected", "closed"].includes(run.peer.connectionState)) {
          void terminate(run, problem("voice_disconnected", "Voice media connection disconnected. Start again to reconnect."));
        }
      };
      // Only create the negotiated event channel. No API session.update settings.
      run.channel = run.peer.createDataChannel("oai-events");
      run.channel.onclose = () => { if (isCurrent(run)) void terminate(run, problem("voice_disconnected", "Voice event channel closed")); };
      run.channel.onerror = () => { if (isCurrent(run)) void terminate(run, problem("voice_data_channel_error", "Voice event channel failed")); };
      if (audio) {
        if (outputCapabilities.volume) audio.volume = settings.outputVolume;
        if (outputCapabilities.outputDevice) await audio.setSinkId(settings.outputDeviceId);
        check(run);
      }
      const offer = await run.peer.createOffer(); check(run);
      await run.peer.setLocalDescription(offer); check(run);
      await gatherIce(run); check(run);
      const sdp = run.peer.localDescription?.sdp;
      if (!sdp) throw problem("voice_sdp_missing", "WebRTC did not produce an SDP offer");
      run.localReady = true;
      update({ state: "connecting" });
      run.connectionTimer = setTimeout(() => { if (isCurrent(run)) void terminate(run, problem("voice_connection_timeout", "Native voice connection timed out")); }, connectionTimeoutMs);
      await bridge.start({ ...run.scope, sessionHandle: run.handle, transport: { type: "webrtc", sdp },
        outputModality: "audio", ...(version ? { version } : {}), ...(run.voice ? { voice: run.voice } : {}) });
      check(run);
      if (run.answer) await applyAnswer(run, run.answer);
      check(run);
      return snapshot();
    } catch (error) {
      if (current === run && ["NotAllowedError", "SecurityError"].includes(error.name)) update({ permission: "denied" });
      // A stale attempt must not clear a replacement controller's media or state.
      if (current === run) await terminate(run, error);
      throw error;
    }
  }
  function caption(event, run) {
    if (!settings.captions) return;
    let captions = state.captions.map((item) => ({ ...item }));
    if (["item_started", "item_completed", "item_transcript_delta"].includes(event.type)) {
      if (event.item && event.item.type !== "transcriptSegment") return;
      if (!run.canonicalCaptions) { run.canonicalCaptions = true; captions = []; }
      const id = event.itemId ?? event.item.id;
      let item = captions.find((c) => c.id === id);
      if (!item) { item = { id, role: event.item?.role ?? "unknown", text: "", final: false }; captions.push(item); }
      if (event.type === "item_transcript_delta") item.text += event.delta ?? "";
      else { item.role = event.item.role; item.text = event.item.text ?? item.text; item.final = event.type === "item_completed"; }
    } else {
      if (run.canonicalCaptions) return;
      let item = captions.findLast((c) => c.role === event.role && !c.final);
      if (!item) { item = { id: `flat-${++run.captionSequence}`, role: event.role, text: "", final: false }; captions.push(item); }
      if (event.type === "transcript_delta") item.text += event.delta ?? "";
      else { item.text = event.text ?? item.text; item.final = true; }
    }
    // Bounded ephemeral display. Native canonical timeline remains persistence owner.
    captions = captions.slice(-200).map((c) => ({ ...c, text: c.text.slice(-16000) }));
    update({ captions });
  }
  const unsubscribe = bridge.subscribe((event) => {
    const run = current;
    if (event.type === 'owner_disconnected') {
      if (run) {
        run.cancelled = true; cleanMedia(run);
        update({ state: 'stop_failed', error: { code: 'voice_owner_disconnected', message: 'The local voice owner disconnected. Media stopped; native cleanup is unconfirmed.' } });
      }
      return;
    }
    if (!run || event.projectId !== run.scope.projectId || event.threadId !== run.scope.threadId || event.sessionHandle !== run.handle) return;
    if (event.type === "closed") {
      run.nativeClosed = true;
      const unexpected = !run.cancelled;
      run.cancelled = true;
      cleanMedia(run); current = null;
      update({ state: unexpected ? "disconnected" : "idle", restartRequired: false,
        ...(unexpected ? { error: { code: "voice_closed", message: event.reason ?? "Native voice closed" } } : {}) });
    } else if (event.type === "error") {
      if (!run.cancelled) void terminate(run, Object.assign(new Error(event.error.message), { code: event.error.code }));
      else update({ error: event.error });
    } else if (event.type === "sdp") {
      run.answer = event.sdp;
      void applyAnswer(run, event.sdp);
    } else if (["transcript_delta", "transcript_done", "item_started", "item_completed", "item_transcript_delta"].includes(event.type) && isCurrent(run)) caption(event, run);
  });
  function deviceChanged() { update({ devicesChanged: true }); }
  mediaDevices?.addEventListener?.("devicechange", deviceChanged);
  async function applySettings(patch) {
    if (disposed) throw problem("voice_disposed", "Voice controller is disposed");
    const next = normalizeVoiceSettings({ ...settings, ...patch }, { catalog: state.catalog, version, ...outputCapabilities });
    if (next.microphoneDeviceId !== settings.microphoneDeviceId && current) throw problem("voice_user_action_required", "Use selectMicrophone from a user action while voice is running");
    try {
      if (next.outputDeviceId !== settings.outputDeviceId && audio) await audio.setSinkId(next.outputDeviceId);
      if (outputCapabilities.volume) audio.volume = next.outputVolume;
    } catch (error) { update({ error: errorInfo(error, "voice_output_device_error") }); throw error; }
    if (disposed) throw problem("voice_disposed", "Voice controller is disposed");
    settings = next;
    current?.stream?.getAudioTracks().forEach((track) => { track.enabled = !settings.muted; });
    update({ restartRequired: Boolean(current && current.voice !== settings.voice),
      ...(!settings.captions || patch.captions === true ? { captions: [] } : {}) });
    return snapshot();
  }
  function updateSettings(patch) {
    const operation = settingsTask.catch(() => {}).then(() => applySettings(patch));
    settingsTask = operation;
    return operation;
  }
  async function selectMicrophone(deviceId, { userInitiated = false } = {}) {
    if (!userInitiated) throw problem("voice_user_action_required", "Choose a microphone from an explicit user action");
    const next = normalizeVoiceSettings({ ...settings, microphoneDeviceId: deviceId });
    if (!current) return updateSettings({ microphoneDeviceId: deviceId });
    const run = current;
    if (!isCurrent(run) || !run.peer) throw problem("voice_not_active", "Wait for voice to connect before changing microphone");
    if (run.deviceChanging) throw problem("voice_microphone_switch_busy", "A microphone change is already in progress");
    run.deviceChanging = true;
    const selection = ++deviceGeneration;
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      check(run);
      if (selection !== deviceGeneration) throw problem("voice_device_change_cancelled", "A newer microphone selection replaced this request");
      const track = stream.getAudioTracks()[0];
      const sender = run.peer.getSenders().find((s) => s.track?.kind === "audio");
      if (!track || !sender?.replaceTrack) throw problem("voice_microphone_switch_unsupported", "Microphone switching is unsupported");
      track.enabled = !settings.muted;
      await sender.replaceTrack(track); check(run);
      if (selection !== deviceGeneration) throw problem("voice_device_change_cancelled", "A newer microphone selection replaced this request");
      run.stream.getTracks().forEach((old) => { old.onended = null; });
      stopStream(run.stream); run.stream = stream;
      track.enabled = !settings.muted;
      track.onended = () => { if (isCurrent(run)) void terminate(run, problem("voice_microphone_ended", "Microphone access ended")); };
      settings = { ...settings, microphoneDeviceId: next.microphoneDeviceId }; update({ permission: "granted" });
      return snapshot();
    } catch (error) { stopStream(stream); if (current === run) update({ error: errorInfo(error) }); throw error; }
    finally { run.deviceChanging = false; }
  }
  return {
    start, refreshAvailability, updateSettings, selectMicrophone, snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async listDevices() {
      // enumerateDevices never requests permission. Labels may be empty until consent.
      if (!mediaDevices?.enumerateDevices) return [];
      return (await mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
        .map(({ deviceId, kind, label }) => ({ deviceId, kind, label }));
    },
    async resumeOutput({ userInitiated = false } = {}) {
      if (!userInitiated) throw problem("voice_user_action_required", "Resume audio from a user action");
      if (!current || !audio) throw problem("voice_not_active", "Voice output is not active");
      try { await audio.play(); update({ outputBlocked: false, error: null }); }
      catch (error) { update({ outputBlocked: true, error: errorInfo(error, "voice_output_blocked") }); throw error; }
    },
    stop(reason) { return end(current, reason); },
    async setScope(nextScope) {
      const next = validScope(nextScope);
      if (next.projectId === scope.projectId && next.threadId === scope.threadId) return snapshot();
      await end(current, "authoritative_thread_changed");
      scope = next;
      update({ state: "idle", error: null, catalog: null, capabilities: null, captions: [] });
      return snapshot();
    },
    async dispose() {
      disposed = true;
      await end(current, "controller_disposed");
      unsubscribe(); listeners.clear();
      mediaDevices?.removeEventListener?.("devicechange", deviceChanged);
    },
  };
}
