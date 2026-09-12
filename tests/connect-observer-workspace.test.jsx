import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCodexEvent } from '../electron/runtime/capability-adapter.mjs';
import { ObserverWorkspace } from '../src/connect/observer-workspace.jsx';

const projectA = { id: 'project-a', displayName: 'Project A', canonicalPath: '/remote/project-a' };
const projectB = { id: 'project-b', displayName: 'Project B', canonicalPath: '/remote/project-b' };

function makeThread(project, id, text) {
  return {
    id,
    projectId: project.id,
    name: `${project.displayName} task`,
    status: { type: 'idle' },
    turns: [
      { id: `${id}-prompt`, status: 'completed', items: [{ id: `${id}-prompt-message`, type: 'userMessage', text: 'Inspect this task.' }] },
      { id: `${id}-turn`, status: 'completed', items: [{ id: `${id}-message`, type: 'agentMessage', text }] }
    ]
  };
}

function createObserverApi({ projects = [projectA, projectB], threads = {}, currentThread, board = null, review = null } = {}) {
  const listeners = new Set();
  const state = {
    currentThread: currentThread ?? makeThread(projectB, 'thread-b', 'Target transcript'),
    board: board ?? { data: [{ id: 'board-1', title: 'Initial board item', owner: 'Mara' }], phases: [] },
    review: review ?? { files: [{ path: 'notes.md', plus: 1, minus: 0, content: 'Initial file preview' }] }
  };
  const api = {
    app: {
      bootstrap: vi.fn(async () => ({ projects, models: [], runtime: { state: 'ready', connected: true } }))
    },
    threads: {
      list: vi.fn(async ({ projectId }) => ({ data: threads[projectId] ?? [state.currentThread].filter((thread) => thread.projectId === projectId) })),
      read: vi.fn(async ({ projectId, threadId }) => {
        if (state.currentThread.projectId !== projectId || state.currentThread.id !== threadId) throw new Error('Task not found.');
        return { thread: state.currentThread, plan: [] };
      })
    },
    tasks: { receipt: vi.fn(async ({ projectId, threadId }) => ({ status: 'completed', projectId, threadId, revision: 1 })) },
    board: { list: vi.fn(async () => state.board) },
    review: { read: vi.fn(async () => state.review) },
    files: { preview: vi.fn(async ({ path }) => ({ path, kind: 'text', content: state.review.files.find((file) => file.path === path)?.content ?? '' })) },
    events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) }
  };
  return {
    api,
    state,
    emit(event) { for (const listener of [...listeners]) listener(event); }
  };
}

afterEach(() => { delete window.__pixiceConnectFixture; });

