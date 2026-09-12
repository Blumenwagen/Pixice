import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { ExecutionThreadWorkspace } from "../src/connect/execution-workspace.jsx";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const appProject = { id: "project-ui", displayName: "UI project", canonicalPath: "/work/ui" };
const appThread = { id: "thread-ui", name: "Rendered request task", turns: [], status: { type: "idle" } };
const appModels = [{
  model: "gpt-ui",
  displayName: "GPT UI",
  provider: "codex",
  isDefault: true,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }]
}];

function createAppApi({ interventions = () => Promise.resolve({ requests: [] }) } = {}) {
  const listeners = new Set();
  const api = {
    app: {
      bootstrap: vi.fn(async () => ({ projects: [appProject], models: appModels, runtime: { state: "ready", connected: true }, settings: {} })),
      saveSettings: vi.fn(async () => ({}))
    },
    runtime: { status: vi.fn(async () => ({ state: "ready", connected: true })) },
    models: { list: vi.fn(async () => appModels) },
    providers: { list: vi.fn(async () => []) },
    projects: { touch: vi.fn(async () => appProject) },
    threads: {
      list: vi.fn(async () => ({ data: [appThread] })),
      read: vi.fn(async () => ({ thread: appThread })),
      children: vi.fn(async () => ({ data: [] }))
    },
    tasks: {
      interventions: vi.fn(interventions),
      receipts: vi.fn(async () => []),
      receipt: vi.fn(async () => null)
    },
    review: { read: vi.fn(async () => ({ repository: null, files: [] })) },
    board: { list: vi.fn(async () => ({ data: [], phases: [] })) },
    proactivity: { list: vi.fn(async () => ({ data: [] })) },
    instruments: {
      list: vi.fn(async () => ({ data: [] })),
      tools: vi.fn(async () => ({ data: [] }))
    },
    browser: { state: vi.fn(async () => ({ native: false, activeTabId: null, tabs: [] })) },
    updates: { status: vi.fn(async () => ({})) },
    turns: { start: vi.fn(async () => ({})), steer: vi.fn(async () => ({})), interrupt: vi.fn(async () => ({})) },
    approvals: { resolve: vi.fn(async () => ({ ok: true })) },
    requests: { respond: vi.fn(async () => ({ ok: true })) },
    questions: { respond: vi.fn(async () => ({ ok: true })) },
    elicitations: { respond: vi.fn(async () => ({ ok: true })) },
    events: {
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    },
    emit(event) {
      listeners.forEach((listener) => listener(event));
    }
  };
  return api;
}

function mapStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
}

function createExecutionApi({ interventions = () => Promise.resolve({ requests: [] }) } = {}) {
  const listeners = new Set();
  const project = { id: "project-execution", displayName: "Execution project", canonicalPath: "/work/execution" };
  const thread = { id: "thread-execution", name: "Execution task", turns: [], status: { type: "idle" } };
  const model = { model: "model-execution", displayName: "Execution model", provider: "codex", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] };
  const api = {
    remote: { hostId: "host-execution", name: "Execution host" },
    app: { bootstrap: vi.fn(async () => ({ projects: [project], models: [model], runtime: { state: "ready", connected: true }, settings: {} })) },
    threads: {
      list: vi.fn(async () => ({ data: [] })),
      read: vi.fn(async () => ({ thread })),
      create: vi.fn(async () => ({ thread }))
    },
    tasks: { interventions: vi.fn(interventions), receipt: vi.fn(async () => null) },
    turns: { start: vi.fn(async () => ({ turn: { id: "turn-execution", status: "inProgress", items: [] } })), steer: vi.fn(), interrupt: vi.fn() },
    browser: { state: vi.fn(async () => ({ native: false, activeTabId: null, tabs: [] })) },
    providers: { list: vi.fn(async () => [{ id: "codex", connected: true, status: { state: "ready" } }]) },
    questions: { respond: vi.fn(async () => ({})) },
    approvals: { resolve: vi.fn(async () => ({})) },
    elicitations: { respond: vi.fn(async () => ({})) },
    files: { preview: vi.fn(), read: vi.fn(), write: vi.fn() },
    events: {
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    },
    emit(event) {
      listeners.forEach((listener) => listener(event));
    }
  };
  return { api, project, thread };
}

