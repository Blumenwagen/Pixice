import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPTION_MODEL_ID,
  TRANSCRIPTION_MODELS,
  findTranscriptionModel,
  recognizerConfig,
  resolveModelFiles,
  supportsLanguageHint
} from "../electron/transcription/catalog.mjs";

describe("transcription catalog", () => {
  it("pins a verified digest and a size for every downloadable model", () => {
    for (const model of TRANSCRIPTION_MODELS) {
      expect(model.archive.sha256, `${model.id} must pin a digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(model.archive.bytes).toBeGreaterThan(0);
      expect(model.archive.url).toContain(model.archive.name);
    }
  });

  it("names a license and attribution for every model", () => {
    for (const model of TRANSCRIPTION_MODELS) {
      expect(model.license.name).toBeTruthy();
      expect(model.license.attribution).toContain(model.license.name);
    }
  });

  it("offers exactly one recommended default that exists", () => {
    const recommended = TRANSCRIPTION_MODELS.filter((model) => model.recommended);
    expect(recommended).toHaveLength(1);
    expect(findTranscriptionModel(DEFAULT_TRANSCRIPTION_MODEL_ID)).toBe(recommended[0]);
  });

  it("uses unique ids", () => {
    const ids = TRANSCRIPTION_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefers quantized weights when a directory ships both precisions", () => {
    const files = resolveModelFiles("whisper", [
      "tiny-encoder.onnx",
      "tiny-encoder.int8.onnx",
      "tiny-decoder.onnx",
      "tiny-decoder.int8.onnx",
      "tiny-tokens.txt"
    ]);

    expect(files).toEqual({
      tokens: "tiny-tokens.txt",
      encoder: "tiny-encoder.int8.onnx",
      decoder: "tiny-decoder.int8.onnx"
    });
  });

  it("resolves the transducer layout Parakeet ships", () => {
    expect(resolveModelFiles("transducer", [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt"
    ])).toEqual({
      tokens: "tokens.txt",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx"
    });
  });

  it("resolves the four-file Moonshine layout", () => {
    expect(resolveModelFiles("moonshine", [
      "preprocess.onnx",
      "encode.int8.onnx",
      "uncached_decode.int8.onnx",
      "cached_decode.int8.onnx",
      "tokens.txt"
    ])).toMatchObject({
      preprocessor: "preprocess.onnx",
      encoder: "encode.int8.onnx",
      uncachedDecoder: "uncached_decode.int8.onnx",
      cachedDecoder: "cached_decode.int8.onnx"
    });
  });

  it("reports the missing file instead of building a broken config", () => {
    expect(() => resolveModelFiles("transducer", ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]))
      .toThrow(/joiner/);
    expect(() => resolveModelFiles("whisper", ["tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx"]))
      .toThrow(/tokens/);
    expect(() => resolveModelFiles("nonsense", ["tokens.txt"])).toThrow(/Unsupported/);
  });

  it("builds a sherpa config with absolute paths for each family", () => {
    const transducer = recognizerConfig({
      family: "transducer",
      directory: "/models/parakeet",
      files: { tokens: "tokens.txt", encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx" }
    });

    expect(transducer.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
    expect(transducer.modelConfig.modelType).toBe("nemo_transducer");
    expect(transducer.modelConfig.transducer.encoder).toBe("/models/parakeet/encoder.int8.onnx");
    expect(transducer.modelConfig.tokens).toBe("/models/parakeet/tokens.txt");

    const whisper = recognizerConfig({
      family: "whisper",
      directory: "/models/whisper",
      files: { tokens: "tiny-tokens.txt", encoder: "tiny-encoder.int8.onnx", decoder: "tiny-decoder.int8.onnx" },
      language: "de"
    });

    expect(whisper.modelConfig.whisper).toMatchObject({ task: "transcribe", language: "de" });
    expect(whisper.modelConfig.whisper.decoder).toBe("/models/whisper/tiny-decoder.int8.onnx");

    const senseVoice = recognizerConfig({
      family: "sense-voice",
      directory: "/models/sense",
      files: { tokens: "tokens.txt", model: "model.int8.onnx" }
    });

    expect(senseVoice.modelConfig.senseVoice.model).toBe("/models/sense/model.int8.onnx");
  });

  it("passes the thread and provider settings through to the model config", () => {
    const config = recognizerConfig({
      family: "sense-voice",
      directory: "/models/sense",
      files: { tokens: "tokens.txt", model: "model.onnx" },
      numThreads: 8,
      provider: "coreml"
    });

    expect(config.modelConfig.numThreads).toBe(8);
    expect(config.modelConfig.provider).toBe("coreml");
  });

  it("only offers a language hint where the model accepts one", () => {
    expect(supportsLanguageHint("whisper")).toBe(true);
    expect(supportsLanguageHint("sense-voice")).toBe(true);
    expect(supportsLanguageHint("transducer")).toBe(false);
    expect(supportsLanguageHint("moonshine")).toBe(false);
  });
});
