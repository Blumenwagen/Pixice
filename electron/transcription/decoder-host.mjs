// Runs one transcription recognizer in its own process. Decoding is a
// multi-second synchronous call inside the native addon, so keeping it here
// stops it from stalling every other backend request. It also means the
// recognizer's memory is returned to the OS when the process exits, and an
// ONNX Runtime crash cannot take the Pixice service down with it.
import { TranscriptionEngine } from "./engine.mjs";

const engine = new TranscriptionEngine({ idleTimeoutMs: 0 });

function reply(message) {
  process.send?.(message);
}

process.on("message", (message) => {
  const { id, type } = message ?? {};
  if (!id) return;
  try {
    if (type === "transcribe") {
      const samples = message.samples instanceof Float32Array ? message.samples : Float32Array.from(message.samples ?? []);
      reply({ id, ok: true, result: engine.transcribe(message.record, samples, message.options) });
    } else if (type === "unload") {
      engine.unload();
      reply({ id, ok: true, result: { unloaded: true } });
    } else {
      reply({ id, ok: false, error: `Unsupported decoder command: ${type}` });
    }
  } catch (error) {
    reply({ id, ok: false, error: String(error?.message ?? error).slice(0, 1000) });
  }
});

process.on("disconnect", () => { process.exit(0); });
