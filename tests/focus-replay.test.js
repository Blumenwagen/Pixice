import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PixiceDatabase } from '../electron/persistence/database.mjs';
import { FocusStore } from '../electron/persistence/focus-store.mjs';
import { FocusSupervisor } from '../electron/runtime/focus-supervisor.mjs';

const temporaryDirectories = [];
const databases = new Set();
const supervisors = new Set();
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
afterEach(() => {
  for (const supervisor of supervisors) supervisor.dispose();
  supervisors.clear();
  for (const database of databases) { try { database.db.close(); } catch {} }
  databases.clear();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(directory) {
  const database = new PixiceDatabase(directory);
  databases.add(database);
  return { database, store: new FocusStore(database) };
}
function fixture(options = {}) {
  const directory = options.directory ?? mkdtempSync(path.join(tmpdir(), 'pixice-focus-replay-'));
  if (!options.directory) temporaryDirectories.push(directory);
  const { database, store } = open(directory);
  if (!database.getProject('project')) database.createProject({ id: 'project', canonicalPath: '/project', displayName: 'Project', folders: ['/project'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const runtime = new EventEmitter();
  runtime.request = vi.fn(options.readThread ?? (async () => { throw new Error('provider offline'); }));
  let index = 0;
  const startWorker = vi.fn(options.startWorker ?? (async () => ({ threadId: `worker-${++index}`, turnId: `turn-${index}` })));
  const deliver = vi.fn(options.deliver ?? (async () => ({ accepted: true, turnId: 'coordinator-turn' })));
  const interruptWorker = vi.fn(options.interruptWorker ?? (async () => {}));
  const supervisor = new FocusSupervisor({ store, runtime, startWorker, deliver, interruptWorker,
    continueWorker: vi.fn(async ({ threadId }) => ({ threadId, turnId: `${threadId}-next` })),
    resolveDelivery: options.resolveDelivery,
    contextForProject: async () => ({ coordinatorThreadId: 'coordinator', cwd: '/project' }) });
  supervisors.add(supervisor);
  return { directory, database, store, supervisor, runtime, startWorker, interruptWorker, deliver };
}
const completion = (work, overrides = {}) => ({ method: 'turn/completed', threadId: work.threadId,
  turn: { id: work.turnId, status: 'completed', items: [{ type: 'agentMessage', text: 'Verified result' }], ...overrides } });

// Reference: T3 Orchestrator V2 command/event transactions, process-bound
// EffectOutbox recovery, and acceptance distinct from completion observation.
describe('durable Focus lifecycle and delivery replay', () => {
  it('rolls back work state when its outbox event cannot commit', () => {
    const { database, store } = fixture();
    const work = store.createWork('project', { title: 'Atomic', status: 'running', threadId: 'worker', turnId: 'turn' });
    database.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON focus_events WHEN NEW.kind='review-ready' BEGIN SELECT RAISE(ABORT, 'simulated event crash'); END;");
    expect(() => store.transitionWork('project', work.id, { status: 'review', answer: 'result' },
      { id: 'terminal-command', kind: 'review-ready', message: 'ready' })).toThrow(/simulated event crash/);
    expect(store.getWork('project', work.id)).toMatchObject({ status: 'running', answer: '', revision: work.revision });
    expect(store.listEvents('project')).toHaveLength(0);
    database.db.exec('DROP TRIGGER reject_review');
    const committed = store.transitionWork('project', work.id, { status: 'review', answer: 'result' },
      { id: 'terminal-command', kind: 'review-ready', message: 'ready' });
    store.transitionWork('project', work.id, { status: 'review', answer: 'result' },
      { id: 'terminal-command', kind: 'review-ready', message: 'ready' });
    expect(store.getWork('project', work.id).revision).toBe(committed.revision);
    expect(store.listEvents('project')).toHaveLength(1);
  });

  it('commits a direction, affected revisions and events together or none of them', () => {
    const { database, store } = fixture();
    const work = store.createWork('project', { title: 'Directions' });
    database.db.exec("CREATE TRIGGER reject_direction BEFORE INSERT ON focus_events WHEN NEW.kind='direction-recorded' BEGIN SELECT RAISE(ABORT, 'direction crash'); END;");
    expect(() => store.recordDecision('project', { commandId: 'direction-command', text: 'Use exact turns' })).toThrow(/direction crash/);
    expect(store.listDecisions('project')).toHaveLength(0);
    expect(store.getWork('project', work.id).decisionRevision).toBe(0);
    database.db.exec('DROP TRIGGER reject_direction');
    const decision = store.recordDecision('project', { commandId: 'direction-command', text: 'Use exact turns' });
    store.recordDecision('project', { commandId: 'direction-command', text: 'Use exact turns' });
    expect(store.listDecisions('project')).toHaveLength(1);
    expect(store.getWork('project', work.id).decisionRevision).toBe(decision.revision);
    expect(store.listEvents('project').filter(event => event.kind === 'direction-recorded')).toHaveLength(1);
  });

  it('claims before delivery and holds a lost acceptance response through restart', async () => {
    const lostResponse = vi.fn(async ({ metadata }) => {
      expect(metadata.deliveryId).toMatch(/^focus-delivery:/);
      expect(metadata.messageId).toMatch(/^focus-message:/);
      throw new Error('provider accepted, response lost');
    });
    const first = fixture({ deliver: lostResponse });
    const work = await first.supervisor.dispatch('project', { title: 'Deliver result', prompt: 'work', access: 'read' });
    await tick();
    first.runtime.emit('event', completion(first.store.getWork('project', work.id)));
    await tick();
    expect(first.store.listDeliveries('project')[0].state).toBe('uncertain');
    expect(first.store.getWork('project', work.id).completionReported).toBe(false);
    await first.supervisor.flush('project');
    expect(first.deliver).toHaveBeenCalledTimes(1);
    const claim = first.store.listDeliveries('project')[0];
    first.supervisor.dispose(); first.database.db.close(); databases.delete(first.database);
    const resolver = vi.fn(async request => {
      expect(request.messageId).toBe(claim.messageId);
      return { state: 'accepted', turnId: 'accepted-coordinator-turn' };
    });
    const second = fixture({ directory: first.directory, resolveDelivery: resolver });
    await second.supervisor.reconcile('project');
    expect(second.deliver).not.toHaveBeenCalled();
    expect(second.store.listDeliveries('project')[0]).toMatchObject({ state: 'accepted', turnId: 'accepted-coordinator-turn' });
    expect(second.store.getWork('project', work.id).completionReported).toBe(true);
    // Provider acceptance does not claim the coordinator has inspected the result.
    second.supervisor.inspect('project', work.id);
    expect(second.store.listDeliveries('project')[0].state).toBe('observed');
  });

  it('does not replay an in-flight claim after process loss without exact acceptance evidence', async () => {
    const never = deferred();
    const first = fixture({ deliver: () => never.promise });
    const work = await first.supervisor.dispatch('project', { title: 'Claim', access: 'read' });
    await tick(); first.runtime.emit('event', completion(first.store.getWork('project', work.id))); await tick();
    expect(first.store.listDeliveries('project')[0].state).toBe('claimed');
    first.supervisor.dispose(); first.database.db.close(); databases.delete(first.database);
    const second = fixture({ directory: first.directory, resolveDelivery: async () => ({ state: 'unknown' }) });
    await second.supervisor.reconcile('project'); await second.supervisor.flush('project');
    expect(second.store.listDeliveries('project')[0].state).toBe('uncertain');
    expect(second.deliver).not.toHaveBeenCalled();
    never.resolve({ accepted: true });
    await tick();
  });

  it('reuses the stable message identity only after proving a claim was not delivered', async () => {
    const first = fixture({ deliver: async () => { throw new Error('lost response'); } });
    const work = await first.supervisor.dispatch('project', { title: 'Retry', access: 'read' });
    await tick(); first.runtime.emit('event', completion(first.store.getWork('project', work.id))); await tick();
    const metadata = first.deliver.mock.calls[0][0].metadata;
    const claim = first.store.listDeliveries('project')[0];
    first.deliver.mockResolvedValue({ accepted: true, turnId: 'retry-turn' });
    first.supervisor.reconcileDelivery('project', claim.id, { state: 'not-delivered' });
    await tick();
    expect(first.deliver).toHaveBeenCalledTimes(2);
    expect(first.deliver.mock.calls[1][0].metadata).toEqual(metadata);
    expect(first.store.listDeliveries('project')[0].state).toBe('accepted');
  });

  it('rolls back acceptance and work reporting if delivery event markers fail to commit', () => {
    const { database, store } = fixture();
    const work = store.createWork('project', { title: 'Accept', status: 'review' });
    const event = store.appendEvent('project', { workId: work.id, kind: 'review-ready' });
    const claim = store.claimDelivery('project', 'coordinator', [event.id]);
    database.db.exec("CREATE TRIGGER reject_accept BEFORE UPDATE OF delivered_at ON focus_events BEGIN SELECT RAISE(ABORT, 'acceptance crash'); END;");
    expect(() => store.settleDelivery('project', claim.id, { state: 'accepted', turnId: 'paid-turn' })).toThrow(/acceptance crash/);
    expect(store.listDeliveries('project')[0].state).toBe('claimed');
    expect(store.getWork('project', work.id).completionReported).toBe(false);
    expect(store.listEvents('project')[0].deliveredAt).toBeNull();
  });
});

describe('confirmed worker stopping', () => {
  it.each(['pause', 'cancel'])('reserves worker capacity and overlapping resources after %s RPC acceptance', async action => {
    let live;
    const f = fixture({ readThread: async () => ({ thread: { turns: [{ id: live.turnId, status: 'inProgress' }] } }) });
    const work = await f.supervisor.dispatch('project', { title: 'First', resources: ['src/shared'] });
    await tick(); live = f.store.getWork('project', work.id);
    await f.supervisor.control('project', work.id, { action }); await tick();
    expect(f.store.getWork('project', work.id)).toMatchObject({ stopRequested: action, status: action === 'cancel' ? 'cancelling' : 'running' });
    const queued = await f.supervisor.dispatch('project', { title: 'Overlap', resources: ['src/shared/child'] });
    await tick(); expect(f.startWorker).toHaveBeenCalledTimes(1);
    expect(f.store.getWork('project', queued.id).status).toBe('queued');
    f.runtime.emit('event', completion(live, { id: 'stale-turn', status: 'interrupted' })); await tick();
    expect(f.startWorker).toHaveBeenCalledTimes(1);
    f.runtime.emit('event', completion(live, { status: 'interrupted', items: [] })); await tick();
    expect(f.store.getWork('project', work.id).status).toBe(action === 'pause' ? 'paused' : 'cancelled');
    expect(f.startWorker).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a terminal event arriving inside interrupt RPC with a later error', async () => {
    let f;
    f = fixture({ interruptWorker: async request => {
      f.runtime.emit('event', { method: 'turn/completed', threadId: request.threadId, turn: { id: request.turnId, status: 'interrupted', items: [] } });
      throw new Error('late interrupt transport failure');
    } });
    const work = await f.supervisor.dispatch('project', { title: 'Reentrant' }); await tick();
    const result = await f.supervisor.control('project', work.id, { action: 'cancel' }); await tick();
    expect(result).toMatchObject({ status: 'cancelled', error: null });
    expect(f.store.getWork('project', work.id).status).toBe('cancelled');
  });

  it('reconciles exact stopping turn on restart, preserving directions and verification state', async () => {
    const first = fixture();
    const work = first.store.createWork('project', { title: 'Stopping', status: 'cancelling', stopRequested: 'cancel', threadId: 'worker', turnId: 'exact-turn',
      decisionRevision: 2, acknowledgedDecisionRevision: 1, verification: { status: 'passed', evidence: 'prior checks' } });
    first.database.db.close(); databases.delete(first.database); first.supervisor.dispose();
    const second = fixture({ directory: first.directory, readThread: async () => ({ thread: { turns: [
      { id: 'other-turn', status: 'inProgress' }, { id: 'exact-turn', status: 'interrupted', items: [] }
    ] } }) });
    await second.supervisor.reconcile('project');
    expect(second.store.getWork('project', work.id)).toMatchObject({ status: 'cancelled', decisionRevision: 2, acknowledgedDecisionRevision: 1,
      verification: { status: 'passed', evidence: 'prior checks' } });
    expect(second.startWorker).not.toHaveBeenCalled();
  });

  it('retains an unconfirmed stop reservation when the exact turn cannot be read', async () => {
    const f = fixture();
    const work = await f.supervisor.dispatch('project', { title: 'Stop unavailable', resources: ['src/shared'] }); await tick();
    await f.supervisor.control('project', work.id, { action: 'pause' }); await tick();
    expect(f.store.getWork('project', work.id)).toMatchObject({ status: 'needs-attention', stopRequested: 'pause' });
    await f.supervisor.dispatch('project', { title: 'Next', resources: ['src/shared'] }); await tick();
    expect(f.startWorker).toHaveBeenCalledTimes(1);
    await expect(f.supervisor.control('project', work.id, { action: 'resume' })).rejects.toThrow(/settle/);
  });
});
