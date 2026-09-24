// Service-level regression checks for the Focus coordinator lifecycle.
// Run from the repository root with: node --test work/investigations/focus-coordinator-checks.mjs
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startService } from '../../electron/backend/service.mjs';
import { ApplicationClient } from '../../electron/connect/application-client.mjs';
import { BackendFixtureProvider } from '../../tests/fixtures/backend-provider.mjs';
import { PixiceFocusMemory } from '../../electron/runtime/pixice-focus.mjs';

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pixice-focus-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const codex = new BackendFixtureProvider();
  const claude = new BackendFixtureProvider('claude');
  const calls = [];
  let implementation = codex.request.bind(codex);
  codex.request = async (method, params) => { calls.push([method, params]); return implementation(method, params); };
  const request = { calls, mockImplementation: (fn) => { implementation = fn; }, mockClear: () => { calls.length = 0; } };
  let database;
  const service = await startService({
    dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'),
    clientDirectory: path.resolve('dist/client'), version: 'test',
    providerFactories: {
      codex: (context) => { database = context.database; return codex; },
      claude: () => claude
    }
  });
  cleanup.push(() => service.stop({ force: true }));
  await service.ready;
  // Match real providers' ready status (the generic fixture emits connected).
  codex.emit('status', { state: 'ready' });
  claude.emit('status', { state: 'ready' });
  const client = new ApplicationClient({
    id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token
  }, { probe: 'service.status' });
  cleanup.push(() => client.close());
  await client.connect();
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const project = await client.call('projects.create', {
    displayName: 'Focus investigation', icon: 'folder', color: 'gray', folders: [folder]
  });
  const focus = await client.call('focus.ensure', { projectId: project.id, model: 'codex:fixture-model' });
  const toolReplies = new Map();
  codex.respond = (id, response) => { toolReplies.get(id)?.(response); toolReplies.delete(id); };
  let toolSequence = 0;
  const tool = async (name, args, threadId = focus.thread.id) => {
    const id = `focus-tool-${++toolSequence}`;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { toolReplies.delete(id); reject(new Error(`Tool ${name} timed out`)); }, 3000);
      toolReplies.set(id, result => { clearTimeout(timeout); resolve(result); });
    });
    codex.emit('server-request', { id, method: 'item/tool/call', params: { namespace: 'pixice_focus', tool: name, threadId, arguments: args } });
    const result = await response;
    const output = JSON.parse(result.contentItems[0].text);
    if (!result.success) throw new Error(output.error ?? String(output));
    return output;
  };
  return { client, codex, claude, request, database, project, focus, service, tool };
}

async function eventually(read, predicate, message = 'Condition not reached') {
  let last;
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`${message}: ${JSON.stringify(last?.work?.map(({ status, error }) => ({ status, error })) ?? last)}; events: ${JSON.stringify(last?.events?.slice(-3))}`);
}

