import { describe, expect, it, vi } from "vitest";
import { DICTATION_SAMPLE_RATE, dictationUnsupportedReason, encodeChunk, floatToInt16, listAudioInputs, rms } from "../src/lib/dictation.js";
import { ChildProcessDecoder } from "../electron/transcription/decoder-client.mjs";

describe("dictation audio encoding", () => {
  it("maps the float range onto full-scale 16-bit samples", () => {
    const encoded = floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5]));

    expect(encoded[0]).toBe(0);
    expect(encoded[1]).toBe(32767);
    expect(encoded[2]).toBe(-32768);
    expect(encoded[3]).toBe(16383);
    expect(encoded[4]).toBe(-16384);
  });

  it("clamps samples that overshoot instead of wrapping around", () => {
    const encoded = floatToInt16(new Float32Array([4, -4]));

    expect(encoded[0]).toBe(32767);
    expect(encoded[1]).toBe(-32768);
  });

  it("round-trips through base64 back to the same bytes the host decodes", () => {
    const samples = new Float32Array([0, 0.25, -0.25, 1, -1]);
    const encoded = floatToInt16(samples);

    const buffer = Buffer.from(encodeChunk(encoded), "base64");

    expect(buffer.length).toBe(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
      expect(buffer.readInt16LE(index * 2)).toBe(encoded[index]);
    }
  });

  it("encodes a chunk larger than the fromCharCode argument limit", () => {
    const samples = new Float32Array(DICTATION_SAMPLE_RATE * 3).fill(0.5);

    const buffer = Buffer.from(encodeChunk(floatToInt16(samples)), "base64");

    expect(buffer.length).toBe(samples.length * 2);
    expect(buffer.readInt16LE(0)).toBe(16383);
    expect(buffer.readInt16LE(buffer.length - 2)).toBe(16383);
  });

  it("measures signal level without dividing by zero on an empty frame", () => {
    expect(rms(new Float32Array([]))).toBe(0);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([1, -1]))).toBeCloseTo(1, 5);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 5);
  });
});

describe("dictation capability checks", () => {
  it("explains why a browser without getUserMedia cannot dictate", () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    try {
      expect(dictationUnsupportedReason()).toMatch(/cannot record audio/);
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { value: original, configurable: true });
    }
  });

  it("explains an insecure context separately from a missing API", () => {
    const originalDevices = navigator.mediaDevices;
    const originalSecure = window.isSecureContext;
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      expect(dictationUnsupportedReason()).toMatch(/secure connection/);
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { value: originalDevices, configurable: true });
      Object.defineProperty(window, "isSecureContext", { value: originalSecure, configurable: true });
    }
  });

  it("lists only audio inputs and falls back to a numbered label", async () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          { kind: "audioinput", deviceId: "a", label: "Built-in Mic" },
          { kind: "videoinput", deviceId: "cam", label: "Camera" },
          { kind: "audioinput", deviceId: "b", label: "" }
        ])
      },
      configurable: true
    });
    try {
      expect(await listAudioInputs()).toEqual([
        { deviceId: "a", label: "Built-in Mic" },
        { deviceId: "b", label: "Microphone 2" }
      ]);
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { value: original, configurable: true });
    }
  });

  it("returns an empty list rather than throwing when enumeration is blocked", async () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", { value: { enumerateDevices: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
    try {
      expect(await listAudioInputs()).toEqual([]);
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { value: original, configurable: true });
    }
  });
});

function fakeChild() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler); return this; },
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(function (message) {
      // Answer on the next tick the way a real IPC round trip would.
      queueMicrotask(() => handlers.get("message")?.({ id: message.id, ok: true, result: { text: "ok", echoed: message.type } }));
    })
  };
}

describe("child process decoder", () => {
  it("spawns one process and reuses it across decodes", async () => {
    const child = fakeChild();
    const forkImpl = vi.fn(() => child);
    const decoder = new ChildProcessDecoder({ hostPath: "/host.mjs", forkImpl, idleTimeoutMs: 0 });

    await decoder.transcribe({ id: "m" }, new Float32Array(4), {});
    await decoder.transcribe({ id: "m" }, new Float32Array(4), {});

    expect(forkImpl).toHaveBeenCalledOnce();
    expect(forkImpl.mock.calls[0][2]).toMatchObject({ serialization: "advanced" });
    expect(child.send).toHaveBeenCalledTimes(2);
  });

  it("answers the availability probe without starting a process", async () => {
    const forkImpl = vi.fn(() => fakeChild());
    const decoder = new ChildProcessDecoder({ hostPath: "/host.mjs", forkImpl, idleTimeoutMs: 0 });

    const result = await decoder.available();

    // Launching a decoder for a feature most sessions never touch would be
    // pure overhead, so this question is answered in the parent process.
    expect(forkImpl).not.toHaveBeenCalled();
    expect(result).toHaveProperty("available");
  });

  it("rejects pending work when the process dies", async () => {
    const child = fakeChild();
    child.send = vi.fn();
    const decoder = new ChildProcessDecoder({ hostPath: "/host.mjs", forkImpl: () => child, idleTimeoutMs: 0 });

    const pending = decoder.transcribe({ id: "m" }, new Float32Array(4), {});
    child.handlers.get("exit")?.(null, "SIGKILL");

    await expect(pending).rejects.toThrow(/stopped unexpectedly/);
  });

  it("surfaces a decode failure when the process cannot start", async () => {
    const decoder = new ChildProcessDecoder({
      hostPath: "/host.mjs",
      forkImpl: () => { throw new Error("spawn failed"); },
      idleTimeoutMs: 0
    });

    await expect(decoder.transcribe({ id: "m" }, new Float32Array(1), {})).rejects.toThrow(/spawn failed/);
  });

  it("refuses new work once closed", async () => {
    const decoder = new ChildProcessDecoder({ hostPath: "/host.mjs", forkImpl: () => fakeChild(), idleTimeoutMs: 0 });
    await decoder.close();

    await expect(decoder.transcribe({ id: "m" }, new Float32Array(1), {})).rejects.toThrow(/stopping/);
  });

  it("times out a decode that never answers and restarts the process", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      child.send = vi.fn();
      const decoder = new ChildProcessDecoder({ hostPath: "/host.mjs", forkImpl: () => child, requestTimeoutMs: 50, idleTimeoutMs: 0 });

      const pending = decoder.transcribe({ id: "m" }, new Float32Array(1), {});
      vi.advanceTimersByTime(60);

      await expect(pending).rejects.toThrow(/did not finish in time/);
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
