import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import WidgetShelf from '../src/components/WidgetShelf.jsx';

const bind = (path) => ({ path });
const projectId = 'focus-project';
const budget = { id: 'budget-widget', projectId, revision: 1, spec: {
  version: 2, catalogVersion: 1, title: 'Budget calculator', root: 'root',
  nodes: [
    { id: 'root', type: 'Stack', slots: { children: ['people', 'hours', 'total'] } },
    { id: 'people', type: 'NumberInput', props: { label: 'People', value: bind('/user/people'), min: 0 }, on: { change: 'editPeople' } },
    { id: 'hours', type: 'NumberInput', props: { label: 'Hours', value: bind('/user/hours'), min: 0 }, on: { change: 'editHours' } },
    { id: 'total', type: 'Number', props: { label: 'Total hours', value: bind('/derived/total') } }
  ], state: { user: { people: 2, hours: 10 }, view: {} }, sources: {},
  derived: { total: { op: 'multiply', left: bind('/user/people'), right: bind('/user/hours') } },
  actions: { editPeople: { type: 'assign', target: '/user/people', input: 'number' }, editHours: { type: 'assign', target: '/user/hours', input: 'number' } }
} };
const board = { id: 'board-widget', projectId, revision: 1, spec: {
  version: 2, catalogVersion: 1, title: 'Board tasks', root: 'root',
  nodes: [{ id: 'root', type: 'Table', props: { rows: bind('/data/board'), columns: [{ field: 'title', label: 'Title' }] } }],
  state: { user: {}, view: {} }, sources: { board: { capability: 'board.list', arguments: {}, refresh: 'event' } }, derived: {}, actions: {}
} };

it('persists sequential calculator edits with current revisions and reloads the saved state', async () => {
  let record = budget;
  const api = { widgets: {
    list: vi.fn(async () => ({ data: [record] })),
    updateUserState: vi.fn(async ({ userState, expectedRevision }) => {
      expect(expectedRevision).toBe(record.revision);
      record = { ...record, revision: record.revision + 1, spec: { ...record.spec, state: { ...record.spec.state, user: userState } } };
      return record;
    })
  } };
  const first = render(<WidgetShelf projectId={projectId} api={api} />);
  await screen.findByLabelText('People');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'People' }), { target: { value: '3' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Hours' }), { target: { value: '20' } });
  await waitFor(() => expect(api.widgets.updateUserState).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(record.revision).toBe(3));
  expect(record.spec.state.user).toEqual({ people: 3, hours: 20 });
  first.unmount();
  render(<WidgetShelf projectId={projectId} api={api} />);
  expect(await screen.findByLabelText('Total hours value')).toHaveTextContent('60');
});

it('reads Board rows through the widget source channel and refreshes for this project only', async () => {
  const listeners = new Set();
  let rows = [{ id: '1', title: 'First task' }];
  const api = {
    widgets: { list: vi.fn(async () => ({ data: [board] })), readSource: vi.fn(async () => ({ data: rows })) },
    events: { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }
  };
  render(<WidgetShelf projectId={projectId} api={api} />);
  expect(await screen.findByText('First task')).toBeInTheDocument();
  expect(api.widgets.readSource).toHaveBeenCalledWith({ projectId, widgetId: board.id, source: 'board' });
  rows = [{ id: '2', title: 'Updated task' }];
  act(() => { listeners.forEach((listener) => listener({ type: 'BoardUpdated', payload: { projectId: 'other-project' } })); });
  expect(api.widgets.readSource).toHaveBeenCalledTimes(1);
  act(() => { listeners.forEach((listener) => listener({ type: 'BoardUpdated', payload: { projectId } })); });
  await waitFor(() => expect(api.widgets.readSource).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Updated task')).toBeInTheDocument();
  expect(api.widgets.readSource).toHaveBeenCalledTimes(2);
});
