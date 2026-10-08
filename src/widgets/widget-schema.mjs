import { z } from 'zod';
import { BOARD_FIELDS, WIDGET_CATALOG_VERSION, WIDGET_SOURCE_CATALOG, widgetCatalog } from './widget-catalog.mjs';

export const WIDGET_V2_LIMITS = Object.freeze({ bytes: 128 * 1024, nodes: 64, depth: 8, nodeProps: 16, nodeSlots: 8, nodeEvents: 8, sources: 8, derived: 24, actions: 32, stateKeys: 32, text: 500, rows: 500 });
const reservedKeys = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine((value) => !reservedKeys.has(value), 'Reserved key');
const label = z.string().trim().min(1).max(160);
const scalar = z.union([z.string().max(WIDGET_V2_LIMITS.text), z.number().finite(), z.boolean()]);
const path = z.string().max(160).regex(/^\/(user|view|data|derived)\/[A-Za-z][A-Za-z0-9_-]*$/).refine((value) => key.safeParse(value.split('/')[2]).success, 'Invalid or reserved path key');
const binding = z.object({ path }).strict();
const boardColumn = z.object({ field: z.enum(BOARD_FIELDS), label }).strict();
const chartRow = z.object({ label, value: z.number().finite() }).strict();
const checklistItem = z.object({ id: key, text: label, done: z.boolean() }).strict();
const prop = z.union([scalar, z.array(scalar).max(100), z.array(boardColumn).min(1).max(BOARD_FIELDS.length), z.array(chartRow).min(1).max(100), z.array(checklistItem).min(1).max(100), binding]);
const record = (schema, max) => z.record(key, schema).refine((value) => Object.keys(value).length <= max, `At most ${max} entries`);
const node = z.object({ id: key, type: key, props: record(prop, WIDGET_V2_LIMITS.nodeProps).default({}), slots: record(z.array(key).max(24), WIDGET_V2_LIMITS.nodeSlots).default({}), on: record(key, WIDGET_V2_LIMITS.nodeEvents).default({}) }).strict();
const source = z.object({ capability: z.enum(Object.keys(WIDGET_SOURCE_CATALOG)), arguments: z.object({}).strict(), refresh: z.enum(['manual', 'onOpen', 'event']) }).strict();
const operand = z.union([z.number().finite(), binding]);
const derived = z.discriminatedUnion('op', [
  z.object({ op: z.literal('multiply'), left: operand, right: operand }).strict(),
  z.object({ op: z.literal('add'), left: operand, right: operand }).strict(),
  z.object({ op: z.literal('subtract'), left: operand, right: operand }).strict(),
  z.object({ op: z.literal('divide'), left: operand, right: operand }).strict(),
  z.object({ op: z.literal('filterRows'), input: binding, field: z.enum(BOARD_FIELDS), equals: z.union([scalar, binding]) }).strict()
]);
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), target: path, value: scalar }).strict(),
  z.object({ type: z.literal('assign'), target: path, input: z.enum(['value', 'checked', 'number']) }).strict(),
  z.object({ type: z.literal('toggle'), target: path }).strict(),
  z.object({ type: z.literal('increment'), target: path, amount: z.number().finite().min(-1000000).max(1000000) }).strict(),
  z.object({ type: z.literal('refresh'), source: key }).strict()
]);
const schema = z.object({
  version: z.literal(2), catalogVersion: z.literal(WIDGET_CATALOG_VERSION), title: label,
  size: z.enum(['small', 'medium', 'large']).optional(), root: key,
  nodes: z.array(node).min(1).max(WIDGET_V2_LIMITS.nodes),
  state: z.object({ user: record(scalar, WIDGET_V2_LIMITS.stateKeys), view: record(scalar, WIDGET_V2_LIMITS.stateKeys) }).strict(),
  sources: record(source, WIDGET_V2_LIMITS.sources),
  derived: record(derived, WIDGET_V2_LIMITS.derived),
  actions: record(action, WIDGET_V2_LIMITS.actions)
}).strict();

