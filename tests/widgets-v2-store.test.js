import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WidgetStore, widgetCandidates } from '../electron/backend/widgets.mjs';
import { refreshWidgetSource } from '../electron/backend/widget-sources.mjs';

const v2 = () => ({ version: 2, catalogVersion: 1, title: 'Count', root: 'root',
  nodes: [{ id: 'root', type: 'Number', props: { value: { path: '/user/count' } } }],
  state: { user: { count: 1 }, view: {} }, sources: {}, derived: {}, actions: {} });
function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixice-widgets-v2-'));
  try { return run(dir, path.join(dir, 'pixice-widgets.json')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('loads v1 file, adds v2, and preserves a real timer deadline', () => fixture((dir, file) => {
  const deadline = '2032-01-01T00:00:00.000Z';
  const spec = widgetCandidates('5 minutes')[0].spec;
  spec.blocks[0].endAt = deadline;
  const now = new Date().toISOString();
  const old = { id: randomUUID(), projectId: 'p', spec, revision: 1, createdAt: now, updatedAt: now };
  writeFileSync(file, JSON.stringify({ version: 1, widgets: [old] }));
  const store = new WidgetStore(dir);
  const next = store.commit('p', v2());
  assert.equal(new WidgetStore(dir).list('p').length, 2);
  assert.equal(new WidgetStore(dir).list('p')[0].spec.blocks[0].endAt, deadline);
  assert.equal(next.spec.version, 2);
  assert.equal(readFileSync(file, 'utf8').includes('"userState"'), true);
  assert.equal(readFileSync(file, 'utf8').includes('.tmp'), false);
}));

test('isolates corrupt and unsupported records without deleting them on save', () => fixture((dir, file) => {
  const now = new Date().toISOString();
  const good = { id: randomUUID(), projectId: 'p', spec: v2(), revision: 1, createdAt: now, updatedAt: now };
  const corrupt = { ...good, id: randomUUID(), spec: { version: 2, nodes: [] } };
  const future = { ...good, id: randomUUID(), spec: { version: 99 } };
  writeFileSync(file, JSON.stringify({ version: 99, widgets: [corrupt, good, future] }));
  const store = new WidgetStore(dir);
  assert.deepEqual(store.list('p').map((item) => item.id), [good.id]);
  store.commit('p', widgetCandidates('Count laps')[0].spec);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.widgets[0], corrupt);
  assert.deepEqual(saved.widgets[2], future);
  assert.equal(saved.widgets[1].id, good.id);
  assert.deepEqual(saved.widgets[1].userState, { count: 1 });
  assert.equal(new WidgetStore(dir).list('p').length, 2);
}));

test('v2 validation, stale revisions and project isolation apply to document and user state', () => fixture((dir) => {
  const store = new WidgetStore(dir);
  assert.throws(() => store.commit('p', { ...v2(), nodes: [{ id: 'root', type: 'Script' }] }));
  const record = store.commit('p', v2());
  assert.throws(() => store.update('other', record.id, v2(), 1), /not found/);
  assert.throws(() => store.updateUserState('other', record.id, { count: 2 }, 1), /not found/);
  assert.throws(() => store.updateUserState('p', record.id, { count: 2 }, 2), /changed/);
  assert.throws(() => store.updateUserState('p', record.id, { count: 'wrong' }, 1));
  assert.throws(() => store.update('p', record.id, { ...v2(), actions: { bad: { type: 'set', target: '/data/x', value: 1 } } }, 1));
  const changed = store.updateUserState('p', record.id, { count: 2 }, 1);
  assert.equal(changed.spec.state.user.count, 2);
  const disk = JSON.parse(readFileSync(path.join(dir, 'pixice-widgets.json'), 'utf8')).widgets[0];
  assert.equal(disk.spec.state.user.count, 1);
  assert.equal(disk.userState.count, 2);
  assert.equal(new WidgetStore(dir).list('p')[0].spec.state.user.count, 2);
  assert.throws(() => store.update('p', record.id, v2(), 1), /changed/);
  assert.deepEqual(store.list('other'), []);
  assert.throws(() => store.delete('other', record.id), /not found/);
  assert.equal(store.delete('p', record.id).id, record.id);
}));

test('Board adapter requires trusted project context and returns bounded real fields only on refresh', () => {
  let calls = 0;
  const context = { projectId: 'p', listBoardTasks(projectId) {
    calls++;
    assert.equal(projectId, 'p');
    return [{ projectId: 'other', id: 'leak', title: 'Secret', description: '', column: 'active', threadId: null, updatedAt: 'now' },
      ...Array.from({ length: 250 }, (_, i) => ({ projectId: 'p', id: String(i), title: 'A', description: 'x'.repeat(700), column: 'ready', threadId: null, updatedAt: 'now', owner: 'secret', schedule: {}, blocked: true }))];
  } };
  const source = { capability: 'board.list', arguments: {}, refresh: 'manual' };
  assert.equal(calls, 0);
  const rows = refreshWidgetSource(source, context);
  assert.equal(calls, 1);
  assert.equal(rows.length, 200);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'title', 'description', 'column', 'threadId', 'updatedAt']);
  assert.equal(rows[0].description.length, 500);
  assert.equal(rows.some((row) => row.id === 'leak'), false);
  assert.throws(() => refreshWidgetSource({ ...source, arguments: { projectId: 'other' } }, context));
  assert.throws(() => refreshWidgetSource(source, { ...context, projectId: '' }), /project context/);
});

