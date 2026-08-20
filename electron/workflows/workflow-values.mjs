const EXACT_EXPRESSION = /^\s*{{\s*([^{}]+?)\s*}}\s*$/;
const INLINE_EXPRESSION = /{{\s*([^{}]+?)\s*}}/g;

function splitFallback(expression) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < expression.length - 1; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === quote && expression[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (depth === 0 && character === "?" && expression[index + 1] === "?") {
      return [expression.slice(0, index).trim(), expression.slice(index + 2).trim()];
    }
  }
  return null;
}

function pathTokens(path) {
  const normalized = String(path ?? "")
    .replace(/\[\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\]/g, (_, value) => `.${JSON.parse(`"${value}"`)}`)
    .replace(/\[\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*\]/g, (_, value) => `.${value.replace(/\\'/g, "'")}`)
    .replace(/\[\s*(\d+)\s*\]/g, ".$1")
    .replace(/^\./, "");
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

export function workflowGetPath(value, path) {
  let current = value;
  for (const token of pathTokens(path)) {
    if (current === null || current === undefined) return undefined;
    current = current[token];
  }
  return current;
}

function literalValue(expression) {
  const trimmed = expression.trim();
  if (trimmed === "undefined") return undefined;
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed); } catch { return undefined; }
  }
  return undefined;
}

function functionCall(expression) {
  const match = /^([a-z][a-z0-9_]*)\((.*)\)$/is.exec(expression.trim());
  return match ? { name: match[1], argument: match[2].trim() } : null;
}

export function workflowResolveExpression(expression, context = {}) {
  const trimmed = String(expression ?? "").trim();
  const fallback = splitFallback(trimmed);
  if (fallback) {
    const value = workflowResolveExpression(fallback[0], context);
    return value === undefined || value === null || value === ""
      ? workflowResolveExpression(fallback[1], context)
      : value;
  }

  const call = functionCall(trimmed);
  if (call) {
    const value = workflowResolveExpression(call.argument, context);
    if (call.name === "length") {
      if (typeof value === "string" || Array.isArray(value)) return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;
    }
    if (call.name === "string") return value === undefined || value === null ? "" : String(value);
    if (call.name === "number") return Number(value);
    if (call.name === "boolean") return Boolean(value);
    if (call.name === "json") return JSON.stringify(value);
    if (call.name === "lower") return String(value ?? "").toLowerCase();
    if (call.name === "upper") return String(value ?? "").toUpperCase();
  }

  const literal = literalValue(trimmed);
  if (literal !== undefined || trimmed === "undefined") return literal;
  if (trimmed === "now") return context.now ?? new Date().toISOString();

  const [root, ...rest] = pathTokens(trimmed);
  if (!root || !Object.prototype.hasOwnProperty.call(context, root)) return undefined;
  return workflowGetPath(context[root], rest.join("."));
}

function interpolationText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function workflowRenderTemplate(value, context = {}) {
  if (Array.isArray(value)) return value.map((entry) => workflowRenderTemplate(entry, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, workflowRenderTemplate(entry, context)]));
  }
  if (typeof value !== "string") return value;
  const exact = EXACT_EXPRESSION.exec(value);
  if (exact) return workflowResolveExpression(exact[1], context);
  return value.replace(INLINE_EXPRESSION, (_match, expression) => interpolationText(workflowResolveExpression(expression, context)));
}

export function workflowParseJsonTemplate(value, context = {}, label = "JSON template") {
  const text = String(value ?? "").trim();
  if (!text) return {};
  const exact = EXACT_EXPRESSION.exec(text);
  if (exact) return workflowResolveExpression(exact[1], context);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return workflowRenderTemplate(parsed, context);
}

export function workflowInputValue(inputs = []) {
  if (inputs.length === 0) return null;
  if (inputs.length === 1) return inputs[0].value;
  return inputs.map((entry) => entry.value);
}

export function workflowExpressionContext({
  inputs = [],
  runInput = {},
  nodeOutputs = {},
  now = new Date().toISOString(),
  extra = {}
} = {}) {
  return {
    ...extra,
    input: workflowInputValue(inputs),
    inputs: inputs.map((entry) => entry.value),
    run: runInput,
    nodes: nodeOutputs,
    now
  };
}

function comparableNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

export const WORKFLOW_CONDITION_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "matches",
  "exists",
  "notExists",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "isTrue",
  "isFalse",
  "isEmpty",
  "isNotEmpty"
];

export function workflowEvaluateCondition(left, operator, right) {
  if (operator === "exists") return left !== undefined && left !== null;
  if (operator === "notExists") return left === undefined || left === null;
  if (operator === "isTrue") return left === true;
  if (operator === "isFalse") return left === false;
  if (operator === "isEmpty") {
    return left === undefined || left === null || left === "" || (Array.isArray(left) && left.length === 0)
      || (typeof left === "object" && !Array.isArray(left) && Object.keys(left).length === 0);
  }
  if (operator === "isNotEmpty") return !workflowEvaluateCondition(left, "isEmpty", right);
  if (operator === "equals") return deepEqual(left, right);
  if (operator === "notEquals") return !deepEqual(left, right);
  if (operator === "contains") {
    if (typeof left === "string") return left.includes(String(right ?? ""));
    if (Array.isArray(left)) return left.some((entry) => deepEqual(entry, right));
    if (left && typeof left === "object") return Object.prototype.hasOwnProperty.call(left, String(right));
    return false;
  }
  if (operator === "notContains") return !workflowEvaluateCondition(left, "contains", right);
  if (operator === "startsWith") return String(left ?? "").startsWith(String(right ?? ""));
  if (operator === "endsWith") return String(left ?? "").endsWith(String(right ?? ""));
  if (operator === "matches") {
    try { return new RegExp(String(right ?? "")).test(String(left ?? "")); } catch (error) {
      throw new Error(`Condition regular expression is invalid: ${error.message}`);
    }
  }
  const leftNumber = comparableNumber(left);
  const rightNumber = comparableNumber(right);
  if (leftNumber === null || rightNumber === null) return false;
  if (operator === "greaterThan") return leftNumber > rightNumber;
  if (operator === "greaterThanOrEqual") return leftNumber >= rightNumber;
  if (operator === "lessThan") return leftNumber < rightNumber;
  if (operator === "lessThanOrEqual") return leftNumber <= rightNumber;
  throw new Error(`Unsupported workflow condition operator: ${operator}`);
}