function literalType(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return 'stringList';
    if (value.every((item) => item && typeof item === 'object' && 'field' in item)) return 'boardColumns';
    if (value.every((item) => item && typeof item === 'object' && 'value' in item)) return 'chartRows';
    if (value.every((item) => item && typeof item === 'object' && 'done' in item)) return 'checklistItems';
    return null;
  }
  return typeof value;
}

function validateDocument(doc, catalog, issues) {
  const fail = (message) => issues.push({ code: z.ZodIssueCode.custom, message, path: [] });
  const ids = new Set(doc.nodes.map((item) => item.id));
  if (ids.size !== doc.nodes.length) fail('Node IDs must be unique');
  if (!ids.has(doc.root)) fail('Root node does not exist');
  const nodeById = new Map(doc.nodes.map((item) => [item.id, item]));
  const types = new Map();
  for (const [scope, values] of Object.entries(doc.state)) for (const [name, value] of Object.entries(values)) types.set(`/${scope}/${name}`, typeof value);
  for (const [name, value] of Object.entries(doc.sources)) types.set(`/data/${name}`, WIDGET_SOURCE_CATALOG[value.capability].output);
  const resolving = new Set();
  function resolvePath(value) {
    const parsed = path.safeParse(value);
    if (!parsed.success) { fail(`Invalid binding path ${value}`); return null; }
    if (types.has(value)) return types.get(value);
    const [, scope, name] = value.split('/');
    if (scope !== 'derived' || !Object.hasOwn(doc.derived, name)) { fail(`Unknown binding path ${value}`); return null; }
    if (resolving.has(name)) { fail(`Derived binding cycle at ${name}`); return null; }
    resolving.add(name);
    const expression = doc.derived[name];
    let result;
    if (expression.op === 'filterRows') {
      const inputType = resolvePath(expression.input.path);
      const equalsType = typeof expression.equals === 'object' ? resolvePath(expression.equals.path) : typeof expression.equals;
      if (inputType !== 'boardRows' || equalsType !== 'string') fail(`Invalid filterRows expression ${name}`);
      result = 'boardRows';
    } else {
      const left = typeof expression.left === 'object' ? resolvePath(expression.left.path) : 'number';
      const right = typeof expression.right === 'object' ? resolvePath(expression.right.path) : 'number';
      if (left !== 'number' || right !== 'number') fail(`Arithmetic expression ${name} needs numbers`);
      if (expression.op === 'divide' && expression.right === 0) fail(`Division ${name} has a literal zero denominator`);
      result = 'number';
    }
    resolving.delete(name);
    types.set(value, result);
    return result;
  }
  for (const name of Object.keys(doc.derived)) resolvePath(`/derived/${name}`);
  const parents = new Map();
  for (const item of doc.nodes) {
    if (!Object.hasOwn(catalog, item.type)) { fail(`Unknown component ${item.type}`); continue; }
    const definition = catalog[item.type];
    for (const name of definition.required ?? []) if (!Object.hasOwn(item.props, name)) fail(`Missing prop ${item.id}.${name}`);
    for (const [name, value] of Object.entries(item.props)) {
      const expected = definition.props[name];
      if (!expected) { fail(`Unknown prop ${item.type}.${name}`); continue; }
      const actual = value && typeof value === 'object' && !Array.isArray(value) ? resolvePath(value.path) : literalType(value);
      if (actual !== expected) fail(`Prop ${item.id}.${name} needs ${expected}, got ${actual}`);
      if (expected === 'boardColumns' && Array.isArray(value) && new Set(value.map((column) => column.field)).size !== value.length) fail('Table columns must be unique');
    }
    if (item.type === 'NumberInput') {
      const valuePath = item.props.value?.path;
      const change = doc.actions[item.on.change];
      if (typeof valuePath !== 'string' || !valuePath.startsWith('/user/')) fail(`NumberInput ${item.id} needs a numeric /user binding`);
      if (change?.type !== 'assign' || change.input !== 'number' || change.target !== valuePath) fail(`NumberInput ${item.id} needs a matching numeric change action`);
    }
    for (const [slot, children] of Object.entries(item.slots)) {
      const rule = definition.slots[slot];
      if (!rule || children.length < rule.min || children.length > rule.max) fail(`Invalid slot ${item.id}.${slot}`);
      for (const child of children) {
        if (!ids.has(child)) fail(`Unknown child ${child}`);
        parents.set(child, (parents.get(child) ?? 0) + 1);
      }
    }
    for (const [slot, rule] of Object.entries(definition.slots)) if (rule.min && !Object.hasOwn(item.slots, slot)) fail(`Missing slot ${item.id}.${slot}`);
    for (const [event, actionId] of Object.entries(item.on)) {
      if (!definition.events.includes(event) || !Object.hasOwn(doc.actions, actionId)) { fail(`Invalid event action ${item.id}.${event}`); continue; }
      const command = doc.actions[actionId];
      if (command.type === 'assign' && (event !== 'change' || (command.input === 'checked' ? item.type !== 'Toggle' : command.input === 'number' ? item.type !== 'NumberInput' : !['Select', 'TextInput'].includes(item.type)))) fail(`Invalid assign input for ${item.id}.${event}`);
    }
  }
  if (parents.has(doc.root)) fail('Root cannot be a child');
  for (const id of ids) if (id !== doc.root && parents.get(id) !== 1) fail(`Node ${id} must have one parent`);
  const visited = new Set();
  function visit(id, depth, active) {
    if (depth > WIDGET_V2_LIMITS.depth) fail('Tree depth limit exceeded');
    if (active.has(id)) { fail(`Tree cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visited.add(id);
    const next = new Set(active); next.add(id);
    for (const children of Object.values(nodeById.get(id)?.slots ?? {})) for (const child of children) visit(child, depth + 1, next);
  }
  if (ids.has(doc.root)) visit(doc.root, 1, new Set());
  if (visited.size !== ids.size) fail('Tree has unreachable nodes');
  for (const [name, command] of Object.entries(doc.actions)) {
    if (command.type === 'refresh') { if (!Object.hasOwn(doc.sources, command.source)) fail(`Unknown action source ${name}`); continue; }
    if (!/^\/(user|view)\//.test(command.target)) { fail(`Action ${name} can only write user or view state`); continue; }
    const targetType = resolvePath(command.target);
    if (command.type === 'toggle' && targetType !== 'boolean') fail(`Toggle ${name} needs a boolean target`);
    if (command.type === 'increment' && targetType !== 'number') fail(`Increment ${name} needs a number target`);
    if (command.type === 'set' && targetType !== typeof command.value) fail(`Set ${name} value type mismatch`);
    if (command.type === 'assign' && targetType !== (command.input === 'checked' ? 'boolean' : command.input === 'number' ? 'number' : 'string')) fail(`Assign ${name} target type mismatch`);
    if (command.type === 'assign' && command.input === 'number' && !command.target.startsWith('/user/')) fail(`Numeric assign ${name} must target user state`);
  }
}

export function createWidgetV2Schema(catalog = widgetCatalog) {
  return schema.superRefine((doc, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (bytes > WIDGET_V2_LIMITS.bytes) context.addIssue({ code: z.ZodIssueCode.custom, message: `Document exceeds ${WIDGET_V2_LIMITS.bytes} UTF-8 bytes`, path: [] });
    const issues = [];
    validateDocument(doc, catalog, issues);
    for (const issue of issues) context.addIssue(issue);
  });
}
export const widgetV2Schema = createWidgetV2Schema();
export const parseWidgetV2 = (input) => widgetV2Schema.parse(input);
