import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/App.jsx";
import { installPromptEditorGeometry, changeEditable, editableValue } from "./helpers/prompt-editor.js";
import { parseContextTokens } from "../src/composer/context.js";

const scope = { hostId: "host-a", deviceId: "device-a", projectId: "project-a" };
const model = { model: "model-a", displayName: "Model A", provider: "codex", supportedReasoningEfforts: [{ reasoningEffort: "high" }] };

function storageAdapter(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
}

function composerProps(overrides = {}) {
  return {
    disabled: false,
    busy: false,
    draftKey: "project-a:new",
    preserveDrafts: true,
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
    attachmentContext: { scope, hostId: scope.hostId, deviceId: scope.deviceId, projectId: scope.projectId },
    ...overrides
  };
}

function fileFrom(text, name) {
  const file = new File([text], name, { type: "text/plain" });
  const bytes = new TextEncoder().encode(text);
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: async () => bytes.slice().buffer });
  Object.defineProperty(file, "slice", { configurable: true, value: (start = 0, end = bytes.byteLength) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }) });
  return file;
}

beforeEach(() => {
  installPromptEditorGeometry();
  vi.restoreAllMocks();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Composer transfer UI", () => {
  it("copies an inline file reference into another task with its exact native file bytes", async () => {
    const storage = storageAdapter();
    const onSubmit = vi.fn(async () => true);
    const context = { scope, hostId: scope.hostId, deviceId: scope.deviceId, projectId: scope.projectId, threadId: "thread-a" };
    const view = render(<Composer {...composerProps({ storage, onSubmit, draftKey: "project-a:thread-a", attachmentContext: context })} />);
    const prompt = screen.getByRole("textbox", { name: "Task prompt" });
    changeEditable(prompt, { target: { value: "Use this source " } });
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [fileFrom("exact bytes", "source.txt")] } });
    await screen.findByRole("button", { name: "Remove source.txt" });
    const copied = new Map();
    const clipboardData = { files: [], items: [], setData: (type, value) => copied.set(type, value), getData: type => copied.get(type) || "" };
    act(() => { prompt.editor.commands.setTextSelection({ from: 1, to: prompt.editor.state.doc.content.size - 1 }); });
    fireEvent.copy(prompt, { clipboardData });

    view.rerender(<Composer {...composerProps({ storage, onSubmit, draftKey: "project-a:thread-b", attachmentContext: { ...context, threadId: "thread-b" } })} />);
    const receivingPrompt = screen.getByRole("textbox", { name: "Task prompt" });
    fireEvent.paste(receivingPrompt, { clipboardData });
    expect(await screen.findByRole("button", { name: "Remove source.txt" })).toBeInTheDocument();
    expect(editableValue(receivingPrompt)).toMatch(/^Use this source /);
    expect(parseContextTokens(editableValue(receivingPrompt)).some(token => token.label === "source.txt")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][2].attachments[0]).toMatchObject({ name: "source.txt", dataUrl: "data:text/plain;base64,ZXhhY3QgYnl0ZXM=" });
    expect(onSubmit.mock.calls[0][5].contextRecords).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", label: "source.txt" })]));
  });

  it("keeps a failed partial upload resumable and completes it only after an explicit send", async () => {
    const transferId = "11111111-1111-4111-8111-111111111111";
    const transferApi = {
      remote: {
        endpoint: "https://connect.example",
        hostId: scope.hostId,
        deviceId: scope.deviceId,
        token: "token",
        capabilities: { transfers: { uploads: true, downloads: false, limits: { maxFileBytes: 25 * 1024 * 1024, maxFiles: 10, maxProjectBytes: 250 * 1024 * 1024, chunkBytes: 2 } } }
      }
    };
    const record = (offset, state = "uploading") => ({ id: transferId, size: 4, offset, state });
    let remoteOffset = 0;
    let lostChunk = false;
    const fetchImpl = vi.fn(async (url) => {
      const route = new URL(url).pathname;
      if (route === "/api/connect/info") return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ protocol: 1, hostId: scope.hostId }) };
      if (route === "/api/connect/uploads") return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => record(0) };
      if (route.endsWith("/chunk")) {
        const offset = Number(new URL(url).searchParams.get("offset"));
        if (!lostChunk) {
          lostChunk = true;
          remoteOffset = 2;
          throw new TypeError("peer stopped");
        }
        remoteOffset = offset + 2;
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => record(remoteOffset) };
      }
      if (route === `/api/connect/uploads/${transferId}`) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => record(remoteOffset) };
      if (route.endsWith("/complete")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => record(4, "ready") };
      throw new Error(`unexpected route ${route}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const onSubmit = vi.fn(async () => true);
    const view = render(<Composer {...composerProps({
      onSubmit,
      attachmentContext: { api: transferApi, scope, hostId: scope.hostId, deviceId: scope.deviceId, projectId: scope.projectId }
    })} />);
    const prompt = screen.getByRole("textbox", { name: "Task prompt" });
    changeEditable(prompt, { target: { value: "Ship the upload" } });
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [fileFrom("abcd", "upload.txt")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove upload.txt" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByText("Upload failed")).toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(0);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/complete"))).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Resume upload" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume upload" })).not.toBeInTheDocument());
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/chunk"))).toHaveLength(2);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/complete"))).toHaveLength(0);
    expect(onSubmit).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/complete"))).toHaveLength(1);
    view.unmount();
  });

  it("keeps later text and files when the submitted snapshot resolves", async () => {
    let resolveSubmit;
    const onSubmit = vi.fn(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    const view = render(<Composer {...composerProps({ onSubmit })} />);
    const prompt = screen.getByRole("textbox", { name: "Task prompt" });

    changeEditable(prompt, { target: { value: "First message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("First message", [], expect.anything(), [], expect.anything(), expect.objectContaining({ adoptDraftKey: expect.any(Function) })));

    changeEditable(prompt, { target: { value: "Later edit" } });
    const file = new File(["new"], "later.txt", { type: "text/plain" });
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [file] } });

    await act(async () => { resolveSubmit(true); });
    expect(editableValue(prompt)).toMatch(/^Later edit/);
    expect(parseContextTokens(editableValue(prompt)).some(token => token.label === "later.txt")).toBe(true);
    expect(screen.getByRole("button", { name: "Remove later.txt" })).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("requires a matching file before restoring a staged upload id", async () => {
    const transferId = "11111111-1111-4111-8111-111111111111";
    const storage = storageAdapter({
      "pixice.draft.project-a:new.attachments": JSON.stringify([{
        id: "saved-file",
        name: "saved.txt",
        type: "text/plain",
        size: 4,
        sha256: "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5",
        transferId,
        transferState: "uploading",
        uploadOffset: 2,
        scope,
        scopeKey: "host-a:device-a:project-a"
      }])
    });
    const view = render(<Composer {...composerProps({ storage })} />);
    const reselect = await screen.findByRole("button", { name: "Reselect file" });
    const input = screen.getByLabelText("Choose saved.txt");

    fireEvent.change(input, { target: { files: [fileFrom("nope", "saved.txt")] } });
    await waitFor(() => expect(screen.getByText(/does not match the saved attachment/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reselect file" })).toBe(reselect);
    expect(storage.getItem("pixice.draft.project-a:new.attachments")).toContain(transferId);

    fireEvent.change(input, { target: { files: [fileFrom("same", "saved.txt")] } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reselect file" })).not.toBeInTheDocument());
    expect(view.container.querySelector('[aria-label="Attached files"]')).toHaveTextContent("saved.txt");
  });

  it("discards a delayed reselect result after the upload target changes", async () => {
    const transferId = "33333333-3333-4333-8333-333333333333";
    const storage = storageAdapter({
      "pixice.draft.project-a:new.attachments": JSON.stringify([{
        id: "saved-file",
        name: "saved.txt",
        type: "text/plain",
        size: 4,
        sha256: "a".repeat(64),
        transferId,
        transferState: "uploading",
        uploadOffset: 2,
        scope,
        scopeKey: "host-a:device-a:project-a"
      }])
    });
    const scopeB = { hostId: "host-b", deviceId: "device-b", projectId: "project-b" };
    let resolveHash;
    const delayedFile = fileFrom("old!", "saved.txt");
    Object.defineProperty(delayedFile, "arrayBuffer", { configurable: true, value: () => new Promise((resolve) => { resolveHash = resolve; }) });
    const view = render(<Composer {...composerProps({ storage, attachmentContext: { scope, hostId: scope.hostId, deviceId: scope.deviceId, projectId: scope.projectId } })} />);
    const input = await screen.findByLabelText("Choose saved.txt");
    fireEvent.change(input, { target: { files: [delayedFile] } });
    await waitFor(() => expect(screen.getByText(/Checking saved.txt/)).toBeInTheDocument());

    view.rerender(<Composer {...composerProps({ storage, attachmentContext: { scope: scopeB, hostId: scopeB.hostId, deviceId: scopeB.deviceId, projectId: scopeB.projectId } })} />);
    await waitFor(() => expect(storage.getItem("pixice.draft.project-a:new.attachments")).not.toContain(transferId));
    await act(async () => { resolveHash(new TextEncoder().encode("old!").buffer); });

    expect(await screen.findByRole("button", { name: "Reselect file" })).toBeInTheDocument();
    expect(screen.queryByText(/does not match the saved attachment/)).not.toBeInTheDocument();
    expect(storage.getItem("pixice.draft.project-a:new.attachments")).not.toContain(transferId);
  });

  it("preserves selected text and files when the upload target changes", async () => {
    const storage = storageAdapter();
    const onSubmit = vi.fn(async () => true);
    const scopeB = { hostId: "host-b", deviceId: "device-b", projectId: "project-b" };
    const view = render(<Composer {...composerProps({ storage, onSubmit, attachmentContext: { scope, hostId: scope.hostId, deviceId: scope.deviceId, projectId: scope.projectId } })} />);
    changeEditable(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Keep this draft" } });
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [fileFrom("keep", "keep.txt")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove keep.txt" })).toBeInTheDocument());

    view.rerender(<Composer {...composerProps({ storage, onSubmit, attachmentContext: { scope: scopeB, hostId: scopeB.hostId, deviceId: scopeB.deviceId, projectId: scopeB.projectId } })} />);
    await waitFor(() => expect(editableValue(screen.getByRole("textbox", { name: "Task prompt" }))).toMatch(/^Keep this draft/));
    expect(parseContextTokens(editableValue(screen.getByRole("textbox", { name: "Task prompt" }))).some(token => token.label === "keep.txt")).toBe(true);
    expect(screen.getByRole("button", { name: "Remove keep.txt" })).toBeInTheDocument();
    await waitFor(() => expect(storage.getItem("pixice.draft.project-a:new.attachments")).toContain("host-b:device-b:project-b"));

    // Files explicitly retained for the new target must remain sendable, with
    // their bytes and inline context agreeing on the new destination scope.
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][2].attachments[0]).toMatchObject({ name: "keep.txt", dataUrl: "data:text/plain;base64,a2VlcA==" });
    expect(onSubmit.mock.calls[0][5].contextRecords.find(record => record.label === "keep.txt").source).toMatchObject({ hostId: "host-b", projectId: "project-b" });
  });
});
