import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationButton } from "../src/components/DictationButton.jsx";
import { transcriptionDownloadOperation } from "../src/App.jsx";
import { OperationCapsuleStack } from "../src/components/OperationCapsule.jsx";
import { publishOperation } from "../src/state/operation-events.js";
import { APPLICATION_CAPABILITIES, APPLICATION_READ_OPERATIONS } from "../electron/connect/application-protocol.mjs";
import { CAPABILITIES, READ_OPERATIONS, REMOTE_EVENTS } from "../electron/connect/protocol.mjs";

function readyState(overrides = {}) {
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

const api = { transcription: {} };

// jsdom has no microphone, and the button correctly hides itself on a device
// that cannot record. These cases are about the model state, so recording
// capability is stubbed in and restored afterwards.
function withMicrophone(getUserMedia = vi.fn()) {
  const originalDevices = navigator.mediaDevices;
  const originalSecure = window.isSecureContext;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia, enumerateDevices: vi.fn(async () => []) }, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  return () => {
    Object.defineProperty(navigator, "mediaDevices", { value: originalDevices, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: originalSecure, configurable: true });
  };
}

describe("composer dictation button", () => {
  let restoreMicrophone = () => {};

  beforeEach(() => { restoreMicrophone = withMicrophone(); });
  afterEach(() => { restoreMicrophone(); });

  it("offers dictation when a model is ready", () => {
    render(<DictationButton api={api} state={readyState()} onTranscript={vi.fn()} />);

    expect(screen.getByRole("button", { name: /dictate a message/i })).toBeEnabled();
  });

  it("stays hidden until a model is downloaded and selected", () => {
    const { container } = render(<DictationButton api={api} state={readyState({ ready: false, selectedModelId: null })} onTranscript={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when a model is installed but none is selected", () => {
    const { container } = render(<DictationButton api={api} state={readyState({ ready: false })} onTranscript={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("hides itself when the host reports speech recognition is unavailable", () => {
    const { container } = render(<DictationButton api={api} state={readyState({ available: false, ready: false })} onTranscript={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("hides itself against a host that predates the feature", () => {
    const { container } = render(<DictationButton api={{}} state={null} onTranscript={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("stays out of the way while the composer is disabled", () => {
    render(<DictationButton api={api} state={readyState()} disabled onTranscript={vi.fn()} />);

    expect(screen.getByRole("button", { name: /dictate a message/i })).toBeDisabled();
  });

  it("reports a refused microphone instead of failing silently", async () => {
    const onError = vi.fn();
    restoreMicrophone();
    restoreMicrophone = withMicrophone(vi.fn(async () => { throw new Error("Permission denied"); }));

    render(<DictationButton api={api} state={readyState()} onTranscript={vi.fn()} onError={onError} />);
    await userEvent.click(screen.getByRole("button", { name: /dictate a message/i }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0].message).toMatch(/Permission denied/);
  });

  it("hides itself on a device that cannot record at all", () => {
    restoreMicrophone();
    restoreMicrophone = () => {};
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });

    const { container } = render(<DictationButton api={api} state={readyState()} onTranscript={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("model download capsule", () => {
  const progress = (overrides = {}) => ({ id: "parakeet-tdt-0.6b-v3-int8", label: "Parakeet TDT 0.6B v3", phase: "downloading", receivedBytes: 0, totalBytes: 400 * 1024 * 1024, error: null, ...overrides });

  it("reports download progress against the same capsule id", () => {
    const first = transcriptionDownloadOperation(progress({ receivedBytes: 100 * 1024 * 1024 }));
    const later = transcriptionDownloadOperation(progress({ receivedBytes: 300 * 1024 * 1024 }));

    expect(first.id).toBe(later.id);
    expect(first.progress).toBe(25);
    expect(later.progress).toBe(75);
    expect(later.label).toBe("Downloading Parakeet TDT 0.6B v3");
    expect(later.detail).toBe("300 MB of 400 MB");
    expect(later.tone).toBe("working");
  });

  it("cannot be dismissed while it is still downloading", () => {
    expect(transcriptionDownloadOperation(progress()).dismissible).toBe(false);
    expect(transcriptionDownloadOperation(progress({ phase: "extracting" })).dismissible).toBe(false);
  });

  it("shows indeterminate progress while unpacking", () => {
    const operation = transcriptionDownloadOperation(progress({ phase: "extracting" }));

    expect(operation.indeterminate).toBe(true);
    expect(operation.label).toBe("Unpacking Parakeet TDT 0.6B v3");
  });

  it("settles into a success capsule that dismisses itself", () => {
    const operation = transcriptionDownloadOperation(progress({ phase: "installed", receivedBytes: 400 * 1024 * 1024 }));

    expect(operation).toMatchObject({ tone: "success", progress: 100, status: "Model ready" });
    expect(operation.autoDismiss).toBeGreaterThan(0);
  });

  it("surfaces a failure with its reason and stays longer", () => {
    const operation = transcriptionDownloadOperation(progress({ phase: "failed", error: "checksum mismatch" }));

    expect(operation).toMatchObject({ tone: "error", detail: "checksum mismatch" });
    expect(operation.autoDismiss).toBeGreaterThan(4500);
  });

  it("removes the capsule when a download is cancelled", () => {
    expect(transcriptionDownloadOperation(progress({ phase: "cancelled" }))).toEqual({
      id: "transcription-model:parakeet-tdt-0.6b-v3-int8",
      dismiss: true
    });
  });

  it("offers a cancel action wired to the host", () => {
    const cancelInstall = vi.fn(async () => ({}));
    const operation = transcriptionDownloadOperation(progress(), { transcription: { cancelInstall } });

    expect(operation.actionLabel).toBe("Cancel");
    operation.onAction();

    expect(cancelInstall).toHaveBeenCalledWith({ modelId: "parakeet-tdt-0.6b-v3-int8" });
  });

  it("falls back to a generic name when the host sends no label", () => {
    expect(transcriptionDownloadOperation(progress({ label: undefined })).title).toBe("Speech model");
  });

  it("renders in the shared capsule stack and updates one capsule in place", async () => {
    render(<OperationCapsuleStack />);

    act(() => publishOperation(transcriptionDownloadOperation(progress({ receivedBytes: 100 * 1024 * 1024 }))));
    const bar = await screen.findByRole("progressbar", { name: /Parakeet TDT 0.6B v3 progress/i });
    expect(bar).toHaveAttribute("aria-valuenow", "25");

    act(() => publishOperation(transcriptionDownloadOperation(progress({ receivedBytes: 300 * 1024 * 1024 }))));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: /Parakeet TDT 0.6B v3 progress/i })).toHaveAttribute("aria-valuenow", "75"));
    // One download is one capsule, not one per progress event.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);

    act(() => publishOperation(transcriptionDownloadOperation(progress({ phase: "installed", receivedBytes: 400 * 1024 * 1024 }))));
    await waitFor(() => expect(screen.getByText(/Parakeet TDT 0.6B v3 ready/)).toBeInTheDocument());
  });

  it("clears the capsule from the stack when the download is cancelled", async () => {
    render(<OperationCapsuleStack />);

    act(() => publishOperation(transcriptionDownloadOperation(progress({ receivedBytes: 10 * 1024 * 1024 }))));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();

    act(() => publishOperation(transcriptionDownloadOperation(progress({ phase: "cancelled" }))));

    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  });
});

describe("transcription protocol registration", () => {
  it("exposes the transcription group to paired clients", () => {
    expect(CAPABILITIES.transcription).toBeDefined();
    expect(APPLICATION_CAPABILITIES.transcription).toEqual(CAPABILITIES.transcription);
  });

  it("treats only the state query as a read operation", () => {
    expect(READ_OPERATIONS.has("transcription.state")).toBe(true);
    expect(APPLICATION_READ_OPERATIONS.has("transcription.state")).toBe(true);
    for (const name of ["start", "chunk", "finish", "install", "remove", "select"]) {
      expect(READ_OPERATIONS.has(`transcription.${name}`)).toBe(false);
    }
  });

  it("forwards transcription events to remote clients", () => {
    expect(REMOTE_EVENTS.has("TranscriptionState")).toBe(true);
    expect(REMOTE_EVENTS.has("TranscriptionModelProgress")).toBe(true);
  });

  it("maps every transcription capability to a distinct channel", () => {
    const channels = Object.values(CAPABILITIES.transcription);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel.startsWith("transcription:")).toBe(true);
  });
});