test('v2 timer keeps its explicit end time through commit and reload', () => fixture((dir) => {
  const endAt = '2032-04-05T06:07:08.000Z';
  const doc = { ...v2(), title: 'Timer', nodes: [{ id: 'root', type: 'Timer', props: { label: 'Remaining', durationSeconds: 300, endAt } }], state: { user: {}, view: {} } };
  const record = new WidgetStore(dir).commit('p', doc);
  assert.equal(record.spec.nodes[0].props.endAt, endAt);
  assert.equal(new WidgetStore(dir).list('p')[0].spec.nodes[0].props.endAt, endAt);
}));

test('project deletion removes matching valid and corrupt records but keeps unrelated unknown records', () => fixture((dir, file) => {
  const now = new Date().toISOString();
  const record = (projectId, spec) => ({ id: randomUUID(), projectId, spec, revision: 1, createdAt: now, updatedAt: now });
  const deleted = [record('p', v2()), record('p', { version: 2, nodes: [] }), record('p', { version: 99 })];
  const kept = [record('other', widgetCandidates('Count laps')[0].spec), record('other', { version: 99 }), { opaque: true }];
  writeFileSync(file, JSON.stringify({ version: 2, widgets: [...deleted, ...kept] }));
  const store = new WidgetStore(dir);
  assert.equal(store.list('p').length, 1);
  store.deleteProject('p');
  const saved = JSON.parse(readFileSync(file, 'utf8')).widgets;
  assert.deepEqual(saved.map((item) => item.id), kept.map((item) => item.id));
  assert.deepEqual(saved.slice(1), kept.slice(1));
  assert.equal(new WidgetStore(dir).list('p').length, 0);
  assert.equal(new WidgetStore(dir).list('other').length, 1);
}));

test('Board source requires raw database rows with projectId, not projected Instrument rows', () => {
  const source = { capability: 'board.list', arguments: {}, refresh: 'manual' };
  const raw = { projectId: 'p', id: 'task', title: 'Task', description: '', column: 'ready', threadId: null, updatedAt: 'now' };
  const database = { listBoardTasks(projectId) { assert.equal(projectId, 'p'); return [raw]; } };
  const context = { projectId: 'p', listBoardTasks: database.listBoardTasks.bind(database) };
  assert.equal(refreshWidgetSource(source, context)[0].id, 'task');
  const instrumentRow = Object.fromEntries(Object.entries(raw).filter(([field]) => field !== 'projectId'));
  assert.deepEqual(refreshWidgetSource(source, { ...context, listBoardTasks: () => [instrumentRow] }), []);
});
