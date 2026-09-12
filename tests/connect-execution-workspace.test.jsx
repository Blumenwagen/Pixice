import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionThreadWorkspace } from '../src/connect/execution-workspace.jsx';
import { normalizeCodexEvent } from '../electron/runtime/capability-adapter.mjs';

function createExecutionApi() {
  const listeners = new Set();
  const project = { id: 'project-b', displayName: 'Remote project', canonicalPath: '/remote/project' };
  const thread = { id: 'thread-b', name: 'Remote task', turns: [], status: { type: 'idle' } };
  const api = {
    remote: { hostId: 'host-b', name: 'Laptop B' },
    app: { bootstrap: vi.fn(async () => ({ projects: [project], models: [{ model: 'model-b', displayName: 'Model B', provider: 'codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], runtime: { state: 'ready', connected: true }, settings: {} })) },
    threads: {
      list: vi.fn(async () => ({ data: [] })),
      read: vi.fn(async () => ({ thread })) ,
      create: vi.fn(async () => ({ thread }))
    },
    turns: { start: vi.fn(async () => ({ turn: { id: 'turn-b', status: 'inProgress', items: [] } })), steer: vi.fn(), interrupt: vi.fn() },
    browser: { state: vi.fn(async () => ({ native: false, activeTabId: null, tabs: [] })), create: vi.fn(), close: vi.fn(), activate: vi.fn(), navigate: vi.fn(), history: vi.fn() },
    events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) },
    providers: { list: vi.fn(async () => [{ id: 'codex', connected: true, status: { state: 'ready' } }]) },
    questions: { respond: vi.fn() },
    approvals: { resolve: vi.fn() },
    elicitations: { respond: vi.fn() },
    files: { preview: vi.fn(), read: vi.fn(), write: vi.fn() }
  };
  return { api, project, emit: (event) => listeners.forEach((listener) => listener(event)) };
}

function mapStorageAdapter(storage = new Map()) {
  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; }
  };
}

afterEach(() => { delete window.pixice; });

describe('ExecutionThreadWorkspace', () => {
  it('creates and starts on the selected host and never adopts the local API', async () => {
    const { api, project } = createExecutionApi();
    const local = { turns: { start: vi.fn() } };
    window.pixice = local;
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" />);

    const prompt = await screen.findByLabelText('Task prompt');
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: 'Run on B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.threads.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b', model: 'model-b' })));
    await waitFor(() => expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b', threadId: 'thread-b', text: 'Run on B' })));
    expect(local.turns.start).not.toHaveBeenCalled();
  });

  it('applies raw normalized provider deltas, completion, child activity, and current questions', async () => {
    const { api, project, emit } = createExecutionApi();
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" />);
    const prompt = await screen.findByLabelText('Task prompt');
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: 'Stream on B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ text: 'Stream on B', threadId: 'thread-b' })));

    act(() => emit(normalizeCodexEvent({ method: 'item/agentMessage/delta', params: { threadId: 'thread-b', turnId: 'turn-b', itemId: 'agent-delta', delta: 'Streamed answer' } })));
    expect(await screen.findByText('Streamed answer')).toBeInTheDocument();
    act(() => emit(normalizeCodexEvent({ method: 'item/updated', params: {
      threadId: 'thread-b',
      item: { id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'thread-b', receiverThreadIds: ['child-b'], prompt: 'Check the remote files', agentsStates: { 'child-b': { status: 'running', message: 'Checking' } } }
    } })));
    act(() => emit(normalizeCodexEvent({ method: 'turn/completed', params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'completed', items: [{ id: 'agent-delta', type: 'agentMessage', text: 'Streamed answer', phase: 'final_answer' }] } } })));
    await waitFor(() => expect(screen.getByText('Streamed answer')).toBeInTheDocument());

    act(() => emit(normalizeCodexEvent({ method: 'item/requestUserInput', params: {
      requestId: 'question-1', requestGeneration: 4, projectId: project.id, threadId: 'thread-b',
      questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }]
    } })));
    fireEvent.click(await screen.findByRole('radio', { name: /Yes/ }));
    await waitFor(() => expect(api.questions.respond).toHaveBeenCalledWith({ requestId: 'question-1', requestGeneration: 4, action: 'answer', answers: { choice: 'Yes' } }), { timeout: 1000 });
  });

  it('preserves the actual active turn for steering without a response turn, then interrupts that turn', async () => {
    const { api, project, emit } = createExecutionApi();
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" />);
    const prompt = await screen.findByLabelText('Task prompt');
    await waitFor(() => expect(prompt).toBeEnabled());
    fireEvent.change(prompt, { target: { value: 'Start' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.turns.start).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Steer task' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Steer the active turn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer task' }));
    await waitFor(() => expect(api.turns.steer).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-b', text: 'Steer the active turn' })));
    expect(api.turns.steer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt task' }));
    await waitFor(() => expect(api.turns.interrupt).toHaveBeenCalledWith({ projectId: project.id, threadId: 'thread-b', turnId: 'turn-b' }));
    act(() => emit(normalizeCodexEvent({ method: 'turn/completed', params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'completed', items: [] } } })));
  });

  it('keeps an initial prompt and attachment when the target start response is lost', async () => {
    const { api, project } = createExecutionApi();
    api.turns.start.mockRejectedValueOnce(new Error('The connection could not be completed.'));
    const storage = new Map();
    const adapter = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key), key: () => null, get length() { return storage.size; } };
    const outcome = vi.fn();
    const attachment = { name: 'notes.png', type: 'image/png', size: 5, dataUrl: 'data:image/png;base64,AAAA' };
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Keep this task" initialAttachments={[attachment]} onInitialSubmissionOutcome={outcome} storage={adapter} originStorage={adapter} />);
    await waitFor(() => expect(outcome).toHaveBeenCalledWith(false), { timeout: 1500 });
    expect(api.threads.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id }));
    expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ text: 'Keep this task', attachments: [attachment] }));
    expect(storage.get('pixice.draft.host-b:project-b:new')).toBe('Keep this task');
    expect(storage.get('pixice.draft.host-b:project-b:thread-b')).toBe('Keep this task');
    expect(storage.get('pixice.draft.host-b:project-b:thread-b.attachments')).toContain('notes.png');
    expect(await screen.findByDisplayValue('Keep this task')).toBeInTheDocument();
  });

  it('clears every matching initial draft copy after acceptance', async () => {
    const { api, project } = createExecutionApi();
    const outcome = vi.fn();
    const storage = new Map();
    const adapter = mapStorageAdapter(storage);
    const attachment = { name: 'matching.txt', type: 'text/plain', size: 4, dataUrl: 'data:text/plain;base64,dGVzdA==' };
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Clear both copies" initialAttachments={[attachment]} onInitialSubmissionOutcome={outcome} storage={adapter} originStorage={adapter} />);

    await waitFor(() => expect(outcome).toHaveBeenCalledWith(true), { timeout: 1_500 });
    expect(storage.get('pixice.draft.host-b:project-b:new')).toBeUndefined();
    expect(storage.get('pixice.draft.host-b:project-b:new.attachments')).toBeUndefined();
    expect(storage.get('pixice.draft.host-b:project-b:thread-b')).toBeUndefined();
    expect(storage.get('pixice.draft.host-b:project-b:thread-b.attachments')).toBeUndefined();
  });

  it('retains a later differing thread draft while clearing the matching new copy', async () => {
    const { api, project } = createExecutionApi();
    let resolveStart;
    api.turns.start.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    const outcome = vi.fn();
    const storage = new Map();
    const adapter = mapStorageAdapter(storage);
    const attachment = { name: 'initial.txt', type: 'text/plain', size: 7, dataUrl: 'data:text/plain;base64,aW5pdGlhbA==' };
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Initial copy" initialAttachments={[attachment]} onInitialSubmissionOutcome={outcome} storage={adapter} originStorage={adapter} />);

    const newDraftKey = 'pixice.draft.host-b:project-b:new';
    const threadDraftKey = 'pixice.draft.host-b:project-b:thread-b';
    await waitFor(() => expect(api.threads.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(storage.get(threadDraftKey)).toBe('Initial copy'));
    expect(storage.get(newDraftKey)).toBe('Initial copy');
    storage.set(threadDraftKey, 'Later edit');
    storage.set(`${threadDraftKey}.attachments`, JSON.stringify([{ name: 'later.txt', type: 'text/plain', size: 5 }]));

    await act(async () => {
      resolveStart({ turn: { id: 'turn-b', status: 'inProgress', items: [] } });
      await Promise.resolve();
    });
    await waitFor(() => expect(outcome).toHaveBeenCalledWith(true), { timeout: 1_500 });
    expect(storage.get(newDraftKey)).toBeUndefined();
    expect(storage.get(`${newDraftKey}.attachments`)).toBeUndefined();
    expect(storage.get(threadDraftKey)).toBe('Later edit');
    expect(storage.get(`${threadDraftKey}.attachments`)).toContain('later.txt');
  });

  it('does not retry or lose an initial draft when thread creation has an uncertain response', async () => {
    const { api, project } = createExecutionApi();
    api.threads.create.mockRejectedValueOnce(new Error('The connection could not be completed.'));
    const outcome = vi.fn();
    const storage = new Map();
    const adapter = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key), key: () => null, get length() { return storage.size; } };
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Do not resend" onInitialSubmissionOutcome={outcome} storage={adapter} originStorage={adapter} />);
    await waitFor(() => expect(outcome).toHaveBeenCalledWith(false), { timeout: 1500 });
    expect(api.threads.create).toHaveBeenCalledOnce();
    expect(api.turns.start).not.toHaveBeenCalled();
    expect(storage.get('pixice.draft.host-b:project-b:new')).toBe('Do not resend');
    expect(await screen.findByDisplayValue('Do not resend')).toBeInTheDocument();
  });

  it('starts an attachment-only initial submission and reports acceptance', async () => {
    const { api, project } = createExecutionApi();
    const outcome = vi.fn();
    const attachment = { name: 'only.png', type: 'image/png', size: 5, dataUrl: 'data:image/png;base64,AAAA' };
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialAttachments={[attachment]} onInitialSubmissionOutcome={outcome} />);
    await waitFor(() => expect(outcome).toHaveBeenCalledWith(true), { timeout: 1500 });
    expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ text: '', attachments: [attachment] }));
  });

  it('keeps the target composer disabled when transport is online but its provider is disconnected', async () => {
    const { api, project } = createExecutionApi();
    api.providers.list.mockResolvedValueOnce([{ id: 'codex', connected: false, status: { state: 'unavailable' } }]);
    render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" />);
    const prompt = await screen.findByLabelText('Task prompt');
    await waitFor(() => expect(prompt).toBeDisabled());
    expect(api.turns.start).not.toHaveBeenCalled();
  });

  it('does not start a turn after the execution composer closes during thread creation', async () => {
    const { api, project } = createExecutionApi();
    let resolveCreate;
    api.threads.create.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const view = render(<ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Close while creating" />);
    await waitFor(() => expect(api.threads.create).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => { resolveCreate({ thread: { ...project, id: 'thread-after-close', turns: [] } }); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.turns.start).not.toHaveBeenCalled();
  });

  it('cancels initial submission when the user closes during thread creation', async () => {
    const { api, project } = createExecutionApi();
    let resolveCreate;
    api.threads.create.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    function Harness() {
      const [open, setOpen] = useState(true);
      return open
        ? <ExecutionThreadWorkspace api={api} hostId="host-b" hostLabel="Laptop B" projectId={project.id} project={project} originProjectId="project-a" initialPrompt="Close this task" onClose={() => setOpen(false)} />
        : null;
    }
    render(<Harness />);
    await waitFor(() => expect(api.threads.create).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close remote task' }));
    await act(async () => { resolveCreate({ thread: { ...project, id: 'thread-after-cancel', turns: [] } }); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.turns.start).not.toHaveBeenCalled();
  });
});
