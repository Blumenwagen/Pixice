import { z } from 'zod';
import { BOARD_FIELDS, WIDGET_CATALOG_VERSION, widgetCandidateCatalog } from '../../src/widgets/widget-catalog.mjs';
import { widgetV2Schema } from '../../src/widgets/widget-schema.mjs';

const inputSchema = z.object({ projectId: z.string().min(1), text: z.string().trim().min(3).max(4000) }).strict();
const fieldDescriptions = Object.freeze({
  id: 'Board task identifier', title: 'Board task title', description: 'Board task description',
  column: 'Board column: backlog, ready, active, or done', threadId: 'Linked thread identifier', updatedAt: 'Last update timestamp'
});
const boardColumns = Object.freeze(['backlog', 'ready', 'active', 'done']);
const bind = (path) => ({ path });
const cleanTitle = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 120);
const node = (id, type, props = {}, on = {}) => ({ id, type, props, on });
const part = (id, domain, description, element, required = false, requires = []) => ({ id, domain, description, node: element, required, requires });
function requestedSize(text) {
  const matches = [...text.matchAll(/\b(small|medium|large)\s+(?:(?:interactive|editable|pinned|bar|progress|project|goal|board|budget|task|quick)\s+){0,2}(?:widget|chart|note|meter|calculator|table|tally|counter)\b|\b(?:widget|chart|note|meter|calculator|table|tally|counter)\s+(?:in\s+)?(small|medium|large)\b/gi)].map((match) => (match[1] ?? match[2]).toLowerCase());
  return new Set(matches).size > 1 ? null : matches[0];
}
function chartRows(text) {
  const start = text.match(/\b(?:bar\s+chart|chart)\s*:\s*([\s\S]+)/i);
  if (!start) return null;
  const items = start[1].split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  if (items.length < 2 || items.length > 8) return null;
  const rows = items.map((item) => {
    const match = item.match(/^([A-Za-z][A-Za-z0-9 _-]{0,39}?)\s*(?::|=)?\s+(\d+(?:\.\d+)?)$/);
    return match ? { label: match[1].trim(), value: Number(match[2]) } : null;
  });
  return rows.every((row) => row && row.label && Number.isFinite(row.value) && row.value <= 1e9) && new Set(rows.map((row) => row.label.toLowerCase())).size === rows.length ? rows : null;
}

