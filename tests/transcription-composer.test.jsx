import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/App.jsx";

const model = { model: "model-a", displayName: "Model A", provider: "codex", supportedReasoningEfforts: [{ reasoningEffort: "high" }] };

function storageAdapter() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
}

function transcriptionState(overrides = {}) {
  return {
    available: true,
    reason: null,
    sampleRate: 16000,
    maxSeconds: 600,
    selectedModelId: "parakeet-tdt-0.6b-v3-int8",
    preferredModelId: "parakeet-tdt-0.6b-v3-int8",
    ready: true,
    models: [],
    diskBytes: 0,
    settings: { numThreads: 2, provider: "cpu", language: "" },
    ...overrides
  };
}

function composerProps(overrides = {}) {
  return {
    disabled: false,
    busy: false,
    draftKey: "project-a:new",
    preserveDrafts: false,
    sendShortcut: "enter",
    spellCheckComposer: true,
    autoFocusComposer: false,
    showSlashCommands: false,
    running: false,
    models: [model],
    selectedModel: model.model,
    onModelChange: vi.fn(),
    effort: "high",
    onEffortChange: vi.fn(),
    fastMode: false,
    onFastModeChange: vi.fn(),
    permissionMode: "workspace-write",
    onPermissionModeChange: vi.fn(),
    providers: [{ id: "codex", connected: true, status: { state: "ready" } }],
    onProviderLogin: vi.fn(),
    onProvidersRefresh: vi.fn(),
    onSubmit: vi.fn(async () => true),
    onInterrupt: vi.fn(),
    storage: storageAdapter(),
    dictationApi: { transcription: {} },
    transcription: transcriptionState(),
    ...overrides
  };
}

// jsdom has no Web Audio. This stands in for the capture graph so the
// recording flow can be driven end to end: `pushFrame` delivers audio the way
// the worklet does, and `stoppedTracks` proves the microphone was released.
function installFakeAudio() {
  const state = { stoppedTracks: 0, port: null };
  const track = { stop: () => { state.stoppedTracks += 1; } };

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      enumerateDevices: vi.fn(async () => [])
    }
  });

  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
      state.port = this.port;
    }
    connect(target) { return target; }
    disconnect() {}
  }
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;

  class FakeAudioContext {
    constructor({ sampleRate }) {
      this.sampleRate = sampleRate;
      this.state = "running";
      this.destination = { connect: () => {}, disconnect: () => {} };
      this.audioWorklet = { addModule: vi.fn(async () => {}) };
    }
    createMediaStreamSource() { return { connect: (node) => node, disconnect: () => {} }; }
    createGain() { return { gain: { value: 1 }, connect: (target) => target, disconnect: () => {} }; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  }
  const originalContext = window.AudioContext;
  window.AudioContext = FakeAudioContext;

  URL.createObjectURL ??= () => "blob:pixice-test";
  URL.revokeObjectURL ??= () => {};

  cleanups.push(() => {
    window.AudioContext = originalContext;
    delete globalThis.AudioWorkletNode;
  });

  return {
    pushFrame: (frame) => act(() => { state.port?.onmessage?.({ data: frame }); }),
    get stoppedTracks() { return state.stoppedTracks; }
  };
}

let cleanups = [];
let restoreMicrophone = () => {};

beforeEach(() => {
  const originalDevices = navigator.mediaDevices;
  const originalSecure = window.isSecureContext;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) }, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  restoreMicrophone = () => {
    Object.defineProperty(navigator, "mediaDevices", { value: originalDevices, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: originalSecure, configurable: true });
  };
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  restoreMicrophone();
});

