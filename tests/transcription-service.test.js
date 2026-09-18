import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSION_SAMPLES, TRANSCRIPTION_SAMPLE_RATE, TranscriptionService } from "../electron/transcription/service.mjs";

let userDataPath;

function pcm(samples) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(index % 1000, index * 2);
  return buffer;
}

function createService({
  installed = ["parakeet-tdt-0.6b-v3-int8"],
  available = { available: true, reason: null },
  transcribe = vi.fn(async () => ({ text: "hello there", durationSeconds: 1, elapsedMs: 12 })),
  now = () => 1000
} = {}) {
  const records = new Map(installed.map((id) => [id, { id, directory: `/models/${id}`, files: { tokens: "tokens.txt" }, bytes: 500, installedAt: "2026-09-18T00:00:00.000Z" }]));
  const library = {
    directory: "/models",
    list: async () => [...records.values()],
    read: async (id) => records.get(id) ?? null,
    diskUsage: async () => 500 * records.size,
    installState: () => null,
    install: vi.fn(async () => ({ id: "x" })),
    cancel: vi.fn(() => true),
    remove: vi.fn(async (id) => { records.delete(id); return { id, installed: false }; })
  };
  const decoder = {
    available: vi.fn(async () => available),
    transcribe,
    unload: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  };
  const events = [];
  const service = new TranscriptionService({
    userDataPath,
    library,
    decoder,
    now,
    send: (type, payload) => events.push({ type, payload })
  });
  return { service, library, decoder, events, records };
}

beforeEach(async () => {
  userDataPath = await mkdtemp(path.join(tmpdir(), "pixice-transcription-"));
});

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true });
});