const formulaPrefix = /^\s*(?:(?:(?:make|build|create)(?:\s+me)?\s+(?:a\s+)?)?(?:(?:small|medium|large)\s+)?calculator\s+for|calculator\s*:|formula\s*:|calculate\s*:?)\s*/i;
const invalidFormula = Object.freeze({ invalid: true });
const bareDateLike = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})\.?$/;
const numericToken = /^(?:\d+(?:\.\d*)?|\.\d+)/;
const identifierToken = /^[A-Za-z][A-Za-z0-9_]*/;
const reservedIdentifiers = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
function formulaRequest(text) {
  const pure = /^[\d.\s()+\-*/×÷−]+$/.test(text.trim()) && /[+\-*/×÷−]/.test(text);
  const prefix = text.match(formulaPrefix);
  if (!pure && !prefix) return undefined;
  if (pure && !prefix && bareDateLike.test(text.trim())) return null;
  const rest = pure ? text.trim() : text.slice(prefix[0].length).trim();
  const split = rest.match(/^(.*?)(?:\s+(?:with|where|defaults?\s*:)\s+(.+))?$/i);
  const expression = (split?.[1] ?? '').trim().replace(/[×]/g, '*').replace(/[÷]/g, '/').replace(/[−]/g, '-');
  if (!expression || expression.length > 160) return null;
  const defaults = new Map();
  if (split?.[2]) {
    const assignments = split[2].split(/[,;]\s*/);
    if (assignments.length > 8) return null;
    for (const assignment of assignments) {
      const match = assignment.trim().match(/^([A-Za-z][A-Za-z0-9_]{0,31})\s*(?:=|:)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
      if (!match || defaults.has(match[1])) return null;
      const value = Number(match[2]);
      if (!Number.isFinite(value) || Math.abs(value) > 1e9) return null;
      defaults.set(match[1], value);
    }
  }
  const tokens = [];
  for (let index = 0; index < expression.length;) {
    const tail = expression.slice(index);
    if (/^\s/.test(tail)) { index++; continue; }
    const numberMatch = tail.match(numericToken);
    const nameMatch = !numberMatch && tail.match(identifierToken);
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value) || Math.abs(value) > 1e9) return null;
      tokens.push({ type: 'number', value }); index += numberMatch[0].length;
    } else if (nameMatch) {
      if (nameMatch[0].length > 32 || reservedIdentifiers.has(nameMatch[0])) return null;
      tokens.push({ type: 'name', value: nameMatch[0] }); index += nameMatch[0].length;
    } else if (/^[()+\-*/]/.test(tail)) { tokens.push({ type: tail[0] }); index++; }
    else return null;
    if (tokens.length > 64) return null;
  }
  let position = 0;
  let operations = 0;
  const variables = new Set();
  const literalTokens = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
  function atom(depth) {
    if (depth > 8) throw new Error('Formula depth');
    const token = tokens[position++];
    if (!token) throw new Error('Missing operand');
    if (token.type === '+' || token.type === '-') {
      const right = atom(depth + 1);
      if (token.type === '+') return right;
      operations++;
      return { type: 'binary', op: 'subtract', left: { type: 'number', value: 0 }, right };
    }
    if (token.type === '(') {
      const value = expressionTree(0, depth + 1);
      if (tokens[position++]?.type !== ')') throw new Error('Unclosed group');
      return value;
    }
    if (token.type === 'number') { const value = { ...token, index: literalTokens.length }; literalTokens.push(value); return value; }
    if (token.type === 'name') { variables.add(token.value); return token; }
    throw new Error('Unexpected token');
  }
  function expressionTree(minimum, depth) {
    let left = atom(depth);
    while (position < tokens.length && precedence[tokens[position].type] >= minimum) {
      const symbol = tokens[position++].type;
      const right = expressionTree(precedence[symbol] + 1, depth + 1);
      operations++;
      left = { type: 'binary', op: { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide' }[symbol], left, right };
    }
    return left;
  }
  let ast;
  try { ast = expressionTree(0, 0); } catch { return null; }
  if (position !== tokens.length || operations < 1 || operations > 24 || variables.size > 8 || (variables.size === 0 && literalTokens.length > 8)) return null;
  if ([...defaults.keys()].some((name) => !variables.has(name)) || (pure && variables.size)) return null;
  function check(node) {
    if (node.type === 'number') return node.value;
    if (node.type === 'name') return defaults.has(node.value) ? defaults.get(node.value) : 0;
    const left = check(node.left);
    const right = check(node.right);
    if (node.op === 'divide' && right === 0) {
      if (!containsName(node.right)) throw new Error('Literal division by zero');
      return null;
    }
    if (left === null || right === null) return null;
    const value = { add: () => left + right, subtract: () => left - right, multiply: () => left * right, divide: () => left / right }[node.op]();
    if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('Result out of range');
    return value;
  }
  function containsName(node) { return node.type === 'name' || (node.type === 'binary' && (containsName(node.left) || containsName(node.right))); }
  try { check(ast); } catch { return null; }
  return { pure, expression, ast, variables: [...variables], defaults, literalTokens };
}

function materializeFormula(request, formula) {
  const size = requestedSize(request);
  if (size === null) return null;
  const base = { version: 2, catalogVersion: WIDGET_CATALOG_VERSION, title: cleanTitle(request), ...(size ? { size } : {}), state: { user: {}, view: {} }, sources: {}, derived: {}, actions: {} };
  const parts = [];
  const editableLiterals = formula.variables.length === 0;
  const inputs = editableLiterals ? formula.literalTokens.map((token) => ({ name: `operand${token.index + 1}`, label: `Operand ${token.index + 1}`, value: token.value }))
    : formula.variables.map((name) => ({ name, label: name.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase()), value: formula.defaults.get(name) ?? 0 }));
  for (const input of inputs) {
    base.state.user[input.name] = input.value;
    base.actions[`edit${input.name}`] = { type: 'assign', target: `/user/${input.name}`, input: 'number' };
    parts.push(part(input.name, 'formula', `Editable ${input.label.toLowerCase()} from the requested formula, initially ${input.value}.`, node(input.name, 'NumberInput', { label: input.label, value: bind(`/user/${input.name}`) }, { change: `edit${input.name}` }), true));
  }
  let index = 0;
  function emit(tree) {
    if (tree.type === 'name') return bind(`/user/${tree.value}`);
    if (tree.type === 'number') return editableLiterals && tree.index !== undefined ? bind(`/user/operand${tree.index + 1}`) : tree.value;
    const name = `calc${++index}`;
    base.derived[name] = { op: tree.op, left: emit(tree.left), right: emit(tree.right) };
    return bind(`/derived/${name}`);
  }
  const result = emit(formula.ast);
  parts.push(part('formulaResult', 'formula', `Computed result of ${formula.expression}.`, node('formulaResult', 'Number', { label: 'Result', value: result }), true, inputs.map((input) => input.name)));
  parts.push(part('formulaText', 'formula', 'Optional validated formula text.', node('formulaText', 'Text', { text: formula.expression })));
  const layouts = ['Stack', 'Grid', 'Card'].map((type) => ({ id: `layout${type}`, type, description: widgetCandidateCatalog.find((candidate) => candidate.type === type).description }));
  const heading = part('heading', 'general', 'Optional calculator heading.', node('heading', 'Heading', { text: 'Calculator', level: 2 }));
  return { kind: 'formula', domains: ['formula'], names: { formula: 'Calculator' }, base, parts, heading, layouts };
}
const number = (text, names, options = {}) => {
  const label = `(?:${names.join('|')})`;
  const after = [...text.matchAll(new RegExp(`\\b${label}\\s*(?::|=|is|of)?\\s*(?:[$€£]\\s*)?(\\d+(?:\\.\\d+)?)\\b`, 'gi'))].map((match) => Number(match[1]));
  const before = [...text.matchAll(new RegExp(`(?:^|[,;\\n]|\\bfor\\b|\\band\\b)\\s*(?:[$€£]\\s*)?(\\d+(?:\\.\\d+)?)\\s*${label}\\b`, 'gi'))].map((match) => Number(match[1]));
  const values = [...after, ...before];
  return values.length && values.every((value) => value === values[0] && Number.isFinite(value) && value <= 1e9) ? values[0] : values.length ? null : Object.hasOwn(options, 'absentValue') ? options.absentValue : 0;
};

