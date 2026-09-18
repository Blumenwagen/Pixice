import { createRequire } from "node:module";
import { findTranscriptionModel, recognizerConfig } from "./catalog.mjs";

const require = createRequire(import.meta.url);

// The int8 Parakeet encoder is roughly 600 MB resident. Holding it forever
// would make Pixice the largest process on the machine for a feature most
// people use in bursts, so an idle recognizer is released.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let cachedAddon;
let cachedAddonError;

// Cheap presence check that resolves the package paths without dlopen-ing the
// native library. It answers the common question, "did this platform get a
// prebuilt binary", without pulling 30 MB into the calling process or spawning
// anything. A library that resolves but fails to load is reported at the first
// real decode instead.
export function addonPresent(requireImpl = require) {
  const platform = process.platform === "win32" ? "win" : process.platform;
  try {
    // The platform binary is an optional dependency of the wrapper, not of
    // Pixice, so under pnpm's isolated layout it is only visible from the
    // wrapper's own directory. Resolve it from there rather than from here.
    const wrapper = requireImpl.resolve("sherpa-onnx-node");
    createRequire(wrapper).resolve(`sherpa-onnx-${platform}-${process.arch}/package.json`);
    return { available: true, reason: null };
  } catch {
    return {
      available: false,
      reason: `Speech recognition is not available for ${platform}-${process.arch} in this build.`
    };
  }
}

// sherpa-onnx-node is an optional-by-platform native addon. A missing or
// unloadable addon disables dictation and never blocks the rest of Pixice.
export function loadAddon(requireImpl = require) {
  if (cachedAddon) return cachedAddon;
  if (cachedAddonError) throw cachedAddonError;
  try {
    cachedAddon = requireImpl("sherpa-onnx-node");
    return cachedAddon;
  } catch (error) {
    cachedAddonError = new Error(`Speech recognition is unavailable on this machine: ${error.message}`);
    throw cachedAddonError;
  }
}

export function resetAddonCache() {
  cachedAddon = undefined;
  cachedAddonError = undefined;
}

export class TranscriptionEngine {
  constructor({ loadAddon: load = loadAddon, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = () => Date.now() } = {}) {
    this.load = load;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = now;
    this.loaded = null;
    this.idleTimer = null;
  }

  available() {
    try { this.load(); return { available: true, reason: null }; }
    catch (error) { return { available: false, reason: error.message }; }
  }

  // `record` is a TranscriptionModelLibrary entry for an installed model.
  #ensureRecognizer(record, options) {
    const key = JSON.stringify([record.id, options.numThreads, options.provider, options.language]);
    if (this.loaded?.key === key) return this.loaded.recognizer;
    this.unload();
    const model = findTranscriptionModel(record.id);
    if (!model) throw new Error(`Unknown transcription model: ${record.id}`);
    const addon = this.load();
    const config = recognizerConfig({
      family: model.family,
      directory: record.directory,
      files: record.files,
      numThreads: options.numThreads,
      provider: options.provider,
      language: options.language
    });
    this.loaded = { key, modelId: record.id, recognizer: new addon.OfflineRecognizer(config) };
    return this.loaded.recognizer;
  }

  loadedModelId() { return this.loaded?.modelId ?? null; }

  unload() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.loaded = null;
  }

  #scheduleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => { this.loaded = null; this.idleTimer = null; }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  // `samples` is 16 kHz mono Float32Array audio in the range [-1, 1].
  transcribe(record, samples, { numThreads = 2, provider = "cpu", language = "" } = {}) {
    if (!(samples instanceof Float32Array)) throw new TypeError("Audio samples must be a Float32Array.");
    if (samples.length === 0) return { text: "", durationSeconds: 0 };
    const startedAt = this.now();
    const recognizer = this.#ensureRecognizer(record, { numThreads, provider, language });
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    this.#scheduleUnload();
    return {
      text: String(result?.text ?? "").trim(),
      durationSeconds: samples.length / 16000,
      elapsedMs: this.now() - startedAt
    };
  }
}