describe('Focus coordinator backend', () => {
  it('dispatches asynchronously, receives a review result, verifies it, and persists the return brief', async () => {
    const { client, project, codex, request, focus, tool } = await fixture();
    const original = BackendFixtureProvider.prototype.request;
    request.mockImplementation(async (method, params) => method === 'model/list'
      ? { data: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'Terra', isDefault: true }] }
      : original.call(codex, method, params));
    await client.call('focus.updatePolicy', { projectId: project.id, patch: { workerModel: 'codex:gpt-5.6-terra' } });
    const work = await tool('dispatch_work', { title: 'Inspect exports', prompt: 'Inspect the exporter and report evidence.', access: 'read' });
    assert.ok(work.id);
    const state = () => client.call('focus.state', { projectId: project.id });
    const running = await eventually(state, value => value.work.some(item => item.id === work.id && item.status === 'running'));
    const worker = running.work.find(item => item.id === work.id);
    assert.notEqual(worker.threadId, focus.thread.id);
    await assert.rejects(client.call('threads.create', { projectId: project.id, parentThreadId: worker.threadId, model: 'codex:gpt-5.6-terra', permissionMode: 'full-access' }), /unsupervised/);
    await assert.rejects(client.call('turns.start', { projectId: project.id, threadId: worker.threadId, text: 'Bypass scheduling', model: 'codex:gpt-5.6-terra' }), /supervised/);
    const dispatch = request.calls.find(([method, params]) => method === 'turn/start' && params.threadId === worker.threadId);
    assert.equal(dispatch[1].permissionMode, 'read-only');
    codex.emit('server-request', { id: 'worker-approval', method: 'item/commandExecution/requestApproval', params: { threadId: worker.threadId } });
    const approval = (await client.call('tasks.interventions')).requests.find(item => item.id === 'worker-approval');
    assert.ok(approval, 'Read-only worker approval must not be silently accepted by Focus');
    await client.call('approvals.resolve', { requestId: approval.id, requestGeneration: approval.requestGeneration, decision: 'decline' });
    const turn = codex.threads.get(worker.threadId).turns.at(-1);
    turn.status = 'completed';
    turn.items = [{ id: 'answer', type: 'agentMessage', text: 'Exporter inspected. No writes were needed.' }];
    codex.event({ method: 'turn/completed', threadId: worker.threadId, turn });
    await eventually(state, value => value.work.find(item => item.id === work.id)?.status === 'review');
    await assert.rejects(tool('complete_work', { workId: work.id, summary: 'Complete', verification: { status: 'failed', evidence: 'A required check failed.' } }), /verification/i);
    const done = await tool('complete_work', { workId: work.id, summary: 'Exporter inspected and findings reviewed.', artifacts: ['src/exporter.js'], verification: { status: 'not-required', evidence: 'Read-only investigation with file evidence reviewed; no implementation changed.' } });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.artifacts, ['src/exporter.js']);
    const brief = await state();
    assert.ok(brief.unseenEvents.length);
    await client.call('focus.markSeen', { projectId: project.id, sequence: brief.latestSequence });
    assert.equal((await state()).unseenEvents.length, 0);
  });

  it('persists independent model policies without replacing a used coordinator provider or task override', async () => {
    const { client, project, focus, codex, claude, request } = await fixture();
    const original = BackendFixtureProvider.prototype.request;
    request.mockImplementation(async (method, params) => method === 'model/list'
      ? { data: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'Terra', isDefault: true }] }
      : original.call(codex, method, params));
    claude.request = async (method, params) => method === 'model/list'
      ? { data: [{ id: 'sonnet', model: 'sonnet', displayName: 'Sonnet' }] }
      : original.call(claude, method, params);
    await client.call('focus.updatePolicy', { projectId: project.id, patch: { coordinatorModel: 'codex:gpt-5.6-terra', workerModel: 'claude:sonnet', reviewModel: 'codex:gpt-5.6-terra', permissionMode: 'auto-approve' } });
    await client.call('turns.start', { projectId: project.id, threadId: focus.thread.id, text: 'A thread-specific model override', model: 'codex:fixture-model' });
    const state = await client.call('focus.state', { projectId: project.id });
    assert.equal(state.policy.coordinatorModel, 'codex:gpt-5.6-terra');
    assert.equal(state.policy.workerModel, 'claude:sonnet');
    assert.equal(state.policy.permissionMode, 'auto-approve');
    assert.equal(Object.hasOwn(state.policy, 'maxWorkers'), false);
    await assert.rejects(client.call('focus.updatePolicy', { projectId: project.id, patch: { maxWorkers: 1 } }), /maxWorkers/);
    await assert.rejects(client.call('focus.updatePolicy', { projectId: project.id, patch: { coordinatorModel: 'claude:sonnet' } }), /stays with its provider/);
    const defaults = await client.call('app.bootstrap');
    assert.notEqual(defaults.settings.defaultModel, 'codex:gpt-5.6-terra');
  });
  it('accepts the first prompt in an empty coordinator and reuses that session', async () => {
    const { client, project, focus, database, request } = await fixture();
    assert.deepEqual(focus.thread.turns, []);
    const again = await client.call('focus.ensure', { projectId: project.id });
    assert.equal(again.created, false);
    assert.equal(again.thread.id, focus.thread.id);
    const { turn } = await client.call('turns.start', {
      projectId: project.id, threadId: focus.thread.id, text: 'Hello', model: 'codex:fixture-model'
    });
    assert.equal(turn.status, 'inProgress');
    assert.equal(database.getProjectFocusSession(project.id).userTurnCount, 1);
    assert.ok(request.calls.some(([method, params]) => method === 'turn/start' && params.threadId === focus.thread.id && params.permissionMode === 'full-access'));
    const listed = await client.call('threads.list', { projectId: project.id });
    assert.equal(listed.data.some(thread => thread.id === focus.thread.id), false);
  });

  it('resumes an empty coordinator after its provider restarts while another provider stays ready', async () => {
    const { client, project, focus, codex, request, database } = await fixture();
    // Provider process state is gone, while its durable thread still exists.
    let loaded = false;
    const original = BackendFixtureProvider.prototype.request;
    request.mockImplementation(async (method, params) => {
      if (method === 'thread/resume') loaded = true;
      if (method === 'turn/start' && !loaded) throw new Error('thread not found: runtime session is not loaded');
      return original.call(codex, method, params);
    });
    await codex.stop();
    await codex.start();
    codex.emit('status', { state: 'ready' });
    request.mockClear();
    await client.call('turns.start', {
      projectId: project.id, threadId: focus.thread.id, text: 'First prompt', model: 'codex:fixture-model'
    });
    assert.equal(request.calls.some(([method]) => method === 'thread/resume'), true);
    assert.equal(database.getProjectFocusSession(project.id).userTurnCount, 1);
  });

  it('rejects a model owned by a different provider before dispatch', async () => {
    const { client, project, focus, request } = await fixture();
    await assert.rejects(client.call('turns.start', {
      projectId: project.id, threadId: focus.thread.id, text: 'First prompt', model: 'claude:sonnet'
    }), /uses codex/i);
    assert.equal(request.calls.some(([method, params]) => method === 'turn/start' && params.model === 'claude:sonnet'), false);
  });

  it('keeps searchable Focus history when reading a Codex thread', async () => {
    const { client, project, focus, database, codex } = await fixture();
    const snapshot = { ...focus.thread, turns: [{
      id: 'completed-turn', status: 'completed', items: [{
        id: 'decision', type: 'userMessage', content: [{ type: 'text', text: 'Use smoky charcoal surfaces.' }]
      }]
    }] };
    codex.threads.set(focus.thread.id, snapshot);
    database.saveProviderThreadSnapshot(focus.thread.id, snapshot);
    assert.equal(database.searchProjectFocusHistory(project.id, 'charcoal', 8).length, 1);
    const result = await client.call('threads.read', { projectId: project.id, threadId: focus.thread.id });
    assert.equal(result.thread.turns.length, 1);
    assert.equal(database.searchProjectFocusHistory(project.id, 'charcoal', 8).length, 1);
  });

  it('indexes a completed Focus transcript received through threads.read', async () => {
    const { client, project, focus, database, codex } = await fixture();
    codex.threads.set(focus.thread.id, { ...focus.thread, turns: [{
      id: 'completed-turn', status: 'completed', items: [{
        id: 'decision', type: 'userMessage', content: [{ type: 'text', text: 'Keep the coordinator conversation persistent.' }]
      }]
    }] });

    assert.deepEqual(database.searchProjectFocusHistory(project.id, 'persistent', 8), []);
    await client.call('threads.read', { projectId: project.id, threadId: focus.thread.id });
    assert.equal(database.searchProjectFocusHistory(project.id, 'persistent', 8).length, 1);
    await client.call('threads.list', { projectId: project.id });
    codex.threads.set(focus.thread.id, { ...focus.thread, turns: [] });
    await client.call('threads.read', { projectId: project.id, threadId: focus.thread.id });
    assert.equal(database.searchProjectFocusHistory(project.id, 'persistent', 8).length, 1);
  });

  it('keeps another provider running when Codex disconnects', async () => {
    const { client, project, codex, claude, service } = await fixture();
    const { thread } = await client.call('threads.create', { projectId: project.id, model: 'claude:sonnet' });
    const { turn } = await client.call('turns.start', {
      projectId: project.id, threadId: thread.id, model: 'claude:sonnet', text: 'Continue working'
    });
    assert.equal(service.status().activeTurns, 1);
    await codex.stop();
    assert.equal(service.status().activeTurns, 1);
    assert.equal(claude.threads.get(thread.id).turns.at(-1).id, turn.id);
    await client.call('turns.interrupt', { projectId: project.id, threadId: thread.id, turnId: turn.id });
    assert.equal(service.status().activeTurns, 0);
  });

  it('changes an explicitly selected unused coordinator provider but preserves a used session', async () => {
    const { client, project, focus, database, claude } = await fixture();
    const switched = await client.call('focus.ensure', {
      projectId: project.id, model: 'claude:sonnet', replaceEmpty: true
    });
    assert.notEqual(switched.thread.id, focus.thread.id);
    assert.equal(switched.configuration.provider, 'claude');
    const { turn } = await client.call('turns.start', {
      projectId: project.id, threadId: switched.thread.id, model: 'claude:sonnet', text: 'First message'
    });
    assert.equal(claude.starts, 1);
    await client.call('turns.interrupt', { projectId: project.id, threadId: switched.thread.id, turnId: turn.id });
    const preserved = await client.call('focus.ensure', {
      projectId: project.id, model: 'codex:fixture-model', replaceEmpty: true
    });
    assert.equal(preserved.thread.id, switched.thread.id);
    assert.equal(database.getProjectFocusSession(project.id).userTurnCount, 1);
  });

  it('rejects stale memory edits and stale maintenance without losing a newer decision', async () => {
    const { client, project, database } = await fixture();
    const initial = await client.call('focus.readMemory', { projectId: project.id });
    const saved = await client.call('focus.updateMemory', {
      projectId: project.id, expectedRevision: initial.revision,
      projectMemory: 'Keep Focus as one project conversation.', userMemory: 'Prefer concise updates.'
    });
    await assert.rejects(client.call('focus.updateMemory', {
      projectId: project.id, expectedRevision: initial.revision,
      projectMemory: 'Stale overwrite', userMemory: ''
    }), /changed/i);
    const maintenance = new PixiceFocusMemory({ database });
    assert.throws(() => maintenance.replaceFromMaintenance(project.id, {
      projectMemory: 'Stale maintenance', userMemory: ''
    }, 10, initial.revision), /changed/i);
    const current = await client.call('focus.readMemory', { projectId: project.id });
    assert.equal(current.projectMemory, saved.projectMemory);
    assert.equal(database.getProjectFocusSession(project.id).lastMemoryReviewTurn, 0);
    const cleared = await client.call('focus.clearMemory', { projectId: project.id, expectedRevision: saved.revision });
    assert.equal(cleared.projectMemory, '');
    assert.equal(cleared.userMemory, '');
  });

  it('reveals a hidden worker question when its reviewer provider disconnects', async () => {
    const { client, project, focus, codex, claude, request } = await fixture();
    const { thread } = await client.call('threads.create', {
      projectId: project.id, model: 'claude:sonnet', parentThreadId: focus.thread.id
    });
    const original = BackendFixtureProvider.prototype.request;
    let reviewerId;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    request.mockImplementation(async (method, params) => {
      const result = await original.call(codex, method, params);
      if (method === 'thread/start' && params.threadSource === 'pixiceFocusQuestionReview') reviewerId = result.thread.id;
      if (method === 'turn/start' && params.threadId === reviewerId) markStarted();
      return result;
    });
    claude.emit('server-request', {
      id: 'worker-question', method: 'item/tool/requestUserInput',
      params: { threadId: thread.id, questions: [{ id: 'choice', header: 'Direction', question: 'Which direction should I use?', options: [] }] }
    });
    await Promise.race([started, new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Question reviewer did not start')), 2000);
      timeout.unref();
      started.then(() => clearTimeout(timeout));
    })]);
    assert.equal((await client.call('tasks.interventions')).requests.length, 0);
    await codex.stop();
    const pending = (await client.call('tasks.interventions')).requests;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].focusCoordinatorQuestion, true);
    assert.equal(pending[0].params.questions[0].id, 'choice');
    assert.equal(claude.connected, true);
  });

  it('answers a routine worker question from durable work directions without surfacing it', async () => {
    const { client, project, codex, request, tool } = await fixture();
    const original = BackendFixtureProvider.prototype.request;
    let reviewerId;
    request.mockImplementation(async (method, params) => {
      if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'Terra', isDefault: true }] };
      const result = await original.call(codex, method, params);
      if (method === 'thread/start' && params.threadSource === 'pixiceFocusQuestionReview') reviewerId = result.thread.id;
      return result;
    });
    await client.call('focus.updatePolicy', { projectId: project.id, patch: { workerModel: 'codex:gpt-5.6-terra' } });
    const work = await tool('dispatch_work', { title: 'Inspect local exporter', prompt: 'Inspect the exporter using only the current project.', access: 'read' });
    const state = () => client.call('focus.state', { projectId: project.id });
    const running = await eventually(state, value => value.work.find(item => item.id === work.id)?.status === 'running');
    const worker = running.work.find(item => item.id === work.id);
    await tool('record_decision', { text: 'Use the current project checkout; do not fetch a remote copy.', workIds: [work.id] });
    const replies = [];
    codex.respond = (id, result) => replies.push({ id, result });
    codex.emit('server-request', {
      id: 'routine-worker-question', method: 'item/tool/requestUserInput', params: {
        threadId: worker.threadId,
        questions: [{ id: 'source', header: 'Source', question: 'Which source should I inspect?', options: [{ label: 'Current project', description: 'Use the checked-out project.' }, { label: 'Remote copy', description: 'Fetch another copy.' }] }]
      }
    });
    await eventually(async () => reviewerId && codex.threads.get(reviewerId)?.turns.at(-1), Boolean, 'Question reviewer did not start');
    const reviewCall = request.calls.findLast(([method, params]) => method === 'turn/start' && params.threadId === reviewerId);
    assert.equal(reviewCall[1].model, 'fixture-model');
    const reviewPrompt = JSON.stringify(reviewCall[1].input);
    assert.match(reviewPrompt, /Inspect local exporter/);
    assert.match(reviewPrompt, /current project checkout/);
    const storedTurn = codex.threads.get(reviewerId).turns.at(-1);
    storedTurn.status = 'completed';
    storedTurn.items = [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ action: 'answer', answers: { source: 'Current project' } }) }];
    codex.event({ method: 'turn/completed', threadId: reviewerId, turn: { id: storedTurn.id, status: 'completed', items: [] } });
    await eventually(async () => replies, value => value.some(reply => reply.id === 'routine-worker-question'));
    const reply = replies.find(item => item.id === 'routine-worker-question');
    assert.deepEqual(reply.result.answers, { source: { answers: ['Current project'] } });
    assert.equal((await client.call('tasks.interventions')).requests.length, 0);
    const receipt = (await state()).events.find(event => event.kind === 'question-answered');
    assert.equal(receipt.source, 'coordinator');
    assert.equal(receipt.wasVisible, false);
    assert.deepEqual(receipt.answers, { source: ['Current project'] });
    assert.match(receipt.message, /Current project/);
  });

  it('uses the coordinator provider, rewrites a genuine choice inline, and forwards a normal-chat answer', async () => {
    const { client, project, focus, codex, claude, tool } = await fixture();
    const switched = await client.call('focus.ensure', { projectId: project.id, model: 'claude:sonnet', replaceEmpty: true });
    assert.notEqual(switched.thread.id, focus.thread.id);
    const { thread: worker } = await client.call('threads.create', { projectId: project.id, model: 'claude:sonnet', parentThreadId: switched.thread.id });
    const originalClaudeRequest = claude.request.bind(claude);
    const claudeCalls = [];
    let reviewerId;
    claude.request = async (method, params) => {
      claudeCalls.push([method, params]);
      const result = await originalClaudeRequest(method, params);
      if (method === 'thread/start' && params.threadSource === 'pixiceFocusQuestionReview') reviewerId = result.thread.id;
      return result;
    };
    const replies = [];
    claude.respond = (id, result) => replies.push({ id, result });
    claude.emit('server-request', {
      id: 'product-choice', method: 'item/tool/requestUserInput', params: {
        threadId: worker.id,
        questions: [{ id: 'location', header: 'Location', question: 'Where should this durable setting live?', options: [{ label: 'Current project', description: 'Keep it project scoped.' }, { label: 'Global', description: 'Apply it everywhere.' }] }]
      }
    });
    await eventually(async () => reviewerId && claude.threads.get(reviewerId)?.turns.at(-1), Boolean, 'Claude question reviewer did not start');
    const reviewStart = claudeCalls.find(([method, params]) => method === 'thread/start' && params.threadSource === 'pixiceFocusQuestionReview');
    assert.equal(reviewStart[1].model, 'sonnet');
    const turn = claude.threads.get(reviewerId).turns.at(-1);
    turn.status = 'completed';
    turn.items = [{ id: 'escalate', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({
      action: 'escalate', reason: 'This changes the scope of a durable product setting.',
      questions: { location: { question: 'Should I keep this setting within the current project, or make it global?', recommendation: 'Current project — it is reversible and avoids changing other projects.' } }
    }) }];
    claude.event({ method: 'turn/completed', threadId: reviewerId, turn });
    const attention = await eventually(() => client.call('tasks.interventions'), value => value.requests.some(request => request.id === 'product-choice'));
    const question = attention.requests.find(request => request.id === 'product-choice');
    assert.equal(question.focusCoordinatorQuestion, true);
    assert.equal(question.params.isBlocking, false);
    assert.equal(question.params.questions[0].id, 'location');
    assert.deepEqual(question.params.questions[0].options.map(option => option.label), ['Current project', 'Global']);
    assert.match(question.params.questions[0].question, /current project.*global/i);
    assert.match(question.params.questions[0].coordinatorRecommendation, /Current project/);
    const listed = await tool('list_questions', {}, switched.thread.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].requestGeneration, question.requestGeneration);
    await tool('answer_question', {
      requestId: 'product-choice', requestGeneration: question.requestGeneration, answers: { location: 'Current project' }
    }, switched.thread.id);
    assert.deepEqual(replies.find(reply => reply.id === 'product-choice')?.result.answers, { location: { answers: ['Current project'] } });
    const receipt = (await client.call('focus.state', { projectId: project.id })).events.find(event => event.kind === 'question-answered');
    assert.equal(receipt.source, 'coordinator');
    assert.equal(receipt.wasVisible, true);
    assert.equal(receipt.request.questions[0].id, 'location');
    assert.deepEqual(receipt.answers, { location: ['Current project'] });
  });

  it('asks once for an identical shared worker decision and remaps the answer to both workers', async () => {
    const { client, project, focus, codex, claude, request } = await fixture();
    const workers = await Promise.all([1, 2].map(() => client.call('threads.create', {
      projectId: project.id, model: 'claude:sonnet', parentThreadId: focus.thread.id
    })));
    const original = BackendFixtureProvider.prototype.request;
    let reviewerId;
    request.mockImplementation(async (method, params) => {
      const result = await original.call(codex, method, params);
      if (method === 'thread/start' && params.threadSource === 'pixiceFocusQuestionReview') reviewerId = result.thread.id;
      return result;
    });
    const replies = [];
    claude.respond = (id, result) => replies.push({ id, result });
    workers.forEach(({ thread }, index) => claude.emit('server-request', {
      id: `question-${index}`, method: 'item/tool/requestUserInput', params: {
        threadId: thread.id, questions: [{ id: `choice-${index}`, header: 'Product term', question: 'Should the product call a workspace a project?', options: [{ label: 'Project', description: 'Use project consistently.' }, { label: 'Workspace', description: 'Keep workspace.' }] }]
      }
    }));
    await eventually(async () => reviewerId && codex.threads.get(reviewerId)?.turns.at(-1), value => Boolean(value));
    const turn = codex.threads.get(reviewerId).turns.at(-1);
    turn.status = 'completed';
    turn.items = [{ id: 'review-answer', type: 'agentMessage', text: JSON.stringify({ action: 'escalate', reason: 'This is a new user terminology preference.' }) }];
    codex.event({ method: 'turn/completed', threadId: reviewerId, turn });
    const attention = await eventually(() => client.call('tasks.interventions'), value => value.requests.length === 1);
    const question = attention.requests[0];
    assert.match(question.taskTitle, /2 workers/);
    await client.call('requests.respond', { requestId: question.id, requestGeneration: question.requestGeneration, answers: { 'choice-0': { answers: ['Project'] } } });
    assert.equal(replies.length, 2);
    assert.deepEqual(replies.map(reply => reply.result.answers), [{ 'choice-0': { answers: ['Project'] } }, { 'choice-1': { answers: ['Project'] } }]);
    assert.equal((await client.call('tasks.interventions')).requests.length, 0);
  });

  it('forwards a secret answer without persisting it in Focus receipts', async () => {
    const { client, project, focus, codex } = await fixture();
    const replies = [];
    codex.respond = (id, result) => replies.push({ id, result });
    codex.emit('server-request', { id: 'secret-question', method: 'item/tool/requestUserInput', params: {
      threadId: focus.thread.id,
      questions: [{ id: 'token', header: 'Credential', question: 'Enter the one-time value', isSecret: true, options: [] }]
    } });
    const question = (await client.call('tasks.interventions')).requests.find(item => item.id === 'secret-question');
    await client.call('questions.respond', { requestId: question.id, requestGeneration: question.requestGeneration, action: 'answer', answers: { token: 'private-one-time-value' } });
    assert.deepEqual(replies.find(reply => reply.id === 'secret-question').result.answers.token.answers, ['private-one-time-value']);
    const receipt = (await client.call('focus.state', { projectId: project.id })).events.find(event => event.kind === 'question-answered');
    assert.equal(receipt.redactedCount, 1);
    assert.deepEqual(receipt.answers, {});
    assert.equal(JSON.stringify(receipt).includes('private-one-time-value'), false);
  });

  it('rejects an old approval after a restarted provider reuses its request ID', async () => {
    const { client, project, codex } = await fixture();
    const { thread } = await client.call('threads.create', { projectId: project.id, model: 'codex:fixture-model' });
    const responses = [];
    codex.respond = (id, result) => responses.push({ id, result });
    const approval = { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id } };
    codex.emit('server-request', approval);
    const first = (await client.call('tasks.interventions')).requests.find(request => request.id === 42);
    assert.ok(first);
    await codex.stop();
    await codex.start();
    codex.emit('status', { state: 'ready' });
    codex.emit('server-request', approval);
    const second = (await client.call('tasks.interventions')).requests.find(request => request.id === 42);
    assert.notEqual(second.requestGeneration, first.requestGeneration);
    await assert.rejects(client.call('approvals.resolve', {
      requestId: 42, requestGeneration: first.requestGeneration, decision: 'accept'
    }), /no longer/i);
    assert.equal(responses.length, 0);
    await client.call('approvals.resolve', {
      requestId: 42, requestGeneration: second.requestGeneration, decision: 'decline'
    });
    assert.deepEqual(responses, [{ id: 42, result: { decision: 'decline' } }]);
  });
});
