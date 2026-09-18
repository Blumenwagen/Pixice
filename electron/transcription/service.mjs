import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, findTranscriptionModel, supportsLanguageHint, TRANSCRIPTION_MODELS } from "./catalog.mjs";
import { ChildProcessDecoder } from "./decoder-client.mjs";
import { TranscriptionModelLibrary } from "./model-library.mjs";

export const TRANSCRIPTION_SAMPLE_RATE = 16000;
// Ten minutes of 16 kHz mono audio. Long enough for any realistic dictation
// and short enough that one abandoned session cannot exhaust host memory.
export const MAX_SESSION_SAMPLES = TRANSCRIPTION_SAMPLE_RATE * 60 * 10;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 8;

export class TranscriptionService {
  constructor({
    userDataPath,
    send = () => {},
    library = null,
    decoder = null,
    now = () => Date.now(),
    sessionIdleTimeoutMs = SESSION_IDLE_TIMEOUT_MS
  }) {
    this.directory = path.join(userDataPath, "transcription", "models");
    this.send = send;
    this.library = library ?? new TranscriptionModelLibrary({ directory: this.directory });
    this.decoder = decoder ?? new ChildProcessDecoder();
    this.now = now;
    this.sessionIdleTimeoutMs = sessionIdleTimeoutMs;
    this.sessions = new Map();
    this.settings = { numThreads: 2, provider: "cpu", language: "" };
    this.selectedModelId = DEFAULT_TRANSCRIPTION_MODEL_ID;
    this.availability = null;
    // The model a decode is currently running against, so removing that model
    // releases the recognizer first.
    this.decodingWith = null;
  }

  async start({ selectedModelId, numThreads, provider, language } = {}) {
    await mkdir(this.directory, { recursive: true });
    if (selectedModelId) this.selectedModelId = selectedModelId;
    if (Number.isInteger(numThreads)) this.settings.numThreads = numThreads;
    if (provider) this.settings.provider = provider;
    if (typeof language === "string") this.settings.language = language;
  }

