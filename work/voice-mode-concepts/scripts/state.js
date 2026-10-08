// Shared simulated voice-session state machine for all three concepts.
// No microphone, no audio APIs, no network calls — amplitude is synthetic.

const VOICE_STATES = ["listening", "thinking", "speaking", "error"];

const CAPTION_SCRIPT = {
  listening: [
    "You: what's the status on the rail refinement task?",
  ],
  thinking: [
    "Coordinator: checking the worker's latest update…",
  ],
  speaking: [
    "Coordinator: two of four steps done, want details?",
    "Coordinator: the spacing pass and final review are still open.",
  ],
  error: [
    "Coordinator: lost the connection — retry when ready.",
  ],
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

// Deterministic pseudo-random noise (seeded) so demo motion is reproducible
// across remounts, echoing the "seed" prop pattern from reference orb components.
function createSeededNoise(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function createVoiceSession({ seed = 42 } = {}) {
  const rng = createSeededNoise(seed);
  const noiseTable = Array.from({ length: 256 }, () => rng());

  const listeners = new Set();
  let rafId = null;
  let startTime = performance.now();

  const state = {
    voiceState: "listening",
    muted: false,
    ended: false,
    autoDemo: true,
    captionsVisible: true,
    amplitude: 0,
    transcript: [],
    // Lives on shared session state (not component-local) so it survives an
    // implicit remount (tab switch, reduced-motion toggle) — it only resets
    // on an explicit end()/restart() intention, never on a remount.
    transcribing: false,
    settings: {
      voice: "Default voice",
      inputDevice: "System default microphone",
      outputVolume: 0.72,
      motionIntensity: 0.8,
      reducedMotion: typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false,
    },
  };

  function emit() {
    for (const listener of listeners) listener(state);
  }

  function sampleNoise(t) {
    const scaled = t * 2.1;
    const i0 = Math.floor(scaled) % noiseTable.length;
    const i1 = (i0 + 1) % noiseTable.length;
    const frac = scaled - Math.floor(scaled);
    return noiseTable[i0] * (1 - frac) + noiseTable[i1] * frac;
  }

  function amplitudeFor(voiceState, tSeconds) {
    if (state.muted) return 0.04;
    switch (voiceState) {
      case "listening":
        return 0.14 + sampleNoise(tSeconds) * 0.1;
      case "thinking":
        return 0.22 + Math.sin(tSeconds * 1.6) * 0.05;
      case "speaking":
        return clamp01(0.38 + sampleNoise(tSeconds) * 0.42 + Math.sin(tSeconds * 5.2) * 0.12);
      case "error":
        return 0.06 + Math.abs(Math.sin(tSeconds * 9)) * 0.05;
      default:
        return 0.1;
    }
  }

  const AUTO_DEMO_SEQUENCE = ["listening", "thinking", "speaking", "speaking", "listening"];
  let autoDemoIndex = 0;
  let autoDemoElapsed = 0;
  const AUTO_DEMO_STEP_SECONDS = 4.2;

  function tick(now) {
    const tSeconds = (now - startTime) / 1000;
    const dt = rafId === null ? 0 : 1 / 60;

    if (state.autoDemo && !state.ended && state.voiceState !== "error") {
      autoDemoElapsed += dt;
      if (autoDemoElapsed >= AUTO_DEMO_STEP_SECONDS) {
        autoDemoElapsed = 0;
        autoDemoIndex = (autoDemoIndex + 1) % AUTO_DEMO_SEQUENCE.length;
        setVoiceState(AUTO_DEMO_SEQUENCE[autoDemoIndex], { silent: true });
      }
    }

    state.amplitude = state.ended ? 0 : amplitudeFor(state.voiceState, tSeconds);
    emit();
    // Stop self-scheduling once ended instead of ticking forever for no
    // visual purpose; restart() calls start() again to resume exactly once.
    rafId = state.ended ? null : requestAnimationFrame(tick);
  }

  function pushCaption(voiceState) {
    const lines = CAPTION_SCRIPT[voiceState];
    if (!lines) return;
    const line = lines[Math.floor(rng() * lines.length)];
    state.transcript = [...state.transcript.slice(-4), { id: `${Date.now()}-${Math.random()}`, speaker: voiceState, text: line }];
  }

  function setVoiceState(next, { silent = false } = {}) {
    if (!VOICE_STATES.includes(next)) return;
    state.voiceState = next;
    if (!silent) autoDemoElapsed = 0;
    if (next === "speaking" || next === "listening" || next === "thinking" || next === "error") pushCaption(next);
    emit();
  }

  function start() {
    if (rafId !== null) return; // idempotent — never double-schedule the loop
    startTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    setVoiceState: (next) => setVoiceState(next, { silent: false }),
    setAutoDemo(value) {
      state.autoDemo = value;
      autoDemoElapsed = 0;
      emit();
    },
    toggleMute() {
      state.muted = !state.muted;
      emit();
    },
    end() {
      state.ended = true;
      state.autoDemo = false;
      state.transcribing = false;
      emit(); // this is the last emission — tick() sees state.ended and stops rescheduling itself
    },
    restart() {
      state.ended = false;
      state.muted = false;
      state.autoDemo = true;
      state.transcribing = false;
      autoDemoIndex = 0;
      autoDemoElapsed = 0;
      start(); // resume the loop exactly once (idempotent if somehow already running)
      setVoiceState("listening", { silent: true });
    },
    setTranscribing(value) {
      state.transcribing = value;
      emit();
    },
    simulateError() {
      setVoiceState("error");
    },
    setCaptionsVisible(value) {
      state.captionsVisible = value;
      emit();
    },
    updateSettings(partial) {
      Object.assign(state.settings, partial);
      emit();
    },
  };
}

export { VOICE_STATES };
