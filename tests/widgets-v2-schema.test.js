import { describe, expect, test } from 'vitest';
import { widgetSpecSchema } from '../electron/backend/widgets.mjs';
import { widgetCandidateCatalog, widgetCatalog } from '../src/widgets/widget-catalog.mjs';
import { createWidgetV2Schema, parseWidgetV2, WIDGET_V2_LIMITS, widgetV2Schema } from '../src/widgets/widget-schema.mjs';

const bound = (path) => ({ path });
const base = (nodes, root = nodes[0].id) => ({ version: 2, catalogVersion: 1, title: 'Example', size: 'medium', root, nodes, state: { user: {}, view: {} }, sources: {}, derived: {}, actions: {} });

describe('proposed widget v2 contract', () => {
  test('validates a Board table and column filter using actual Board fields', () => {
    const doc = base([
      { id: 'root', type: 'Stack', props: { direction: 'vertical' }, slots: { children: ['filter', 'table'] } },
      { id: 'filter', type: 'Select', props: { label: 'Column', value: bound('/view/column'), options: ['backlog', 'ready', 'active', 'done'] }, on: { change: 'chooseColumn' } },
      { id: 'table', type: 'Table', props: { rows: bound('/derived/visible'), columns: [
        { field: 'title', label: 'Title' }, { field: 'description', label: 'Description' },
        { field: 'column', label: 'Column' }, { field: 'threadId', label: 'Thread' },
        { field: 'updatedAt', label: 'Updated' }, { field: 'id', label: 'ID' }
      ] } }
    ]);
    doc.state.view.column = 'active';
    doc.sources.board = { capability: 'board.list', arguments: {}, refresh: 'event' };
    doc.derived.visible = { op: 'filterRows', input: bound('/data/board'), field: 'column', equals: bound('/view/column') };
    doc.actions.chooseColumn = { type: 'assign', target: '/view/column', input: 'value' };
    expect(parseWidgetV2(doc)).toMatchObject(doc);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: doc.nodes.map((node) => node.id === 'table' ? { ...node, props: { ...node.props, columns: [{ field: 'owner', label: 'Owner' }] } } : node) }).success).toBe(false);
  });

  test('validates an editable budget calculator and its derived results', () => {
    const doc = base([
      { id: 'root', type: 'Card', props: { title: 'Project budget' }, slots: { body: ['people', 'hours', 'weeks', 'rate', 'totalHours', 'budget'] } },
      ...['people', 'hours', 'weeks', 'rate'].map((name) => ({ id: name, type: 'NumberInput', props: { label: name, value: bound(`/user/${name}`) }, on: { change: `edit${name}` } })),
      { id: 'totalHours', type: 'Number', props: { label: 'Total hours', value: bound('/derived/totalHours') } },
      { id: 'budget', type: 'Number', props: { label: 'Budget CHF', value: bound('/derived/budget') } }
    ]);
    doc.state.user = { people: 3, hours: 20, weeks: 4, rate: 100 };
    doc.derived.hoursPerPerson = { op: 'multiply', left: bound('/user/hours'), right: bound('/user/weeks') };
    doc.derived.totalHours = { op: 'multiply', left: bound('/user/people'), right: bound('/derived/hoursPerPerson') };
    doc.derived.budget = { op: 'multiply', left: bound('/derived/totalHours'), right: bound('/user/rate') };
    for (const name of ['people', 'hours', 'weeks', 'rate']) doc.actions[`edit${name}`] = { type: 'assign', target: `/user/${name}`, input: 'number' };
    expect(widgetV2Schema.safeParse(doc).success).toBe(true);
    const evaluate = (value) => {
      if (typeof value === 'number') return value;
      const [, scope, name] = value.path.split('/');
      if (scope === 'user') return doc.state.user[name];
      const expression = doc.derived[name];
      return expression.op === 'add' ? evaluate(expression.left) + evaluate(expression.right) : evaluate(expression.left) * evaluate(expression.right);
    };
    expect(evaluate(bound('/derived/totalHours'))).toBe(240);
    expect(evaluate(bound('/derived/budget'))).toBe(24000);
    const editPeople = doc.actions.editpeople;
    doc.state.user[editPeople.target.split('/')[2]] = 4;
    expect(evaluate(bound('/derived/totalHours'))).toBe(320);
    expect(evaluate(bound('/derived/budget'))).toBe(32000);
    expect(widgetV2Schema.safeParse({ ...doc, state: { ...doc.state, view: { people: 4 } }, actions: { ...doc.actions, editpeople: { type: 'assign', target: '/view/people', input: 'number' } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, actions: { ...doc.actions, editpeople: { type: 'assign', target: '/user/people', input: 'value' } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, state: { ...doc.state, view: { people: 4 } }, nodes: doc.nodes.map((node) => node.id === 'people' ? { ...node, props: { ...node.props, value: bound('/view/people') } } : node) }).success).toBe(false);
  });

  test('accepts prompt-sized arithmetic with nested derived steps and all four operators', () => {
    const doc = base([
      { id: 'root', type: 'Card', props: { title: 'Project estimate' }, slots: { body: ['hours', 'rate', 'fee', 'result'] } },
      ...['hours', 'rate', 'fee'].map((name) => ({ id: name, type: 'NumberInput', props: { label: name, value: bound(`/user/${name}`) }, on: { change: `edit${name}` } })),
      { id: 'result', type: 'Number', props: { label: 'Net per hour', value: bound('/derived/result') } }
    ]);
    doc.state.user = { hours: 8, rate: 100, fee: 50 };
    doc.derived.subtotal = { op: 'multiply', left: bound('/user/hours'), right: bound('/user/rate') };
    doc.derived.total = { op: 'add', left: bound('/derived/subtotal'), right: bound('/user/fee') };
    doc.derived.net = { op: 'subtract', left: bound('/derived/total'), right: 10 };
    doc.derived.result = { op: 'divide', left: bound('/derived/net'), right: bound('/user/hours') };
    for (const name of ['hours', 'rate', 'fee']) doc.actions[`edit${name}`] = { type: 'assign', target: `/user/${name}`, input: 'number' };
    expect(widgetV2Schema.safeParse(doc).success).toBe(true);
    expect(widgetV2Schema.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(true);
    const evaluate = (operand) => {
      if (typeof operand === 'number') return operand;
      const [, scope, name] = operand.path.split('/');
      if (scope === 'user') return doc.state.user[name];
      const { op, left, right } = doc.derived[name];
      const a = evaluate(left); const b = evaluate(right);
      return { add: () => a + b, subtract: () => a - b, multiply: () => a * b, divide: () => a / b }[op]();
    };
    expect(evaluate(bound('/derived/result'))).toBe(105);
    const literal = base([{ id: 'root', type: 'Number', props: { label: '12 + 8', value: bound('/derived/result') } }]);
    literal.derived.result = { op: 'add', left: 12, right: 8 };
    expect(widgetV2Schema.safeParse(literal).success).toBe(true);
  });

  test('rejects invalid arithmetic and literal zero division while allowing editable zero', () => {
    const doc = base([{ id: 'root', type: 'Number', props: { value: bound('/derived/result') } }]);
    doc.state.user = { divisor: 0, label: 'oops' };
    doc.derived.result = { op: 'divide', left: 12, right: bound('/user/divisor') };
    expect(widgetV2Schema.safeParse(doc).success).toBe(true);
    expect(widgetV2Schema.safeParse({ ...doc, derived: { result: { op: 'divide', left: 12, right: 0 } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, derived: { result: { op: 'subtract', left: bound('/user/label'), right: 2 } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, derived: { result: { op: 'divide', left: Number.POSITIVE_INFINITY, right: 2 } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, derived: { result: { op: 'divide', left: bound('/derived/result'), right: 2 } } }).success).toBe(false);
  });

  test('offers bounded candidate metadata for every catalog component', () => {
    expect(widgetCandidateCatalog).toHaveLength(Object.keys(widgetCatalog).length);
    for (const candidate of widgetCandidateCatalog) {
      expect(candidate.description.length).toBeGreaterThan(0);
      expect(candidate.description.length).toBeLessThanOrEqual(120);
      expect(candidate.cues.length).toBeLessThanOrEqual(4);
      expect(candidate.recipe).toBe('catalog-node-v1');
      expect(widgetCatalog[candidate.type]).toBeDefined();
    }
    expect(widgetCandidateCatalog.some((candidate) => candidate.type === 'NumberInput')).toBe(true);
  });

  test('rejects bad bindings, actions, cycles, and disconnected trees', () => {
    const doc = base([
      { id: 'root', type: 'Stack', slots: { children: ['value'] } },
      { id: 'value', type: 'Number', props: { value: bound('/user/count') }, on: {} }
    ]);
    doc.state.user.count = 1;
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [doc.nodes[0], { ...doc.nodes[1], props: { value: bound('/user/missing') } }] }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, actions: { bad: { type: 'increment', target: '/data/board', amount: 1 } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, actions: { bad: { type: 'refresh', source: 'missing' } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, actions: { bad: { type: 'toggle', target: '/user/count' } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [doc.nodes[0], { ...doc.nodes[1], props: {} }] }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [doc.nodes[0], { ...doc.nodes[1], type: 'constructor' }] }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [{ ...doc.nodes[0], slots: { children: ['value', 'root'] } }, doc.nodes[1]] }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [...doc.nodes, { id: 'orphan', type: 'Text', props: { text: 'x' } }] }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, derived: { one: { op: 'add', left: bound('/derived/two'), right: 1 }, two: { op: 'add', left: bound('/derived/one'), right: 1 } } }).success).toBe(false);
    expect(widgetV2Schema.safeParse({ ...doc, nodes: [...doc.nodes, ...Array.from({ length: 63 }, (_, index) => ({ id: `extra${index}`, type: 'Text', props: { text: 'x' } }))] }).success).toBe(false);
  });

  test('keeps v1 parsing independent of v2', () => {
    const v1 = { version: 1, title: 'Count', blocks: [{ type: 'counter', label: 'Count', value: 0, step: 1 }] };
    expect(widgetSpecSchema.parse(v1)).toEqual(v1);
    expect(widgetV2Schema.safeParse(v1).success).toBe(false);
    expect(widgetSpecSchema.safeParse(base([{ id: 'root', type: 'Text', props: { text: 'x' } }])).success).toBe(false);
  });

  test('rejects reserved keys in IDs, maps, and paths', () => {
    const doc = base([{ id: 'root', type: 'Number', props: { value: bound('/user/count') } }]);
    doc.state.user.count = 1;
    for (const reserved of ['constructor', 'prototype', 'toString', '__proto__']) {
      const withKey = (value) => Object.fromEntries([[reserved, value]]);
      expect(widgetV2Schema.safeParse({ ...doc, nodes: [{ ...doc.nodes[0], id: reserved }], root: reserved }).success).toBe(false);
      expect(widgetV2Schema.safeParse({ ...doc, state: { user: withKey(1), view: {} } }).success).toBe(false);
      expect(widgetV2Schema.safeParse({ ...doc, sources: withKey({ capability: 'board.list', arguments: {}, refresh: 'manual' }) }).success).toBe(false);
      expect(widgetV2Schema.safeParse({ ...doc, derived: withKey({ op: 'add', left: 1, right: 2 }) }).success).toBe(false);
      expect(widgetV2Schema.safeParse({ ...doc, actions: withKey({ type: 'set', target: '/user/count', value: 2 }) }).success).toBe(false);
      expect(widgetV2Schema.safeParse({ ...doc, nodes: [{ ...doc.nodes[0], props: { value: bound(`/user/${reserved}`) } }] }).success).toBe(false);
    }
  });

  test('caps serialized UTF-8 size while accepting a large valid tree', () => {
    const groups = Array.from({ length: 3 }, (_, group) => ({
      id: `group${group}`, type: 'Stack', slots: { children: Array.from({ length: 20 }, (_, index) => `item${group}_${index}`) }
    }));
    const items = Array.from({ length: 60 }, (_, index) => ({ id: `item${Math.floor(index / 20)}_${index % 20}`, type: 'Text', props: { text: '漢'.repeat(500) } }));
    const doc = base([{ id: 'root', type: 'Stack', slots: { children: groups.map((group) => group.id) } }, ...groups, ...items]);
    const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
    expect(bytes(doc)).toBeLessThan(WIDGET_V2_LIMITS.bytes);
    expect(widgetV2Schema.safeParse(doc).success).toBe(true);
    const oversized = { ...doc, state: { ...doc.state, user: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`note${index}`, '漢'.repeat(500)])) } };
    expect(bytes(oversized)).toBeGreaterThan(WIDGET_V2_LIMITS.bytes);
    const result = widgetV2Schema.safeParse(oversized);
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message.includes('UTF-8 bytes'))).toBe(true);
  });

  test('caps each node map even when a custom catalog allows every entry', () => {
    const makeKeys = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    const props = makeKeys('prop', WIDGET_V2_LIMITS.nodeProps + 1);
    const slots = makeKeys('slot', WIDGET_V2_LIMITS.nodeSlots + 1);
    const events = makeKeys('event', WIDGET_V2_LIMITS.nodeEvents + 1);
    const catalog = { Big: {
      props: Object.fromEntries(props.map((name) => [name, 'string'])),
      slots: Object.fromEntries(slots.map((name) => [name, { min: 0, max: 0 }])),
      events, required: []
    } };
    const customSchema = createWidgetV2Schema(catalog);
    const doc = base([{ id: 'root', type: 'Big' }]);
    doc.state.user.value = 'x';
    for (const event of events) doc.actions[event] = { type: 'set', target: '/user/value', value: 'x' };
    const parsed = (patch) => customSchema.safeParse({ ...doc, nodes: [{ ...doc.nodes[0], ...patch }] });
    expect(parsed({ props: Object.fromEntries(props.slice(0, -1).map((name) => [name, 'x'])) }).success).toBe(true);
    expect(parsed({ slots: Object.fromEntries(slots.slice(0, -1).map((name) => [name, []])) }).success).toBe(true);
    expect(parsed({ on: Object.fromEntries(events.slice(0, -1).map((name) => [name, name])) }).success).toBe(true);
    for (const [field, entries, value, cap] of [
      ['props', props, 'x', WIDGET_V2_LIMITS.nodeProps],
      ['slots', slots, [], WIDGET_V2_LIMITS.nodeSlots],
      ['on', events, null, WIDGET_V2_LIMITS.nodeEvents]
    ]) {
      const result = parsed({ [field]: Object.fromEntries(entries.map((name) => [name, value ?? name])) });
      expect(result.success).toBe(false);
      expect(result.error.issues.some((issue) => issue.message === `At most ${cap} entries`)).toBe(true);
    }
  });
});
