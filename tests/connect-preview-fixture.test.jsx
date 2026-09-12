import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { ConnectPreview } from "../src/connect-preview.jsx";
import { RemoteClient } from "../src/connect/client.js";
import { createWorkspaceStorage } from "../src/connect/execution-storage.js";

let fixture;

function dispatchFiles(input, files) {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

function makeFixtureFile(contents, name) {
  const bytes = new window.Uint8Array(new TextEncoder().encode(contents));
  const file = new window.File([bytes], name, { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: () => Promise.resolve(bytes.slice().buffer) });
  Object.defineProperty(file, "slice", {
    configurable: true,
    value: (start = 0, end = bytes.byteLength) => {
      const chunk = bytes.slice(start, end);
      return { size: chunk.byteLength, arrayBuffer: () => Promise.resolve(chunk.slice().buffer) };
    }
  });
  return file;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fixture = ConnectPreview.installFixture(window);
});

afterEach(() => {
  fixture?.restore();
  fixture = null;
  vi.unstubAllGlobals();
});

describe("Connect preview fixture integration", () => {
  it("mounts the real App, sends one target-project turn, and keeps observer writes blocked", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);
    await screen.findByRole("complementary", { name: "Primary navigation" });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const runOn = await screen.findByRole("combobox", { name: "Run on" });
    expect(runOn.closest(".composer")).toBeNull();
    expect(runOn.closest(".execution-preflight")).toBeInTheDocument();
    fireEvent.change(runOn, { target: { value: "host-b" } });
    const targetProject = await screen.findByRole("combobox", { name: "Target project" });
    fireEvent.change(targetProject, { target: { value: "project-b" } });
    const prompt = await screen.findByRole("textbox", { name: "Task prompt" });
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: "Run on B only" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(fixture.calls.some((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b")).toBe(true), { timeout: 5_000 });
    const targetThreads = [...fixture.hosts[ConnectPreview.fixtureHosts.operator].dynamicThreads.values()].filter((thread) => thread.projectId === "project-b");
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0].turns.at(-1).items[0].content).toEqual([{ type: "text", text: "Run on B only" }]);
    const execution = await screen.findByRole("region", { name: "Task on Beacon host" });
    await waitFor(() => expect(within(execution).getByText("Run on B only")).toBeInTheDocument());
    expect(execution.querySelector('[aria-label="Run on"]')).toBeNull();
    expect(within(execution).getByRole("status", { name: "Connected to Beacon host" })).toBeInTheDocument();
    expect(execution.querySelector(".app-toolbar .toolbar-actions")).toContainElement(within(execution).getByRole("status", { name: "Connected to Beacon host" }));
    expect(within(execution).getByRole("button", { name: "Close remote task" })).toBeInTheDocument();
    expect(within(execution).queryByText("Running on Beacon host")).not.toBeInTheDocument();
    expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.hostId === "local" && call.turnMutation)).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.turnMutation && call.projectId === "project-a")).toHaveLength(0);

    const observer = new RemoteClient({ id: "observer-c", endpoint: "https://observer-c.example", token: fixture.hosts[ConnectPreview.fixtureHosts.observer].token });
    await observer.connect();
    await expect(observer.api.turns.start({ projectId: "project-b", threadId: "thread-collision", text: "observer must not write" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    observer.close();
  });

  it("removes Run on after the first local send", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);
    await screen.findByRole("complementary", { name: "Primary navigation" });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const origin = document.querySelector(".origin-task-workspace");
    const prompt = within(origin).getByRole("textbox", { name: "Task prompt" });
    await waitFor(() => expect(prompt).toBeEnabled());
    expect(within(origin).getByRole("combobox", { name: "Run on" })).toBeInTheDocument();
    fireEvent.change(prompt, { target: { value: "Run locally" } });
    fireEvent.click(within(origin).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(fixture.calls.some((call) => call.hostId === "local" && call.operation === "turns.start" && call.projectId === "project-a")).toBe(true), { timeout: 5_000 });
    await waitFor(() => expect(origin.querySelector(".execution-preflight")).toBeNull());
    expect(origin.querySelector('[aria-label="Run on"]')).toBeNull();
  });

  it("clears accepted origin and target snapshots when a remote task closes and reopens", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);
    await screen.findByRole("complementary", { name: "Primary navigation" });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const runOn = await screen.findByRole("combobox", { name: "Run on" });
    fireEvent.change(runOn, { target: { value: "host-b" } });
    fireEvent.change(await screen.findByRole("combobox", { name: "Target project" }), { target: { value: "project-b" } });
    const origin = document.querySelector(".origin-task-workspace");
    const prompt = within(origin).getByRole("textbox", { name: "Task prompt" });
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: "Accepted remote task" } });
    dispatchFiles(origin.querySelector('input[type="file"][multiple]'), [makeFixtureFile("submitted content", "fixture-sample.txt")]);
    await waitFor(() => expect(within(origin).getByText("fixture-sample.txt")).toBeInTheDocument());
    fireEvent.click(within(origin).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b")).toHaveLength(1), { timeout: 5_000 });
    await waitFor(() => expect(within(origin).getByRole("textbox", { name: "Task prompt", hidden: true })).toHaveValue(""));
    await waitFor(() => expect(within(origin).queryByText("fixture-sample.txt")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close remote task" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Task on Beacon host" })).not.toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Environment: This device" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loom desktop" })).toHaveAttribute("aria-current", "true");
    expect(within(origin).getByRole("textbox", { name: "Task prompt", hidden: true })).toHaveValue("");
    expect(within(origin).queryByText("fixture-sample.txt")).not.toBeInTheDocument();

    const linked = (await screen.findAllByRole("button", { name: /Untitled fixture task/ }))
      .find((button) => button.title.includes("Beacon mobile"));
    expect(linked).toBeTruthy();
    fireEvent.click(linked);
    const reopened = await screen.findByRole("region", { name: "Task on Beacon host" });
    await waitFor(() => expect(within(reopened).getByRole("textbox", { name: "Task prompt" })).toHaveValue(""));
    expect(within(reopened).queryByText("fixture-sample.txt")).not.toBeInTheDocument();
  });

  it("keeps later origin text and files while the real preparation request is gated", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);
    await screen.findByRole("complementary", { name: "Primary navigation" });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Run on" }), { target: { value: "host-b" } });
    fireEvent.change(await screen.findByRole("combobox", { name: "Target project" }), { target: { value: "project-b" } });
    const origin = document.querySelector(".origin-task-workspace");
    const prompt = within(origin).getByRole("textbox", { name: "Task prompt" });
    const input = origin.querySelector('input[type="file"][multiple]');
    const submitted = makeFixtureFile("submitted content", "submitted.txt");
    const later = makeFixtureFile("later content", "later.txt");
    await waitFor(() => expect(prompt).toBeEnabled());
    dispatchFiles(input, [submitted]);
    fireEvent.change(prompt, { target: { value: "Submitted origin task" } });
    expect(origin.textContent).toContain("submitted.txt");

    const fixtureFetch = window.fetch;
    let releasePreparation;
    const preparationReleased = new Promise((resolve) => { releasePreparation = resolve; });
    window.fetch = (inputValue, init = {}) => {
      const url = new URL(typeof inputValue === "string" ? inputValue : inputValue?.url, window.location.href);
      if (url.hostname === "host-b.example" && url.pathname === "/api/connect/uploads" && init.method === "POST") {
        return preparationReleased.then(() => fixtureFetch(inputValue, init));
      }
      return fixtureFetch(inputValue, init);
    };
    fireEvent.click(within(origin).getByRole("button", { name: "Send message" }));
    expect(origin.textContent).toContain("submitted.txt");
    fireEvent.change(prompt, { target: { value: "Later origin task" } });
    dispatchFiles(input, [later]);
    await waitFor(() => expect(origin.textContent).toContain("later.txt"));

    await act(async () => { releasePreparation(); });
    await waitFor(() => expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b")).toHaveLength(1), { timeout: 5_000 });
    const originInput = input;
    expect(originInput).toBeDisabled();
    expect(origin).toHaveAttribute("aria-hidden", "true");
    expect(origin.querySelector(".composer")).toHaveAttribute("data-composer-drop-scope", "local");
    const execution = screen.getByRole("region", { name: "Task on Beacon host" });
    const executionComposer = execution.querySelector('.composer[data-composer-drop-scope="global"]');
    expect(executionComposer).toBeInTheDocument();
    await waitFor(() => {
      expect(within(execution).getByRole("textbox", { name: "Task prompt" })).toBeEnabled();
      expect(executionComposer).toHaveAttribute("data-question-present", "false");
    });
    fireEvent.drop(executionComposer, {
      dataTransfer: {
        files: [makeFixtureFile("execution-only", "execution-only.txt")],
        items: [{ kind: "file" }]
      }
    });
    await waitFor(() => expect(within(execution).getByText("execution-only.txt")).toBeInTheDocument());
    expect(within(origin).getByText("later.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close remote task" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Task on Beacon host" })).not.toBeInTheDocument());

    expect(within(origin).getByRole("textbox", { name: "Task prompt" })).toHaveValue("Later origin task");
    expect(within(origin).queryByText("submitted.txt")).not.toBeInTheDocument();
    expect(within(origin).getByText("later.txt")).toBeInTheDocument();
    const localStorage = createWorkspaceStorage("local");
    expect(localStorage.getItem("pixice.draft.project-a:new")).toBe("Later origin task");
    expect(JSON.parse(localStorage.getItem("pixice.draft.project-a:new.attachments"))).toEqual([
      expect.objectContaining({ name: "later.txt", size: later.size })
    ]);

    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const startsBeforeRetry = fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b");
    expect(startsBeforeRetry).toHaveLength(1);
    fireEvent.click(within(origin).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start" && call.projectId === "project-b")).toHaveLength(2), { timeout: 5_000 });
    await waitFor(() => expect([...host.uploads.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "later.txt", size: later.size, state: "ready", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    ])), { timeout: 5_000 });
    expect(within(origin).queryByRole("button", { name: "Reselect file" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close remote task" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Task on Beacon host" })).not.toBeInTheDocument());
  });

  it("keeps target prompt and file metadata after a lost create response without retrying on rerender", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);
    await screen.findByRole("complementary", { name: "Primary navigation" });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Run on" }), { target: { value: "host-b" } });
    fireEvent.change(await screen.findByRole("combobox", { name: "Target project" }), { target: { value: "project-b" } });
    const origin = document.querySelector(".origin-task-workspace");
    const prompt = within(origin).getByRole("textbox", { name: "Task prompt" });
    const input = origin.querySelector('input[type="file"][multiple]');
    const attachment = makeFixtureFile("create response payload", "create-lost.txt");
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: "Keep after lost create" } });
    dispatchFiles(input, [attachment]);
    await waitFor(() => expect(within(origin).getByText("create-lost.txt")).toBeInTheDocument());
    const send = within(origin).getByRole("button", { name: "Send message" });
    await waitFor(() => expect(send).toBeEnabled());
    fixture.hosts[ConnectPreview.fixtureHosts.operator].responseLoss = true;
    await act(async () => { fireEvent.click(send); });

    await waitFor(() => expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "threads.create" && call.projectId === "project-b")).toHaveLength(1), { timeout: 5_000 });
    const targetStorage = createWorkspaceStorage("host-b");
    await waitFor(() => expect(targetStorage.getItem("pixice.draft.host-b:project-b:new")).toBe("Keep after lost create"));
    expect(JSON.parse(targetStorage.getItem("pixice.draft.host-b:project-b:new.attachments"))).toEqual([
      expect.objectContaining({ name: "create-lost.txt", size: attachment.size })
    ]);
    expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "turns.start")).toHaveLength(0);

    fixture.toggleHost("host-b", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.calls.filter((call) => call.hostId === "host-b" && call.operation === "threads.create" && call.projectId === "project-b")).toHaveLength(1);
    expect(within(origin).getByRole("textbox", { name: "Task prompt", hidden: true })).toHaveValue("Keep after lost create");
    expect(within(origin).getByText("create-lost.txt")).toBeInTheDocument();
  });

  it("keeps an empty poll bounded and returns a Response-like json contract", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const pending = window.fetch(`https://host-b.example/api/connect/poll?cursor=1&instanceId=${host.instanceId}`, { headers: { Authorization: `Bearer ${host.token}` } });
    const started = Date.now();
    const result = await pending;
    const body = await result.json();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(body).toEqual({ events: [] });
    expect(host.waiters.size).toBe(0);

    const client = new RemoteClient({ id: host.id, endpoint: "https://host-b.example", token: host.token });
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    const pollsAfterConnect = fixture.pollRequests;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fixture.pollRequests - pollsAfterConnect).toBeLessThanOrEqual(4);
    fixture.toggleHost(host.id, { providerConnected: false });
    await waitFor(() => expect(events.some((event) => event.type === "RuntimeStatus")).toBe(true));
    expect(client.online).toBe(true);
    client.close();
  });

  it("preserves accepted response-loss status and resyncs after a host restart", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const client = new RemoteClient({ id: host.id, endpoint: "https://host-b.example", token: host.token });
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    host.responseLoss = true;
    const failure = await client.api.turns.start({ projectId: "project-b", threadId: "thread-collision", text: "accepted before response loss" }).catch((cause) => cause);
    expect(failure).toMatchObject({ uncertain: true });
    expect(await client.commandStatus(failure.commandId)).toMatchObject({ status: "completed", outcome: "completed" });
    fixture.restartHost(host.id);
    await waitFor(() => expect(events.some((event) => event.type === "ApplicationResync")).toBe(true), { timeout: 3_000 });
    client.close();
  });

  it("uses the same request id with new generations and rejects stale replies", async () => {
    fixture.emitAttention("approval");
    const host = fixture.hosts[ConnectPreview.fixtureHosts.local];
    const first = host.attention.get("fixture-approval-request");
    fixture.emitAttention("approval");
    const second = host.attention.get("fixture-approval-request");
    expect(second.requestId).toBe(first.requestId);
    expect(second.requestGeneration).toBe(first.requestGeneration + 1);
    await expect(fixture.localApi.approvals.resolve({ requestId: first.requestId, requestGeneration: first.requestGeneration, decision: "accept" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
