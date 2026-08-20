const MONTH_NAMES = new Map([
  ["JAN", 1], ["FEB", 2], ["MAR", 3], ["APR", 4], ["MAY", 5], ["JUN", 6],
  ["JUL", 7], ["AUG", 8], ["SEP", 9], ["OCT", 10], ["NOV", 11], ["DEC", 12]
]);
const WEEKDAY_NAMES = new Map([
  ["SUN", 0], ["MON", 1], ["TUE", 2], ["WED", 3], ["THU", 4], ["FRI", 5], ["SAT", 6]
]);

const FIELD_DEFINITIONS = [
  { name: "minute", minimum: 0, maximum: 59 },
  { name: "hour", minimum: 0, maximum: 23 },
  { name: "day of month", minimum: 1, maximum: 31 },
  { name: "month", minimum: 1, maximum: 12, names: MONTH_NAMES },
  { name: "weekday", minimum: 0, maximum: 7, names: WEEKDAY_NAMES, normalize: (value) => value === 7 ? 0 : value }
];

function numberValue(raw, definition) {
  const text = String(raw ?? "").trim().toUpperCase();
  const named = definition.names?.get(text);
  const number = named ?? Number(text);
  if (!Number.isInteger(number) || number < definition.minimum || number > definition.maximum) {
    throw new Error(`Cron ${definition.name} value is invalid: ${raw}`);
  }
  return definition.normalize ? definition.normalize(number) : number;
}

function addRange(values, start, end, step, definition) {
  if (start > end) throw new Error(`Cron ${definition.name} range cannot descend`);
  if (!Number.isInteger(step) || step < 1) throw new Error(`Cron ${definition.name} step must be a positive integer`);
  for (let value = start; value <= end; value += step) values.add(definition.normalize ? definition.normalize(value) : value);
}

function parsePart(rawPart, definition, values) {
  const [rangeText, stepText] = rawPart.split("/");
  if (rawPart.split("/").length > 2) throw new Error(`Cron ${definition.name} contains an invalid step`);
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step < 1) throw new Error(`Cron ${definition.name} step must be a positive integer`);

  if (rangeText === "*") {
    addRange(values, definition.minimum, definition.maximum, step, definition);
    return;
  }
  const range = rangeText.split("-");
  if (range.length === 1) {
    const value = numberValue(range[0], definition);
    if (stepText !== undefined) addRange(values, value, definition.maximum, step, definition);
    else values.add(value);
    return;
  }
  if (range.length !== 2) throw new Error(`Cron ${definition.name} range is invalid: ${rawPart}`);
  addRange(values, numberValue(range[0], definition), numberValue(range[1], definition), step, definition);
}

function parseField(raw, definition) {
  const text = String(raw ?? "").trim().toUpperCase();
  if (!text) throw new Error(`Cron ${definition.name} cannot be empty`);
  const values = new Set();
  for (const part of text.split(",")) parsePart(part.trim(), definition, values);
  return { values, wildcard: text === "*" };
}

export function parseWorkflowCron(expression) {
  const fields = String(expression ?? "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron schedules require exactly five fields: minute hour day month weekday");
  const [minute, hour, dayOfMonth, month, weekday] = fields.map((field, index) => parseField(field, FIELD_DEFINITIONS[index]));
  return { expression: fields.join(" "), minute, hour, dayOfMonth, month, weekday };
}

export function workflowCronMatches(expression, value) {
  const cron = typeof expression === "string" ? parseWorkflowCron(expression) : expression;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Cron matching requires a valid date");
  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;
  const dayMatches = cron.dayOfMonth.values.has(date.getDate());
  const weekdayMatches = cron.weekday.values.has(date.getDay());
  if (!cron.dayOfMonth.wildcard && !cron.weekday.wildcard) return dayMatches || weekdayMatches;
  if (!cron.dayOfMonth.wildcard) return dayMatches;
  if (!cron.weekday.wildcard) return weekdayMatches;
  return true;
}

export function workflowNextCronDate(expression, after = new Date(), maximumMinutes = 60 * 24 * 366 * 5) {
  const cron = typeof expression === "string" ? parseWorkflowCron(expression) : expression;
  const start = after instanceof Date ? after : new Date(after);
  if (!Number.isFinite(start.getTime())) throw new Error("Cron scheduling requires a valid starting date");
  const candidate = new Date(start);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let index = 0; index < maximumMinutes; index += 1) {
    if (workflowCronMatches(cron, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error("Cron schedule did not produce a run time within five years");
}

export function workflowIntervalMilliseconds(config) {
  const multipliers = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000
  };
  const every = Math.max(1, Math.round(Number(config?.every) || 1));
  return every * (multipliers[config?.unit] ?? multipliers.minutes);
}

export function workflowNextScheduleDate(config, after = new Date()) {
  if (config?.mode === "cron") return workflowNextCronDate(config.cron, after);
  const date = after instanceof Date ? after : new Date(after);
  if (!Number.isFinite(date.getTime())) throw new Error("Schedule requires a valid starting date");
  return new Date(date.getTime() + workflowIntervalMilliseconds(config));
}
