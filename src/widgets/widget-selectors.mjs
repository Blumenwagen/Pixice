import { BOARD_FIELDS, WIDGET_SOURCE_CATALOG } from './widget-catalog.mjs';
import { WIDGET_V2_LIMITS } from './widget-schema.mjs';

const fields = new Set(BOARD_FIELDS);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function projectWidgetSource(source, result) {
  if (source.capability !== 'board.list' || !Object.hasOwn(WIDGET_SOURCE_CATALOG, source.capability)) throw new Error('Unsupported widget source.');
  const rows = Array.isArray(result) ? result : result?.data;
  if (!Array.isArray(rows) || rows.length > WIDGET_V2_LIMITS.rows) throw new Error('Board source exceeds the widget row limit.');
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid Board row.');
    return Object.fromEntries(Object.entries(row).filter(([name]) => fields.has(name)));
  });
}

export function evaluateWidgetPath(document, state, data, path, visiting = new Set()) {
  const [, scope, name] = path.split('/');
  if (scope === 'user' || scope === 'view') return state[scope][name];
  if (scope === 'data') return data[name] ?? [];
  if (scope !== 'derived' || !Object.hasOwn(document.derived, name) || visiting.has(name)) throw new Error('Invalid derived binding.');
  visiting.add(name);
  const expression = document.derived[name];
  const value = (operand) => operand && typeof operand === 'object' ? evaluateWidgetPath(document, state, data, operand.path, visiting) : operand;
  let result;
  if (expression.op === 'filterRows') {
    const rows = value(expression.input);
    if (!Array.isArray(rows) || rows.length > WIDGET_V2_LIMITS.rows || !fields.has(expression.field)) throw new Error('Invalid Board rows.');
    const expected = value(expression.equals);
    result = rows.filter((row) => row[expression.field] === expected);
  } else {
    const left = value(expression.left);
    const right = value(expression.right);
    if (left === null || right === null) result = null;
    else if (left === undefined || right === undefined) result = undefined;
    else {
      if (!finite(left) || !finite(right)) throw new Error('Invalid numeric selector input.');
      switch (expression.op) {
        case 'add': result = left + right; break;
        case 'subtract': result = left - right; break;
        case 'multiply': result = left * right; break;
        case 'divide': result = right === 0 ? null : left / right; break;
        default: throw new Error('Unknown numeric selector operation.');
      }
      if (result !== null && !finite(result)) result = undefined;
    }
  }
  visiting.delete(name);
  return result;
}

export function resolveWidgetProp(document, state, data, prop) {
  return prop && typeof prop === 'object' && !Array.isArray(prop) && Object.hasOwn(prop, 'path')
    ? evaluateWidgetPath(document, state, data, prop.path) : prop;
}