function appApproval({ generation, command }) {
  return {
    id: "approval-ui",
    requestGeneration: generation,
    projectId: appProject.id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: appThread.id, command }
  };
}

function executionApproval({ generation, command, projectId, threadId }) {
  return {
    id: "approval-execution",
    requestGeneration: generation,
    projectId,
    threadId,
    method: "item/commandExecution/requestApproval",
    params: { projectId, threadId, command }
  };
}

afterEach(() => {
  delete window.pixice;
  localStorage.clear();
});

describe("rendered request generation handling", () => {
  it("sends the captured App approval generation and keeps a replacement after the old reply settles", async () => {
    const user = userEvent.setup();
    const api = createAppApi();
    const oldReply = deferred();
    api.approvals.resolve.mockImplementation((payload) => payload.requestGeneration === 41 ? oldReply.promise : Promise.resolve({ ok: true }));
    window.pixice = api;
    render(<App />);
    await screen.findByText("Rendered request task");
    await waitFor(() => expect(document.querySelector(".pixice-app")).toHaveAttribute("data-active-thread-id", appThread.id));

    act(() => api.emit({ type: "AttentionRequired", payload: appApproval({ generation: 41, command: "old command" }) }));
    await user.click(await screen.findByRole("button", { name: "Approve", exact: true }));
    expect(api.approvals.resolve).toHaveBeenCalledWith({ requestId: "approval-ui", requestGeneration: 41, decision: "accept" });

    act(() => api.emit({ type: "AttentionRequired", payload: appApproval({ generation: 42, command: "new command" }) }));
    expect(await screen.findByText("new command")).toBeInTheDocument();
    await act(async () => { oldReply.resolve({ ok: true }); await oldReply.promise; });
    expect(screen.getByText("new command")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve", exact: true }));
    await waitFor(() => expect(api.approvals.resolve).toHaveBeenLastCalledWith({ requestId: "approval-ui", requestGeneration: 42, decision: "accept" }));
  });

  it("resets the real App question UI when a same-ID generation replaces it before delayed submit", async () => {
    const user = userEvent.setup();
    const api = createAppApi();
    window.pixice = api;
    render(<App />);
    await screen.findByText("Rendered request task");
    await waitFor(() => expect(document.querySelector(".pixice-app")).toHaveAttribute("data-active-thread-id", appThread.id));

    const question = (generation, label) => ({
      id: "question-ui",
      requestGeneration: generation,
      projectId: appProject.id,
      method: "item/tool/requestUserInput",
      params: {
        threadId: appThread.id,
        isBlocking: false,
        questions: [{ id: "choice", header: "Choice", question: "Which path?", options: [{ label }] }]
      }
    });
    act(() => api.emit({ type: "AttentionRequired", payload: question(41, "Old path") }));
    const oldPath = await screen.findByText("Old path");
    await user.click(oldPath);
    const submitAnswer = screen.getByRole("button", { name: "Submit answer" });
    expect(submitAnswer).toBeEnabled();
    act(() => {
      fireEvent.click(submitAnswer);
      api.emit({ type: "AttentionRequired", payload: question(42, "New path") });
    });
    expect((await screen.findByText("New path")).closest("button")).toHaveAttribute("aria-checked", "false");
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(api.questions.respond).not.toHaveBeenCalled();

    await user.click(screen.getByText("New path"));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => expect(api.questions.respond).toHaveBeenCalledWith({ requestId: "question-ui", action: "answer", answers: { choice: "New path" }, requestGeneration: 42 }));
  });

  it("does not let a stale App intervention read overwrite a newer event payload", async () => {
    const read = deferred();
    const api = createAppApi({ interventions: () => read.promise });
    window.pixice = api;
    render(<App />);
    await screen.findByText("Rendered request task");
    await waitFor(() => expect(document.querySelector(".pixice-app")).toHaveAttribute("data-active-thread-id", appThread.id));
    act(() => api.emit({ type: "AttentionRequired", payload: appApproval({ generation: 42, command: "event command" }) }));
    await act(async () => { read.resolve({ requests: [appApproval({ generation: 41, command: "stale read" })] }); await read.promise; });
    expect(await screen.findByText("event command")).toBeInTheDocument();
    expect(screen.queryByText("stale read")).not.toBeInTheDocument();
  });

  it.each([
    ["resolved", (api, request) => api.emit({ type: "AttentionResolved", payload: { requestId: request.id, requestGeneration: request.requestGeneration } })],
    ["empty reset", (api) => api.emit({ type: "AttentionReset", payload: { attention: [] } })]
  ])("does not resurrect an App request after a deferred initial snapshot and %s", async (_label, finishAttention) => {
    const read = deferred();
    const api = createAppApi({ interventions: () => read.promise });
    const request = appApproval({ generation: 41, command: "removed App request" });
    window.pixice = api;
    render(<App />);
    await screen.findByText("Rendered request task");
    await waitFor(() => expect(document.querySelector(".pixice-app")).toHaveAttribute("data-active-thread-id", appThread.id));

    act(() => api.emit({ type: "AttentionRequired", payload: request }));
    expect(await screen.findByText("removed App request")).toBeInTheDocument();
    act(() => finishAttention(api, request));
    expect(screen.queryByText("removed App request")).not.toBeInTheDocument();
    await act(async () => { read.resolve({ requests: [request] }); await read.promise; });
    expect(screen.queryByText("removed App request")).not.toBeInTheDocument();
  });
});

