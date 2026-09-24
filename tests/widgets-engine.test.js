import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeWidgetDraft, WidgetStore, widgetCandidates, widgetSpecSchema } from '../electron/backend/widgets.mjs';

test('request-specific candidates contain timer and checklist blocks', () => {
  const candidates = widgetCandidates('5 minutes\nReview notes\nSend update');
  assert.deepEqual(candidates.map((candidate) => candidate.key), ['timer', 'checklist']);
  assert.equal(candidates[0].spec.blocks[0].durationSeconds, 300);
});

test('checklist imperative is not an item, but requested items remain', () => {
  const [candidate] = widgetCandidates('Make a checklist:\nBuy milk\nCall Mom');
  assert.equal(candidate.key, 'checklist');
  assert.deepEqual(candidate.spec.blocks[0].items.map((item) => item.text), ['Buy milk', 'Call Mom']);
  const [withRealFirstItem] = widgetCandidates('Buy milk\nCall Mom');
  assert.deepEqual(withRealFirstItem.spec.blocks[0].items.map((item) => item.text), ['Buy milk', 'Call Mom']);
  const [withContext] = widgetCandidates('Make me a checklist for groceries:\nBuy milk\nCall Mom');
  assert.deepEqual(withContext.spec.blocks[0].items.map((item) => item.text), ['Buy milk', 'Call Mom']);
});

test('explicit size is independent of widget type and checklist length', () => {
  const [checklist] = widgetCandidates('Small checklist:\nOne\nTwo\nThree\nFour\nFive');
  assert.equal(checklist.spec.size, 'small');
  assert.deepEqual(checklist.spec.blocks[0].items.map((item) => item.text), ['One', 'Two', 'Three', 'Four', 'Five']);
  const [withoutColon] = widgetCandidates('Small checklist\nBuy milk\nCall Mom');
  assert.deepEqual(withoutColon.spec.blocks[0].items.map((item) => item.text), ['Buy milk', 'Call Mom']);
  assert.equal(widgetCandidates('Large timer for 5 minutes')[0].spec.size, 'large');
  assert.equal(widgetCandidates('Medium counter to track laps')[0].spec.size, 'medium');
  assert.equal(widgetCandidates('Medium widget to count laps')[0].spec.size, 'medium');
  assert.equal(Object.hasOwn(widgetCandidates('5 minutes')[0].spec, 'size'), false);
});

test('explicit to-do list size aliases do not infer size from unrelated small items', () => {
  for (const [heading, size] of [
    ['Small to-do list', 'small'],
    ['Medium todo list', 'medium'],
    ['Large to-do-list', 'large'],
    ['Small task-list', 'small']
  ]) {
    const [candidate] = widgetCandidates(`${heading}:\nBuy milk\nCall Mom`);
    assert.equal(candidate.key, 'checklist');
    assert.equal(candidate.spec.size, size);
    assert.deepEqual(candidate.spec.blocks[0].items.map((item) => item.text), ['Buy milk', 'Call Mom']);
  }
  const [unrelated] = widgetCandidates('Small groceries:\nBuy milk\nCall Mom');
  assert.equal(Object.hasOwn(unrelated.spec, 'size'), false);
});

test('Jev request uses official typed questions and returns selected validated draft', async () => {
  let sent;
  const result = await composeWidgetDraft({ projectId: 'p', text: 'Count my laps' }, { key: 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.authorization, 'Bearer test-key');
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { suitable: { type: 'noul', noul: .95 }, selection: { type: 'choice', choice: 'counter', confidence: .9 }, utility: { type: 'score', score: 2, confidence: .9 }, include_counter: { type: 'noul', noul: .96 } } }) };
  } });
  assert.deepEqual(Object.values(sent.questions).map((question) => question.type), ['noul', 'choice', 'score', 'noul']);
  assert.equal(result.spec.blocks[0].type, 'counter');
  assert.equal(result.status, 'draft');
});

test('Jev composes more than one concrete block', async () => {
  const result = await composeWidgetDraft({ projectId: 'p', text: '5 minutes\nReview notes\nSend update' }, { key: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
    suitable: { type: 'noul', noul: .94 }, selection: { type: 'choice', choice: 'timer', confidence: .82 }, utility: { type: 'score', score: 1.9, confidence: .82 },
    include_timer: { type: 'noul', noul: .96 }, include_checklist: { type: 'noul', noul: .91 }
  } }) }) });
  assert.deepEqual(result.spec.blocks.map((block) => block.type), ['timer', 'checklist']);
});

test('draft carries explicit size through Jev composition', async () => {
  let state;
  const result = await composeWidgetDraft({ projectId: 'p', text: 'Large timer for 5 minutes' }, { key: 'x', fetchImpl: async (_url, init) => {
    state = JSON.parse(init.body).state;
    return { ok: true, json: async () => ({ answers: {
      suitable: { type: 'noul', noul: .95 }, selection: { type: 'choice', choice: 'timer', confidence: .9 },
      utility: { type: 'score', score: 2, confidence: .9 }, include_timer: { type: 'noul', noul: .95 }
    } }) };
  } });
  assert.equal(state.candidates[0].spec.size, 'large');
  assert.equal(result.status, 'draft');
  assert.equal(result.spec.size, 'large');
  assert.equal(result.spec.blocks[0].type, 'timer');
});

