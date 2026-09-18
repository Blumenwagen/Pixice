// Pixice ships no transcription model. Every entry here is downloaded on
// request into the user data directory and can be removed again from
// Settings -> Voice.
//
// Sizes come from the sherpa-onnx `asr-models` release. Every digest is
// verified before a download is accepted, so a new or changed entry needs its
// hash filled in by `node scripts/pin-transcription-models.mjs`, and
// `--verify` re-checks the pinned ones against the live archives.
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export const TRANSCRIPTION_MODELS = Object.freeze([
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT 0.6B v3",
    vendor: "NVIDIA",
    family: "transducer",
    summary: "Fast and accurate across 25 European languages. The best default for most people.",
    languages: "25 European languages",
    punctuation: true,
    recommended: true,
    archive: {
      name: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
      bytes: 487_170_055,
      sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf"
    },
    license: {
      name: "CC-BY-4.0",
      url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
      attribution: "Parakeet TDT 0.6B v3 by NVIDIA, licensed CC-BY-4.0."
    }
  },
  {
    id: "parakeet-tdt-0.6b-v2-int8",
    label: "Parakeet TDT 0.6B v2",
    vendor: "NVIDIA",
    family: "transducer",
    summary: "English only, with strong punctuation and capitalization.",
    languages: "English",
    punctuation: true,
    recommended: false,
    archive: {
      name: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
      bytes: 482_468_385,
      sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad"
    },
    license: {
      name: "CC-BY-4.0",
      url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2",
      attribution: "Parakeet TDT 0.6B v2 by NVIDIA, licensed CC-BY-4.0."
    }
  },
  {
    id: "whisper-turbo",
    label: "Whisper Turbo",
    vendor: "OpenAI",
    family: "whisper",
    summary: "The widest language coverage. Slower than Parakeet on the same machine.",
    languages: "99 languages",
    punctuation: true,
    recommended: false,
    archive: {
      name: "sherpa-onnx-whisper-turbo.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-whisper-turbo.tar.bz2`,
      bytes: 563_790_207,
      sha256: "b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22"
    },
    license: { name: "MIT", url: "https://github.com/openai/whisper", attribution: "Whisper by OpenAI, licensed MIT." }
  },
  {
    id: "moonshine-base-en-int8",
    label: "Moonshine Base",
    vendor: "Useful Sensors",
    family: "moonshine",
    summary: "English only and very light on memory. Good on older machines.",
    languages: "English",
    punctuation: true,
    recommended: false,
    archive: {
      name: "sherpa-onnx-moonshine-base-en-int8.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
      bytes: 250_807_309,
      sha256: "21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e"
    },
    license: { name: "MIT", url: "https://github.com/usefulsensors/moonshine", attribution: "Moonshine by Useful Sensors, licensed MIT." }
  },
  {
    id: "sense-voice-int8",
    label: "SenseVoice",
    vendor: "Alibaba",
    family: "sense-voice",
    summary: "Chinese, English, Japanese, Korean, and Cantonese in a small download.",
    languages: "zh, en, ja, ko, yue",
    punctuation: true,
    recommended: false,
    archive: {
      name: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2`,
      bytes: 165_783_878,
      sha256: "7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63"
    },
    license: { name: "Apache-2.0", url: "https://github.com/FunAudioLLM/SenseVoice", attribution: "SenseVoice by Alibaba, licensed Apache-2.0." }
  },
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    vendor: "OpenAI",
    family: "whisper",
    summary: "The smallest download. Noticeably less accurate, useful as a fallback.",
    languages: "99 languages",
    punctuation: true,
    recommended: false,
    archive: {
      name: "sherpa-onnx-whisper-tiny.tar.bz2",
      url: `${RELEASE}/sherpa-onnx-whisper-tiny.tar.bz2`,
      bytes: 116_204_861,
      sha256: "c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1"
    },
    license: { name: "MIT", url: "https://github.com/openai/whisper", attribution: "Whisper by OpenAI, licensed MIT." }
  }
]);

export const DEFAULT_TRANSCRIPTION_MODEL_ID = "parakeet-tdt-0.6b-v3-int8";

export const TRANSCRIPTION_MODEL_IDS = Object.freeze(TRANSCRIPTION_MODELS.map((model) => model.id));

export function findTranscriptionModel(id) {
  return TRANSCRIPTION_MODELS.find((model) => model.id === id) ?? null;
}

// Archive layouts differ between model families and change between releases,
// so the required files are discovered after extraction instead of hardcoded.
// int8 weights are preferred when a directory ships both precisions.
const FAMILY_FILES = {
  transducer: { encoder: /^encoder.*\.onnx$/i, decoder: /^decoder.*\.onnx$/i, joiner: /^joiner.*\.onnx$/i },
  whisper: { encoder: /-encoder.*\.onnx$/i, decoder: /-decoder.*\.onnx$/i },
  moonshine: {
    preprocessor: /^preprocess\.onnx$/i,
    encoder: /^encode.*\.onnx$/i,
    uncachedDecoder: /^uncached_decode.*\.onnx$/i,
    cachedDecoder: /^cached_decode.*\.onnx$/i
  },
  "sense-voice": { model: /^model.*\.onnx$/i }
};

function pickFile(entries, pattern) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length === 0) return null;
  // Prefer the quantized weights, then the shortest name, so `encoder.int8.onnx`
  // wins over `encoder.onnx` and neither loses to an unrelated longer sibling.
  return matches.sort((left, right) => {
    const quantized = Number(/int8/i.test(right)) - Number(/int8/i.test(left));
    return quantized !== 0 ? quantized : left.length - right.length;
  })[0];
}

// `entries` is the flat file listing of an installed model directory.
export function resolveModelFiles(family, entries) {
  const patterns = FAMILY_FILES[family];
  if (!patterns) throw new Error(`Unsupported transcription model family: ${family}`);
  const tokens = pickFile(entries, /^tokens.*\.txt$/i) ?? pickFile(entries, /tokens.*\.txt$/i);
  if (!tokens) throw new Error("The model directory does not contain a tokens file.");
  const files = { tokens };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = pickFile(entries, pattern);
    if (!match) throw new Error(`The model directory does not contain a ${key} file.`);
    files[key] = match;
  }
  return files;
}

export function recognizerConfig({ family, directory, files, numThreads = 2, provider = "cpu", language = "" }) {
  const resolve = (name) => `${directory}/${name}`;
  const modelConfig = { tokens: resolve(files.tokens), numThreads, provider, debug: 0 };
  if (family === "transducer") {
    modelConfig.transducer = { encoder: resolve(files.encoder), decoder: resolve(files.decoder), joiner: resolve(files.joiner) };
    modelConfig.modelType = "nemo_transducer";
  } else if (family === "whisper") {
    modelConfig.whisper = { encoder: resolve(files.encoder), decoder: resolve(files.decoder), task: "transcribe", language };
  } else if (family === "moonshine") {
    modelConfig.moonshine = {
      preprocessor: resolve(files.preprocessor),
      encoder: resolve(files.encoder),
      uncachedDecoder: resolve(files.uncachedDecoder),
      cachedDecoder: resolve(files.cachedDecoder)
    };
  } else if (family === "sense-voice") {
    modelConfig.senseVoice = { model: resolve(files.model), useInverseTextNormalization: 1, language };
  } else {
    throw new Error(`Unsupported transcription model family: ${family}`);
  }
  return { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig };
}

// Only Whisper and SenseVoice accept a language hint. The others infer it.
export function supportsLanguageHint(family) {
  return family === "whisper" || family === "sense-voice";
}