  async #available() {
    if (!this.availability) this.availability = await this.decoder.available();
    return this.availability;
  }

  async state() {
    const [availability, installed, diskBytes] = await Promise.all([
      this.#available(),
      this.library.list(),
      this.library.diskUsage().catch(() => 0)
    ]);
    const byId = new Map(installed.map((record) => [record.id, record]));
    const models = TRANSCRIPTION_MODELS.map((model) => {
      const record = byId.get(model.id);
      return {
        id: model.id,
        label: model.label,
        vendor: model.vendor,
        family: model.family,
        summary: model.summary,
        languages: model.languages,
        recommended: model.recommended,
        license: model.license,
        downloadBytes: model.archive.bytes,
        verified: Boolean(model.archive.sha256),
        supportsLanguageHint: supportsLanguageHint(model.family),
        installed: Boolean(record),
        installedBytes: record?.bytes ?? 0,
        installedAt: record?.installedAt ?? null,
        install: this.library.installState(model.id)
      };
    });
    const selected = models.find((model) => model.id === this.selectedModelId && model.installed)
      ?? models.find((model) => model.installed)
      ?? null;
    return {
      available: availability.available,
      reason: availability.reason,
      sampleRate: TRANSCRIPTION_SAMPLE_RATE,
      maxSeconds: MAX_SESSION_SAMPLES / TRANSCRIPTION_SAMPLE_RATE,
      selectedModelId: selected?.id ?? null,
      preferredModelId: this.selectedModelId,
      ready: Boolean(availability.available && selected),
      models,
      diskBytes,
      settings: { ...this.settings }
    };
  }

  #publish() {
    this.state().then((state) => this.send("TranscriptionState", state)).catch(() => {});
  }

  async select(modelId) {
    if (modelId !== null && !findTranscriptionModel(modelId)) throw new Error(`Unknown transcription model: ${modelId}`);
    this.selectedModelId = modelId;
    // A different model means the loaded recognizer is stale.
    await this.decoder.unload().catch(() => {});
    this.#publish();
    return this.state();
  }

  async configure({ numThreads, provider, language }) {
    if (Number.isInteger(numThreads)) this.settings.numThreads = Math.min(Math.max(numThreads, 1), 16);
    if (provider) this.settings.provider = provider;
    if (typeof language === "string") this.settings.language = language.trim().slice(0, 16);
    await this.decoder.unload().catch(() => {});
    this.#publish();
    return this.state();
  }

  install(modelId) {
    const promise = this.library.install(modelId, {
      onProgress: (progress) => this.send("TranscriptionModelProgress", progress)
    });
    promise.then(() => this.#publish(), () => this.#publish());
    // The caller gets an immediate acknowledgement; progress arrives as events.
    return { id: modelId, started: true };
  }

  cancelInstall(modelId) {
    return { id: modelId, cancelled: this.library.cancel(modelId) };
  }

  async remove(modelId) {
    if (this.decodingWith === modelId) await this.decoder.unload().catch(() => {});
    const result = await this.library.remove(modelId);
    await this.decoder.unload().catch(() => {});
    this.#publish();
    return result;
  }

  #expireSessions() {
    const cutoff = this.now() - this.sessionIdleTimeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(id);
    }
  }

  async startSession({ modelId = null, deviceId = null } = {}) {
    this.#expireSessions();
    const state = await this.state();
    if (!state.available) throw new Error(state.reason ?? "Speech recognition is unavailable on this machine.");
    const requested = modelId ?? state.selectedModelId;
    if (!requested) throw new Error("No transcription model is installed. Choose one in Settings, Voice.");
    const record = await this.library.read(requested);
    if (!record) throw new Error("That transcription model is not installed.");
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) throw new Error("Too many recordings are already in progress.");

    const id = randomUUID();
    this.sessions.set(id, { id, modelId: requested, record, chunks: [], samples: 0, touchedAt: this.now(), deviceId });
    return { sessionId: id, modelId: requested, sampleRate: TRANSCRIPTION_SAMPLE_RATE, maxSamples: MAX_SESSION_SAMPLES };
  }

  #session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("That recording is no longer active.");
    return session;
  }

  // `pcm` is a Buffer of little-endian signed 16-bit mono samples at 16 kHz.
  appendChunk(sessionId, pcm) {
    const session = this.#session(sessionId);
    if (pcm.length % 2 !== 0) throw new Error("Audio chunks must contain whole 16-bit samples.");
    const count = pcm.length / 2;
    if (session.samples + count > MAX_SESSION_SAMPLES) {
      this.sessions.delete(sessionId);
      throw new Error(`A single recording may be at most ${MAX_SESSION_SAMPLES / TRANSCRIPTION_SAMPLE_RATE / 60} minutes long.`);
    }
    session.chunks.push(pcm);
    session.samples += count;
    session.touchedAt = this.now();
    return { sessionId, samples: session.samples, seconds: session.samples / TRANSCRIPTION_SAMPLE_RATE };
  }

  abortSession(sessionId) {
    return { sessionId, aborted: this.sessions.delete(sessionId) };
  }

  async finishSession(sessionId) {
    const session = this.#session(sessionId);
    this.sessions.delete(sessionId);
    if (session.samples === 0) return { sessionId, text: "", durationSeconds: 0, modelId: session.modelId };

    const merged = Buffer.concat(session.chunks, session.samples * 2);
    const samples = new Float32Array(session.samples);
    for (let index = 0; index < session.samples; index += 1) {
      const value = merged.readInt16LE(index * 2);
      samples[index] = value / (value < 0 ? 0x8000 : 0x7fff);
    }
    this.decodingWith = session.modelId;
    try {
      const result = await this.decoder.transcribe(session.record, samples, { ...this.settings });
      return { sessionId, modelId: session.modelId, text: result.text, durationSeconds: result.durationSeconds, elapsedMs: result.elapsedMs ?? null };
    } finally {
      this.decodingWith = null;
    }
  }

  async close() {
    this.sessions.clear();
    await this.decoder.close().catch(() => {});
  }
}