describe("composer dictation integration", () => {
  it("puts the microphone button next to Send", () => {
    const { container } = render(<Composer {...composerProps()} />);

    const actions = container.querySelector(".composer-actions");
    const buttons = [...actions.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));

    expect(buttons).toContain("Dictate a message");
    expect(buttons).toContain("Send message");
    // The microphone sits immediately before Send, not off in the attachment row.
    expect(buttons.indexOf("Dictate a message")).toBe(buttons.indexOf("Send message") - 1);
    expect(within(container.querySelector(".composer-primary-actions")).queryByLabelText("Dictate a message")).toBeNull();
  });

  it("leaves the composer untouched when the host cannot transcribe", () => {
    const { container } = render(<Composer {...composerProps({ transcription: null })} />);

    const actions = container.querySelector(".composer-actions");
    expect(within(actions).queryByLabelText(/dictate/i)).toBeNull();
    expect(within(actions).getByLabelText("Send message")).toBeInTheDocument();
  });

  it("records, transcribes, and inserts the text at the cursor without sending", async () => {
    const audio = installFakeAudio();
    const onSubmit = vi.fn(async () => true);
    const transcription = {
      start: vi.fn(async () => ({ sessionId: "s1", modelId: "parakeet-tdt-0.6b-v3-int8", sampleRate: 16000, maxSamples: 9_600_000 })),
      chunk: vi.fn(async () => ({ sessionId: "s1", samples: 16000, seconds: 1 })),
      finish: vi.fn(async () => ({ sessionId: "s1", modelId: "parakeet-tdt-0.6b-v3-int8", text: "the failing test", durationSeconds: 1 })),
      abort: vi.fn(async () => ({ sessionId: "s1", aborted: true }))
    };
    render(<Composer {...composerProps({ onSubmit, dictationApi: { transcription } })} />);

    const textarea = screen.getByRole("textbox", { name: "Task prompt" });
    await userEvent.type(textarea, "please fix");

    await userEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await waitFor(() => expect(transcription.start).toHaveBeenCalled());

    // One second of audio, then stop.
    audio.pushFrame(new Float32Array(16000).fill(0.2));
    await userEvent.click(await screen.findByRole("button", { name: /stop recording and transcribe/i }));

    await waitFor(() => expect(textarea).toHaveValue("please fix the failing test"));
    expect(transcription.chunk).toHaveBeenCalled();
    expect(transcription.finish).toHaveBeenCalledWith({ sessionId: "s1" });
    // The transcript is handed to the composer for editing, never submitted.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("discards the audio when a recording is cancelled", async () => {
    const audio = installFakeAudio();
    const transcription = {
      start: vi.fn(async () => ({ sessionId: "s2", modelId: "m", sampleRate: 16000, maxSamples: 9_600_000 })),
      chunk: vi.fn(async () => ({})),
      finish: vi.fn(),
      abort: vi.fn(async () => ({ sessionId: "s2", aborted: true }))
    };
    render(<Composer {...composerProps({ dictationApi: { transcription } })} />);

    await userEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await waitFor(() => expect(transcription.start).toHaveBeenCalled());
    audio.pushFrame(new Float32Array(16000).fill(0.2));

    await userEvent.click(await screen.findByRole("button", { name: /discard recording/i }));

    await waitFor(() => expect(transcription.abort).toHaveBeenCalledWith({ sessionId: "s2" }));
    expect(transcription.finish).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Task prompt" })).toHaveValue("");
    expect(audio.stoppedTracks).toBeGreaterThan(0);
  });

  it("keeps Send disabled until there is something to send", async () => {
    render(<Composer {...composerProps()} />);

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Task prompt" }), "hello");

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  });

  it("keeps the microphone out of the composer until a model is downloaded and selected", () => {
    const { container } = render(<Composer {...composerProps({ transcription: transcriptionState({ ready: false, selectedModelId: null }) })} />);

    const actions = container.querySelector(".composer-actions");
    expect(within(actions).queryByLabelText(/dictate/i)).toBeNull();
    expect(within(actions).queryByLabelText(/set up dictation/i)).toBeNull();
    // The rest of the composer is unaffected.
    expect(within(actions).getByLabelText("Send message")).toBeInTheDocument();
  });

  it("disables dictation along with the rest of a disabled composer", () => {
    render(<Composer {...composerProps({ disabled: true })} />);

    expect(screen.getByRole("button", { name: "Dictate a message" })).toBeDisabled();
  });
});
