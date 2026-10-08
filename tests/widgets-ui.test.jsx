import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WidgetShelf from '../src/components/WidgetShelf.jsx';
import { WidgetRenderer } from '../src/widgets/widget-renderer.jsx';

const itemId = 'f7241fba-8760-4de7-a31c-4b9b3a70c5a8';
const projectId = 'project-a';

function widget(blocks, overrides = {}) {
  return { id: 'widget-1', projectId, revision: 2, spec: { version: 1, title: 'Morning routine', blocks }, ...overrides };
}

function apiWith(initial) {
  const listeners = new Set();
  let record = initial;
  const api = {
    widgets: {
      list: vi.fn(async () => ({ data: [record] })),
      update: vi.fn(async ({ spec, expectedRevision }) => {
        if (expectedRevision !== record.revision) throw new Error('Widget has changed. Refresh it before saving.');
        record = { ...record, spec, revision: record.revision + 1 };
        return record;
      }),
      delete: vi.fn(async ({ widgetId }) => {
        if (widgetId !== record.id) throw new Error('Widget not found.');
        return record;
      })
    },
    events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) },
    emit: (payload) => listeners.forEach((listener) => listener({ type: 'WidgetUpdated', payload }))
  };
  return api;
}

function sizeStorage() {
  const values = new Map();
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key))
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('WidgetShelf', () => {
  it('loads project widgets, uses revision checked updates, and refreshes on a matching event', async () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 2 }]);
    const api = apiWith(initial);
    const onWidgetsChange = vi.fn();
    render(<WidgetShelf projectId={projectId} api={api} onWidgetsChange={onWidgetsChange} />);

    expect(await screen.findByLabelText('Reps value')).toHaveTextContent('4');
    fireEvent.click(screen.getByRole('button', { name: 'Increase Reps by 2' }));
    await waitFor(() => expect(screen.getByLabelText('Reps value')).toHaveTextContent('6'));
    expect(api.widgets.update).toHaveBeenCalledWith({ projectId, widgetId: 'widget-1', expectedRevision: 2, spec: { ...initial.spec, blocks: [{ type: 'counter', label: 'Reps', value: 6, step: 2 }] } });
    await waitFor(() => expect(onWidgetsChange).toHaveBeenCalledWith([expect.objectContaining({ revision: 3 })]));

    const calls = api.widgets.list.mock.calls.length;
    api.emit({ projectId: 'another-project', widgetId: 'widget-1', action: 'updated' });
    expect(api.widgets.list).toHaveBeenCalledTimes(calls);
    api.emit({ projectId, widgetId: 'widget-1', action: 'updated' });
    await waitFor(() => expect(api.widgets.list).toHaveBeenCalledTimes(calls + 1));
  });

  it('keeps both saved values when two widget edits resolve out of order', async () => {
    const records = [
      widget([{ type: 'counter', label: 'A', value: 0, step: 1 }], { id: 'a', spec: { version: 1, title: 'Counter A', blocks: [{ type: 'counter', label: 'A', value: 0, step: 1 }] } }),
      widget([{ type: 'counter', label: 'B', value: 0, step: 1 }], { id: 'b', spec: { version: 1, title: 'Counter B', blocks: [{ type: 'counter', label: 'B', value: 0, step: 1 }] } })
    ];
    const pending = new Map();
    const api = { widgets: {
      list: vi.fn(async () => ({ data: records })),
      update: vi.fn(({ widgetId, spec }) => new Promise((resolve) => pending.set(widgetId, () => {
        const index = records.findIndex((item) => item.id === widgetId);
        const saved = { ...records[index], revision: 3, spec };
        records[index] = saved;
        resolve(saved);
      })))
    } };
    const onWidgetsChange = vi.fn();
    render(<WidgetShelf projectId={projectId} api={api} onWidgetsChange={onWidgetsChange} />);
    await screen.findByLabelText('A value');
    fireEvent.click(screen.getByRole('button', { name: 'Increase A by 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase B by 1' }));
    expect(api.widgets.update).toHaveBeenCalledTimes(2);

    await act(async () => pending.get('b')());
    await act(async () => pending.get('a')());
    expect(screen.getByLabelText('A value')).toHaveTextContent('1');
    expect(screen.getByLabelText('B value')).toHaveTextContent('1');
    expect(records.map((item) => item.spec.blocks[0].value)).toEqual([1, 1]);
    expect(onWidgetsChange.mock.lastCall[0].map((item) => item.spec.blocks[0].value)).toEqual([1, 1]);
  });

  it('does not replace a completed edit with a list response started before that edit', async () => {
    const initial = widget([{ type: 'counter', label: 'A', value: 0, step: 1 }]);
    let resolveStaleList;
    const api = apiWith(initial);
    api.widgets.list.mockResolvedValueOnce({ data: [initial] }).mockImplementationOnce(() => new Promise((resolve) => { resolveStaleList = resolve; }));
    render(<WidgetShelf projectId={projectId} api={api} />);
    await screen.findByLabelText('A value');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh widgets' }));
    await waitFor(() => expect(resolveStaleList).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Increase A by 1' }));
    await waitFor(() => expect(screen.getByLabelText('A value')).toHaveTextContent('1'));
    await act(async () => resolveStaleList({ data: [initial] }));
    expect(screen.getByLabelText('A value')).toHaveTextContent('1');
  });

  it('preserves another widget edit when an overlapping delete completes', async () => {
    const records = [
      widget([{ type: 'counter', label: 'A', value: 0, step: 1 }], { id: 'a', spec: { version: 1, title: 'Counter A', blocks: [{ type: 'counter', label: 'A', value: 0, step: 1 }] } }),
      widget([{ type: 'counter', label: 'B', value: 0, step: 1 }], { id: 'b', spec: { version: 1, title: 'Counter B', blocks: [{ type: 'counter', label: 'B', value: 0, step: 1 }] } })
    ];
    let finishDelete;
    let finishUpdate;
    const api = { widgets: {
      list: vi.fn(async () => ({ data: records })),
      update: vi.fn(({ spec }) => new Promise((resolve) => { finishUpdate = () => resolve({ ...records[1], revision: 3, spec }); })),
      delete: vi.fn(() => new Promise((resolve) => { finishDelete = resolve; }))
    } };
    const onWidgetsChange = vi.fn();
    render(<WidgetShelf projectId={projectId} api={api} onWidgetsChange={onWidgetsChange} />);
    await screen.findByLabelText('A value');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Counter A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Counter A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase B by 1' }));
    await act(async () => finishUpdate());
    await act(async () => finishDelete());
    expect(screen.queryByRole('article', { name: 'Counter A' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('B value')).toHaveTextContent('1');
    expect(onWidgetsChange.mock.lastCall[0].map((item) => [item.id, item.spec.blocks[0].value])).toEqual([['b', 1]]);
  });

  it('keeps delete confirmation through a same-revision prop refresh and resets for a newer revision', () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 1 }]);
    const onDelete = vi.fn();
    const view = render(<WidgetRenderer widget={initial} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning routine' }));
    expect(screen.getByRole('button', { name: 'Confirm delete Morning routine' })).toBeInTheDocument();

    view.rerender(<WidgetRenderer widget={{ ...initial, spec: { ...initial.spec } }} onDelete={onDelete} />);
    expect(screen.getByRole('button', { name: 'Confirm delete Morning routine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    const saved = { ...initial, revision: initial.revision + 1, spec: { ...initial.spec, blocks: [{ type: 'counter', label: 'Reps', value: 7, step: 1 }] } };
    view.rerender(<WidgetRenderer widget={saved} onDelete={onDelete} />);
    expect(screen.queryByRole('button', { name: 'Confirm delete Morning routine' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reps value')).toHaveTextContent('7');
  });

  it('keeps a failed edit visible as an error and restores the saved value', async () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 1 }]);
    const api = apiWith(initial);
    api.widgets.update.mockRejectedValueOnce(new Error('Widget has changed. Refresh it before saving.'));
    render(<WidgetShelf projectId={projectId} api={api} />);
    await screen.findByLabelText('Reps value');
    fireEvent.click(screen.getByRole('button', { name: 'Increase Reps by 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Widget has changed');
    expect(screen.getByLabelText('Reps value')).toHaveTextContent('4');
  });

  it('uses supplied widgets and exposes a close action without changing parent layout', () => {
    const onClose = vi.fn();
    const api = apiWith(widget([{ type: 'counter', label: 'Reps', value: 0, step: 1 }]));
    const { container } = render(<div style={{ position: 'relative' }}><WidgetShelf projectId={projectId} widgets={[]} api={api} onClose={onClose} /></div>);
    expect(screen.getByText('No live widgets yet.')).toBeInTheDocument();
    expect(api.widgets.list).not.toHaveBeenCalled();
    expect(container.querySelector('.widget-shelf')).toBeInTheDocument();
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Live widgets' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close widgets' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.widgets.delete).not.toHaveBeenCalled();
  });

  it('confirms deletion, calls the project API, and updates supplied widget state', async () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 1 }]);
    const api = apiWith(initial);
    const onWidgetsChange = vi.fn();
    const storage = sizeStorage();
    render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} onWidgetsChange={onWidgetsChange} storage={storage} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change size of Morning routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning routine' }));
    expect(api.widgets.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.widgets.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Morning routine' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Morning routine' }));
    await waitFor(() => expect(api.widgets.delete).toHaveBeenCalledWith({ projectId, widgetId: initial.id }));
    await waitFor(() => expect(onWidgetsChange).toHaveBeenCalledWith([]));
    expect(storage.removeItem).toHaveBeenCalledWith(expect.stringContaining('project-a:widget-1'));
    expect(screen.queryByRole('article', { name: 'Morning routine' })).not.toBeInTheDocument();
  });

  it('shows a failed deletion and leaves the widget available', async () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 1 }]);
    const api = apiWith(initial);
    api.widgets.delete.mockRejectedValueOnce(new Error('Could not delete widget.'));
    render(<WidgetShelf projectId={projectId} api={api} />);
    await screen.findByRole('button', { name: 'Delete Morning routine' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Morning routine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete widget.');
    expect(screen.getByRole('button', { name: 'Delete Morning routine' })).toBeInTheDocument();
  });

  it('ignores a delayed list result from the previous project', async () => {
    const requests = new Map();
    const first = widget([{ type: 'counter', label: 'First', value: 1, step: 1 }]);
    const second = widget([{ type: 'counter', label: 'Second', value: 2, step: 1 }], { id: 'widget-2', projectId: 'project-b', spec: { version: 1, title: 'Second project', blocks: [{ type: 'counter', label: 'Second', value: 2, step: 1 }] } });
    const api = apiWith(first);
    api.widgets.list.mockImplementation(({ projectId: requestedProject }) => new Promise((resolve) => requests.set(requestedProject, resolve)));
    const view = render(<WidgetShelf projectId={projectId} api={api} />);
    expect(requests.has(projectId)).toBe(true);
    view.rerender(<WidgetShelf projectId="project-b" api={api} />);
    expect(requests.has('project-b')).toBe(true);
    await act(async () => requests.get('project-b')({ data: [second] }));
    expect(screen.getByText('Second project')).toBeInTheDocument();
    await act(async () => requests.get(projectId)({ data: [first] }));
    expect(screen.getByText('Second project')).toBeInTheDocument();
    expect(screen.queryByText('Morning routine')).not.toBeInTheDocument();
  });

  it('uses the requested initial size regardless of widget type or item count', () => {
    const timerBlock = { type: 'timer', label: 'Focus', durationSeconds: 60, endAt: '2026-09-23T10:01:00.000Z' };
    const listItems = [
      { id: itemId, text: 'First', done: false },
      { id: '37e02662-5cf0-4960-ae1a-304369a74cb5', text: 'Second', done: false },
      { id: '463073bc-9b86-4c99-8bf3-646a5ab97219', text: 'Third', done: false },
      { id: 'f7241fba-8760-4de7-a31c-4b9b3a70c5a9', text: 'Fourth', done: false },
      { id: 'f7241fba-8760-4de7-a31c-4b9b3a70c5aa', text: 'Fifth', done: false }
    ];
    const counterBlock = { type: 'counter', label: 'Count', value: 2, step: 1 };
    const timer = widget([timerBlock], { id: 'timer', spec: { version: 1, title: 'Focus', size: 'medium', blocks: [timerBlock] } });
    const list = widget([{ type: 'checklist', label: 'Tasks', items: listItems }], { id: 'list', spec: { version: 1, title: 'Tasks', size: 'large', blocks: [{ type: 'checklist', label: 'Tasks', items: listItems }] } });
    const counter = widget([counterBlock], { id: 'counter', spec: { version: 1, title: 'Count', size: 'small', blocks: [counterBlock] } });
    const { container } = render(<WidgetShelf projectId={projectId} widgets={[timer, list, counter]} api={apiWith(timer)} storage={sizeStorage()} />);
    expect([...container.querySelectorAll('.widget-shelf-widget')].map((element) => element.dataset.size)).toEqual(['medium', 'large', 'small']);
    expect(screen.getByRole('button', { name: 'Restart Focus' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Third' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Count by 1' })).toBeInTheDocument();
  });

  it('temporarily opens a seven-item small checklist, restores focus and size, then persists a manual medium size', async () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: `f7241fba-8760-4de7-a31c-4b9b3a70c5a${index}`, text: `Task ${index + 1}`, done: false }));
    const initial = widget([{ type: 'checklist', label: 'Tasks', items }], { spec: { version: 1, title: 'Tasks', size: 'small', blocks: [{ type: 'checklist', label: 'Tasks', items }] } });
    const api = apiWith(initial);
    const storage = sizeStorage();
    const first = render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} storage={storage} />);
    expect(first.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'small');
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Tasks complete' })).toHaveAttribute('aria-valuemax', '7');
    const openList = screen.getByRole('button', { name: 'Open Tasks list' });
    fireEvent.click(openList);
    expect(first.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'large');
    expect(screen.getAllByRole('checkbox')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Close Tasks list' })).toHaveFocus();
    expect(storage.setItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change size of Tasks' }));
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(screen.getByRole('group', { name: 'Size for Tasks' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Tasks list' }));
    expect(first.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'small');
    expect(screen.getByRole('button', { name: 'Open Tasks list' })).toHaveFocus();
    expect(storage.setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Tasks list' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Tasks list' }), { key: 'Escape' });
    expect(first.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'small');
    expect(screen.getByRole('button', { name: 'Open Tasks list' })).toHaveFocus();
    expect(storage.setItem).not.toHaveBeenCalled();

    first.unmount();
    const reopened = render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} storage={storage} />);
    expect(reopened.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'small');
    fireEvent.click(screen.getByRole('button', { name: 'Change size of Tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));
    expect(reopened.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'medium');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('+5 more')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Task 2' }));
    await waitFor(() => expect(api.widgets.update).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({ size: 'small' }) })));
    reopened.unmount();

    const second = render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} storage={storage} />);
    expect(second.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'medium');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(storage.setItem).toHaveBeenCalledWith(expect.stringContaining('project-a:widget-1'), 'medium');
  });

  it('keeps both counter actions usable at small size', async () => {
    const block = { type: 'counter', label: 'Water', value: 2, step: 1 };
    const initial = widget([block], { spec: { version: 1, title: 'Water', size: 'small', blocks: [block] } });
    render(<WidgetShelf projectId={projectId} widgets={[initial]} api={apiWith(initial)} storage={sizeStorage()} />);
    expect(screen.getByRole('article', { name: 'Water' })).toHaveAttribute('data-kind', 'counter');
    fireEvent.click(screen.getByRole('button', { name: 'Increase Water by 1' }));
    await waitFor(() => expect(screen.getByLabelText('Water value')).toHaveTextContent('3'));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Water by 1' }));
    await waitFor(() => expect(screen.getByLabelText('Water value')).toHaveTextContent('2'));
  });

  it('uses a readable compact numeral for a long small counter value', () => {
    const block = { type: 'counter', label: 'Total', value: -1000000, step: 1 };
    const initial = widget([block], { spec: { version: 1, title: 'Total', size: 'small', blocks: [block] } });
    render(<WidgetShelf projectId={projectId} widgets={[initial]} api={apiWith(initial)} storage={sizeStorage()} />);
    expect(screen.getByLabelText('Total value')).toHaveTextContent('-1,000,000');
    expect(screen.getByLabelText('Total value')).toHaveClass('widget-shelf-count-very-long');
  });

  it('defaults unsized widgets to medium without inspecting their content', () => {
    const counter = widget([{ type: 'counter', label: 'Count', value: 2, step: 1 }]);
    const { container } = render(<WidgetShelf projectId={projectId} widgets={[counter]} api={apiWith(counter)} storage={sizeStorage()} />);
    expect(container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'medium');
  });

  it('persists size per project and widget and keeps controls usable after resizing', () => {
    const initial = widget([{ type: 'counter', label: 'Reps', value: 4, step: 1 }]);
    const storage = sizeStorage();
    const api = apiWith(initial);
    const first = render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} storage={storage} />);
    const sizeButton = screen.getByRole('button', { name: 'Change size of Morning routine' });
    fireEvent.click(sizeButton);
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(screen.getByRole('group', { name: 'Size for Morning routine' }), { key: 'Escape' });
    expect(sizeButton).toHaveFocus();
    expect(screen.queryByRole('group', { name: 'Size for Morning routine' })).not.toBeInTheDocument();
    fireEvent.click(sizeButton);
    fireEvent.click(screen.getByRole('button', { name: 'Large' }));
    expect(first.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'large');
    expect(storage.setItem).toHaveBeenCalledWith(expect.stringContaining('project-a:widget-1'), 'large');
    fireEvent.click(screen.getByRole('button', { name: 'Increase Reps by 1' }));
    expect(screen.getByLabelText('Reps value')).toHaveTextContent('5');
    first.unmount();

    const second = render(<WidgetShelf projectId={projectId} widgets={[initial]} api={api} storage={storage} />);
    expect(second.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'large');
    second.rerender(<WidgetShelf projectId="project-b" widgets={[{ ...initial, projectId: 'project-b' }]} api={api} storage={storage} />);
    expect(second.container.querySelector('.widget-shelf-widget')).toHaveAttribute('data-size', 'medium');
  });
});