describe("execution request generation handling", () => {
  it("keeps a newer execution replacement after a deferred old reply and answers the replacement generation", async () => {
    const user = userEvent.setup();
    const { api, project, thread } = createExecutionApi();
    const oldReply = deferred();
    api.approvals.resolve.mockImplementation((payload) => payload.requestGeneration === 41 ? oldReply.promise : Promise.resolve({ ok: true }));
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    await waitFor(() => expect(screen.getByLabelText("Task prompt")).toBeEnabled());

    act(() => api.emit({ type: "AttentionRequired", payload: executionApproval({ generation: 41, command: "execution old", projectId: project.id, threadId: thread.id }) }));
    await user.click(await screen.findByRole("button", { name: "Approve", exact: true }));
    expect(api.approvals.resolve).toHaveBeenCalledWith({ requestId: "approval-execution", requestGeneration: 41, decision: "accept" });
    act(() => api.emit({ type: "AttentionRequired", payload: executionApproval({ generation: 42, command: "execution new", projectId: project.id, threadId: thread.id }) }));
    expect(await screen.findByText("execution new")).toBeInTheDocument();
    await act(async () => { oldReply.resolve({ ok: true }); await oldReply.promise; });
    expect(screen.getByText("execution new")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve", exact: true }));
    await waitFor(() => expect(api.approvals.resolve).toHaveBeenLastCalledWith({ requestId: "approval-execution", requestGeneration: 42, decision: "accept" }));
  });

  it("merges a newer event over a stale deferred intervention read", async () => {
    const read = deferred();
    const { api, project, thread } = createExecutionApi({ interventions: () => read.promise });
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    act(() => api.emit({ type: "AttentionRequired", payload: executionApproval({ generation: 42, command: "execution event", projectId: project.id, threadId: thread.id }) }));
    await act(async () => { read.resolve({ requests: [executionApproval({ generation: 41, command: "execution stale", projectId: project.id, threadId: thread.id })] }); await read.promise; });
    expect(await screen.findByText("execution event")).toBeInTheDocument();
    expect(screen.queryByText("execution stale")).not.toBeInTheDocument();
  });

  it("filters execution AttentionReset by both top-level and parameter project/thread scope", async () => {
    const { api, project, thread } = createExecutionApi();
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    await waitFor(() => expect(screen.getByLabelText("Task prompt")).toBeEnabled());
    const target = executionApproval({ generation: 1, command: "target reset", projectId: project.id, threadId: thread.id });
    const otherProjectTopLevel = { ...executionApproval({ generation: 2, command: "other project top", projectId: "project-other", threadId: thread.id }), params: { threadId: thread.id, projectId: project.id, command: "other project top" } };
    const otherProjectParams = { ...executionApproval({ generation: 3, command: "other project params", projectId: project.id, threadId: thread.id }), params: { threadId: thread.id, projectId: "project-other", command: "other project params" } };
    const otherThreadTopLevel = { ...executionApproval({ generation: 4, command: "other thread top", projectId: project.id, threadId: "thread-other" }), params: { threadId: thread.id, projectId: project.id, command: "other thread top" } };
    const otherThreadParams = { ...executionApproval({ generation: 5, command: "other thread params", projectId: project.id, threadId: thread.id }), params: { threadId: "thread-other", projectId: project.id, command: "other thread params" } };
    act(() => api.emit({ type: "AttentionReset", payload: { attention: [target, otherProjectTopLevel, otherProjectParams, otherThreadTopLevel, otherThreadParams] } }));
    expect(await screen.findByText("target reset")).toBeInTheDocument();
    expect(screen.queryByText("other project top")).not.toBeInTheDocument();
    expect(screen.queryByText("other project params")).not.toBeInTheDocument();
    expect(screen.queryByText("other thread top")).not.toBeInTheDocument();
    expect(screen.queryByText("other thread params")).not.toBeInTheDocument();
  });

  it("does not resurrect an execution request after a deferred initial snapshot and empty reset", async () => {
    const read = deferred();
    const { api, project, thread } = createExecutionApi({ interventions: () => read.promise });
    const request = executionApproval({ generation: 41, command: "removed execution request", projectId: project.id, threadId: thread.id });
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    act(() => api.emit({ type: "AttentionRequired", payload: request }));
    expect(await screen.findByText("removed execution request")).toBeInTheDocument();
    act(() => api.emit({ type: "AttentionReset", payload: { attention: [] } }));
    expect(screen.queryByText("removed execution request")).not.toBeInTheDocument();
    await act(async () => { read.resolve({ requests: [request] }); await read.promise; });
    expect(screen.queryByText("removed execution request")).not.toBeInTheDocument();
  });

  it("replaces execution attention on a successful fresh resync and preserves it when the read fails", async () => {
    const freshRead = deferred();
    const interventions = vi.fn()
      .mockResolvedValueOnce({ requests: [] })
      .mockImplementationOnce(() => freshRead.promise)
      .mockRejectedValueOnce(new Error("interventions unavailable"));
    const { api, project, thread } = createExecutionApi({ interventions });
    const request = executionApproval({ generation: 1, command: "resync request", projectId: project.id, threadId: thread.id });
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    await waitFor(() => expect(interventions).toHaveBeenCalledTimes(1));

    act(() => api.emit({ type: "AttentionRequired", payload: request }));
    expect(await screen.findByText("resync request")).toBeInTheDocument();
    act(() => api.emit({ type: "ApplicationResync", payload: {} }));
    await act(async () => { freshRead.resolve({ requests: [] }); await freshRead.promise; });
    expect(screen.queryByText("resync request")).not.toBeInTheDocument();

    act(() => api.emit({ type: "AttentionRequired", payload: request }));
    expect(await screen.findByText("resync request")).toBeInTheDocument();
    act(() => api.emit({ type: "ApplicationResync", payload: {} }));
    await waitFor(() => expect(interventions).toHaveBeenCalledTimes(3));
    expect(screen.getByText("resync request")).toBeInTheDocument();
  });

  it("renders and answers a provider question with numeric id zero and its generation", async () => {
    const user = userEvent.setup();
    const { api, project, thread } = createExecutionApi();
    render(<ExecutionThreadWorkspace api={api} hostId="host-execution" hostLabel="Execution host" projectId={project.id} project={project} threadId={thread.id} storage={mapStorage()} originStorage={mapStorage()} />);
    const question = {
      id: 0,
      requestId: 0,
      requestGeneration: 7,
      projectId: project.id,
      threadId: thread.id,
      method: "item/tool/requestUserInput",
      params: {
        threadId: thread.id,
        isBlocking: false,
        questions: [{ id: "choice", header: "Provider choice", question: "Which provider path?", options: [{ label: "Numeric path" }] }]
      }
    };
    act(() => api.emit({ type: "RuntimeEvent", payload: { payload: question } }));
    await user.click(await screen.findByText("Numeric path"));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => expect(api.questions.respond).toHaveBeenCalledWith({ requestId: 0, requestGeneration: 7, action: "answer", answers: { choice: "Numeric path" } }), { timeout: 1000 });
  });
});
