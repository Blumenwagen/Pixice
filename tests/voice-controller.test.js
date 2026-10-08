import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceController } from "../src/voice/controller.js";
import { normalizeVoiceSettings, describeVoiceSettings } from "../src/voice/settings.js";
import { createVoiceClient } from "../src/voice/client.js";
import { EventEmitter } from "node:events";
import { createVoiceSessionBridge, CODEX_0159_VOICE_CAPABILITIES } from "../electron/runtime/voice-session.mjs";

const scope = { projectId: "project-a", threadId: "thread-a" };
const catalog = { v1: ["voice-one"], v2: ["voice-two"], defaultV1: "voice-one", defaultV2: "voice-two" };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function stream() {
  const track = { kind: "audio", enabled: true, stop: vi.fn() };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
const controllers = [];
function fixture({ sink = true, ...options } = {}) {
  const listeners = new Set();
  let handle = 0;
  const bridge = {
    availability: vi.fn(async () => ({ catalog, capabilities: { transports: ["webrtc", "websocket"] }, sessionAvailability: "unverified" })),
    prepare: vi.fn(async () => ({ ...scope, sessionHandle: `handle-${++handle}` })),
    start: vi.fn(async () => ({})), stop: vi.fn(async () => ({ stopped: true })),
    subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
  };
  const mic = stream();
  const mediaDevices = { getUserMedia: vi.fn(async () => mic), enumerateDevices: vi.fn(async () => [{ kind: "audioinput", label: "", deviceId: "mic" }]),
    addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const channel = { close: vi.fn() };
  const peer = { localDescription: { type: "offer", sdp: "offer" }, iceGatheringState: "complete", connectionState: "new",
    addTrack: vi.fn(), createDataChannel: vi.fn(() => channel), createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}), close: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), getSenders: vi.fn(() => [{ track: mic.track, replaceTrack: vi.fn(async () => {}) }]) };
  const audio = { volume: 1, srcObject: null, pause: vi.fn(), play: vi.fn(async () => {}), ...(sink ? { setSinkId: vi.fn(async () => {}) } : {}) };
  const controller = createVoiceController({ bridge, scope, mediaDevices, peerConnectionFactory: () => peer, audioFactory: () => audio,
    mediaStreamFactory: (tracks) => ({ getTracks: () => tracks }), ...options });
  controllers.push(controller);
  function emit(type, fields = {}) {
    const event = { ...scope, sessionHandle: "handle-1", type, ...fields };
    listeners.forEach((listener) => listener(event));
  }
  return { controller, bridge, mediaDevices, mic, peer, channel, audio, emit, listeners };
}
afterEach(async () => { await Promise.allSettled(controllers.splice(0).map((c) => c.dispose())); });