export function materializeWidgetCandidates(text) {
  const request = z.string().trim().min(3).max(4000).parse(text);
  const formula = formulaRequest(request);
  if (formula !== undefined) return formula ? materializeFormula(request, formula) ?? invalidFormula : invalidFormula;
  const isBoard = /\bboard\b/i.test(request) && /\b(tasks?|table|columns?)\b/i.test(request);
  const isBudget = /\b(budget|cost|estimate|calculator)\b/i.test(request) && /\b(people|persons?|hours?|weeks?|rates?)\b/i.test(request);
  const isTally = /\b(?:tally|counter)\s+(?:to(?:ward)?\s+)?goal\b|\bgoal\s+(?:tally|counter)\b|\b(?:tally|counter)\s+with\s+progress\b/i.test(request);
  const isGoal = !isTally && /\b(?:goal|progress)\s+(?:meter|widget)\b|\bgoal\s+progress\b/i.test(request);
  const isChart = /\b(?:bar\s+chart|chart)\s*:/i.test(request);
  const isNote = /\b(?:pinned\s+note|editable\s+note|notepad)\b/i.test(request);
  const domains = Object.entries({ board: isBoard, budget: isBudget, goal: isGoal, tally: isTally, chart: isChart, note: isNote }).filter(([, enabled]) => enabled).map(([name]) => name);
  if (!domains.length || domains.length > 2) return null;
  const size = requestedSize(request);
  if (size === null) return null;
  // v2 filterRows matches one column. "Open" spans multiple Board columns, so it needs chat clarification.
  if (isBoard && /\bopen\b/i.test(request)) return null;
  const title = cleanTitle(request);
  const base = { version: 2, catalogVersion: WIDGET_CATALOG_VERSION, title, ...(size ? { size } : {}), state: { user: {}, view: {} }, sources: {}, derived: {}, actions: {} };
  const parts = [];
  if (isBoard) {
    const selected = [
      ...[...request.matchAll(/\b(?:column|status)\s*(?::|=|is|to)?\s*(backlog|ready|active|done)\b/gi)].map((match) => match[1].toLowerCase()),
      ...[...request.matchAll(/\b(backlog|ready|active|done)\s+column\b/gi)].map((match) => match[1].toLowerCase())
    ];
    if (new Set(selected).size > 1) return null;
    const requestedFilter = /\bfilter(?:ed)?\b/i.test(request) || selected.length > 0;
    if (requestedFilter && !selected.length) return null;
    const requestedFields = BOARD_FIELDS.filter((field) => new RegExp(`\\b${field}\\b`, 'i').test(request));
    const fields = [...new Set(['title', 'column', 'updatedAt', ...requestedFields])];
    base.sources.board = { capability: 'board.list', arguments: {}, refresh: 'event' };
    if (requestedFilter) {
      base.state.view.column = selected[0];
      base.derived.filtered = { op: 'filterRows', input: bind('/data/board'), field: 'column', equals: bind('/view/column') };
      base.actions.chooseColumn = { type: 'assign', target: '/view/column', input: 'value' };
      parts.push(part('columnFilter', 'board', `Select Board column. Allowed values: ${boardColumns.join(', ')}.`, node('columnFilter', 'Select', { label: 'Column', value: bind('/view/column'), options: [...boardColumns] }, { change: 'chooseColumn' }), true, ['taskTable']));
    }
    parts.push(part('taskTable', 'board', `Live Board task table. Columns: ${fields.map((field) => `${field} (${fieldDescriptions[field]})`).join(', ')}.`, node('taskTable', 'Table', { rows: bind(requestedFilter ? '/derived/filtered' : '/data/board'), columns: fields.map((field) => ({ field, label: fieldDescriptions[field] })), emptyText: requestedFilter ? 'No tasks in this column' : 'No Board tasks' }), true, requestedFilter ? ['columnFilter'] : []));
  }
  if (isBudget) {
    const values = { people: number(request, ['people', 'persons?']), hours: number(request, ['hours?']), weeks: number(request, ['weeks?']), rate: number(request, ['rate']) };
    if (Object.values(values).some((value) => value === null)) return null;
    base.state.user = values;
    for (const [id, label] of Object.entries({ people: 'People', hours: 'Hours per person per week', weeks: 'Weeks', rate: 'Hourly rate' })) {
      base.actions[`edit${id}`] = { type: 'assign', target: `/user/${id}`, input: 'number' };
      parts.push(part(id, 'budget', `Editable ${label.toLowerCase()}; starts at ${values[id]} from explicit request or zero as an empty calculator value.`, node(id, 'NumberInput', { label, value: bind(`/user/${id}`), min: 0, step: 1 }, { change: `edit${id}` }), true));
    }
    base.derived.teamHours = { op: 'multiply', left: bind('/user/people'), right: bind('/user/hours') };
    base.derived.totalHours = { op: 'multiply', left: bind('/derived/teamHours'), right: bind('/user/weeks') };
    base.derived.budget = { op: 'multiply', left: bind('/derived/totalHours'), right: bind('/user/rate') };
    const inputs = ['people', 'hours', 'weeks', 'rate'];
    parts.push(part('totalHours', 'budget', 'Derived total hours: people times hours per week times weeks.', node('totalHours', 'Number', { label: 'Total hours', value: bind('/derived/totalHours') }), /\b(?:total hours|derived totals)\b/i.test(request), inputs));
    parts.push(part('budget', 'budget', 'Derived project budget: total hours times hourly rate.', node('budget', 'Number', { label: 'Project budget', value: bind('/derived/budget') }), true, inputs));
  }
  if (isGoal) {
    const current = number(request, ['current']);
    const target = number(request, ['target']);
    if (current === null || target === null || target <= 0) return null;
    base.state.user.current = current;
    base.state.user.target = target;
    for (const [id, label, min] of [['current', 'Current', 0], ['target', 'Target', 1]]) {
      base.actions[`edit${id}`] = { type: 'assign', target: `/user/${id}`, input: 'number' };
      parts.push(part(id, 'goal', `Editable ${label.toLowerCase()} goal value; initially ${base.state.user[id]}.`, node(id, 'NumberInput', { label, value: bind(`/user/${id}`), min, step: 1 }, { change: `edit${id}` }), true));
    }
    parts.push(part('goalProgress', 'goal', 'Progress meter bound to editable current and target values.', node('goalProgress', 'Progress', { value: bind('/user/current'), max: bind('/user/target') }), true, ['current', 'target']));
  }
  if (isTally) {
    const target = number(request, ['goal', 'target']);
    const initial = number(request, ['current', 'start']);
    const step = number(request, ['step'], { absentValue: undefined });
    if (target === null || target <= 0 || initial === null || (/\bstep\b/i.test(request) && step === undefined) || (step !== undefined && (step === null || step < 1 || step > 1000000))) return null;
    base.state.user.tally = initial;
    const increment = step ?? 1;
    base.actions.increaseTally = { type: 'increment', target: '/user/tally', amount: increment };
    base.actions.decreaseTally = { type: 'increment', target: '/user/tally', amount: -increment };
    parts.push(part('tallyCounter', 'tally', `Interactive tally starting at ${initial}, step ${increment}.`, node('tallyCounter', 'Counter', { label: 'Tally', value: bind('/user/tally'), step: increment }, { increment: 'increaseTally', decrement: 'decreaseTally' }), true));
    parts.push(part('tallyProgress', 'tally', `Progress toward explicit goal ${target}.`, node('tallyProgress', 'Progress', { value: bind('/user/tally'), max: target }), true, ['tallyCounter']));
  }
  if (isChart) {
    const rows = chartRows(request);
    if (!rows) return null;
    parts.push(part('barChart', 'chart', `Bar chart of explicit pairs: ${rows.map((row) => `${row.label} ${row.value}`).join(', ')}.`, node('barChart', 'BarChart', { rows, xKey: 'label', yKey: 'value' }), true));
  }
  if (isNote) {
    const match = request.match(/\b(?:pinned\s+note|editable\s+note|notepad)\s*:\s*([^;\n]*)/i);
    const note = match?.[1]?.trim() ?? '';
    if (note.length > 500) return null;
    base.state.user.note = note;
    base.actions.editNote = { type: 'assign', target: '/user/note', input: 'value' };
    parts.push(part('noteInput', 'note', 'Editable pinned note text supplied by the user, or blank initially.', node('noteInput', 'TextInput', { label: 'Pinned note', value: bind('/user/note'), placeholder: 'Write a note' }, { change: 'editNote' }), true));
    parts.push(part('notePreview', 'note', 'Optional live text preview bound to the pinned note.', node('notePreview', 'Text', { text: bind('/user/note') }), false, ['noteInput']));
  }
  const layouts = ['Stack', 'Grid', 'Card'].map((type) => ({ id: `layout${type}`, type, description: widgetCandidateCatalog.find((candidate) => candidate.type === type).description }));
  const names = { board: 'Board tasks', budget: 'Project budget', goal: 'Goal progress', tally: 'Tally goal', chart: 'Bar chart', note: 'Pinned note' };
  const heading = part('heading', 'general', 'Optional section heading describing the requested widget.', node('heading', 'Heading', { text: domains.map((domain) => names[domain]).join(' and '), level: 2 }));
  return { kind: domains.length === 2 ? 'mixed' : domains[0], domains, names, base, parts, heading, layouts };
}

