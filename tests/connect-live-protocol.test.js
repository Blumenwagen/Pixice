import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ApplicationClient } from '../electron/connect/application-client.mjs';
import { createRemoteInvoker } from '../electron/connect/remote-operations.mjs';
import { ConnectServer } from '../electron/connect/server.mjs';
import { CONNECT_ERROR_CODES } from '../electron/connect/protocol.mjs';
import { createRemoteClientRegistry } from '../src/connect/client.js';

const hosts = [];
const REPLAY_PENDING_EVENT_LIMIT = 512;
const REPLAY_PENDING_BYTE_LIMIT = 1024 * 1024;

afterEach(async () => {
  for (const close of hosts.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function host(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-connect-live-protocol-'));
  const clientDirectory = path.join(directory, 'client');
  await mkdir(clientDirectory);
  await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Pixice</title>');
  const server = new ConnectServer({
    directory,
    clientDirectory,
    persist: false,
    invoke: async (operation, payload) => ({ operation, payload }),
    ...options
  });
  server.state.enabled = true;
  server.state.port = 0;
  const cleanup = async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  };
  hosts.push(cleanup);
  await server.start();

  const endpoint = () => `http://127.0.0.1:${server.status().port}`;
  const request = async (route, { token, body, headers = {} } = {}) => {
    const response = await fetch(`${endpoint()}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const contentType = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      headers: response.headers,
      body: contentType.includes('json') ? await response.json() : await response.text()
    };
  };
  const pair = async (name = 'Live protocol test') => {
    const offer = server.pairOffer();
    const pairingToken = new URLSearchParams(new URL(offer.url).hash.slice(1)).get('pair');
    return (await request('/api/connect/pair', { body: { token: pairingToken, name } })).body;
  };
  return { server, directory, endpoint, request, pair };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the live protocol condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readSse(reader, { until = () => false, timeoutMs = 3_000 } = {}) {
  const decoder = new TextDecoder();
  let raw = '';
  let done = false;
  let timer;
  const read = async () => {
    while (!done) {
      const next = await reader.read();
      done = next.done;
      if (!done) raw += decoder.decode(next.value, { stream: true });
      const events = [...raw.matchAll(/data: ([^\n]+)\n\n/g)].map((match) => JSON.parse(match[1]));
      if (done || until(events)) return { done, raw, events };
    }
    return { done, raw, events: [] };
  };
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out reading SSE after ${timeoutMs}ms.`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function holdFirstSseWrite({ sendFirst = true } = {}) {
  const originalWrite = http.ServerResponse.prototype.write;
  let heldResponse = null;
  let held = false;
  http.ServerResponse.prototype.write = function patchedSseWrite(...args) {
    const contentType = String(this.getHeader('content-type') ?? '');
    if (contentType.startsWith('text/event-stream') && !held) {
      held = true;
      heldResponse = this;
      if (sendFirst) originalWrite.call(this, ...args);
      return false;
    }
    return originalWrite.call(this, ...args);
  };
  return {
    get held() { return held; },
    get response() { return heldResponse; },
    release() { heldResponse?.emit('drain'); },
    restore() { http.ServerResponse.prototype.write = originalWrite; }
  };
}

function currentStream(server) {
  return server.streams.values().next().value;
}

async function closeReader(reader) {
  try { await reader.cancel(); } catch { /* The server may already have closed the socket. */ }
}

describe('live Connect protocol boundaries', () => {
  it('bounds replay backlog and emits one current reset after a blocked replay and oversized event', async () => {
    const context = await host();
    const { server, endpoint, pair } = context;
    const { token } = await pair();
    server.publish({ type: 'TaskUpdated', payload: { projectId: 'project-a', marker: 'retained-before-replay' } });

    const gate = holdFirstSseWrite();
    let reader;
    const observed = [];
    const originalPublish = server.publish.bind(server);
    server.publish = (event) => {
      const result = originalPublish(event);
      const stream = currentStream(server);
      if (stream) observed.push({ pending: stream.pending.length, pendingBytes: stream.pendingBytes, replayAborted: stream.replayAborted });
      return result;
    };
    try {
      const response = await fetch(`${endpoint()}/api/connect/events?cursor=0&instanceId=${server.instanceId}`, { headers: { Authorization: `Bearer ${token}` } });
      reader = response.body.getReader();
      await waitFor(() => gate.held && server.streams.size === 1);

      for (let index = 0; index < REPLAY_PENDING_EVENT_LIMIT + 8; index += 1) {
        server.publish({ type: 'TaskUpdated', payload: { projectId: 'project-a', marker: `queued-${index}` } });
      }
      server.publish({ type: 'ActivityReceived', payload: { delta: 'x'.repeat(512_001), marker: 'oversized-reset' } });

      const stream = currentStream(server);
      expect(Math.max(...observed.map(({ pending }) => pending))).toBeLessThanOrEqual(REPLAY_PENDING_EVENT_LIMIT);
      expect(Math.max(...observed.map(({ pendingBytes }) => pendingBytes))).toBeLessThanOrEqual(REPLAY_PENDING_BYTE_LIMIT);
      expect(stream).toMatchObject({ replayAborted: true, pending: [], pendingBytes: 0, replayReset: { payload: { reason: 'large-event' } } });

      gate.release();
      const result = await readSse(reader, { until: (events) => events.some((event) => event.type === 'ConnectReady') });
      const resetIndex = result.events.findIndex((event) => event.type === 'ConnectReset' && event.payload.reason === 'large-event');
      expect(resetIndex).toBeGreaterThanOrEqual(0);
      const reset = result.events[resetIndex];
      expect(result.events.slice(resetIndex + 1)).toEqual([expect.objectContaining({ type: 'ConnectReady', sequence: reset.sequence })]);
      expect(result.events.slice(resetIndex + 1).some((event) => String(event.payload?.marker ?? '').startsWith('queued-'))).toBe(false);
      const postResetSequences = result.events.slice(resetIndex).map((event) => event.sequence);
      expect(postResetSequences).toEqual([...postResetSequences].sort((a, b) => a - b));
      expect(server.sequence).toBe(reset.sequence);
      expect(stream.pending).toEqual([]);
      expect(stream.pendingBytes).toBe(0);
    } finally {
      gate.restore();
      await closeReader(reader);
    }
  });

  it('closes a replay whose drain never arrives within the server timeout', async () => {
    const context = await host();
    const { server, endpoint, pair } = context;
    const { token } = await pair();
    server.publish({ type: 'TaskUpdated', payload: { marker: 'drain-timeout' } });

    const gate = holdFirstSseWrite();
    let reader;
    const startedAt = Date.now();
    try {
      const response = await fetch(`${endpoint()}/api/connect/events?cursor=0&instanceId=${server.instanceId}`, { headers: { Authorization: `Bearer ${token}` } });
      reader = response.body.getReader();
      const result = await readSse(reader, { timeoutMs: 3_500 });
      expect(result.done).toBe(true);
      expect(result.events.some((event) => event.type === 'ConnectReady')).toBe(false);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
      await waitFor(() => server.streams.size === 0);
    } finally {
      gate.restore();
      await closeReader(reader);
    }
  });

  it('does not send a protected replay payload after device revocation', async () => {
    const context = await host();
    const { server, endpoint, pair } = context;
    const { token, deviceId } = await pair();
    server.publish({ type: 'TaskUpdated', payload: { protectedMarker: 'must-not-cross-revocation' } });

    const gate = holdFirstSseWrite({ sendFirst: false });
    let reader;
    try {
      const response = await fetch(`${endpoint()}/api/connect/events?cursor=0&instanceId=${server.instanceId}`, { headers: { Authorization: `Bearer ${token}` } });
      reader = response.body.getReader();
      await waitFor(() => gate.held && server.streams.size === 1);
      const reading = readSse(reader, { timeoutMs: 2_000 });
      server.revoke({ id: deviceId });
      const result = await reading;
      expect(result.done).toBe(true);
      expect(result.raw).not.toContain('must-not-cross-revocation');
      expect(result.events.some((event) => event.payload?.protectedMarker === 'must-not-cross-revocation')).toBe(false);
      await waitFor(() => server.streams.size === 0);
    } finally {
      gate.restore();
      await closeReader(reader);
    }
  });

  it.each([
    {
      label: 'approval',
      operation: 'approvals.resolve',
      method: 'item/commandExecution/requestApproval',
      payload: (requestGeneration) => ({ requestId: 7, requestGeneration, decision: 'accept' })
    },
    {
      label: 'question',
      operation: 'questions.respond',
      method: 'item/tool/requestUserInput',
      payload: (requestGeneration) => ({ requestId: 7, requestGeneration, action: 'answer', answers: { choice: 'yes' } })
    }
  ])('keeps the rendered $label generation bound across real attention replacement and calls', async ({ operation, method, payload }) => {
    let runtimeGeneration = 41;
    const pending = new Map();
    const responseHandler = vi.fn(async (_event, value) => {
      pending.delete(String(value.requestId));
      return { ok: true };
    });
    const handlers = new Map([
      ['runtime:status', async () => ({ state: 'ready', connected: true })],
      [operation === 'approvals.resolve' ? 'approvals:resolve' : 'questions:respond', responseHandler]
    ]);
    let server;
    const invoke = createRemoteInvoker({
      handlers,
      pendingRequest: (id) => pending.get(String(id)),
      generation: () => runtimeGeneration,
      hostId: () => server.state.hostId,
      validateThread: async () => {}
    });
    const attention = (generation, requestMethod) => ({ id: 7, requestId: 7, method: requestMethod, requestGeneration: generation });
    pending.set('7', { request: attention(runtimeGeneration, method), generation: runtimeGeneration });
    const context = await host({ invoke, attention: () => [...pending.values()].map(({ request, generation }) => ({ ...request, requestGeneration: generation })) });
    server = context.server;
    const { token } = await context.pair();
    const instance = { id: server.state.hostId, endpoint: context.endpoint(), token };
    const client = new ApplicationClient(instance);
    const freshClient = new ApplicationClient(instance);
    try {
      await client.connect();
      await waitFor(() => client.requests.get('7') === 41);

      runtimeGeneration = 42;
      pending.set('7', { request: attention(runtimeGeneration, method), generation: runtimeGeneration });
      server.publish({ type: 'AttentionRequired', payload: attention(runtimeGeneration, method) });
      await waitFor(() => client.requests.get('7') === 42);

      await expect(client.call(operation, payload(41))).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.INVALID_REQUEST, uncertain: false });
      expect(responseHandler).not.toHaveBeenCalled();
      expect(pending.get('7')).toMatchObject({ generation: 42 });

      freshClient.instanceId = server.instanceId;
      freshClient.online = true;
      await expect(freshClient.call(operation, payload(41))).rejects.toThrow('no longer current');
      expect(responseHandler).not.toHaveBeenCalled();
      expect(pending.get('7')).toMatchObject({ generation: 42 });

      await expect(freshClient.call(operation, payload(42))).resolves.toEqual({ ok: true });
      expect(responseHandler).toHaveBeenCalledOnce();
      expect(responseHandler.mock.calls[0][1]).toMatchObject({ requestId: 7, requestGeneration: 42 });
      await expect(freshClient.call(operation, payload(42))).rejects.toThrow('no longer current');
      expect(responseHandler).toHaveBeenCalledOnce();
    } finally {
      client.close();
      freshClient.close();
    }
  });

  it('keeps command metadata after a dropped response and exposes wire status with current instance and bounded result summary', async () => {
    const commandResultBytes = 128;
    let server;
    const handlers = new Map([
      ['runtime:status', async () => ({ state: 'ready', connected: true })],
      ['turns:start', async () => ({ thread: { id: 'result-thread' }, output: 'x'.repeat(5_000) })]
    ]);
    const invoke = createRemoteInvoker({
      handlers,
      hostId: () => server.state.hostId,
      validateThread: async () => {}
    });
    const context = await host({ invoke, commandResultBytes });
    server = context.server;
    const paired = await context.pair();
    const issued = vi.fn();
    const uncertain = vi.fn();
    const registry = createRemoteClientRegistry({
      getInstance: () => ({ id: server.state.hostId, endpoint: context.endpoint(), token: paired.token, deviceId: paired.deviceId }),
      getOrigin: () => ({ hostId: 'origin-host', projectId: 'origin-project' }),
      onCommandIssued: issued,
      onCommandUncertain: uncertain
    });
    const entry = registry.ensure(server.state.hostId);
    try {
      await entry.connecting;
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (url, options) => {
        const response = await realFetch(url, options);
        if (String(url).includes('/api/connect/call')) throw new TypeError('simulated dropped response');
        return response;
      });
      try {
        await expect(entry.client.call('turns.start', {
          projectId: 'target-project',
          threadId: 'target-thread',
          text: 'private prompt must not enter recovery metadata'
        })).rejects.toMatchObject({ uncertain: true, commandId: expect.any(String) });
      } finally {
        vi.stubGlobal('fetch', realFetch);
      }

      expect(issued).toHaveBeenCalledOnce();
      expect(uncertain).toHaveBeenCalledOnce();
      const issuedDescriptor = issued.mock.calls[0][1];
      const uncertainDescriptor = uncertain.mock.calls[0][1];
      expect(issuedDescriptor).toMatchObject({
        hostId: server.state.hostId,
        deviceId: paired.deviceId,
        originHostId: 'origin-host',
        originProjectId: 'origin-project',
        projectId: 'target-project',
        threadId: 'target-thread',
        operation: 'turns.start'
      });
      expect(uncertainDescriptor).toMatchObject({ commandId: issuedDescriptor.commandId, backendInstanceId: server.instanceId, projectId: 'target-project', threadId: 'target-thread', uncertain: true });
      expect(JSON.stringify(uncertainDescriptor)).not.toContain('private prompt');

      const status = await entry.client.commandStatus(issuedDescriptor.commandId, server.instanceId);
      expect(status).toMatchObject({
        id: issuedDescriptor.commandId,
        instanceId: server.instanceId,
        currentInstanceId: server.instanceId,
        status: 'completed',
        result: { truncated: true, maxBytes: commandResultBytes, resultSummary: { threadId: 'result-thread' } }
      });
    } finally {
      registry.close();
    }
  });
});
