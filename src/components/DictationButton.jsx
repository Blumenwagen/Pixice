import { useCallback, useEffect, useRef, useState } from "react";
import { Microphone, SpinnerGap, X } from "./icons/index.jsx";
import { dictationUnsupportedReason, startDictation } from "../lib/dictation.js";
import styles from "./DictationButton.module.css";

function formatElapsed(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Sits next to Send. Recording happens on this device, decoding happens on the
// Pixice host, and the transcript is handed back to the composer for editing
// rather than being submitted.
export function DictationButton({ api, state, deviceId = null, disabled = false, onTranscript, onError }) {
  const [phase, setPhase] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recorderRef = useRef(null);
  const timerRef = useRef(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  useEffect(() => () => {
    stopTimer();
    void recorderRef.current?.cancel().catch(() => {});
  }, [stopTimer]);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    stopTimer();
    setPhase("transcribing");
    setLevel(0);
    try {
      const result = await recorder.stop();
      if (result.text) onTranscript(result.text);
      else onError?.(new Error("No speech was detected in that recording."));
    } catch (error) {
      onError?.(error);
    } finally {
      setPhase("idle");
      setElapsed(0);
    }
  }, [onError, onTranscript, stopTimer]);

  const cancel = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    stopTimer();
    setPhase("idle");
    setElapsed(0);
    setLevel(0);
    await recorder?.cancel().catch(() => {});
  }, [stopTimer]);

  const begin = useCallback(async () => {
    if (!state?.ready) return;
    setPhase("starting");
    try {
      const recorder = await startDictation({
        api,
        modelId: state.selectedModelId,
        deviceId,
        onLevel: setLevel,
        onError: (error) => { onError?.(error); void cancel(); }
      });
      recorderRef.current = recorder;
      setPhase("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(recorder.seconds()), 200);
    } catch (error) {
      setPhase("idle");
      onError?.(error);
    }
  }, [api, cancel, deviceId, onError, state]);

  useEffect(() => {
    if (phase !== "recording") return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); void cancel(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, phase]);

  // The composer stays clean until dictation can actually run: a host with the
  // capability, a model downloaded and selected in Settings, and a device that
  // can record. Discovery happens in Settings, not through a button here that
  // would only lead somewhere else.
  // A recording already in flight keeps its controls even if the host state
  // changes underneath it, so the audio is never dropped silently.
  if (!api?.transcription || (!state?.ready && phase === "idle")) return null;
  if (dictationUnsupportedReason()) return null;

  if (phase === "recording") {
    return (
      <div className={styles.recording} role="group" aria-label="Recording">
        <button
          type="button"
          className={styles.cancel}
          onClick={() => void cancel()}
          aria-label="Discard recording"
          title="Discard recording (Esc)"
        >
          <X size={14} />
        </button>
        <span className={styles.meter} aria-hidden="true">
          <i style={{ transform: `scaleY(${0.25 + Math.min(1, level * 6) * 0.75})` }} />
        </span>
        <button
          type="button"
          className={styles.stop}
          onClick={() => void finish()}
          aria-label={`Stop recording and transcribe, ${formatElapsed(elapsed)}`}
        >
          <span className={styles.square} aria-hidden="true" />
          <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
        </button>
      </div>
    );
  }

  const busy = phase === "starting" || phase === "transcribing";
  const label = phase === "transcribing" ? "Transcribing" : "Dictate a message";

  return (
    <button
      type="button"
      className="icon-button"
      onClick={() => void begin()}
      disabled={disabled || busy}
      aria-label={label}
      title={label}
    >
      {busy ? <SpinnerGap className="spin-icon" size={17} /> : <Microphone size={17} />}
    </button>
  );
}
