import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageQueuePanel } from "../src/components/MessageQueue.jsx";

afterEach(cleanup);

describe("message queue live updates", () => {
  it.each(["events", "legacy"])("subscribes through the %s API and ignores another thread's queue", async (kind) => {
    let listener;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((callback) => { listener = callback; return unsubscribe; });
    const api = { turns: { queueList: vi.fn(async () => ({ entries: [], held: false })) }, ...(kind === "events" ? { events: { subscribe } } : { onEvent: subscribe }) };
    const { unmount } = render(<MessageQueuePanel api={api} projectId="project" threadId="thread" />);
    await act(async () => {});
    act(() => listener({ type: "MessageQueueUpdated", payload: { projectId: "project", threadId: "other", entries: [{ id: "other", text: "Unrelated message" }] } }));
    expect(screen.queryByText("Unrelated message")).toBeNull();
    act(() => listener({ type: "MessageQueueUpdated", payload: { projectId: "project", threadId: "thread", held: true, entries: [{ id: "message", text: "Queued follow-up", source: "user", state: "queued" }] } }));
    expect(screen.getByText("Queued follow-up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume queue" })).toBeInTheDocument();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("uses only one subscription when both API shapes are exposed", async () => {
    const subscribe = vi.fn(() => () => {}), legacy = vi.fn(() => () => {});
    render(<MessageQueuePanel api={{ turns: { queueList: async () => ({ entries: [] }) }, events: { subscribe }, onEvent: legacy }} projectId="project" threadId="thread" />);
    await act(async () => {});
    expect(subscribe).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("does not replace a live update with an older list request that resolves later", async () => {
    let listener, resolveList;
    const queueList = new Promise((resolve) => { resolveList = resolve; });
    render(<MessageQueuePanel api={{ turns: { queueList: () => queueList }, events: { subscribe: (callback) => { listener = callback; return () => {}; } } }} projectId="project" threadId="thread" />);
    act(() => listener({ type: "MessageQueueUpdated", payload: { projectId: "project", threadId: "thread", held: false, entries: [{ id: "live", text: "Latest queued message", source: "user", state: "queued" }] } }));
    await act(async () => resolveList({ entries: [], held: false }));
    expect(screen.getByText("Latest queued message")).toBeInTheDocument();
  });

  it("edits inside the owning composer and exposes latest-edit / oldest-steer keyboard controls", async () => {
    const entries = [
      { id: 'oldest', text: 'First queued', source: 'user', state: 'queued', attachments: [{ name: 'one.png' }] },
      { id: 'latest', text: 'Last queued', source: 'user', state: 'queued' },
      { id: 'watch', text: 'Background update', source: 'watch', state: 'queued' }
    ];
    const onEdit = vi.fn(), onQueueChange = vi.fn();
    const controlRef = { current: null };
    const api = { turns: { queueList: vi.fn(async () => ({ entries, held: false })), queueSteer: vi.fn(async () => ({ entries: entries.slice(1), held: false })) } };
    render(<MessageQueuePanel api={api} projectId="project" threadId="thread" activeTurnId="turn" onEdit={onEdit} onQueueChange={onQueueChange} controlRef={controlRef} />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]));
    expect(onEdit).toHaveBeenLastCalledWith(entries[0]);
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull();
    await act(async () => controlRef.current.editLatest());
    expect(onEdit).toHaveBeenLastCalledWith(entries[1]);
    await act(async () => controlRef.current.promoteFirst());
    expect(api.turns.queueSteer).toHaveBeenCalledWith({ projectId: 'project', threadId: 'thread', id: 'oldest', turnId: 'turn' });
    expect(onQueueChange).toHaveBeenLastCalledWith(expect.objectContaining({ entries: entries.slice(1) }));
  });

  it("keeps the text-only fallback and does not silently promote uncertain dispatches", async () => {
    const entries = [{ id: 'editable', text: 'Original', source: 'user', state: 'queued' }];
    const api = { turns: { queueList: vi.fn(async () => ({ entries, held: false })), queueEdit: vi.fn(async () => ({ entries: [{ ...entries[0], text: 'Updated' }], held: false })) } };
    const controlRef = { current: null };
    const { rerender } = render(<MessageQueuePanel api={api} projectId="project" threadId="thread" controlRef={controlRef} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit queued message' }), { target: { value: 'Updated' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(api.turns.queueEdit).toHaveBeenCalledWith({ projectId: 'project', threadId: 'thread', id: 'editable', text: 'Updated' });
    const uncertainApi = { turns: { queueList: async () => ({ entries: [{ ...entries[0], state: 'uncertain' }], held: true }), queueSteer: vi.fn() } };
    rerender(<MessageQueuePanel api={uncertainApi} projectId="project" threadId="thread" activeTurnId="turn" controlRef={controlRef} />);
    await act(async () => {});
    expect(controlRef.current.promoteFirst()).toBe(false);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(uncertainApi.turns.queueSteer).not.toHaveBeenCalled();
  });
});
