import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { widgetV2Schema } from '../../src/widgets/widget-schema.mjs';

const label = z.string().trim().min(1).max(160);
const id = z.string().uuid();
const timer = z.object({ type: z.literal('timer'), label, durationSeconds: z.number().int().min(1).max(86400 * 30), endAt: z.string().datetime().nullable() }).strict();
const checklist = z.object({ type: z.literal('checklist'), label, items: z.array(z.object({ id, text: label, done: z.boolean() }).strict()).min(1).max(30) }).strict();
const counter = z.object({ type: z.literal('counter'), label, value: z.number().int().min(-1000000).max(1000000), step: z.number().int().min(1).max(1000) }).strict();
export const widgetSpecSchema = z.object({ version: z.literal(1), title: label, size: z.enum(['small', 'medium', 'large']).optional(), blocks: z.array(z.discriminatedUnion('type', [timer, checklist, counter])).min(1).max(8) }).strict();
const textSchema = z.string().trim().min(3).max(4000);
const contextSchema = z.object({ projectName: z.string().trim().max(160).optional() }).strict();
const draftSchema = z.object({ projectId: z.string().min(1), text: textSchema, context: contextSchema.optional() }).strict();

function duration(text) {
  const units = { s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600 };
  const matches = [...text.matchAll(/(\d{1,4})\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)];
  const total = matches.reduce((sum, match) => sum + Number(match[1]) * units[match[2].toLowerCase()], 0);
  return total > 0 && total <= 86400 * 30 ? total : null;
}
function title(text) { return text.replace(/\s+/g, ' ').trim().slice(0, 120); }
function requestedSize(text) {
  const beforeType = /\b(small|medium|large)\s+(?:(?:live|interactive|simple)\s+)?(?:widget|timer|countdown|check-?list|counter|tally|to(?:-|\s)?do(?:-|\s)?list|task(?:-|\s)list)\b/gi;
  const afterType = /\b(?:widget|timer|countdown|check-?list|counter|tally|to(?:-|\s)?do(?:-|\s)?list|task(?:-|\s)list)\s+(?:(?:should be|sized|in size|as)\s+)?(small|medium|large)\b/gi;
  const sizes = new Set([...text.matchAll(beforeType), ...text.matchAll(afterType)].map((match) => (match[1] ?? match[2]).toLowerCase()));
  return sizes.size === 1 ? [...sizes][0] : undefined;
}
function checklistItems(text) {
  const lines = text.split(/\n|;|\s*,\s*/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)]|\[[ x]\])\s*/, '').trim()).filter(Boolean);
  const introduction = /^(?:(?:please\s+)?(?:make(?: me)?|create|build|give me|show me)\s+(?:a\s+)?)?(?:(?:small|medium|large)\s+)?(?:check-?list|to(?:-|\s)?do(?:-|\s)?list|task(?:-|\s)list)(?:\s+(?:for|of)\s+[^:]+)?\s*:?\s*$/i;
  if (lines.length > 1 && introduction.test(lines[0])) lines.shift();
  return lines.length > 1 ? lines.slice(0, 30) : null;
}
export function widgetCandidates(text) {
  text = textSchema.parse(text);
  const candidates = [];
  const size = requestedSize(text);
  const sizeField = size ? { size } : {};
  const seconds = duration(text);
  if (seconds) candidates.push({ key: 'timer', description: `Countdown for ${seconds} seconds`, spec: { version: 1, title: title(text), ...sizeField, blocks: [{ type: 'timer', label: 'Time remaining', durationSeconds: seconds, endAt: null }] } });
  const items = checklistItems(text);
  if (items) candidates.push({ key: 'checklist', description: `Checklist with ${items.length} request items`, spec: { version: 1, title: title(text), ...sizeField, blocks: [{ type: 'checklist', label: 'Checklist', items: items.map((item) => ({ id: randomUUID(), text: item.slice(0, 160), done: false })) }] } });
  if (/\b(count|counter|tally|track|increment|reps?|laps?)\b/i.test(text)) candidates.push({ key: 'counter', description: 'Interactive tally counter', spec: { version: 1, title: title(text), ...sizeField, blocks: [{ type: 'counter', label: title(text), value: 0, step: 1 }] } });
  return candidates.map((candidate) => ({ ...candidate, spec: widgetSpecSchema.parse(candidate.spec) }));
}