test('missing key and low confidence fall back', async () => {
  assert.deepEqual(await composeWidgetDraft({ projectId: 'p', text: 'Count laps' }), { status: 'fallback', reason: 'key_missing' });
  const result = await composeWidgetDraft({ projectId: 'p', text: 'Count laps' }, { key: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { suitable: { type: 'noul', noul: .2 } } }) }) });
  assert.equal(result.reason, 'low_confidence');
});

test('a high score with low, missing, or invalid Score confidence falls back', async () => {
  for (const confidence of [.64, undefined, -0.1, 1.1]) {
    const result = await composeWidgetDraft({ projectId: 'p', text: 'Count laps' }, { key: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      suitable: { type: 'noul', noul: .95 }, selection: { type: 'choice', choice: 'counter', confidence: .9 },
      utility: { type: 'score', score: 2, confidence }, include_counter: { type: 'noul', noul: .95 }
    } }) }) });
    assert.deepEqual(result, { status: 'fallback', reason: 'low_confidence' });
  }
});

test('draft abort and service errors let normal chat continue', async () => {
  const controller = new AbortController();
  const pending = composeWidgetDraft({ projectId: 'p', text: 'Count laps' }, { key: 'x', signal: controller.signal, fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  controller.abort();
  assert.deepEqual(await pending, { status: 'fallback', reason: 'cancelled' });
  assert.deepEqual(await composeWidgetDraft({ projectId: 'p', text: 'Count laps' }, { key: 'x', fetchImpl: async () => ({ ok: false }) }), { status: 'fallback', reason: 'service_error' });
});

test('project store starts timer at commit, persists state, and rejects cross-project updates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixice-widget-'));
  try {
    const store = new WidgetStore(dir);
    const draft = widgetCandidates('5 minutes')[0].spec;
    const before = Date.now();
    const record = store.commit('p', draft);
    assert.ok(Date.parse(record.spec.blocks[0].endAt) >= before + 300000);
    assert.equal(new WidgetStore(dir).list('p').length, 1);
    assert.throws(() => store.update('other', record.id, draft, 1), /not found/);
    assert.throws(() => store.update('p', record.id, draft, 2), /changed/);
    assert.equal(store.delete('p', record.id).id, record.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('updating a timer with null endAt restarts it on the host and persists the deadline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixice-widget-restart-'));
  try {
    const store = new WidgetStore(dir);
    const spec = widgetCandidates('5 minutes')[0].spec;
    const record = store.commit('p', { ...spec, blocks: [{ ...spec.blocks[0], endAt: '2020-01-01T00:00:00.000Z' }] });
    const before = Date.now();
    const restarted = store.update('p', record.id, spec, record.revision);
    const deadline = Date.parse(restarted.spec.blocks[0].endAt);
    assert.ok(deadline >= before + 300000);
    assert.ok(deadline <= Date.now() + 300000);
    assert.equal(new WidgetStore(dir).list('p')[0].spec.blocks[0].endAt, restarted.spec.blocks[0].endAt);
    assert.equal(restarted.revision, 2);
    const explicitEndAt = '2030-01-01T00:00:00.000Z';
    const updated = store.update('p', record.id, { ...spec, blocks: [{ ...spec.blocks[0], endAt: explicitEndAt }] }, restarted.revision);
    assert.equal(updated.spec.blocks[0].endAt, explicitEndAt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('size persists on commit and update while legacy specs stay valid', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixice-widget-size-'));
  try {
    const store = new WidgetStore(dir);
    const legacy = widgetCandidates('Count laps')[0].spec;
    assert.equal(Object.hasOwn(legacy, 'size'), false);
    const record = store.commit('p', legacy);
    assert.equal(Object.hasOwn(new WidgetStore(dir).list('p')[0].spec, 'size'), false);
    const sized = store.update('p', record.id, { ...legacy, size: 'large' }, record.revision);
    assert.equal(new WidgetStore(dir).list('p')[0].spec.size, 'large');
    assert.throws(() => store.update('p', record.id, { ...legacy, size: 'huge' }, sized.revision));
    assert.equal(new WidgetStore(dir).list('p')[0].revision, sized.revision);
    const resized = store.update('p', record.id, { ...legacy, size: 'small' }, sized.revision);
    assert.equal(resized.spec.size, 'small');
    assert.equal(new WidgetStore(dir).list('p')[0].spec.size, 'small');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid widget spec rejects unknown executable fields', () => {
  assert.throws(() => widgetSpecSchema.parse({ version: 1, title: 'Bad', blocks: [{ type: 'counter', label: 'Count', value: 0, step: 1, script: 'alert(1)' }] }));
});