describe("voice controller consent and media lifecycle", () => {
  it('stops mocked media immediately on authenticated-owner loss without resuming a session', async () => {
    const { controller, bridge, mic, peer, emit } = fixture();
    await controller.start({ userInitiated: true });
    emit('owner_disconnected');
    expect(mic.track.stop).toHaveBeenCalledOnce(); expect(peer.close).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe('stop_failed');
    expect(bridge.start).toHaveBeenCalledOnce(); expect(bridge.stop).not.toHaveBeenCalled();
  });
  it('keeps native startup separate from actual WebRTC connection readiness', async () => {
    const { controller, emit, peer } = fixture();
    await controller.start({ userInitiated: true });
    emit('started', { version: 'v3' });
    expect(controller.snapshot().state).toBe('connecting');
    peer.connectionState = 'connected'; peer.onconnectionstatechange();
    expect(controller.snapshot().state).toBe('active');
  });
  it("never opens a microphone on construction, catalog refresh, enumeration or implicit start", async () => {
    const { controller, mediaDevices, bridge } = fixture();
    await controller.refreshAvailability();
    await controller.listDevices();
    await expect(controller.start()).rejects.toMatchObject({ code: "voice_user_action_required" });
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });
  it("reserves renewal admission before opening the mic and sends only SDP through the bridge", async () => {
    const { controller, bridge, mediaDevices, peer, audio, mic } = fixture();
    await controller.updateSettings({ microphoneDeviceId: "selected", muted: true, outputVolume: 0.3, voice: "voice-two" });
    await controller.start({ userInitiated: true });
    expect(bridge.prepare.mock.invocationCallOrder[0]).toBeLessThan(mediaDevices.getUserMedia.mock.invocationCallOrder[0]);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "selected" } } });
    expect(mic.track.enabled).toBe(false);
    expect(audio.volume).toBe(0.3);
    expect(peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(bridge.start).toHaveBeenCalledWith({ ...scope, sessionHandle: "handle-1", outputModality: "audio", voice: "voice-two", transport: { type: "webrtc", sdp: "offer" } });
    expect(controller.snapshot().state).toBe("connecting");
    peer.connectionState = "connected"; peer.onconnectionstatechange();
    expect(controller.snapshot().state).toBe("active");
  });
  it("applies an SDP notification that arrives before the start response", async () => {
    const { controller, bridge, emit, peer } = fixture();
    bridge.start.mockImplementation(async () => { emit("sdp", { sdp: "early-answer" }); return {}; });
    await controller.start({ userInitiated: true });
    expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "early-answer" });
  });
  it("fails before mic access if WebRTC or account availability is absent", async () => {
    const { controller, bridge, mediaDevices } = fixture();
    bridge.availability.mockResolvedValue({ catalog, capabilities: { transports: ["websocket"] } });
    await expect(controller.start({ userInitiated: true })).rejects.toMatchObject({ code: "voice_webrtc_unavailable" });
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(bridge.prepare).not.toHaveBeenCalled();
    bridge.availability.mockRejectedValue(Object.assign(new Error("Account unavailable"), { code: "voice_account_unavailable" }));
    await expect(controller.start({ userInitiated: true })).rejects.toMatchObject({ code: "voice_account_unavailable" });
    expect(controller.snapshot().error.code).toBe("voice_account_unavailable");
  });
  it("surfaces permission denial and releases the native preparation", async () => {
    const { controller, bridge, mediaDevices } = fixture();
    mediaDevices.getUserMedia.mockRejectedValue(new DOMException("Microphone permission denied", "NotAllowedError"));
    await expect(controller.start({ userInitiated: true })).rejects.toThrow("permission denied");
    expect(controller.snapshot()).toMatchObject({ state: "error", permission: "denied", error: { code: "voice_microphone_denied" } });
    expect(bridge.stop).toHaveBeenCalledWith({ ...scope, sessionHandle: "handle-1" }, "media_or_runtime_error");
    expect(bridge.start).not.toHaveBeenCalled();
  });
  it("stops capture returned after stop during the permission dialog", async () => {
    const { controller, bridge, mediaDevices, mic } = fixture();
    const permission = deferred();
    mediaDevices.getUserMedia.mockReturnValue(permission.promise);
    const started = controller.start({ userInitiated: true });
    const rejected = expect(started).rejects.toMatchObject({ code: "voice_start_cancelled" });
    await vi.waitFor(() => expect(mediaDevices.getUserMedia).toHaveBeenCalled());
    await controller.stop();
    permission.resolve(mic);
    await rejected;
    expect(mic.track.stop).toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(controller.snapshot().state).toBe("idle");
  });
  it("releases a lease returned after stop during native preparation", async () => {
    const { controller, bridge, mediaDevices } = fixture();
    const preparing = deferred();
    bridge.prepare.mockReturnValue(preparing.promise);
    const starting = controller.start({ userInitiated: true });
    const rejected = expect(starting).rejects.toMatchObject({ code: "voice_start_cancelled" });
    await vi.waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
    const stopped = controller.stop();
    preparing.resolve({ sessionHandle: "late-handle" });
    await stopped; await rejected;
    expect(bridge.stop).toHaveBeenCalledWith({ ...scope, sessionHandle: "late-handle" }, "user_stop");
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it("keeps voice changes pending for explicit restart and applies mute locally", async () => {
    const { controller, bridge, mic } = fixture();
    await controller.start({ userInitiated: true });
    await controller.updateSettings({ voice: "voice-two", muted: true });
    expect(controller.snapshot().restartRequired).toBe(true);
    expect(mic.track.enabled).toBe(false);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    await controller.stop();
    await controller.start({ userInitiated: true });
    expect(bridge.start.mock.lastCall[0].voice).toBe("voice-two");
  });
  it("hides unsupported settings and rejects invented protocol controls", async () => {
    const { controller, audio } = fixture({ sink: false });
    expect(controller.snapshot().settingsModel.find((s) => s.key === "outputDeviceId").supported).toBe(false);
    await expect(controller.updateSettings({ outputDeviceId: "speakers" })).rejects.toThrow("unsupported");
    await expect(controller.updateSettings({ speed: 1.5 })).rejects.toThrow("Unsupported voice setting");
    await controller.updateSettings({ outputVolume: 0.2 });
    expect(audio.volume).toBe(0.2);
    expect(() => normalizeVoiceSettings({ outputVolume: 2 })).toThrow();
    expect(describeVoiceSettings({ catalog, version: "v3" })[0]).toMatchObject({ supported: false, choices: [] });
  });
  it("changes a microphone only on a user action and stops replaced tracks", async () => {
    const { controller, mediaDevices, mic, peer } = fixture();
    await controller.start({ userInitiated: true });
    await expect(controller.updateSettings({ microphoneDeviceId: "next" })).rejects.toMatchObject({ code: "voice_user_action_required" });
    const next = stream(); mediaDevices.getUserMedia.mockResolvedValue(next);
    const sender = { track: mic.track, replaceTrack: vi.fn(async () => {}) }; peer.getSenders.mockReturnValue([sender]);
    await controller.selectMicrophone("next", { userInitiated: true });
    expect(sender.replaceTrack).toHaveBeenCalledWith(next.track);
    expect(mic.track.stop).toHaveBeenCalled();
    expect(controller.snapshot().settings.microphoneDeviceId).toBe("next");
    await controller.stop(); expect(next.track.stop).toHaveBeenCalled();
  });
  it("cleans up on disconnect and exposes native stop failure for retry", async () => {
    const { controller, bridge, mic, peer, channel, audio } = fixture();
    await controller.start({ userInitiated: true });
    bridge.stop.mockRejectedValueOnce(new Error("stop timed out"));
    peer.connectionState = "disconnected"; peer.onconnectionstatechange();
    await vi.waitFor(() => expect(controller.snapshot().state).toBe("stop_failed"));
    expect(mic.track.stop).toHaveBeenCalled(); expect(peer.close).toHaveBeenCalled(); expect(channel.close).toHaveBeenCalled();
    expect(audio.srcObject).toBe(null);
    await expect(controller.start({ userInitiated: true })).rejects.toMatchObject({ code: "voice_session_busy" });
    await controller.stop(); expect(controller.snapshot().state).toBe("idle");
  });
  it("stops the previous authoritative thread and ignores its stale notifications", async () => {
    const { controller, bridge, emit } = fixture();
    await controller.start({ userInitiated: true });
    await controller.setScope({ ...scope, threadId: "thread-new" });
    expect(bridge.stop).toHaveBeenCalledWith({ ...scope, sessionHandle: "handle-1" }, "authoritative_thread_changed");
    emit("transcript_delta", { role: "user", delta: "stale" });
    expect(controller.snapshot().captions).toEqual([]);
    expect(controller.snapshot().scope.threadId).toBe("thread-new");
    expect(controller.snapshot().catalog).toBe(null);
  });
  it("uses canonical caption completion to replace deltas and avoids duplicate flat captions", async () => {
    const { controller, emit } = fixture();
    await controller.start({ userInitiated: true });
    emit("transcript_delta", { role: "user", delta: "hello" });
    emit("transcript_done", { role: "user", text: "hello" });
    expect(controller.snapshot().captions).toHaveLength(1);
    emit("item_started", { item: { id: "item", type: "transcriptSegment", role: "user", text: "" } });
    emit("item_transcript_delta", { itemId: "item", delta: "hello" });
    emit("item_completed", { item: { id: "item", type: "transcriptSegment", role: "user", text: "hello there" } });
    emit("transcript_done", { role: "user", text: "hello there" });
    expect(controller.snapshot().captions).toEqual([{ id: "item", role: "user", text: "hello there", final: true }]);
    await controller.updateSettings({ captions: false });
    emit("transcript_delta", { role: "user", delta: "hidden" });
    expect(controller.snapshot().captions).toEqual([]);
  });
  it("surfaces blocked playback and permits explicit output retry", async () => {
    const { controller, peer, audio } = fixture();
    await controller.start({ userInitiated: true });
    audio.play.mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"));
    peer.ontrack({ track: stream().track, streams: [{}] });
    await vi.waitFor(() => expect(controller.snapshot().outputBlocked).toBe(true));
    await expect(controller.resumeOutput()).rejects.toMatchObject({ code: "voice_user_action_required" });
    await controller.resumeOutput({ userInitiated: true });
    expect(controller.snapshot().outputBlocked).toBe(false);
  });
  it("cleans tracks and subscriptions on runtime close and disposal", async () => {
    const { controller, mic, peer, emit, listeners, mediaDevices } = fixture();
    await controller.start({ userInitiated: true });
    emit("closed", { reason: "runtime_disconnected" });
    expect(controller.snapshot().state).toBe("disconnected");
    expect(mic.track.stop).toHaveBeenCalled(); expect(peer.close).toHaveBeenCalled();
    await controller.dispose();
    expect(listeners.size).toBe(0);
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
  });
  it("adapts only voice events and forwards the stop reason through the invoker", async () => {
    const invoke = vi.fn(async () => ({}));
    let subscriber;
    const client = createVoiceClient({ invoke, subscribe: (listener) => { subscriber = listener; return () => {}; } });
    const listener = vi.fn(); client.subscribe(listener);
    subscriber({ type: "TaskUpdated", payload: { irrelevant: true } });
    subscriber({ type: "VoiceSessionEvent", payload: { type: "closed" } });
    expect(listener).toHaveBeenCalledTimes(1);
    await client.stop({ ...scope, sessionHandle: "handle" }, "project_changed");
    expect(invoke).toHaveBeenCalledWith("voice:stop", { ...scope, sessionHandle: "handle", reason: "project_changed" });
  });
  it("times out ICE gathering and closes media without making a native voice call", async () => {
    vi.useFakeTimers();
    try {
      const { controller, peer, bridge, mic } = fixture({ iceTimeoutMs: 25 });
      peer.iceGatheringState = "gathering";
      const start = controller.start({ userInitiated: true });
      const rejected = expect(start).rejects.toMatchObject({ code: "voice_ice_timeout" });
      await vi.advanceTimersByTimeAsync(30);
      await rejected;
      expect(bridge.start).not.toHaveBeenCalled();
      expect(mic.track.stop).toHaveBeenCalled();
      expect(peer.removeEventListener).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("times out native negotiation and releases capture and reservation", async () => {
    vi.useFakeTimers();
    try {
      const { controller, mic, bridge } = fixture({ connectionTimeoutMs: 25 });
      await controller.start({ userInitiated: true });
      await vi.advanceTimersByTimeAsync(30);
      expect(controller.snapshot()).toMatchObject({ state: "error", error: { code: "voice_connection_timeout" } });
      expect(mic.track.stop).toHaveBeenCalled();
      expect(bridge.stop).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("preserves the prior mic on device replacement failure and reports the error", async () => {
    const { controller, mediaDevices, mic, peer } = fixture();
    await controller.start({ userInitiated: true });
    const next = stream(); mediaDevices.getUserMedia.mockResolvedValue(next);
    peer.getSenders.mockReturnValue([{ track: mic.track, replaceTrack: vi.fn(async () => { throw new Error("device replacement failed"); }) }]);
    await expect(controller.selectMicrophone("next", { userInitiated: true })).rejects.toThrow("replacement failed");
    expect(next.track.stop).toHaveBeenCalled(); expect(mic.track.stop).not.toHaveBeenCalled();
    expect(controller.snapshot().settings.microphoneDeviceId).toBe("");
    expect(controller.snapshot().error.message).toContain("replacement failed");
  });
  it("runs the renderer lifecycle against the real isolated bridge using simulated media", async () => {
    const runtime = new EventEmitter(); runtime.connected = true;
    runtime.request = vi.fn(async (method) => {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "thread/realtime/listVoices") return { voices: catalog };
      if (method === "thread/realtime/start") {
        runtime.emit("event", { method: "thread/realtime/started", params: { threadId: scope.threadId, version: "v2", realtimeSessionId: "rt" } });
        runtime.emit("event", { method: "thread/realtime/sdp", params: { threadId: scope.threadId, sdp: "native-answer" } });
      }
      return {};
    });
    const native = createVoiceSessionBridge({ runtime, resolveScope: async (input) => ({ ...input, provider: "codex" }), capabilities: CODEX_0159_VOICE_CAPABILITIES });
    const { controller, peer, mic } = fixture({ bridge: native });
    try {
      await controller.start({ userInitiated: true });
      expect(native.blocksRollover(scope)).toBe(true);
      expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "native-answer" });
      peer.connectionState = "connected"; peer.onconnectionstatechange();
      await controller.stop();
      expect(native.blocksRollover(scope)).toBe(false);
      expect(controller.snapshot().state).toBe("idle");
      expect(mic.track.stop).toHaveBeenCalled();
    } finally { await controller.dispose(); await native.dispose(); }
  });
  it("serializes output-device changes so an older request cannot overwrite the newer choice", async () => {
    const { controller, audio } = fixture();
    const first = deferred(); audio.setSinkId.mockReturnValueOnce(first.promise);
    const a = controller.updateSettings({ outputDeviceId: "speaker-a" });
    const b = controller.updateSettings({ outputDeviceId: "speaker-b" });
    await vi.waitFor(() => expect(audio.setSinkId).toHaveBeenCalledWith("speaker-a"));
    expect(audio.setSinkId).toHaveBeenCalledTimes(1);
    first.resolve(); await a; await b;
    expect(audio.setSinkId).toHaveBeenLastCalledWith("speaker-b");
    expect(controller.snapshot().settings.outputDeviceId).toBe("speaker-b");
  });
});
