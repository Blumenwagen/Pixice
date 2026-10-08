import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_0159_VOICE_CAPABILITIES, createVoiceSessionBridge, createVoiceInvokeHandlers } from "../electron/runtime/voice-session.mjs";

const catalog = { voices: { v1: ["voice-one"], v2: ["voice-two"], defaultV1: "voice-one", defaultV2: "voice-two" } };
const scope = { projectId: "project-a", threadId: "thread-a" };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const bridges = [];
function fixture(options = {}) {
  const runtime = new EventEmitter();
  runtime.connected = true;
  runtime.request = vi.fn(async (method) => {
    if (method === "account/read") return { account: { type: "chatgpt", accessToken: "must-never-leave-main" } };
    if (method === "thread/realtime/listVoices") return catalog;
    return {};
  });
  const resolveScope = vi.fn(async (input) => ({ ...input, provider: "codex" }));
  const bridge = createVoiceSessionBridge({ runtime, resolveScope, capabilities: CODEX_0159_VOICE_CAPABILITIES, ...options });
  bridges.push(bridge);
  const events = [];
  bridge.subscribe((event) => events.push(event));
  return { runtime, bridge, resolveScope, events };
}
async function begin(bridge, target = scope, options = {}) {
  const prepared = await bridge.prepare(target);
  const input = { ...target, sessionHandle: prepared.sessionHandle, outputModality: "audio", transport: { type: "webrtc", sdp: "offer" }, ...options };
  await bridge.start(input);
  return input;
}
function notification(runtime, suffix, params = {}, target = scope) {
  runtime.emit("event", { type: "TaskUpdated", payload: { method: `thread/realtime/${suffix}`, threadId: target.threadId, ...params } });
}
afterEach(async () => { await Promise.allSettled(bridges.splice(0).map((b) => b.dispose())); });