function choice(answer, allowed) {
  return answer?.type === 'choice' && allowed.includes(answer.choice) && Number.isFinite(answer.confidence) && answer.confidence >= 0.65 && answer.confidence <= 1 ? answer.choice : null;
}
function included(answer) {
  if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
  if (answer.noul >= 0.7) return true;
  if (answer.noul <= 0.3) return false;
  return null;
}
function layoutNode(id, type, children, title) {
  return { id, type, props: type === 'Grid' ? { columns: 2, gap: 12 } : type === 'Stack' ? { direction: 'vertical', gap: 12 } : { title }, slots: { [type === 'Card' ? 'body' : 'children']: children } };
}
function buildSpec(material, answers) {
  const layout = choice(answers.layout, material.layouts.map((item) => item.id));
  const grouping = choice(answers.grouping, ['flat', 'sections']);
  const order = choice(answers.order, ['inputsFirst', 'outputsFirst']);
  const domainOrder = material.kind === 'mixed' ? choice(answers.domainOrder, material.domains.map((domain) => `${domain}First`)) : `${material.domains[0]}First`;
  const heading = included(answers.include_heading);
  if (!layout || !grouping || !order || !domainOrder || heading === null) return null;
  const selected = [];
  for (const candidate of material.parts) {
    const include = included(answers[`include_${candidate.id}`]);
    if (include === null || (candidate.required && !include)) return null;
    if (include) selected.push(candidate);
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  if (selected.some((item) => item.requires.some((id) => !selectedIds.has(id)))) return null;
  const domains = material.kind === 'mixed' && domainOrder === `${material.domains[1]}First` ? [...material.domains].reverse() : material.domains;
  const byDomain = domains.map((domain) => {
    const items = selected.filter((item) => item.domain === domain);
    const inputs = items.filter((item) => ['Select', 'NumberInput', 'TextInput', 'Counter'].includes(item.node.type));
    const outputs = items.filter((item) => !inputs.includes(item));
    return { domain, items: order === 'inputsFirst' ? [...inputs, ...outputs] : [...outputs, ...inputs] };
  });
  const rootType = material.layouts.find((item) => item.id === layout).type;
  const nodes = [];
  const rootChildren = heading ? [material.heading.id] : [];
  if (grouping === 'sections') {
    for (const { domain, items } of byDomain) {
      if (!items.length) continue;
      const id = `${domain}Section`;
      rootChildren.push(id);
      nodes.push(layoutNode(id, 'Card', items.map((item) => item.id), material.names[domain]));
    }
  } else for (const { items } of byDomain) rootChildren.push(...items.map((item) => item.id));
  if (!rootChildren.length) return null;
  nodes.unshift(layoutNode('root', rootType, rootChildren, material.base.title));
  if (heading) nodes.push(material.heading.node);
  nodes.push(...selected.map((item) => item.node));
  return widgetV2Schema.parse({ ...material.base, root: 'root', nodes });
}

export async function composeWidgetV2Draft(input, { key, fetchImpl = fetch, signal, timeoutMs = 10000 } = {}) {
  const { projectId, text } = inputSchema.parse(input);
  if (!key) return { status: 'fallback', reason: 'key_missing' };
  const material = materializeWidgetCandidates(text);
  if (!material || material.invalid) return { status: 'fallback', reason: 'no_candidate' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted) return { status: 'fallback', reason: signal?.aborted ? 'cancelled' : 'timeout' };
    const candidates = [...material.layouts.map(({ id, type, description }) => ({ id, type, description })), ...[...material.parts, material.heading].map(({ id, description, node: element, required }) => ({ id, type: element.type, description, required }))];
    const questions = {
      suitable: { type: 'noul', instructions: material.kind === 'formula' ? 'A valid arithmetic expression is calculator widget intent, even without the word widget. Does this request fit the supplied formula candidates?' : 'Does this request clearly ask for this interactive widget?', criteria: { true: 'A widget directly fulfills the request', false: 'Normal chat or clarification is more suitable' } },
      layout: { type: 'choice', instructions: 'Choose the root layout from supplied candidates.', criteria: Object.fromEntries(material.layouts.map(({ id, description }) => [id, description])) },
      grouping: { type: 'choice', instructions: 'Choose how to group the selected atomic components.', criteria: { flat: 'Place selected components directly in the root', sections: 'Group each requested purpose in a titled card' } },
      order: { type: 'choice', instructions: 'Choose component order within each group.', criteria: { inputsFirst: 'Controls before data or results', outputsFirst: 'Data or results before controls' } },
      ...(material.kind === 'mixed' ? { domainOrder: { type: 'choice', instructions: 'Choose section order.', criteria: Object.fromEntries(material.domains.map((domain) => [`${domain}First`, `${material.names[domain]} first`])) } } : {}),
      ...Object.fromEntries([...material.parts, material.heading].map(({ id, description, required }) => [`include_${id}`, { type: 'noul', instructions: `Include this supplied ${required ? 'required' : 'optional'} component: ${description}`, criteria: { true: 'Include this exact configured candidate', false: required ? 'Unsuitable; return normal chat' : 'Omit this candidate' } }]))
    };
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: 'jev-latest', state: { request: text, purpose: material.kind, candidates }, questions })
    });
    if (!response.ok) return { status: 'fallback', reason: 'service_error' };
    const data = await response.json();
    if (controller.signal.aborted) return { status: 'fallback', reason: signal?.aborted ? 'cancelled' : 'timeout' };
    const answers = data?.answers;
    if (answers?.suitable?.type !== 'noul' || !Number.isFinite(answers.suitable.noul) || answers.suitable.noul < 0.7 || answers.suitable.noul > 1) return { status: 'fallback', reason: 'low_confidence' };
    const spec = buildSpec(material, answers);
    return spec ? { status: 'draft', projectId, spec, candidate: material.kind } : { status: 'fallback', reason: 'low_confidence' };
  } catch {
    return { status: 'fallback', reason: signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'service_error' };
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
