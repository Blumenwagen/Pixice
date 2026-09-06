import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectServer } from '../electron/connect/server.mjs';
import { normalizeEndpoint, OPERATIONS } from '../electron/connect/protocol.mjs';

const hosts = [];
afterEach(async () => { for (const { server, directory } of hosts.splice(0)) { await server.stop(); await rm(directory, { recursive: true, force: true }); } });
async function host(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-connect-test-'));
  const clientDirectory = path.join(directory, 'client');
  await mkdir(clientDirectory);
  await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Pixice</title>');
  const invoke = options.invoke ?? vi.fn(async (operation, payload) => ({ operation, payload }));
  const server = new ConnectServer({ directory, clientDirectory, invoke, ...options });
  server.state.enabled = true;
  server.state.port = 0;
  hosts.push({ server, directory });
  await server.start();
  const endpoint = `http://127.0.0.1:${server.status().port}`;
  const request = async (route, body, token, headers = {}) => {
    const response = await fetch(`${endpoint}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  const pair = async () => {
    const offer = server.pairOffer();
    const token = new URLSearchParams(new URL(offer.url).hash.slice(1)).get('pair');
    return { offer, pairingToken: token, ...(await request('/api/connect/pair', { token, name: 'Test browser' })).body };
  };
  const call = (operation, payload, extra = {}) => ({ operation, payload, instanceId: server.instanceId, id: randomUUID(), issuedAt: Date.now(), ...extra });
  return { server, directory, endpoint, request, pair, call, invoke };
}

describe('Pixice Connect host boundary', () => {
  it('starts disabled and rejects insecure remote endpoint configuration', async () => {
    expect(() => normalizeEndpoint('http://192.168.1.5:43187')).toThrow('HTTPS');
    expect(() => normalizeEndpoint('https://user:password@example.com')).toThrow();
    expect(() => normalizeEndpoint('https://example.com/other')).toThrow();
    expect(normalizeEndpoint('https://pixice.example.com/')).toBe('https://pixice.example.com');
    const { server } = await host();
    await expect(server.configure({ enabled: true, host: '0.0.0.0', port: 43187 })).rejects.toThrow('TLS');
    await expect(server.configure({ enabled: true, port: 80 })).rejects.toThrow('Port');
  });

  it('keeps the host disabled after corrupt state and refuses missing TLS after restart', async () => {
    const { server, directory } = await host();
    await server.stop();
    server.state.host = '0.0.0.0'; server.save();
    const restarted = new ConnectServer({ directory, invoke: async () => true });
    await expect(restarted.start()).rejects.toThrow('TLS');
    expect(restarted.status().running).toBe(false);
    const missingFiles = new ConnectServer({ directory, tlsFiles: { cert: path.join(directory, 'missing.pem'), key: path.join(directory, 'missing.key') } });
    await expect(missingFiles.start()).rejects.toThrow('TLS files');
    expect(missingFiles.status().running).toBe(false);
    await writeFile(path.join(directory, 'connect.json'), '{corrupt');
    const corrupt = new ConnectServer({ directory, invoke: async () => true });
    await corrupt.start();
    expect(corrupt.status()).toMatchObject({ enabled: false, running: false });
    expect(corrupt.status().error).toContain('could not be read');
  });

  it('exchanges a single-use pairing offer and never persists or returns credential hashes in status', async () => {
    const { server, directory, request, pair } = await host();
    const device = await pair();
    expect(device.token).toHaveLength(43);
    expect((await request('/api/connect/pair', { token: device.pairingToken, name: 'Attacker' })).status).toBe(401);
    const disk = await readFile(path.join(directory, 'connect.json'), 'utf8');
    expect(disk).not.toContain(device.token);
    expect(disk).not.toContain(device.pairingToken);
    expect(JSON.stringify(server.status())).not.toContain('tokenHash');
    expect((await request('/api/connect/call', {}, undefined)).status).toBe(401);
    expect(server.status().devices).toHaveLength(1);
  });

  it('rejects expired offers, expired devices, hostile origins and DNS rebinding', async () => {
    const { server, pair, request, endpoint } = await host();
    const offer = server.pairOffer();
    server.state.offers[0].expiresAt = 0;
    expect((await request('/api/connect/pair', { token: new URLSearchParams(new URL(offer.url).hash.slice(1)).get('pair'), name: 'Expired' })).status).toBe(401);
    const device = await pair();
    expect((await request('/api/connect/info', undefined, undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    const badHostStatus = await new Promise((resolve, reject) => { const req = http.get(`${endpoint}/api/connect/info`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    expect(badHostStatus).toBe(403);
    server.state.devices[0].expiresAt = 0;
    expect((await request('/api/connect/poll', undefined, device.token)).status).toBe(401);
  });

  it('deduplicates simultaneous commands and rejects reusing an ID for different content', async () => {
    let finish;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { pair, request, call } = await host({ invoke });
    const { token } = await pair();
    const body = call('turns.start', { text: 'Run once' });
    const first = request('/api/connect/call', body, token);
    const second = request('/api/connect/call', body, token);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    finish({ turn: { id: 'one-turn' } });
    expect((await first).body).toEqual((await second).body);
    expect((await request('/api/connect/call', { ...body, payload: { text: 'Changed' } }, token)).status).toBe(409);
  });

  it('blocks native administration, stale host instances and old command envelopes', async () => {
    const { pair, request, call, invoke } = await host();
    const { token } = await pair();
    for (const operation of ['providers.login', 'updates.install', 'connect.configure', 'external.openTerminal', 'app.saveSettings', 'workflowCredentials.create', 'turns:start']) {
      expect((await request('/api/connect/call', call(operation), token)).status).toBe(404);
    }
    expect((await request('/api/connect/call', call('turns.start', {}, { instanceId: 'old-host' }), token)).status).toBe(409);
    expect((await request('/api/connect/call', call('turns.start', {}, { issuedAt: 0 }), token)).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    expect(OPERATIONS.has('files.write')).toBe(true);
  });

  it('restores attention on connection, replays ordered events and resets when a cursor is lost', async () => {
    const { server, pair, request } = await host({ attention: () => [{ id: 1, requestGeneration: 4, method: 'approval' }] });
    const { token } = await pair();
    const initial = await request('/api/connect/poll?cursor=0&instanceId=', undefined, token);
    expect(initial.body.events[0]).toMatchObject({ type: 'ConnectReset', sequence: 0, payload: { attention: [{ id: 1, requestGeneration: 4, method: 'approval' }] } });
    server.publish({ type: 'ActivityReceived', payload: { delta: 'Hello' } });
    server.publish({ type: 'TaskUpdated', payload: { threadId: 'thread' } });
    server.publish({ type: 'GitHubAuthProgress', payload: { secret: 'must stay local' } });
    const events = await request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    expect(events.body.events.map((event) => event.sequence)).toEqual([1, 2]);
    const stale = await request('/api/connect/poll?cursor=2&instanceId=old', undefined, token);
    expect(stale.body.events[0].type).toBe('ConnectReset');
  });

  it('wakes a waiting client immediately and revocation terminates outstanding polls', async () => {
    const { server, pair, request } = await host();
    const { token, deviceId } = await pair();
    const next = request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    await vi.waitFor(() => expect(server.polls.size).toBe(1));
    server.publish({ type: 'AttentionRequired', payload: { id: 2 } });
    expect((await next).body.events[0].type).toBe('AttentionRequired');
    const pending = request(`/api/connect/poll?cursor=1&instanceId=${server.instanceId}`, undefined, token);
    await vi.waitFor(() => expect(server.polls.size).toBe(1));
    server.revoke({ id: deviceId });
    expect((await pending).status).toBe(401);
    expect((await request('/api/connect/poll', undefined, token)).status).toBe(401);
  });

  it('confirms an idle reconnect immediately without forcing a snapshot', async () => {
    const { server, pair, request } = await host(); const { token } = await pair();
    const response = await request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}&wait=0`, undefined, token);
    expect(response).toMatchObject({ status: 200, body: { events: [] } });
    expect(server.polls.size).toBe(0);
  });
  it('resynchronizes large events without breaking a live poll or silently skipping the event', async () => {
    const { server, pair, request } = await host(); const { token } = await pair();
    const pending = request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    await vi.waitFor(() => expect(server.polls.size).toBe(1));
    server.publish({ type: 'ActivityReceived', payload: { delta: 'x'.repeat(512_001) } });
    expect(await pending).toMatchObject({ status: 200, body: { events: [{ type: 'ConnectReset', sequence: 1 }] } });
    const missed = await request(`/api/connect/poll?cursor=0&instanceId=${server.instanceId}`, undefined, token);
    expect(missed.body.events[0]).toMatchObject({ type: 'ConnectReset', sequence: 1 });
    server.publish({ type: 'TaskUpdated', payload: { threadId: 'task' } });
    const replay = await request(`/api/connect/poll?cursor=1&instanceId=${server.instanceId}`, undefined, token);
    expect(replay.body.events.map(event => event.sequence)).toEqual([2]);
  });
  it('keeps the public request limit while allowing the private listener to set its own budget', async () => {
    const { server } = await host();
    const req = { socket: { remoteAddress: '127.0.0.1' } };
    for (let count = 0; count < 1200; count++) server.rate(req, 'api', server.apiRateLimit);
    expect(() => server.rate(req, 'api', server.apiRateLimit)).toThrow('Too many requests');
    const { server: local } = await host({ apiRateLimit: 60_000 });
    expect(() => { for (let count = 0; count < 2400; count++) local.rate(req, 'api', local.apiRateLimit); }).not.toThrow();
  });
  it('withholds an in-flight browser capture when the device is revoked', async () => {
    let finish;
    const invoke = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { server, pair, request, call } = await host({ invoke });
    const { token, deviceId } = await pair();
    const capture = request('/api/connect/call', call('browser.frame', { workspaceId: 'task', tabId: 'tab', width: 800, height: 600 }), token);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    server.revoke({ id: deviceId });
    finish({ image: 'private-page-pixels' });
    const response = await capture;
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('private-page-pixels');
  });

  it('serves the real client shell with restrictive headers and prevents symlink escape', async () => {
    const { directory, request } = await host();
    await writeFile(path.join(directory, 'secret.txt'), 'secret');
    await symlink(path.join(directory, 'secret.txt'), path.join(directory, 'client', 'escape.txt'));
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('Pixice');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await request('/escape.txt')).status).toBe(404);
  });

  it('survives a host restart with paired device access intact and a new event generation', async () => {
    const { server, directory, pair } = await host();
    const { token } = await pair();
    const originalId = server.instanceId;
    await server.stop();
    const restarted = new ConnectServer({ directory, clientDirectory: path.join(directory, 'client'), invoke: async () => true });
    expect(restarted.instanceId).not.toBe(originalId);
    expect(restarted.state.hostId).toBe(server.state.hostId);
    expect(restarted.authenticate({ headers: { authorization: `Bearer ${token}` } }).name).toBe('Test browser');
  });
});