export async function composeWidgetDraft(input, { key, fetchImpl = fetch, signal, timeoutMs = 10000 } = {}) {
  const { projectId, text, context = {} } = draftSchema.parse(input);
  if (!key) return { status: 'fallback', reason: 'key_missing' };
  const candidates = widgetCandidates(text);
  if (!candidates.length) return { status: 'fallback', reason: 'no_candidate' };
  const size = candidates[0].spec.size;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: 'jev-latest', state: { request: text, project: context.projectName ?? '', candidates: candidates.map(({ key, description, spec }) => ({ key, description, spec })) }, questions: {
        suitable: { type: 'noul', instructions: 'Does this request ask for a small interactive utility that can be represented by one of the concrete candidates?', criteria: { true: 'A candidate directly helps the request', false: 'The user wants normal chat or no candidate fits' } },
        selection: { type: 'choice', instructions: 'Choose the candidate that most directly fulfills the request. Do not invent data.', criteria: Object.fromEntries(candidates.map(({ key, description }) => [key, description])) },
        utility: { type: 'score', instructions: 'How useful is an interactive widget composed from the fitting candidates for this exact request?', criteria: ['Not useful', 'Somewhat useful', 'Directly useful'] },
        ...Object.fromEntries(candidates.map(({ key, description }) => [`include_${key}`, { type: 'noul', instructions: `Should the widget include this block: ${description}?`, criteria: { true: 'The user explicitly wants this utility', false: 'This utility is incidental or unrelated' } }]))
      } })
    });
    if (!response.ok) return { status: 'fallback', reason: 'service_error' };
    const data = await response.json();
    const answers = data?.answers;
    const choice = answers?.selection;
    const lead = candidates.find((candidate) => candidate.key === choice?.choice);
    if (answers?.suitable?.type !== 'noul' || !Number.isFinite(answers.suitable.noul) || answers.suitable.noul < 0.7 || answers.suitable.noul > 1 || choice?.type !== 'choice' || !Number.isFinite(choice.confidence) || choice.confidence < 0.65 || choice.confidence > 1 || answers?.utility?.type !== 'score' || !Number.isFinite(answers.utility.score) || answers.utility.score < 1.4 || answers.utility.score > 2 || !Number.isFinite(answers.utility.confidence) || answers.utility.confidence < 0.65 || answers.utility.confidence > 1 || !lead) return { status: 'fallback', reason: 'low_confidence' };
    const selected = candidates.filter((candidate) => {
      const answer = answers[`include_${candidate.key}`];
      return answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0.7 && answer.noul <= 1;
    });
    if (!selected.some((candidate) => candidate.key === lead.key)) selected.unshift(lead);
    const spec = widgetSpecSchema.parse({ version: 1, title: title(text), ...(size ? { size } : {}), blocks: selected.flatMap((candidate) => candidate.spec.blocks) });
    return { status: 'draft', projectId, spec, candidate: selected.map((candidate) => candidate.key).join('+') };
  } catch (error) {
    return { status: 'fallback', reason: signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'service_error' };
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

function startNullTimers(spec, nowMs) {
  return { ...spec, blocks: spec.blocks.map((block) => block.type === 'timer' && block.endAt === null
    ? { ...block, endAt: new Date(nowMs + block.durationSeconds * 1000).toISOString() }
    : block) };
}

const storedBase = z.object({ id, projectId: z.string().min(1), revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string() });

function parseStoredRecord(input) {
  const base = storedBase.parse(input);
  if (input.spec?.version === 1) return { ...base, spec: widgetSpecSchema.parse(input.spec) };
  if (input.spec?.version === 2) {
    // The immutable document keeps initial state; userState holds later user edits.
    const spec = widgetV2Schema.parse(input.spec);
    const userState = input.userState === undefined ? spec.state.user : input.userState;
    const hydrated = widgetV2Schema.parse({ ...spec, state: { ...spec.state, user: userState } });
    return { ...base, spec, userState: hydrated.state.user };
  }
  throw new Error('Unsupported widget version');
}
function publicRecord(record) {
  const result = structuredClone(record);
  if (result.spec.version === 2) {
    result.spec.state.user = structuredClone(result.userState);
    delete result.userState;
  }
  return result;
}

export class WidgetStore {
  constructor(directory) { this.path = path.join(directory, 'pixice-widgets.json'); this.records = this.#load(); }
  #load() {
    if (!existsSync(this.path)) return [];
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!value || !Array.isArray(value.widgets)) throw new Error('Invalid widgets file');
    return value.widgets.map((entry) => {
      try { return { valid: true, record: parseStoredRecord(entry) }; }
      catch { return { valid: false, record: entry }; }
    });
  }
  #save(next) {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 2, widgets: next.map((entry) => entry.record) }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      try { chmodSync(this.path, 0o600); } catch {}
      this.records = next;
    } catch (error) { try { rmSync(temporary, { force: true }); } catch {} throw error; }
  }
  list(projectId) { return this.records.filter((entry) => entry.valid && entry.record.projectId === projectId).map((entry) => publicRecord(entry.record)); }
  commit(projectId, spec) {
    if (typeof projectId !== 'string' || !projectId) throw new Error('Project ID is required');
    const nowMs = Date.now();
    const parsed = spec?.version === 2 ? widgetV2Schema.parse(spec) : startNullTimers(widgetSpecSchema.parse(spec), nowMs);
    const now = new Date(nowMs).toISOString();
    const record = { id: randomUUID(), projectId, spec: parsed, ...(parsed.version === 2 ? { userState: structuredClone(parsed.state.user) } : {}), revision: 1, createdAt: now, updatedAt: now };
    this.#save([...this.records, { valid: true, record }]);
    return publicRecord(record);
  }
  update(projectId, widgetId, spec, expectedRevision) {
    const index = this.records.findIndex((entry) => entry.valid && entry.record.id === widgetId && entry.record.projectId === projectId);
    if (index < 0) throw new Error('Widget not found in this project');
    const existing = this.records[index].record;
    if (existing.revision !== expectedRevision) throw new Error('Widget has changed. Refresh it before saving.');
    const nowMs = Date.now();
    const parsed = spec?.version === 2 ? widgetV2Schema.parse(spec) : startNullTimers(widgetSpecSchema.parse(spec), nowMs);
    if (parsed.version !== existing.spec.version) throw new Error('Widget version cannot change');
    const record = { ...existing, spec: parsed, ...(parsed.version === 2 ? { userState: structuredClone(parsed.state.user) } : {}), revision: existing.revision + 1, updatedAt: new Date(nowMs).toISOString() };
    this.#save(this.records.map((entry, position) => position === index ? { valid: true, record } : entry));
    return publicRecord(record);
  }
  updateUserState(projectId, widgetId, userState, expectedRevision) {
    const index = this.records.findIndex((entry) => entry.valid && entry.record.id === widgetId && entry.record.projectId === projectId);
    if (index < 0) throw new Error('Widget not found in this project');
    const existing = this.records[index].record;
    if (existing.revision !== expectedRevision) throw new Error('Widget has changed. Refresh it before saving.');
    if (existing.spec.version !== 2) throw new Error('User state is only available for v2 widgets');
    const hydrated = widgetV2Schema.parse({ ...existing.spec, state: { ...existing.spec.state, user: userState } });
    const record = { ...existing, userState: hydrated.state.user, revision: existing.revision + 1, updatedAt: new Date().toISOString() };
    this.#save(this.records.map((entry, position) => position === index ? { valid: true, record } : entry));
    return publicRecord(record);
  }
  delete(projectId, widgetId) {
    const index = this.records.findIndex((entry) => entry.valid && entry.record.id === widgetId && entry.record.projectId === projectId);
    if (index < 0) throw new Error('Widget not found in this project');
    const record = this.records[index].record;
    this.#save(this.records.filter((_entry, position) => position !== index));
    return publicRecord(record);
  }
  deleteProject(projectId) { this.#save(this.records.filter((entry) => entry.record?.projectId !== projectId)); }
}
