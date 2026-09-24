import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WidgetRenderer, isRenderableWidget } from '../src/widgets/widget-renderer.jsx';
import { dispatchWidgetAction, initialWidgetState } from '../src/widgets/widget-state.mjs';

const bind = (path) => ({ path });
const widget = (nodes, overrides = {}) => ({ id: 'v2-widget', projectId: 'project-a', revision: 1, spec: {
  version: 2, catalogVersion: 1, title: 'Live widget', size: 'large', root: 'root', nodes,
  state: { user: {}, view: {} }, sources: {}, derived: {}, actions: {}, ...overrides
} });

describe('v2 widget runtime', () => {
  it('edits a budget calculator and publishes only user state to its persistence seam', async () => {
    const names = ['people', 'hours', 'weeks', 'rate'];
    const record = widget([
      { id: 'root', type: 'Card', props: { title: 'Project budget' }, slots: { body: [...names, 'total', 'budget'] } },
      ...names.map((name) => ({ id: name, type: 'NumberInput', props: { label: name, value: bind(`/user/${name}`) }, on: { change: `edit${name}` } })),
      { id: 'total', type: 'Number', props: { label: 'Total hours', value: bind('/derived/totalHours') } },
      { id: 'budget', type: 'Number', props: { label: 'Budget CHF', value: bind('/derived/budget') } }
    ], {
      state: { user: { people: 3, hours: 20, weeks: 4, rate: 100 }, view: {} },
      derived: {
        hoursPerPerson: { op: 'multiply', left: bind('/user/hours'), right: bind('/user/weeks') },
        totalHours: { op: 'multiply', left: bind('/user/people'), right: bind('/derived/hoursPerPerson') },
        budget: { op: 'multiply', left: bind('/derived/totalHours'), right: bind('/user/rate') }
      },
      actions: Object.fromEntries(names.map((name) => [`edit${name}`, { type: 'assign', target: `/user/${name}`, input: 'number' }]))
    });
    const persist = vi.fn();
    render(<WidgetRenderer widget={record} onStateChange={persist} />);
    expect(screen.getByLabelText('Total hours value')).toHaveTextContent('240');
    expect(screen.getByLabelText('Budget CHF value')).toHaveTextContent('24’000');
    expect(screen.getByLabelText('Budget CHF value').compareDocumentPosition(screen.getByLabelText('Total hours value')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Budget CHF value').compareDocumentPosition(screen.getByRole('spinbutton', { name: 'people' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'people' }), { target: { value: '4' } });
    expect(screen.getByLabelText('Total hours value')).toHaveTextContent('320');
    expect(screen.getByLabelText('Budget CHF value')).toHaveTextContent('32’000');
    await waitFor(() => expect(persist).toHaveBeenCalledWith({ people: 4, hours: 20, weeks: 4, rate: 100 }, { widgetId: 'v2-widget', revision: 1 }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'people' }), { target: { value: 'Infinity' } });
    expect(screen.getByLabelText('Total hours value')).toHaveTextContent('320');
  });

  it('temporarily opens compact formula controls without changing the saved size', () => {
    const record = widget([
      { id: 'root', type: 'Card', props: { title: '12 + 8' }, slots: { body: ['left', 'right', 'expression', 'result'] } },
      { id: 'left', type: 'NumberInput', props: { label: 'Left', value: bind('/user/left') }, on: { change: 'editLeft' } },
      { id: 'right', type: 'NumberInput', props: { label: 'Right', value: bind('/user/right') }, on: { change: 'editRight' } },
      { id: 'expression', type: 'Text', props: { text: '12 + 8' } },
      { id: 'result', type: 'Number', props: { label: 'Result', value: bind('/derived/sum') } }
    ], {
      state: { user: { left: 12, right: 8 }, view: {} },
      derived: { sum: { op: 'add', left: bind('/user/left'), right: bind('/user/right') } },
      actions: {
        editLeft: { type: 'assign', target: '/user/left', input: 'number' },
        editRight: { type: 'assign', target: '/user/right', input: 'number' }
      }
    });
    const onSizeChange = vi.fn();
    const { rerender } = render(<WidgetRenderer widget={record} size="small" onSizeChange={onSizeChange} />);
    const article = screen.getByRole('article', { name: 'Live widget' });
    expect(article).toHaveAttribute('data-size', 'small');
    expect(article).toHaveAttribute('data-saved-size', 'small');
    expect(screen.getByLabelText('Result value')).toHaveTextContent('20');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Live widget' }));
    expect(article).toHaveAttribute('data-size', 'large');
    expect(article).toHaveAttribute('data-saved-size', 'small');
    expect(screen.getByRole('button', { name: 'Close Live widget' })).toHaveFocus();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Left' }), { target: { value: '13' } });
    expect(screen.getByLabelText('Result value')).toHaveTextContent('21');
    fireEvent.keyDown(article, { key: 'Escape' });
    expect(article).toHaveAttribute('data-size', 'small');
    expect(screen.getByRole('button', { name: 'Edit Live widget' })).toHaveFocus();
    expect(onSizeChange).not.toHaveBeenCalled();
    rerender(<WidgetRenderer widget={record} size="medium" onSizeChange={onSizeChange} />);
    expect(article).toHaveAttribute('data-size', 'medium');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Live widget' }));
    expect(article).toHaveAttribute('data-size', 'large');
    expect(article).toHaveAttribute('data-saved-size', 'medium');
    expect(onSizeChange).not.toHaveBeenCalled();
  });

  it('filters projected Board rows by a view selector without persisting view state', () => {
    const record = widget([
      { id: 'root', type: 'Stack', slots: { children: ['filter', 'table'] } },
      { id: 'filter', type: 'Select', props: { label: 'Column', value: bind('/view/column'), options: ['active', 'done'] }, on: { change: 'choose' } },
      { id: 'table', type: 'Table', props: { rows: bind('/derived/visible'), columns: [{ field: 'title', label: 'Title' }, { field: 'column', label: 'Column' }] } }
    ], {
      state: { user: {}, view: { column: 'active' } },
      sources: { board: { capability: 'board.list', arguments: {}, refresh: 'manual' } },
      derived: { visible: { op: 'filterRows', input: bind('/data/board'), field: 'column', equals: bind('/view/column') } },
      actions: { choose: { type: 'assign', target: '/view/column', input: 'value' } }
    });
    const persist = vi.fn();
    const { container } = render(<WidgetRenderer widget={record} sourceData={{ board: [{ id: '1', title: 'Active task', column: 'active', owner: 'invented' }, { id: '2', title: 'Done task', column: 'done' }] }} onStateChange={persist} />);
    const table = within(screen.getByRole('region', { name: 'Board table' }));
    expect(table.getByText('Active task')).toBeInTheDocument();
    expect(table.queryByText('Done task')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('invented');
    fireEvent.change(screen.getByRole('combobox', { name: 'Column' }), { target: { value: 'done' } });
    expect(table.getByText('Done task')).toBeInTheDocument();
    expect(table.queryByText('Active task')).not.toBeInTheDocument();
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps other catalog combinations in the same card grammar', () => {
    const record = widget([
      { id: 'root', type: 'Card', props: { title: 'Sprint pulse' }, slots: { body: ['summary', 'grid'] } },
      { id: 'summary', type: 'Text', props: { text: 'Two milestones ready' } },
      { id: 'grid', type: 'Grid', props: { columns: 2 }, slots: { children: ['steps', 'progress'] } },
      { id: 'steps', type: 'List', props: { items: ['Review', 'Ship'] } },
      { id: 'progress', type: 'Progress', props: { value: 2, max: 3 } }
    ]);
    const { container } = render(<WidgetRenderer widget={record} />);
    expect(container.querySelector('.widget-v2-card')).toHaveAttribute('data-composition', 'content');
    expect(screen.getByText('Two milestones ready')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveValue(2);
  });

  it('evaluates nested subtraction and division and shows zero division without losing editable state', async () => {
    const record = widget([
      { id: 'root', type: 'Card', props: { title: 'Unit calculator' }, slots: { body: ['left', 'right', 'divisor', 'result'] } },
      ...['left', 'right', 'divisor'].map((name) => ({ id: name, type: 'NumberInput', props: { label: name, value: bind(`/user/${name}`) }, on: { change: `edit${name}` } })),
      { id: 'result', type: 'Number', props: { label: 'Result', value: bind('/derived/quotient') } }
    ], {
      state: { user: { left: 10, right: 4, divisor: 2 }, view: {} },
      derived: {
        difference: { op: 'subtract', left: bind('/user/left'), right: bind('/user/right') },
        quotient: { op: 'divide', left: bind('/derived/difference'), right: bind('/user/divisor') }
      },
      actions: Object.fromEntries(['left', 'right', 'divisor'].map((name) => [`edit${name}`, { type: 'assign', target: `/user/${name}`, input: 'number' }]))
    });
    const persist = vi.fn();
    render(<WidgetRenderer widget={record} onStateChange={persist} />);
    expect(screen.getByLabelText('Result value')).toHaveTextContent('3');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'divisor' }), { target: { value: '0' } });
    expect(screen.getByLabelText('Result: Cannot divide by zero')).toHaveTextContent('—');
    expect(screen.getByText('Cannot divide by zero')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'divisor' })).toHaveValue(0);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'divisor' }), { target: { value: '3' } });
    expect(screen.getByLabelText('Result value')).toHaveTextContent('2');
    await waitFor(() => expect(persist).toHaveBeenLastCalledWith({ left: 10, right: 4, divisor: 3 }, { widgetId: 'v2-widget', revision: 1 }));
  });

  it('shows unavailable derived progress and utilities until a zero divisor recovers', () => {
    const record = widget([
      { id: 'root', type: 'Stack', slots: { children: ['divisor', 'valueProgress', 'maxProgress', 'overflowProgress', 'timer', 'counter'] } },
      { id: 'divisor', type: 'NumberInput', props: { label: 'Divisor', value: bind('/user/divisor'), max: bind('/derived/quotient') }, on: { change: 'editDivisor' } },
      { id: 'valueProgress', type: 'Progress', props: { value: bind('/derived/quotient'), max: 10 } },
      { id: 'maxProgress', type: 'Progress', props: { value: 0, max: bind('/derived/quotient') } },
      { id: 'overflowProgress', type: 'Progress', props: { value: bind('/derived/overflow'), max: 10 } },
      { id: 'timer', type: 'Timer', props: { label: 'Derived timer', durationSeconds: bind('/derived/quotient') } },
      { id: 'counter', type: 'Counter', props: { label: 'Derived count', value: bind('/derived/quotient'), step: 1 } }
    ], {
      state: { user: { divisor: 2 }, view: {} },
      derived: {
        quotient: { op: 'divide', left: 10, right: bind('/user/divisor') },
        overflow: { op: 'multiply', left: 1e308, right: 1e308 }
      },
      actions: { editDivisor: { type: 'assign', target: '/user/divisor', input: 'number' } }
    });
    const { container } = render(<WidgetRenderer widget={record} />);
    const progress = container.querySelectorAll('[data-node-type="Progress"]');
    expect(within(progress[0]).getByRole('progressbar')).toHaveValue(5);
    expect(within(progress[1]).getByRole('progressbar')).toHaveValue(0);
    expect(within(progress[2]).getByRole('status', { name: 'Progress: Value unavailable' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Divisor' }), { target: { value: '0' } });
    expect(within(progress[0]).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(progress[0]).getByRole('status', { name: 'Progress: Cannot divide by zero' })).toBeInTheDocument();
    expect(within(progress[1]).getByRole('status', { name: 'Progress: Cannot divide by zero' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Derived timer: Cannot divide by zero' })).toHaveTextContent('—');
    expect(screen.getByLabelText('Derived count: Cannot divide by zero')).toHaveTextContent('—');
    expect(screen.getByRole('status', { name: 'Divisor: input limit unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Divisor' })).toBeEnabled();
    expect(container).not.toHaveTextContent('NaN');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Divisor' }), { target: { value: '2' } });
    expect(within(progress[0]).getByRole('progressbar')).toHaveValue(5);
    expect(within(progress[1]).getByRole('progressbar')).toHaveValue(0);
    expect(screen.getByLabelText('Derived count value')).toHaveTextContent('5');
    expect(screen.queryByRole('status', { name: 'Divisor: input limit unavailable' })).not.toBeInTheDocument();
  });

  it('uses the result composition for a fixed expression without editable operands', () => {
    const record = widget([
      { id: 'root', type: 'Card', props: { title: 'Quick calculation' }, slots: { body: ['expression', 'result'] } },
      { id: 'expression', type: 'Text', props: { text: '8 + 5' } },
      { id: 'result', type: 'Number', props: { label: 'Result', value: bind('/derived/sum') } }
    ], { derived: { sum: { op: 'add', left: 8, right: 5 } } });
    const { container } = render(<WidgetRenderer widget={record} />);
    expect(container.querySelector('.widget-v2-card')).toHaveAttribute('data-composition', 'calculation');
    expect(screen.getByLabelText('Result value')).toHaveTextContent('13');
    expect(screen.getByText('8 + 5')).toBeInTheDocument();
  });

  it('keeps semantic Board cells and labels for a narrow visual row layout', () => {
    const record = widget([{ id: 'root', type: 'Table', props: { rows: bind('/data/board'), columns: [
      { field: 'title', label: 'Title' }, { field: 'description', label: 'Description' },
      { field: 'column', label: 'Column' }, { field: 'updatedAt', label: 'Updated' }
    ] } }], { sources: { board: { capability: 'board.list', arguments: {}, refresh: 'manual' } } });
    render(<WidgetRenderer widget={record} size="large" sourceData={{ board: [{ id: '1', title: 'Review plan', description: 'Check the latest version', column: 'active', updatedAt: '2026-09-23' }] }} />);
    const table = within(screen.getByRole('table'));
    expect(table.getAllByRole('columnheader')).toHaveLength(4);
    expect(table.getAllByRole('cell')).toHaveLength(4);
    expect(table.getByRole('cell', { name: '2026-09-23' })).toHaveAttribute('data-label', 'Updated');
    expect(table.getByRole('cell', { name: 'Review plan' })).toHaveAttribute('data-field', 'title');
  });

  it('loads event-refreshed Board data through the scoped project API', async () => {
    const record = widget([
      { id: 'root', type: 'Table', props: { rows: bind('/data/board'), columns: [{ field: 'title', label: 'Title' }] } }
    ], { sources: { board: { capability: 'board.list', arguments: {}, refresh: 'event' } } });
    const listeners = new Set();
    const api = {
      widgets: { readSource: vi.fn().mockResolvedValueOnce({ data: [{ id: '1', title: 'First', owner: 'hidden' }] }).mockResolvedValueOnce({ data: [{ id: '2', title: 'Second' }] }) },
      events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) }
    };
    render(<WidgetRenderer widget={record} api={api} />);
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    for (const listener of listeners) listener({ type: 'BoardUpdated', payload: { projectId: 'project-a' } });
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(api.widgets.readSource).toHaveBeenCalledWith({ projectId: 'project-a', widgetId: 'v2-widget', source: 'board' });
  });

  it('shows v2 timer and checklist data without controls that cannot update them', () => {
    const record = widget([
      { id: 'root', type: 'Stack', slots: { children: ['timer', 'checklist'] } },
      { id: 'timer', type: 'Timer', props: { label: 'Focus', durationSeconds: 60 }, on: { restart: 'flip' } },
      { id: 'checklist', type: 'Checklist', props: { label: 'Tasks', items: [{ id: 'first', text: 'Review plan', done: true }] }, on: { toggle: 'flip' } }
    ], { state: { user: {}, view: { flag: false } }, actions: { flip: { type: 'toggle', target: '/view/flag' } } });
    render(<WidgetRenderer widget={record} />);
    expect(screen.getByText('Focus')).toBeInTheDocument();
    expect(screen.getByText('Review plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Focus' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows a v2 Counter control only when its action updates the displayed value', () => {
    const record = widget([{ id: 'root', type: 'Counter', props: { label: 'Count', value: bind('/user/count'), step: 2 }, on: { increment: 'grow', decrement: 'shrink' } }], {
      state: { user: { count: 2, other: 0 }, view: {} },
      actions: { grow: { type: 'increment', target: '/user/count', amount: 2 }, shrink: { type: 'increment', target: '/user/other', amount: -2 } }
    });
    render(<WidgetRenderer widget={record} />);
    expect(screen.queryByRole('button', { name: 'Decrease Count' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Increase Count' }));
    expect(screen.getByLabelText('Count value')).toHaveTextContent('4');
  });

  it('disables controls with absent or mismatched actions instead of showing dead editors', () => {
    const record = widget([
      { id: 'root', type: 'Stack', slots: { children: ['button', 'textMissing', 'textWrong', 'selectMissing', 'selectWrong', 'toggleMissing', 'toggleWrong', 'toggleWrongFlip'] } },
      { id: 'button', type: 'Button', props: { label: 'Unwired button' } },
      { id: 'textMissing', type: 'TextInput', props: { label: 'Unwired text', value: bind('/user/name') } },
      { id: 'textWrong', type: 'TextInput', props: { label: 'Other text', value: bind('/user/name') }, on: { change: 'editShadow' } },
      { id: 'selectMissing', type: 'Select', props: { label: 'Unwired select', value: bind('/view/column'), options: ['active', 'done'] } },
      { id: 'selectWrong', type: 'Select', props: { label: 'Other select', value: bind('/view/column'), options: ['active', 'done'] }, on: { change: 'editOtherColumn' } },
      { id: 'toggleMissing', type: 'Toggle', props: { label: 'Unwired toggle', checked: bind('/user/enabled') } },
      { id: 'toggleWrong', type: 'Toggle', props: { label: 'Other toggle', checked: bind('/user/enabled') }, on: { change: 'editOtherFlag' } },
      { id: 'toggleWrongFlip', type: 'Toggle', props: { label: 'Other flip', checked: bind('/user/enabled') }, on: { change: 'flipOtherFlag' } }
    ], {
      state: { user: { name: 'Ada', shadow: '', enabled: true, otherFlag: false }, view: { column: 'active', otherColumn: 'done' } },
      actions: {
        editShadow: { type: 'assign', target: '/user/shadow', input: 'value' },
        editOtherColumn: { type: 'assign', target: '/view/otherColumn', input: 'value' },
        editOtherFlag: { type: 'assign', target: '/user/otherFlag', input: 'checked' },
        flipOtherFlag: { type: 'toggle', target: '/user/otherFlag' }
      }
    });
    expect(isRenderableWidget(record)).toBe(true);
    render(<WidgetRenderer widget={record} />);
    for (const name of ['Unwired button', 'Unwired text', 'Other text', 'Unwired select', 'Other select', 'Unwired toggle', 'Other toggle', 'Other flip']) {
      expect(screen.getByRole(name.includes('button') ? 'button' : name.includes('text') ? 'textbox' : name.includes('select') ? 'combobox' : 'checkbox', { name })).toBeDisabled();
    }
    expect(screen.getByRole('textbox', { name: 'Other text' })).toHaveValue('Ada');
    expect(screen.getByRole('combobox', { name: 'Other select' })).toHaveValue('active');
    expect(screen.getByRole('checkbox', { name: 'Other toggle' })).toBeChecked();
  });

  it('keeps matching editors and a refresh button active', async () => {
    const record = widget([
      { id: 'root', type: 'Stack', slots: { children: ['text', 'toggle', 'directToggle', 'refresh'] } },
      { id: 'text', type: 'TextInput', props: { label: 'Name', value: bind('/user/name') }, on: { change: 'editName' } },
      { id: 'toggle', type: 'Toggle', props: { label: 'Enabled', checked: bind('/user/enabled') }, on: { change: 'editEnabled' } },
      { id: 'directToggle', type: 'Toggle', props: { label: 'Direct toggle', checked: bind('/user/direct') }, on: { change: 'flipDirect' } },
      { id: 'refresh', type: 'Button', props: { label: 'Refresh Board' }, on: { press: 'reload' } }
    ], {
      state: { user: { name: 'Ada', enabled: false, direct: false }, view: {} },
      sources: { board: { capability: 'board.list', arguments: {}, refresh: 'manual' } },
      actions: {
        editName: { type: 'assign', target: '/user/name', input: 'value' },
        editEnabled: { type: 'assign', target: '/user/enabled', input: 'checked' },
        flipDirect: { type: 'toggle', target: '/user/direct' },
        reload: { type: 'refresh', source: 'board' }
      }
    });
    const readSource = vi.fn(async () => ({ data: [] }));
    render(<WidgetRenderer widget={record} onSourceRead={readSource} />);
    const name = screen.getByRole('textbox', { name: 'Name' });
    const enabled = screen.getByRole('checkbox', { name: 'Enabled' });
    const directToggle = screen.getByRole('checkbox', { name: 'Direct toggle' });
    const refresh = screen.getByRole('button', { name: 'Refresh Board' });
    expect(name).toBeEnabled();
    expect(enabled).toBeEnabled();
    expect(directToggle).toBeEnabled();
    expect(refresh).toBeEnabled();
    fireEvent.change(name, { target: { value: 'Bea' } });
    fireEvent.click(enabled);
    fireEvent.click(directToggle);
    fireEvent.click(refresh);
    expect(name).toHaveValue('Bea');
    expect(enabled).toBeChecked();
    expect(directToggle).toBeChecked();
    await waitFor(() => expect(readSource).toHaveBeenCalledWith(record.spec.sources.board, { widgetId: 'v2-widget', source: 'board' }));
  });

  it('rejects invalid documents and unsafe state changes', () => {
    const valid = widget([{ id: 'root', type: 'Number', props: { value: bind('/user/count') } }], { state: { user: { count: 1 }, view: {} }, actions: { grow: { type: 'increment', target: '/user/count', amount: 1 } } });
    expect(isRenderableWidget(valid)).toBe(true);
    expect(isRenderableWidget({ ...valid, spec: { ...valid.spec, nodes: [{ ...valid.spec.nodes[0], type: 'Unknown' }] } })).toBe(false);
    expect(isRenderableWidget({ ...valid, spec: { ...valid.spec, actions: { grow: { type: 'set', target: '/data/board', value: 1 } } } })).toBe(false);
    expect(initialWidgetState(valid.spec, { user: { count: Infinity } }).user.count).toBe(1);
    expect(dispatchWidgetAction(valid.spec, initialWidgetState(valid.spec), 'grow').user.count).toBe(2);
  });
});
