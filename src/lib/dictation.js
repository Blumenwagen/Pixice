// Microphone capture for the composer's dictation button.
//
// Audio is captured on whichever device the person is sitting at, including a
// paired browser, and streamed to the Pixice host as 16 kHz mono PCM. The host
// owns the model and does the decoding, so a phone or laptop never downloads
// half a gigabyte of weights to dictate one sentence.

export const DICTATION_SAMPLE_RATE = 16000;
// One second of audio per request. Small enough to keep host memory bounded
// and large enough that a long dictation does not become thousands of calls.
const CHUNK_SAMPLES = DICTATION_SAMPLE_RATE;

// The worklet only forwards frames. Everything else stays on the main thread
// where it can be tested without an AudioContext.
const WORKLET_SOURCE = `
registerProcessor("pixice-dictation", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
});
`;

export function floatToInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export function encodeChunk(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  // btoa takes a binary string. Chunked so a long recording cannot blow the
  // argument limit of String.fromCharCode.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function rms(samples) {
  if (!samples.length) return 0;
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
  return Math.sqrt(total / samples.length);
}

async function createCaptureNode(context, source, onFrame) {
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, "pixice-dictation");
    node.port.onmessage = (event) => onFrame(event.data);
    source.connect(node);
    // A worklet with no destination is not pulled in every implementation, so
    // it is routed through a muted gain node instead of the speakers.
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(context.destination);
    return () => { node.port.onmessage = null; node.disconnect(); sink.disconnect(); };
  } catch {
    // Older embedded Chromium builds and some locked-down web views refuse
    // blob worklets. ScriptProcessorNode is deprecated but still works.
    const node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(node);
    const sink = context.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(context.destination);
    return () => { node.onaudioprocess = null; node.disconnect(); sink.disconnect(); };
  }
}

export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
}

export function dictationUnsupportedReason() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "This browser cannot record audio. Pixice needs a secure connection and microphone support.";
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "Recording needs a secure connection. Open Pixice over HTTPS or on the host machine.";
  }
  return null;
}

// Starts a recording and returns a handle. `stop()` resolves with the
// transcript, `cancel()` discards the audio without transcribing it.
export async function startDictation({ api, modelId = null, deviceId = null, onLevel = () => {}, onError = () => {} }) {
  const unsupported = dictationUnsupportedReason();
  if (unsupported) throw new Error(unsupported);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
  });

  let context;
  let session;
  let disconnect = () => {};
  const release = () => {
    try { disconnect(); } catch { /* the graph is already torn down */ }
    for (const track of stream.getTracks()) track.stop();
    context?.close().catch(() => {});
  };

  try {
    // Chromium resamples the microphone to the requested rate, which removes
    // the need for a resampler here.
    context = new (window.AudioContext ?? window.webkitAudioContext)({ sampleRate: DICTATION_SAMPLE_RATE });
    if (context.state === "suspended") await context.resume();
    session = await api.transcription.start({ modelId, deviceId });
  } catch (error) {
    release();
    throw error;
  }

  let pending = [];
  let pendingSamples = 0;
  let totalSamples = 0;
  let stopped = false;
  let failure = null;
  // Chunk uploads are chained so they reach the host in recording order.
  let queue = Promise.resolve();

  const flush = (force = false) => {
    if (pendingSamples === 0 || (!force && pendingSamples < CHUNK_SAMPLES)) return;
    const merged = new Float32Array(pendingSamples);
    let offset = 0;
    for (const frame of pending) { merged.set(frame, offset); offset += frame.length; }
    pending = [];
    pendingSamples = 0;
    const payload = encodeChunk(floatToInt16(merged));
    queue = queue.then(() => api.transcription.chunk({ sessionId: session.sessionId, pcm: payload })).catch((error) => {
      failure ??= error;
      onError(error);
    });
  };

  const handleFrame = (frame) => {
    if (stopped || failure) return;
    pending.push(frame);
    pendingSamples += frame.length;
    totalSamples += frame.length;
    onLevel(rms(frame));
    flush(false);
  };

  try {
    disconnect = await createCaptureNode(context, context.createMediaStreamSource(stream), handleFrame);
  } catch (error) {
    release();
    await api.transcription.abort({ sessionId: session.sessionId }).catch(() => {});
    throw error;
  }

  return {
    sessionId: session.sessionId,
    modelId: session.modelId,
    seconds: () => totalSamples / DICTATION_SAMPLE_RATE,
    async stop() {
      if (stopped) throw new Error("This recording already finished.");
      stopped = true;
      flush(true);
      release();
      await queue;
      if (failure) {
        await api.transcription.abort({ sessionId: session.sessionId }).catch(() => {});
        throw failure;
      }
      return api.transcription.finish({ sessionId: session.sessionId });
    },
    async cancel() {
      if (stopped) return;
      stopped = true;
      pending = [];
      pendingSamples = 0;
      release();
      await queue.catch(() => {});
      await api.transcription.abort({ sessionId: session.sessionId }).catch(() => {});
    }
  };
}