describe('WidgetRenderer', () => {
  it('toggles a checklist item while preserving the other blocks', async () => {
    const initial = widget([
      { type: 'checklist', label: 'Tasks', items: [{ id: itemId, text: 'Send report', done: false }] },
      { type: 'counter', label: 'Reps', value: 3, step: 1 }
    ]);
    let revision = 2;
    const onUpdate = vi.fn(async (spec) => ({ ...initial, spec, revision: ++revision }));
    render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    const strike = document.querySelector('.widget-shelf-wavy-line path');
    expect(strike).toHaveAttribute('data-done', 'false');
    expect(strike.closest('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send report' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ ...initial.spec, blocks: [
      { type: 'checklist', label: 'Tasks', items: [{ id: itemId, text: 'Send report', done: true }] },
      initial.spec.blocks[1]
    ] }, 2));
    expect(screen.getByRole('checkbox', { name: 'Send report' })).toBeChecked();
    expect(strike).toHaveAttribute('data-done', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send report' }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith({ ...initial.spec, blocks: [
      { type: 'checklist', label: 'Tasks', items: [{ id: itemId, text: 'Send report', done: false }] },
      initial.spec.blocks[1]
    ] }, 3));
    expect(screen.getByRole('checkbox', { name: 'Send report' })).not.toBeChecked();
    expect(strike).toHaveAttribute('data-done', 'false');
  });

  it('reverses a checklist strike when a failed save rolls back', async () => {
    const initial = widget([{ type: 'checklist', label: 'Tasks', items: [{ id: itemId, text: 'Send report', done: false }] }]);
    let rejectSave;
    const onUpdate = vi.fn(() => new Promise((_, reject) => { rejectSave = reject; }));
    render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Send report' });
    const strike = document.querySelector('.widget-shelf-wavy-line path');
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(strike).toHaveAttribute('data-done', 'true');
    await act(async () => rejectSave(new Error('Save failed')));
    expect(checkbox).not.toBeChecked();
    expect(strike).toHaveAttribute('data-done', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
  });

  it('renders the timer ring and restarts through a null end timestamp', async () => {
    const endAt = new Date(Date.now() + 65000).toISOString();
    const initial = widget([{ type: 'timer', label: 'Focus', durationSeconds: 120, endAt }]);
    const onUpdate = vi.fn(async (spec) => ({ ...initial, revision: 3, spec: { ...spec, blocks: [{ ...spec.blocks[0], endAt: new Date(Date.now() + 120000).toISOString() }] } }));
    render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    expect(screen.getByRole('timer', { name: /Focus:/ })).toHaveTextContent(/1:0[45]/);
    const timer = screen.getByRole('region', { name: 'Focus' });
    fireEvent.click(within(timer).getByRole('button', { name: 'Restart Focus' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ ...initial.spec, blocks: [{ ...initial.spec.blocks[0], endAt: null }] }, 2));
  });

  it('ticks a timer locally without saving every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const initial = widget([{ type: 'timer', label: 'Focus', durationSeconds: 3, endAt: '2026-09-23T10:00:03.000Z' }]);
    const onUpdate = vi.fn();
    render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    expect(screen.getByRole('timer', { name: 'Focus: 0:03' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('timer', { name: 'Focus: Time is up' })).toHaveTextContent('Done');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('uses the persisted end timestamp after remounting and offers no local pause', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const initial = widget([{ type: 'timer', label: 'Focus', durationSeconds: 60, endAt: '2026-09-23T10:01:00.000Z' }]);
    const onUpdate = vi.fn();
    const { container, unmount } = render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    expect(container.querySelectorAll('.widget-shelf-widget')).toHaveLength(1);
    expect(container.querySelector('.widget-shelf-card')).toBeNull();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole('timer', { name: 'Focus: 0:50' })).toBeInTheDocument();
    unmount();
    act(() => vi.advanceTimersByTime(20000));
    render(<WidgetRenderer widget={initial} onUpdate={onUpdate} />);
    expect(screen.getByRole('timer', { name: 'Focus: 0:30' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pause|Resume/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Focus' })).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('rejects malformed specs and prevents out of range counter updates', () => {
    const invalid = widget([{ type: 'counter', label: 'Unsafe', value: 0, step: 0 }]);
    const { rerender } = render(<WidgetRenderer widget={invalid} onUpdate={vi.fn()} />);
    expect(screen.getByText('This widget cannot be displayed.')).toBeInTheDocument();
    rerender(<WidgetRenderer widget={widget([{ type: 'counter', label: 'Limit', value: 1000000, step: 1 }])} onUpdate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Increase Limit by 1' })).toBeDisabled();
  });
});