describe("native voice protocol and admission", () => {
  it('expires a reservation even while asynchronous scope validation is pending', async () => {
    const gate = deferred();
    const { runtime, bridge } = fixture({ prepareTimeoutMs: 20, resolveScope: () => gate.promise });
    const preparing = bridge.prepare(scope);
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'voice_session_stale' });
    expect(bridge.blocksRollover(scope)).toBe(true);
    await vi.waitFor(() => expect(bridge.blocksRollover(scope)).toBe(false));
    gate.resolve({ ...scope, provider: 'codex' }); await rejected;
    expect(runtime.request).not.toHaveBeenCalled();
  });
  it('surfaces an unverified native started version while retaining rollover protection until stop', async () => {
    const { runtime, bridge, events } = fixture();
    const input = await begin(bridge);
    notification(runtime, 'started', { version: 'future-version' });
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'voice_version_unsupported' } });
    expect(bridge.blocksRollover(scope)).toBe(true); await bridge.stop(input);
    expect(bridge.blocksRollover(scope)).toBe(false);
  });
  it("matches method and start-field evidence from the actual 0.159.0 schema", () => {
    const evidence = JSON.parse(readFileSync("work/voice-implementation/protocol-0.159.0.json", "utf8"));
    expect(evidence.codexVersion).toBe(CODEX_0159_VOICE_CAPABILITIES.schemaVersion);
    expect(evidence["ClientRequest.json"].map((e) => e.properties.method.enum[0])).toEqual([
      "thread/realtime/start", "thread/realtime/appendAudio", "thread/realtime/appendText", "thread/realtime/appendSpeech", "thread/realtime/stop", "thread/realtime/listVoices",
    ]);
    const start = evidence.schemas["ThreadRealtimeStartParams.json"];
    expect(start.required).toEqual(["outputModality", "threadId"]);
    expect(start.definitions.ThreadRealtimeStartTransport.oneOf.map((t) => t.properties.type.enum[0])).toEqual(["websocket", "webrtc", "existingCall"]);
    for (const fake of ["speed", "interruptVAD", "personality"]) expect(start.properties).not.toHaveProperty(fake);
  });
  it("discovers the live catalog without starting voice or disclosing account data", async () => {
    const { runtime, bridge } = fixture();
    const result = await bridge.availability(scope);
    expect(result.catalog).toEqual(catalog.voices);
    expect(result.sessionAvailability).toBe("unverified");
    expect(runtime.request.mock.calls.map(([m]) => m)).toEqual(["account/read", "thread/realtime/listVoices"]);
    expect(JSON.stringify(result)).not.toContain("accessToken");
  });
  it("reserves before async ownership validation, prevents duplicates and releases failed preparation", async () => {
    const gate = deferred();
    const { bridge } = fixture({ resolveScope: () => gate.promise });
    const preparing = bridge.prepare(scope);
    expect(bridge.blocksRollover(scope)).toBe(true);
    await expect(bridge.prepare(scope)).rejects.toMatchObject({ code: "voice_session_busy" });
    gate.resolve({ ...scope, threadId: "new-thread", provider: "codex" });
    await expect(preparing).rejects.toMatchObject({ code: "voice_thread_changed" });
    expect(bridge.blocksRollover(scope)).toBe(false);
  });
  it("separates projects and rejects a handle borrowed from another project", async () => {
    const { bridge } = fixture();
    const a = await begin(bridge);
    const other = { projectId: "project-b", threadId: "thread-b" };
    const b = await begin(bridge, other);
    await expect(bridge.stop({ ...other, sessionHandle: a.sessionHandle })).rejects.toMatchObject({ code: "voice_session_stale" });
    await bridge.stop(a);
    expect(bridge.blocksRollover(scope)).toBe(false);
    expect(bridge.blocksRollover(other)).toBe(true);
    await bridge.stop(b);
  });
  it("rejects non-ChatGPT account mode and missing verified support explicitly", async () => {
    const { runtime, bridge } = fixture();
    runtime.request.mockResolvedValue({ account: { type: "apiKey" } });
    await expect(bridge.availability(scope)).rejects.toMatchObject({ code: "voice_account_unavailable" });
    expect(runtime.request).toHaveBeenCalledTimes(1);
    const unsupported = fixture({ capabilities: {} }).bridge;
    await expect(unsupported.prepare(scope)).rejects.toMatchObject({ code: "voice_unsupported" });
  });
  it("starts with only supported projected fields and uses live voice membership", async () => {
    const { runtime, bridge } = fixture();
    await begin(bridge, scope, { voice: "voice-two", version: "v2", speed: 3, apiKey: "private", prompt: "untrusted renderer prompt" });
    expect(runtime.request).toHaveBeenCalledWith("thread/realtime/start", {
      threadId: "thread-a", outputModality: "audio", transport: { type: "webrtc", sdp: "offer" }, voice: "voice-two", version: "v2",
    });
  });
  it("never invents a v3 catalog or accepts an unavailable selected voice", async () => {
    const { runtime, bridge } = fixture();
    await expect(begin(bridge, scope, { voice: "voice-two", version: "v3" })).rejects.toMatchObject({ code: "voice_catalog_version_unknown" });
    await expect(begin(bridge, scope, { voice: "not-in-catalog" })).rejects.toMatchObject({ code: "voice_selection_unavailable" });
    expect(runtime.request.mock.calls.some(([m]) => m === "thread/realtime/start")).toBe(false);
    expect(bridge.blocksRollover(scope)).toBe(false);
  });
  it("waits for an in-flight start before stopping and blocks renewal throughout", async () => {
    const { runtime, bridge } = fixture();
    const started = deferred();
    const original = runtime.request.getMockImplementation();
    runtime.request.mockImplementation((method, params) => method === "thread/realtime/start" ? started.promise : original(method, params));
    const prepared = await bridge.prepare(scope);
    const input = { ...scope, sessionHandle: prepared.sessionHandle, transport: { type: "webrtc", sdp: "offer" } };
    const startTask = bridge.start(input);
    await vi.waitFor(() => expect(runtime.request).toHaveBeenCalledWith("thread/realtime/start", expect.anything()));
    const stopTask = bridge.stop(input);
    expect(bridge.blocksRollover(scope)).toBe(true);
    expect(runtime.request.mock.calls.some(([m]) => m === "thread/realtime/stop")).toBe(false);
    started.resolve({});
    await startTask; await stopTask;
    expect(runtime.request).toHaveBeenLastCalledWith("thread/realtime/stop", { threadId: "thread-a" });
    expect(bridge.blocksRollover(scope)).toBe(false);
  });
  it("retains the renewal blocker after uncertain stop and permits retry", async () => {
    const { runtime, bridge } = fixture();
    const input = await begin(bridge);
    runtime.request.mockRejectedValueOnce(new Error("Timed out waiting for thread/realtime/stop"));
    await expect(bridge.stop(input)).rejects.toThrow("Timed out");
    expect(bridge.snapshot(scope).state).toBe("stop_failed");
    expect(bridge.blocksRollover(scope)).toBe(true);
    runtime.emit('status', { state: 'error' });
    expect(bridge.blocksRollover(scope)).toBe(true);
    await bridge.stop(input);
    expect(bridge.blocksRollover(scope)).toBe(false);
  });
  it("does not redirect appends to a renewed thread and can still stop the old thread", async () => {
    const { runtime, bridge, resolveScope } = fixture();
    const input = await begin(bridge);
    notification(runtime, "started", { version: "v2", realtimeSessionId: "rt-a" });
    resolveScope.mockResolvedValue({ ...scope, threadId: "thread-renewed", provider: "codex" });
    await expect(bridge.appendText({ ...input, text: "hello" })).rejects.toMatchObject({ code: "voice_thread_changed" });
    await bridge.stop(input);
    expect(runtime.request).toHaveBeenLastCalledWith("thread/realtime/stop", { threadId: scope.threadId });
  });
  it("handles early SDP, flat and canonical transcripts, ignores foreign and raw items", async () => {
    const { runtime, bridge, events } = fixture();
    const original = runtime.request.getMockImplementation();
    runtime.request.mockImplementation(async (method, params) => {
      if (method === "thread/realtime/start") {
        runtime.emit("event", { method: "thread/realtime/sdp", params: { threadId: scope.threadId, sdp: "answer" } });
        notification(runtime, "started", { version: "v2", realtimeSessionId: "rt-a" });
      }
      return original(method, params);
    });
    await begin(bridge);
    notification(runtime, "transcript/delta", { role: "user", delta: "hi" });
    notification(runtime, "item/completed", { item: { id: "i", realtimeSessionId: "rt-a", type: "transcriptSegment", role: "user", text: "hi", accessToken: "secret" } });
    notification(runtime, "itemAdded", { item: { accessToken: "secret" } });
    notification(runtime, "transcript/done", { role: "user", text: "foreign" }, { threadId: "foreign" });
    expect(events.find((e) => e.type === "sdp")?.sdp).toBe("answer");
    expect(events.some((e) => e.type === "item_completed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("foreign");
  });
  it("supports explicit text/speech appends and opaque websocket audio fields", async () => {
    const { runtime, bridge } = fixture();
    const input = await begin(bridge, scope, { transport: { type: "websocket" } });
    notification(runtime, "started", { version: "v1", realtimeSessionId: "rt-a" });
    await bridge.appendText({ ...input, text: "hello", role: "user" });
    await bridge.appendSpeech({ ...input, text: "speak" });
    const audio = { data: "opaque", sampleRate: 24000, numChannels: 1, samplesPerChannel: 20, itemId: "chunk" };
    await bridge.appendAudio({ ...input, audio: { ...audio, secret: "not-forwarded" } });
    expect(runtime.request).toHaveBeenCalledWith("thread/realtime/appendAudio", { threadId: scope.threadId, audio });
    expect(() => bridge.appendAudio({ ...input, audio: { ...audio, sampleRate: -1 } })).toThrow("sampleRate");
  });
  it("releases all project leases on disconnect and unsubscribes on disposal", async () => {
    const { runtime, bridge, events } = fixture();
    await begin(bridge);
    await bridge.prepare({ projectId: "project-b", threadId: "thread-b" });
    runtime.connected = false;
    runtime.emit("status", { state: "reconnecting" });
    expect(bridge.blocksRollover()).toBe(false);
    expect(events.filter((e) => e.type === "closed")).toHaveLength(2);
    await bridge.dispose();
    expect(runtime.listenerCount("event")).toBe(0);
    expect(runtime.listenerCount("status")).toBe(0);
  });
  it("holds host authorization and renewal admission for handler preparation", async () => {
    const { bridge } = fixture();
    const authorizeInvoke = vi.fn(async () => {});
    const admitPrepare = vi.fn(async (_scope, run) => run());
    const handlers = createVoiceInvokeHandlers({ bridge, authorizeInvoke, admitPrepare });
    const prepared = await handlers["voice:prepare"]({}, scope, { local: true });
    expect(admitPrepare).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(bridge.blocksRollover(scope)).toBe(true);
    authorizeInvoke.mockRejectedValueOnce(new Error("caller denied"));
    await expect(handlers["voice:stop"]({}, { ...scope, sessionHandle: prepared.sessionHandle }, {})).rejects.toThrow("caller denied");
    expect(bridge.blocksRollover(scope)).toBe(true);
    await handlers["voice:stop"]({}, { ...scope, sessionHandle: prepared.sessionHandle }, {});
  });
  it("expires an abandoned preparation without opening a native session", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, bridge } = fixture({ prepareTimeoutMs: 50 });
      await bridge.prepare(scope);
      await vi.advanceTimersByTimeAsync(51);
      expect(bridge.blocksRollover(scope)).toBe(false);
      expect(runtime.request).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("surfaces a start availability failure and frees a lease without silently falling back", async () => {
    const { runtime, bridge, events } = fixture();
    const original = runtime.request.getMockImplementation();
    runtime.request.mockImplementation((method, params) => method === "thread/realtime/start" ? Promise.reject(new Error("Account has no realtime access")) : original(method, params));
    await expect(begin(bridge)).rejects.toThrow("no realtime access");
    expect(events.find((e) => e.type === "error").error.message).toContain("no realtime access");
    expect(bridge.blocksRollover(scope)).toBe(false);
    expect(runtime.request).toHaveBeenLastCalledWith("thread/realtime/stop", { threadId: scope.threadId });
  });
});