describe("transcription service", () => {
  it("reports the catalog with installed state and a usable selection", async () => {
    const { service } = createService();
    await service.start({ selectedModelId: "parakeet-tdt-0.6b-v3-int8" });

    const state = await service.state();

    expect(state.available).toBe(true);
    expect(state.ready).toBe(true);
    expect(state.selectedModelId).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(state.sampleRate).toBe(TRANSCRIPTION_SAMPLE_RATE);
    expect(state.models.find((model) => model.id === "parakeet-tdt-0.6b-v3-int8")).toMatchObject({ installed: true, installedBytes: 500 });
    expect(state.models.find((model) => model.id === "whisper-tiny")).toMatchObject({ installed: false });
  });

  it("is not ready when the addon is unavailable, and says why", async () => {
    const { service } = createService({ available: { available: false, reason: "addon missing" } });
    await service.start();

    const state = await service.state();

    expect(state.ready).toBe(false);
    expect(state.reason).toBe("addon missing");
  });

  it("is not ready when no model is installed", async () => {
    const { service } = createService({ installed: [] });
    await service.start();

    const state = await service.state();

    expect(state.available).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.selectedModelId).toBeNull();
  });

  it("falls back to an installed model when the preferred one was removed", async () => {
    const { service } = createService({ installed: ["whisper-tiny"] });
    await service.start({ selectedModelId: "parakeet-tdt-0.6b-v3-int8" });

    const state = await service.state();

    expect(state.preferredModelId).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(state.selectedModelId).toBe("whisper-tiny");
    expect(state.ready).toBe(true);
  });

  it("transcribes a chunked recording and cleans the session up", async () => {
    const transcribe = vi.fn(async () => ({ text: "  spoken words  ", durationSeconds: 2, elapsedMs: 40 }));
    const { service } = createService({ transcribe });
    await service.start();

    const session = await service.startSession({});
    expect(service.appendChunk(session.sessionId, pcm(16000))).toMatchObject({ samples: 16000, seconds: 1 });
    expect(service.appendChunk(session.sessionId, pcm(8000))).toMatchObject({ samples: 24000, seconds: 1.5 });

    const result = await service.finishSession(session.sessionId);

    expect(result.text).toBe("  spoken words  ");
    expect(transcribe).toHaveBeenCalledOnce();
    const [, samples] = transcribe.mock.calls[0];
    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBe(24000);
    expect(service.sessions.size).toBe(0);
  });

  it("converts 16-bit PCM into the normalized float range", async () => {
    const transcribe = vi.fn(async () => ({ text: "", durationSeconds: 0 }));
    const { service } = createService({ transcribe });
    await service.start();

    const session = await service.startSession({});
    const buffer = Buffer.alloc(6);
    buffer.writeInt16LE(32767, 0);
    buffer.writeInt16LE(-32768, 2);
    buffer.writeInt16LE(0, 4);
    service.appendChunk(session.sessionId, buffer);
    await service.finishSession(session.sessionId);

    const [, samples] = transcribe.mock.calls[0];
    expect(samples[0]).toBeCloseTo(1, 5);
    expect(samples[1]).toBeCloseTo(-1, 5);
    expect(samples[2]).toBe(0);
  });

  it("returns empty text for a recording with no audio instead of decoding", async () => {
    const transcribe = vi.fn();
    const { service } = createService({ transcribe });
    await service.start();

    const session = await service.startSession({});
    const result = await service.finishSession(session.sessionId);

    expect(result.text).toBe("");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects a chunk that is not whole samples", async () => {
    const { service } = createService();
    await service.start();
    const session = await service.startSession({});

    expect(() => service.appendChunk(session.sessionId, Buffer.alloc(5))).toThrow(/whole 16-bit samples/);
  });

  it("drops a recording that exceeds the length cap", async () => {
    const { service } = createService();
    await service.start();
    const session = await service.startSession({});

    service.appendChunk(session.sessionId, pcm(MAX_SESSION_SAMPLES));

    expect(() => service.appendChunk(session.sessionId, pcm(1))).toThrow(/at most 10 minutes/);
    expect(service.sessions.size).toBe(0);
  });

  it("refuses to start when nothing is installed", async () => {
    const { service } = createService({ installed: [] });
    await service.start();

    await expect(service.startSession({})).rejects.toThrow(/No transcription model is installed/);
  });

  it("refuses to start when the addon is unavailable", async () => {
    const { service } = createService({ available: { available: false, reason: "no addon here" } });
    await service.start();

    await expect(service.startSession({})).rejects.toThrow(/no addon here/);
  });

  it("refuses a model that is in the catalog but not installed", async () => {
    const { service } = createService();
    await service.start();

    await expect(service.startSession({ modelId: "whisper-turbo" })).rejects.toThrow(/not installed/);
  });

  it("treats an unknown session as gone rather than throwing something opaque", async () => {
    const { service } = createService();
    await service.start();

    await expect(service.finishSession("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/no longer active/);
    expect(service.abortSession("11111111-1111-4111-8111-111111111111")).toMatchObject({ aborted: false });
  });

  it("discards the audio when a recording is aborted", async () => {
    const transcribe = vi.fn();
    const { service } = createService({ transcribe });
    await service.start();

    const session = await service.startSession({});
    service.appendChunk(session.sessionId, pcm(16000));

    expect(service.abortSession(session.sessionId)).toMatchObject({ aborted: true });
    expect(service.sessions.size).toBe(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("expires sessions that were abandoned", async () => {
    let clock = 1000;
    const { service } = createService({ now: () => clock });
    await service.start();

    const session = await service.startSession({});
    clock += 10 * 60 * 1000;
    await service.startSession({});

    expect(service.sessions.has(session.sessionId)).toBe(false);
  });

  it("caps how many recordings can run at once", async () => {
    const { service } = createService();
    await service.start();

    for (let index = 0; index < 8; index += 1) await service.startSession({});

    await expect(service.startSession({})).rejects.toThrow(/Too many recordings/);
  });

  it("drops the loaded recognizer when the model or settings change", async () => {
    const { service, decoder } = createService();
    await service.start();

    await service.select("whisper-tiny");
    expect(decoder.unload).toHaveBeenCalledTimes(1);

    const state = await service.configure({ numThreads: 8, provider: "coreml", language: "de" });
    expect(decoder.unload).toHaveBeenCalledTimes(2);
    expect(state.settings).toEqual({ numThreads: 8, provider: "coreml", language: "de" });
  });

  it("clamps the thread count and trims the language hint", async () => {
    const { service } = createService();
    await service.start();

    expect((await service.configure({ numThreads: 99 })).settings.numThreads).toBe(16);
    expect((await service.configure({ numThreads: 0 })).settings.numThreads).toBe(1);
    expect((await service.configure({ language: "  de  " })).settings.language).toBe("de");
    // A non-integer is ignored rather than coerced, leaving the last good value.
    expect((await service.configure({ numThreads: 2.5 })).settings.numThreads).toBe(1);
  });

  it("rejects a model id that is not in the catalog", async () => {
    const { service } = createService();
    await service.start();

    await expect(service.select("made-up")).rejects.toThrow(/Unknown transcription model/);
  });

  it("passes the configured settings through to the decoder", async () => {
    const transcribe = vi.fn(async () => ({ text: "ok", durationSeconds: 1 }));
    const { service } = createService({ transcribe });
    await service.start({ numThreads: 6, provider: "coreml", language: "fr" });

    const session = await service.startSession({});
    service.appendChunk(session.sessionId, pcm(100));
    await service.finishSession(session.sessionId);

    expect(transcribe.mock.calls[0][2]).toEqual({ numThreads: 6, provider: "coreml", language: "fr" });
  });

  it("reports install progress as events", async () => {
    const { service, library, events } = createService();
    await service.start();
    library.install = vi.fn(async (_id, { onProgress }) => {
      onProgress({ id: "whisper-tiny", phase: "downloading", receivedBytes: 10, totalBytes: 100, error: null });
      return { id: "whisper-tiny" };
    });

    expect(service.install("whisper-tiny")).toEqual({ id: "whisper-tiny", started: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "TranscriptionModelProgress")).toBe(true));
  });

  it("closes without leaving sessions behind", async () => {
    const { service, decoder } = createService();
    await service.start();
    await service.startSession({});

    await service.close();

    expect(service.sessions.size).toBe(0);
    expect(decoder.close).toHaveBeenCalled();
  });
});
