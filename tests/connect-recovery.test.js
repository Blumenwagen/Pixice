import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationClient, requestJson } from '../electron/connect/application-client.mjs';
import { ConnectServer } from '../electron/connect/server.mjs';
import { CONNECT_ERROR_CODES, CONNECT_LIMITS, CONNECT_RECOVERY_EVENTS } from '../electron/connect/protocol.mjs';
import { sanitizeRecoveryRecord } from '../src/connect/recovery.js';

const hosts = [];
afterEach(async () => {
  for (const { server, directory } of hosts.splice(0)) {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function host(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-connect-recovery-'));
  const clientDirectory = path.join(directory, 'client');
  await mkdir(clientDirectory);
  await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Pixice</title>');
  const invoke = options.invoke ?? vi.fn(async (operation, payload) => ({ operation, payload }));
  const server = new ConnectServer({ directory, clientDirectory, invoke, ...options });
  server.state.enabled = true;
  server.state.port = 0;
  hosts.push({ server, directory });
  await server.start();
  let activeServer = server;
  const request = async (route, body, token, headers = {}) => {
    const endpoint = `http://127.0.0.1:${activeServer.status().port}`;
    const response = await fetch(`${endpoint}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  const pair = async (name = 'Test browser') => {
    const offer = activeServer.pairOffer();
    const pairingToken = new URLSearchParams(new URL(offer.url).hash.slice(1)).get('pair');
    return { offer, pairingToken, ...(await request('/api/connect/pair', { token: pairingToken, name })).body };
  };
  const call = (operation, payload, extra = {}) => ({ operation, payload, instanceId: activeServer.instanceId, id: randomUUID(), issuedAt: Date.now(), ...extra });
  const restart = async () => {
    await activeServer.stop();
    const restarted = new ConnectServer({ directory, clientDirectory, invoke, ...options });
    restarted.state.enabled = true;
    restarted.state.port = 0;
    hosts[hosts.length - 1].server = restarted;
    await restarted.start();
    activeServer = restarted;
    return restarted;
  };
  return { server, get activeServer() { return activeServer; }, request, pair, call, invoke, restart };
}

describe('Connect recovery contracts', () => {
  it('keeps bounded origin identifiers in recovery metadata without retaining command data', () => {
    const record = sanitizeRecoveryRecord({
      hostId: 'target-host', deviceId: 'device-1', commandId: 'command-1', backendInstanceId: 'backend-1', operation: 'threads.create', issuedAt: Date.now(),
      projectId: 'target-project', threadId: 'target-thread', originHostId: 'origin-host', originProjectId: 'origin-project', prompt: 'private prompt', result: { secret: true }
    });
    expect(record).toMatchObject({ originHostId: 'origin-host', originProjectId: 'origin-project', projectId: 'target-project', threadId: 'target-thread' });
    expect(JSON.stringify(record)).not.toContain('private prompt');
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('returns machine-readable restart errors and keeps stale commands out of pairing state', async () => {
    const { server, pair, request, call } = await host();
    const { token } = await pair();
    const response = await request('/api/connect/call', call('turns.start', {}, { instanceId: 'old-instance' }), token);
    expect(response).toMatchObject({ status: 409, body: { code: CONNECT_ERROR_CODES.HOST_RESTARTED, status: 409 } });
    expect(response.body.error).toContain('restarted');

    const onState = vi.fn();
    const client = new ApplicationClient({ id: server.state.hostId, endpoint: 'https://pixice.example', token }, { onState });
    client.instanceId = 'old-instance';
    client.online = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'The host restarted.', code: CONNECT_ERROR_CODES.HOST_RESTARTED, status: 409 }) })));
    await expect(client.call('turns.start', {})).rejects.toMatchObject({ status: 409, code: CONNECT_ERROR_CODES.HOST_RESTARTED });
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: 'reconnecting', resync: true }));
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'unauthorized' }));
    client.close();
  });

  it('exposes authenticated session capabilities without public credential data', async () => {
    const { server, pair, request } = await host({ version: 'development-secret-looking-version' });
    const { token } = await pair();
    const response = await request('/api/connect/session', undefined, token);
    expect(response).toMatchObject({
      status: 200,
      body: {
        role: 'operator',
        projectIds: null,
        limits: { maxBodyBytes: CONNECT_LIMITS.maxBodyBytes, maxAttachmentBytes: CONNECT_LIMITS.maxAttachmentBytes, maxAttachments: CONNECT_LIMITS.maxAttachments },
        transport: { poll: true, sse: true },
        transfers: {
          uploads: false,
          downloads: false,
          limits: expect.objectContaining({ maxFileBytes: expect.any(Number), maxFiles: expect.any(Number), maxProjectBytes: expect.any(Number), maxGlobalBytes: expect.any(Number), chunkBytes: expect.any(Number), ttlMs: expect.any(Number), maxDownloadBytes: expect.any(Number) })
        },
        push: { supported: false },
        host: { name: server.state.name.slice(0, 80), version: 'development-secret-looking-version' }
      }
    });
    expect(response.body.operations).toContain('turns.start');
    expect(response.body.operations).toContain('projects.directories');
    expect(JSON.stringify(response.body)).not.toContain('tokenHash');
    expect((await request('/api/connect/session')).status).toBe(401);
    expect((await request('/api/connect/info')).body).not.toHaveProperty('operations');
    expect(server.session().devices).toBeUndefined();
  });

  it('allocates read, mutation, and control budgets per device, after pre-auth IP limits', async () => {
    const { pair, request, call } = await host({ preauthRateLimit: 1, deviceRateLimits: { poll: 10, read: 1, mutation: 1, control: 1 } });
    const first = await pair('First');
    const second = await pair('Second');
    expect((await request('/api/connect/session', undefined, 'not-a-token')).status).toBe(401);
    expect((await request('/api/connect/call', call('turns.start', { value: 1 }), first.token)).status).toBe(200);
    expect((await request('/api/connect/call', call('turns.start', { value: 2 }), first.token)).body.code).toBe(CONNECT_ERROR_CODES.RATE_LIMITED);
    expect((await request('/api/connect/call', call('turns.start', { value: 3 }), second.token)).status).toBe(200);
    expect((await request('/api/connect/call', call('turns.interrupt', { turnId: 'turn' }), first.token)).status).toBe(200);
    expect((await request('/api/connect/call', call('turns.interrupt', { turnId: 'turn-2' }), first.token)).body.code).toBe(CONNECT_ERROR_CODES.RATE_LIMITED);
  });

  it('keeps valid devices independent when they share a proxy address during reads and controls', async () => {
    const context = await host({ preauthRateLimit: 1, deviceRateLimits: { poll: 4, read: 4, mutation: 2, control: 2 } });
    const first = await context.pair('First');
    const second = await context.pair('Second');
    const readRequests = [first, first, second, second].map(({ token }) => context.request('/api/connect/call', context.call('browser.frame', { workspaceId: 'task', tabId: 'tab' }), token));
    const pollRequests = [first, second].map(({ token }) => context.request(`/api/connect/poll?cursor=0&instanceId=${context.activeServer.instanceId}&wait=0`, undefined, token));
    expect((await Promise.all([...readRequests, ...pollRequests])).every(({ status }) => status === 200)).toBe(true);
    const controls = await Promise.all([
      context.request('/api/connect/call', context.call('turns.interrupt', { turnId: 'first' }), first.token),
      context.request('/api/connect/call', context.call('turns.interrupt', { turnId: 'second' }), second.token)
    ]);
    expect(controls.map(({ status }) => status)).toEqual([200, 200]);
  });

  it('delivers bounded ordered poll batches while keeping priority events in order', async () => {
    const { server, pair, request } = await host({ pollBatchSize: 2 });
    const { token } = await pair();
    server.publish({ type: 'ActivityReceived', payload: { delta: 'one' } });
    server.publish({ type: 'ActivityReceived', payload: { delta: 'two' } });
    server.publish({ type: 'ActivityReceived', payload: { delta: 'three' } });
    const first = await request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    expect(first.body.events.map((event) => event.sequence)).toEqual([1, 2]);
    const second = await request(`/api/connect/poll?cursor=2&instanceId=${server.instanceId}`, undefined, token);
    expect(second.body.events.map((event) => event.sequence)).toEqual([3]);
  });

  it('coalesces ordinary waiting polls but wakes priority state immediately', async () => {
    const { server, pair, request } = await host({ pollCoalesceMs: 150 });
    const { token } = await pair();
    const ordinaryStarted = Date.now();
    const ordinary = request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    await vi.waitFor(() => expect(server.polls.size).toBe(1));
    server.publish({ type: 'ActivityReceived', payload: { delta: 'ordinary' } });
    expect(server.polls.size).toBe(1);
    expect((await ordinary).body.events.map((event) => event.sequence)).toEqual([1]);
    expect(Date.now() - ordinaryStarted).toBeGreaterThanOrEqual(100);

    const priorityStarted = Date.now();
    const priority = request(`/api/connect/poll?cursor=1&instanceId=${server.instanceId}`, undefined, token);
    await vi.waitFor(() => expect(server.polls.size).toBe(1));
    server.publish({ type: 'AttentionRequired', payload: { id: 'approval-1', method: 'approval' } });
    expect((await priority).body.events[0]).toMatchObject({ sequence: 2, type: 'AttentionRequired' });
    expect(Date.now() - priorityStarted).toBeLessThan(100);
  });

  it('reports pending, completed, failed, device-owned, and post-restart unknown commands', async () => {
    let finish;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const context = await host({ invoke, commandResultBytes: 1024 });
    const first = await context.pair('First');
    const second = await context.pair('Second');
    const body = context.call('turns.start', { text: 'once' });
    const sent = context.request('/api/connect/call', body, first.token);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(await context.request(`/api/connect/commands/${body.id}?instanceId=${body.instanceId}`, undefined, first.token)).toMatchObject({ body: { id: body.id, status: 'pending', result: null } });
    expect(await context.request(`/api/connect/commands/${body.id}?instanceId=${body.instanceId}`, undefined, second.token)).toMatchObject({ body: { id: body.id, status: 'unknown', result: null } });
    finish({ output: 'x'.repeat(5_000) });
    await expect(sent).resolves.toMatchObject({ status: 200, body: { result: { output: 'x'.repeat(5_000) } } });
    const completed = await context.request(`/api/connect/commands/${body.id}?instanceId=${body.instanceId}`, undefined, first.token);
    expect(completed.body).toMatchObject({ status: 'completed', result: { truncated: true, maxBytes: 1024 } });

    invoke.mockImplementationOnce(async () => { throw new Error('Action failed'); });
    const failedBody = context.call('turns.start', { text: 'fail' });
    expect((await context.request('/api/connect/call', failedBody, first.token)).body).toMatchObject({ code: CONNECT_ERROR_CODES.ACTION_FAILED });
    expect(await context.request(`/api/connect/commands/${failedBody.id}`, undefined, first.token)).toMatchObject({ body: { status: 'failed', error: 'Action failed', result: null } });

    const restarted = await context.restart();
    expect(await context.request(`/api/connect/commands/${body.id}?instanceId=${restarted.instanceId}`, undefined, first.token)).toMatchObject({ body: { id: body.id, status: 'unknown', result: null } });
  });

  it('expires completed command records during a status lookup and retains only bounded metadata', async () => {
    const context = await host({ invoke: async () => ({ ok: true }) });
    const first = await context.pair('First');
    const body = context.call('turns.start', {
      projectId: 'p'.repeat(500), threadId: 't'.repeat(500), text: 'private prompt', attachments: [{ dataUrl: 'data:text/plain;base64,cHJpdmF0ZQ==', name: 'private.txt', size: 7 }]
    });
    await context.request('/api/connect/call', body, first.token);
    const record = context.activeServer.operations.get(`${first.deviceId}:${body.id}`);
    expect(record).toMatchObject({ projectId: 'p'.repeat(256), threadId: 't'.repeat(256), status: 'completed' });
    expect(record).not.toHaveProperty('payload');
    expect(JSON.stringify(record)).not.toContain('private prompt');
    record.until = Date.now() - 1;
    expect(await context.request(`/api/connect/commands/${body.id}?instanceId=${body.instanceId}`, undefined, first.token)).toMatchObject({ body: { id: body.id, status: 'unknown', result: null } });
    expect(context.activeServer.operations.has(`${first.deviceId}:${body.id}`)).toBe(false);
  });

  it('rejects oversized attachment counts and decoded files before invoking a mutation', async () => {
    const context = await host();
    const { token } = await context.pair();
    const tooMany = context.call('turns.start', { attachments: Array.from({ length: CONNECT_LIMITS.maxAttachments + 1 }, () => ({ name: 'x.txt', size: 0, dataUrl: 'data:text/plain;base64,' })) });
    const manyResponse = await context.request('/api/connect/call', tooMany, token);
    expect(manyResponse).toMatchObject({ status: 413, body: { code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE, status: 413 } });
    const tooLarge = context.call('turns.start', { attachments: [{ name: 'large.bin', size: CONNECT_LIMITS.maxAttachmentBytes + 1, dataUrl: 'data:application/octet-stream;base64,' }] });
    const largeResponse = await context.request('/api/connect/call', tooLarge, token);
    expect(largeResponse).toMatchObject({ status: 413, body: { code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE, status: 413 } });
    expect(context.invoke).not.toHaveBeenCalled();
  });

  it('rejects oversized encoded JSON before sending and does not label it uncertain', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(requestJson('https://pixice.example', 'call', { body: { text: 'x'.repeat(CONNECT_LIMITS.maxBodyBytes) } })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE, uncertain: false });
    expect(fetch).not.toHaveBeenCalled();

    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'instance';
    client.online = true;
    await expect(client.call('turns.start', { text: 'x'.repeat(CONNECT_LIMITS.maxBodyBytes) })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE, uncertain: false, commandId: expect.any(String), command: { uncertain: false } });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it('retains bounded uncertainty metadata for lost mutation responses and excludes read failures', async () => {
    const onState = vi.fn();
    const uncertain = vi.fn();
    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' }, { onState, onCommandUncertain: uncertain });
    client.instanceId = 'backend-1';
    client.online = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } })));
    await expect(client.call('turns.start', { projectId: 'p', threadId: 't', text: 'do not retain me', attachments: [{ dataUrl: 'secret' }] })).rejects.toMatchObject({
      status: 200, code: CONNECT_ERROR_CODES.INVALID_RESPONSE, uncertain: true, commandId: expect.any(String),
      command: { operation: 'turns.start', backendInstanceId: 'backend-1', projectId: 'p', threadId: 't', uncertain: true }
    });
    expect(uncertain).toHaveBeenCalledOnce();
    expect(JSON.stringify(uncertain.mock.calls[0][0])).not.toContain('do not retain me');
    expect(JSON.stringify(client.listUncertainCommands())).not.toContain('secret');
    const commandId = client.listUncertainCommands()[0].commandId;
    expect(client.resolveUncertainCommand(commandId)).toBe(true);
    expect(client.listUncertainCommands()).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Conflict', code: CONNECT_ERROR_CODES.CONFLICT, status: 409 }) })));
    await expect(client.call('turns.start', { projectId: 'p' })).rejects.toMatchObject({ status: 409, code: CONNECT_ERROR_CODES.CONFLICT, uncertain: false, command: { uncertain: false } });
    expect(client.online).toBe(true);
    expect(onState).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } })));
    await expect(client.call('runtime.status')).rejects.toMatchObject({ status: 200, code: CONNECT_ERROR_CODES.INVALID_RESPONSE, uncertain: false });
    expect(client.listUncertainCommands()).toEqual([]);
    client.close();
  });

  it('marks a proxy 5xx mutation response uncertain without retrying it', async () => {
    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'backend-1';
    client.online = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'upstream unavailable', code: 'UPSTREAM_UNAVAILABLE', status: 503 }) })));
    await expect(client.call('turns.start', { projectId: 'p' })).rejects.toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE', uncertain: true, command: { commandId: expect.any(String), uncertain: true } });
    expect(client.listUncertainCommands()).toHaveLength(1);
    client.close();
  });

  it('falls back cleanly when an older host has no session endpoint', async () => {
    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Unknown endpoint', code: CONNECT_ERROR_CODES.NOT_FOUND, status: 404 }) }));
    vi.stubGlobal('fetch', fetch);
    await expect(client.getCapabilities()).resolves.toBeNull();
    expect(client.capabilities).toBeNull();
  });

  it('emits issued and settled descriptors only after transport preflight succeeds', async () => {
    const events = [];
    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'backend-1';
    client.online = true;
    client.subscribe((event) => events.push(event));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { thread: { id: 'thread-1' } } }) })));
    await client.call('turns.start', { projectId: 'project-1', threadId: 'thread-1', text: 'start' });
    expect(events.map((event) => event.type)).toEqual([CONNECT_RECOVERY_EVENTS.issued, CONNECT_RECOVERY_EVENTS.settled]);
    expect(events[0].payload).toMatchObject({ operation: 'turns.start', commandId: expect.any(String), backendInstanceId: 'backend-1', projectId: 'project-1', threadId: 'thread-1' });
    expect(events[1].payload).toMatchObject({ outcome: 'completed', commandId: events[0].payload.commandId });

    events.length = 0;
    await expect(client.call('turns.start', { text: 'x'.repeat(CONNECT_LIMITS.maxBodyBytes) })).rejects.toMatchObject({ uncertain: false });
    expect(events).toEqual([]);
    client.close();
  });

  it('rejects an old explicit response generation before dispatch and never upgrades it', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = new ApplicationClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'backend-1';
    client.online = true;
    client.requests.set('request-7', 2);
    await expect(client.call('approvals.resolve', { requestId: 'request-7', requestGeneration: 1, decision: 'accept' })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.INVALID_REQUEST, uncertain: false });
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it('returns OUTCOME_UNAVAILABLE after a dispatched mutation loses authorization', async () => {
    let finish;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const context = await host({ invoke });
    const { token, deviceId } = await context.pair();
    const client = new ApplicationClient({ id: context.server.state.hostId, endpoint: `http://127.0.0.1:${context.server.status().port}`, token });
    client.instanceId = context.server.instanceId;
    client.online = true;
    const call = client.call('turns.start', { projectId: 'project-1', threadId: 'thread-1', text: 'delayed' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    context.server.revoke({ id: deviceId });
    finish({ thread: { id: 'thread-1' } });
    await expect(call).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.OUTCOME_UNAVAILABLE, uncertain: true });
    expect(invoke).toHaveBeenCalledOnce();
    expect([...context.server.operations.values()][0]).toMatchObject({ projectId: 'project-1', threadId: 'thread-1', status: 'completed' });
    client.close();
  });
});
