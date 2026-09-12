import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationClient } from '../electron/connect/application-client.mjs';
import { CONNECT_ERROR_CODES } from '../electron/connect/protocol.mjs';

const response = (result, status = 200) => ({ ok: status < 400, status, json: async () => result });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' })), { once: true });
  });
}

function client() {
  const instance = { id: 'host', endpoint: 'https://pixice.example', token: 'token' };
  const value = new ApplicationClient(instance);
  value.instanceId = 'backend-old';
  value.online = true;
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ApplicationClient intervention request cache', () => {
  it('keeps a newer AttentionRequired generation when a slower read returns', async () => {
    const delayedRead = deferred();
    const approvalDispatches = [];
    let pollCalls = 0;
    const fetch = vi.fn((url, options = {}) => {
      if (url.includes('/poll?')) {
        pollCalls += 1;
        if (pollCalls === 1) return Promise.resolve(response({ events: [{ protocol: 1, type: 'AttentionRequired', sequence: 1, payload: { id: 'request', requestId: 'request', requestGeneration: 42, method: 'approval' } }] }));
        return pendingUntilAbort(options.signal);
      }
      const body = JSON.parse(options.body);
      if (body.operation === 'tasks.interventions') return delayedRead.promise;
      if (body.operation === 'approvals.resolve') {
        approvalDispatches.push(body);
        return Promise.resolve(response({ result: { ok: true } }));
      }
      throw new Error(`Unexpected operation: ${body.operation}`);
    });
    vi.stubGlobal('fetch', fetch);
    const value = client();
    let polling;
    try {
      const read = value.call('tasks.interventions');
      await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/call'))).toHaveLength(1));

      polling = value.poll();
      await vi.waitFor(() => expect(value.requests.get('request')).toBe(42));

      delayedRead.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 41 }] } }));
      await expect(read).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 41 }] });
      expect(value.requests.get('request')).toBe(42);

      await expect(value.call('approvals.resolve', { requestId: 'request', requestGeneration: 42, decision: 'accept' })).resolves.toEqual({ ok: true });
      expect(approvalDispatches).toHaveLength(1);
      expect(approvalDispatches[0].payload.requestGeneration).toBe(42);
    } finally {
      value.close();
      await polling;
    }
  });

  it.each([
    ['AttentionResolved', { protocol: 1, type: 'AttentionResolved', sequence: 1, payload: { requestId: 'request', requestGeneration: 41 } }],
    ['AttentionReset', { protocol: 1, type: 'AttentionReset', sequence: 1, payload: {} }]
  ])('does not repopulate a removed cache entry after %s', async (_label, event) => {
    const delayedRead = deferred();
    let pollCalls = 0;
    const fetch = vi.fn((url, options = {}) => {
      if (url.includes('/poll?')) {
        pollCalls += 1;
        if (pollCalls === 1) return Promise.resolve(response({ events: [event] }));
        return pendingUntilAbort(options.signal);
      }
      const body = JSON.parse(options.body);
      if (body.operation === 'tasks.interventions') return delayedRead.promise;
      throw new Error(`Unexpected operation: ${body.operation}`);
    });
    vi.stubGlobal('fetch', fetch);
    const value = client();
    value.requests.set('request', 40);
    let polling;
    try {
      const read = value.call('tasks.interventions');
      await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/call'))).toHaveLength(1));
      polling = value.poll();
      await vi.waitFor(() => expect(value.attentionRevision).toBe(1));

      delayedRead.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 41 }] } }));
      await expect(read).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 41 }] });
      expect(value.requests.has('request')).toBe(false);
    } finally {
      value.close();
      await polling;
    }
  });

  it('does not repopulate a delayed read after a backend identity reset and accepts generation zero on the new backend', async () => {
    const delayedRead = deferred();
    let delayed = true;
    let pollCalls = 0;
    const approvalDispatches = [];
    const fetch = vi.fn((url, options = {}) => {
      if (url.includes('/poll?')) {
        pollCalls += 1;
        if (pollCalls === 1) return Promise.resolve(response({ events: [{ protocol: 1, type: 'ConnectReset', instanceId: 'backend-new', sequence: 1, payload: { attention: [] } }] }));
        return pendingUntilAbort(options.signal);
      }
      const body = JSON.parse(options.body);
      if (body.operation === 'tasks.interventions') {
        if (delayed) return delayedRead.promise;
        return Promise.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 0 }] } }));
      }
      if (body.operation === 'approvals.resolve') {
        approvalDispatches.push(body);
        return Promise.resolve(response({ result: { ok: true } }));
      }
      throw new Error(`Unexpected operation: ${body.operation}`);
    });
    vi.stubGlobal('fetch', fetch);
    const value = client();
    value.requests.set('request', 41);
    let polling;
    try {
      const read = value.call('tasks.interventions');
      await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/call'))).toHaveLength(1));
      polling = value.poll();
      await vi.waitFor(() => expect(value.instanceId).toBe('backend-new'));

      delayed = false;
      delayedRead.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 41 }] } }));
      await expect(read).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 41 }] });
      expect(value.requests.has('request')).toBe(false);

      await expect(value.call('tasks.interventions')).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 0 }] });
      expect(value.requests.get('request')).toBe(0);
      await expect(value.call('approvals.resolve', { requestId: 'request', requestGeneration: 0, decision: 'accept' })).resolves.toEqual({ ok: true });
      expect(approvalDispatches).toHaveLength(1);
      expect(approvalDispatches[0]).toMatchObject({ instanceId: 'backend-new', payload: { requestGeneration: 0 } });
    } finally {
      value.close();
      await polling;
    }
  });

  it('keeps the latest requested result when overlapping reads finish out of order without a poll event', async () => {
    const firstRead = deferred();
    const secondRead = deferred();
    let interventionCalls = 0;
    const fetch = vi.fn((url, options = {}) => {
      if (!url.endsWith('/call')) throw new Error(`Unexpected route: ${url}`);
      const body = JSON.parse(options.body);
      if (body.operation !== 'tasks.interventions') throw new Error(`Unexpected operation: ${body.operation}`);
      interventionCalls += 1;
      return interventionCalls === 1 ? firstRead.promise : secondRead.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const value = client();
    try {
      const first = value.call('tasks.interventions');
      await vi.waitFor(() => expect(interventionCalls).toBe(1));
      const second = value.call('tasks.interventions');
      await vi.waitFor(() => expect(interventionCalls).toBe(2));

      secondRead.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 42 }] } }));
      await expect(second).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 42 }] });
      firstRead.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 41 }] } }));
      await expect(first).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 41 }] });
      expect(value.requests.get('request')).toBe(42);
    } finally {
      value.close();
    }
  });

  it('populates fresh reads, rejects stale explicit replies before dispatch, and never replays a failed mutation', async () => {
    let mutationCalls = 0;
    const fetch = vi.fn((url, options = {}) => {
      if (!url.endsWith('/call')) throw new Error(`Unexpected route: ${url}`);
      const body = JSON.parse(options.body);
      if (body.operation === 'tasks.interventions') return Promise.resolve(response({ result: { requests: [{ id: 'request', requestGeneration: 7 }] } }));
      if (body.operation === 'turns.start') {
        mutationCalls += 1;
        return Promise.reject(new TypeError('network down'));
      }
      throw new Error(`Unexpected operation: ${body.operation}`);
    });
    vi.stubGlobal('fetch', fetch);
    const value = client();
    try {
      await expect(value.call('tasks.interventions')).resolves.toEqual({ requests: [{ id: 'request', requestGeneration: 7 }] });
      expect(value.requests.get('request')).toBe(7);
      await expect(value.call('approvals.resolve', { requestId: 'request', requestGeneration: 6, decision: 'accept' })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.INVALID_REQUEST, uncertain: false });
      expect(mutationCalls).toBe(0);

      await expect(value.call('turns.start', { projectId: 'project', threadId: 'thread', text: 'once' })).rejects.toMatchObject({ uncertain: true });
      expect(mutationCalls).toBe(1);
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/call'))).toHaveLength(2);
    } finally {
      value.close();
    }
  });
});