describe('ObserverWorkspace', () => {
  it('uses only explicit target props and never falls back when the requested task is invalid', async () => {
    expect(window.__pixiceConnectFixture).toBeUndefined();
    const target = makeThread(projectB, 'thread-target', 'Exact target transcript');
    const fallback = makeThread(projectB, 'thread-fallback', 'Unrelated fallback transcript');
    const { api } = createObserverApi({ threads: { [projectB.id]: [target, fallback] }, currentThread: target });
    render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectA.id, projectB.id]} initialProjectId={projectB.id} initialThreadId={target.id} />);

    await waitFor(() => expect(screen.getByLabelText('Observer project')).toHaveValue(projectB.id));
    await waitFor(() => expect(screen.getByLabelText('Observer task')).toHaveValue(target.id));
    await waitFor(() => expect(screen.getByText('Exact target transcript')).toBeInTheDocument());
    expect(api.threads.read).toHaveBeenCalledWith({ projectId: projectB.id, threadId: target.id });
    expect(api.threads.read).not.toHaveBeenCalledWith({ projectId: projectB.id, threadId: fallback.id });

    const invalid = createObserverApi({ threads: { [projectB.id]: [fallback] }, currentThread: fallback });
    render(<ObserverWorkspace api={invalid.api} hostId="observer-invalid" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId="missing-thread" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('requested task is not available'));
    expect(screen.getAllByLabelText('Observer task').at(-1)).toHaveValue('');
    expect(invalid.api.threads.read).not.toHaveBeenCalled();
  });

  it('bounds spaced activity refreshes and does not read receipts for message deltas', async () => {
    const { api, state, emit } = createObserverApi({ currentThread: makeThread(projectB, 'thread-b', 'Transcript 0') });
    render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId="thread-b" />);
    await waitFor(() => expect(screen.getByText('Transcript 0')).toBeInTheDocument());
    const initialThreadReads = api.threads.read.mock.calls.length;
    const initialReceiptReads = api.tasks.receipt.mock.calls.length;

    await act(async () => {
      for (let index = 1; index <= 30; index += 1) {
        state.currentThread = makeThread(projectB, 'thread-b', index === 30 ? 'Final transcript' : `Transcript ${index}`);
        emit(normalizeCodexEvent({
          method: 'item/agentMessage/delta',
          params: { projectId: projectB.id, threadId: 'thread-b', turnId: 'turn-b', itemId: 'message-b', delta: `token-${index}` }
        }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    await waitFor(() => expect(screen.getByText('Final transcript')).toBeInTheDocument(), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(api.threads.read.mock.calls.length - initialThreadReads).toBeLessThanOrEqual(5);
    expect(api.tasks.receipt).toHaveBeenCalledTimes(initialReceiptReads);
  });

  it('refreshes the displayed Board and rehydrates all scoped data after resync while preserving selection', async () => {
    const target = makeThread(projectB, 'thread-b', 'Before resync');
    const { api, state, emit } = createObserverApi({ currentThread: target });
    render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId={target.id} />);
    await waitFor(() => expect(screen.getByLabelText('Observer task')).toHaveValue(target.id));
    const initialBoardReads = api.board.list.mock.calls.length;
    state.board = { data: [{ id: 'board-2', title: 'Updated board item', owner: 'Nico' }], phases: [] };
    act(() => emit({ type: 'BoardUpdated', payload: { projectId: projectB.id } }));
    await waitFor(() => expect(screen.getByText('Updated board item')).toBeInTheDocument());
    expect(api.board.list.mock.calls.length).toBeGreaterThan(initialBoardReads);

    state.currentThread = makeThread(projectB, 'thread-b', 'After resync transcript');
    state.review = { files: [{ path: 'after.md', plus: 2, minus: 0, content: 'After resync file' }] };
    act(() => emit({ type: 'ApplicationResync', payload: { reason: 'reconnected' } }));
    await waitFor(() => expect(api.app.bootstrap).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('Observer project')).toHaveValue(projectB.id));
    await waitFor(() => expect(screen.getByLabelText('Observer task')).toHaveValue(target.id));
    await waitFor(() => expect(screen.getByText('After resync transcript')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('After resync file')).toBeInTheDocument());
  });

  it('keeps project refresh available without a selected task and recovers a failed bootstrap', async () => {
    const { api, state } = createObserverApi({ threads: { [projectB.id]: [] } });
    api.app.bootstrap.mockRejectedValueOnce(new Error('Bootstrap unavailable'));
    render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Bootstrap unavailable'));
    expect(screen.getByRole('button', { name: 'Refresh project' })).toBeEnabled();
    state.board = { data: [{ id: 'board-recovered', title: 'Recovered board item', owner: 'Mara' }], phases: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project' }));
    await waitFor(() => expect(screen.getByText('Recovered board item')).toBeInTheDocument());
    expect(api.app.bootstrap).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Refresh project' })).toBeInTheDocument();
  });

  it('does not bootstrap again when the equal allowed scope gets a new array identity', async () => {
    const { api } = createObserverApi({ currentThread: makeThread(projectB, 'thread-b', 'Stable transcript') });
    const view = render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId="thread-b" />);
    await waitFor(() => expect(screen.getByText('Stable transcript')).toBeInTheDocument());
    const bootstrapReads = api.app.bootstrap.mock.calls.length;
    view.rerender(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId="thread-b" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.app.bootstrap).toHaveBeenCalledTimes(bootstrapReads);
  });

  it('keeps the selected project file visible when switching tasks in that project', async () => {
    const target = makeThread(projectB, 'thread-target', 'Target transcript');
    const fallback = makeThread(projectB, 'thread-fallback', 'Fallback transcript');
    const { api, state } = createObserverApi({
      threads: { [projectB.id]: [target, fallback] },
      currentThread: target,
      review: { files: [{ path: 'first.md', plus: 1, minus: 0, content: 'First content' }, { path: 'second.md', plus: 2, minus: 0, content: 'Second content' }] }
    });
    render(<ObserverWorkspace api={api} hostId="observer" projectIds={[projectB.id]} initialProjectId={projectB.id} initialThreadId={target.id} />);
    await waitFor(() => expect(screen.getByText('Target transcript')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('option', { name: /second\.md/ }));
    await waitFor(() => expect(screen.getByText('Second content')).toBeInTheDocument());
    state.currentThread = fallback;
    fireEvent.change(screen.getByLabelText('Observer task'), { target: { value: fallback.id } });
    await waitFor(() => expect(screen.getByText('Fallback transcript')).toBeInTheDocument());
    expect(screen.getByText('Second content')).toBeInTheDocument();
  });
});
