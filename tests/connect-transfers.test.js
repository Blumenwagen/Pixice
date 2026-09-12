import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { renameSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectServer } from '../electron/connect/server.mjs';
import { TransferStore } from '../electron/connect/transfer-store.mjs';
import { previewFileTarget } from '../electron/runtime/preview-files.mjs';

const contexts = [];
const digest = (value) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) {
    await context.server.stop();
    await context.store.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

async function host({ storeOptions = {}, serverOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-connect-transfers-'));
  const clientDirectory = path.join(directory, 'client');
  const projectRoot = path.join(directory, 'project');
  await mkdir(clientDirectory);
  await mkdir(projectRoot);
  await writeFile(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Pixice</title>');
  const store = new TransferStore({ directory: path.join(directory, 'uploads'), projectExists: (id) => id === 'project-a', ...storeOptions });
  const server = new ConnectServer({
    directory,
    clientDirectory,
    knownProjectIds: () => ['project-a'],
    projectExists: (id) => id === 'project-a',
    transferStore: store,
    resolveFile: (_projectId, reference, allowExternal) => previewFileTarget({ reference, primaryRoot: projectRoot, roots: [projectRoot], allowExternal }),
    invoke: async () => ({ ok: true }),
    ...serverOptions
  });
  server.state.enabled = true;
  server.state.port = 0;
  await server.start();
  const endpoint = `http://127.0.0.1:${server.status().port}`;
  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${endpoint}${route}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {})
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) return { status: response.status, body: await response.json(), response };
    if (contentType.startsWith('application/octet-stream')) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, body: bytes.toString('utf8'), bytes, response };
    }
    return { status: response.status, body: await response.text(), response };
  };
  const pair = async (access = {}) => {
    const offer = server.pairOffer(access);
    const token = new URLSearchParams(new URL(offer.url).hash.slice(1)).get('pair');
    return (await request('/api/connect/pair', { method: 'POST', body: { token, name: `device-${server.state.devices.length}` } })).body;
  };
  const context = { directory, projectRoot, store, server, request, pair };
  contexts.push(context);
  return context;
}

function bodyStream(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
    resume() {}
  };
}

function blockedStream() {
  let resolveNext;
  const next = new Promise((resolve) => { resolveNext = resolve; });
  return {
    [Symbol.asyncIterator]() { return { next: () => next, return: async () => ({ done: true }) }; },
    destroy() { resolveNext({ done: true }); },
    resume() {}
  };
}

describe('Connect file transfers', () => {
  it('streams chunks, resumes exact replays, rejects changed offsets, and completes opaque IDs', async () => {
    const context = await host();
    const device = await context.pair();
    const first = Buffer.from('hello ');
    const second = Buffer.from('world');
    const content = Buffer.concat([first, second]);
    const init = await context.request('/api/connect/uploads', { token: device.token, method: 'POST', body: { projectId: 'project-a', name: 'hello.txt', mimeType: 'text/plain', size: content.length, sha256: digest(content) } });
    expect(init).toMatchObject({ status: 200, body: { id: expect.any(String), offset: 0, size: content.length, state: 'uploading', chunkBytes: 1_048_576 } });
    const chunk = (offset, value) => context.request(`/api/connect/uploads/${init.body.id}/chunk?projectId=project-a&offset=${offset}`, { token: device.token, method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(value.length), 'X-Pixice-Chunk-Sha256': digest(value) }, body: value });
    expect(await chunk(0, first)).toMatchObject({ status: 200, body: { offset: first.length } });
    expect(await chunk(0, first)).toMatchObject({ status: 200, body: { offset: first.length } });
    expect(await chunk(0, Buffer.from('xxxxx'))).toMatchObject({ status: 409, body: { code: 'CONFLICT' } });
    expect(await chunk(99, second)).toMatchObject({ status: 409, body: { code: 'CONFLICT' } });
    expect(await chunk(first.length, second)).toMatchObject({ status: 200, body: { offset: content.length } });
    expect(await context.request(`/api/connect/uploads/${init.body.id}?projectId=project-a`, { token: device.token })).toMatchObject({ status: 200, body: { offset: content.length, state: 'uploading' } });
    expect(await context.request(`/api/connect/uploads/${init.body.id}/complete`, { token: device.token, method: 'POST', body: { projectId: 'project-a' } })).toMatchObject({ status: 200, body: { state: 'ready', offset: content.length } });
    const resolved = await context.store.resolveAttachmentIds({ deviceId: device.deviceId, projectId: 'project-a', attachmentIds: [init.body.id] });
    expect(resolved).toMatchObject([{ name: 'hello.txt', mimeType: 'text/plain', size: content.length }]);
    expect(resolved[0].path).not.toContain('hello.txt');
  });

  it('allows zero-byte completion, restores progress, and rejects observer uploads', async () => {
    const context = await host();
    const operator = await context.pair();
    const observer = await context.pair({ role: 'observer', projectIds: ['project-a'] });
    const zero = await context.request('/api/connect/uploads', { token: operator.token, method: 'POST', body: { projectId: 'project-a', name: 'empty.bin', mimeType: 'application/octet-stream', size: 0, sha256: digest(Buffer.alloc(0)) } });
    expect(await context.request(`/api/connect/uploads/${zero.body.id}/complete`, { token: operator.token, method: 'POST', body: { projectId: 'project-a' } })).toMatchObject({ status: 200, body: { state: 'ready', offset: 0 } });
    await context.store.close();
    const restored = new TransferStore({ directory: path.join(context.directory, 'uploads'), projectExists: () => true });
    await restored.ready;
    expect(await restored.read(zero.body.id, { deviceId: operator.deviceId, projectId: 'project-a' })).toMatchObject({ state: 'ready', offset: 0 });
    await restored.close();
    context.store = { close: async () => {} };
    expect(await context.request('/api/connect/uploads', { token: observer.token, method: 'POST', body: { projectId: 'project-a', name: 'blocked.txt', mimeType: 'text/plain', size: 0, sha256: digest(Buffer.alloc(0)) } })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  it('streams only files inside the project and enforces change and size checks', async () => {
    const context = await host();
    const device = await context.pair();
    await writeFile(path.join(context.projectRoot, 'readme.txt'), 'download me');
    await writeFile(path.join(context.directory, 'secret.txt'), 'secret');
    await symlink(path.join(context.directory, 'secret.txt'), path.join(context.projectRoot, 'escape.txt'));
    const allowed = await context.request('/api/connect/download?projectId=project-a&path=readme.txt', { token: device.token });
    expect(allowed).toMatchObject({ status: 200 });
    expect(allowed.response.headers.get('content-type')).toBe('application/octet-stream');
    expect(allowed.response.headers.get('content-disposition')).toContain('readme.txt');
    expect(allowed.body).toBe('download me');
    expect(await context.request('/api/connect/download?projectId=project-a&path=escape.txt', { token: device.token })).toMatchObject({ status: 404 });
    expect(await context.request('/api/connect/download?projectId=project-a&path=readme.txt&expectedMtimeMs=1', { token: device.token })).toMatchObject({ status: 409 });
    expect(await context.request('/api/connect/download?projectId=project-a&path=../secret.txt', { token: device.token })).toMatchObject({ status: 404 });
  });

  it('downloads Unicode project artifacts with an ASCII fallback and RFC5987 filename', async () => {
    const context = await host();
    const device = await context.pair();
    const filename = 'report-東京😀.pdf';
    const content = Buffer.from('protected artifact bytes');
    await writeFile(path.join(context.projectRoot, filename), content);

    const response = await context.request(`/api/connect/download?projectId=project-a&path=${encodeURIComponent(filename)}`, { token: device.token });

    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(content);
    expect(response.response.headers.get('content-length')).toBe(String(content.length));
    const disposition = response.response.headers.get('content-disposition');
    expect(disposition).toContain('filename="report-___.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
  });

  it('serializes concurrent reservations and caps zero-byte metadata globally', async () => {
    const context = await host({ storeOptions: { maxFiles: 1, maxGlobalBytes: 5, maxGlobalFiles: 2 } });
    const reservations = await Promise.allSettled(Array.from({ length: 12 }, () => context.store.reserve({ deviceId: 'device-a', projectId: 'project-a', name: 'same.txt', mimeType: 'text/plain', size: 5, sha256: digest(Buffer.from('12345')) })));
    expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(reservations.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'RATE_LIMITED')).toBe(true);
    await context.store.invalidateDevice('device-a');
    const zeroes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => context.store.reserve({ deviceId: `device-${index}`, projectId: 'project-a', name: `${index}.bin`, mimeType: 'application/octet-stream', size: 0, sha256: digest(Buffer.alloc(0)) })));
    expect(zeroes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(zeroes.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'RATE_LIMITED')).toBe(true);
  });

  it('rolls back file bytes and in-memory offset when metadata persistence fails', async () => {
    const context = await host();
    const record = await context.store.reserve({ deviceId: 'device-a', projectId: 'project-a', name: 'rollback.txt', mimeType: 'text/plain', size: 5, sha256: digest(Buffer.from('hello')) });
    const originalWriteMetadata = context.store.writeMetadata.bind(context.store);
    context.store.writeMetadata = async (value) => {
      if (value.offset === 5) throw new Error('injected metadata failure');
      return originalWriteMetadata(value);
    };
    await expect(context.store.writeChunk({ transferId: record.id, deviceId: 'device-a', projectId: 'project-a', offset: 0, expectedHash: digest(Buffer.from('hello')), stream: bodyStream(Buffer.from('hello')), contentLength: 5 })).rejects.toThrow('injected metadata failure');
    expect(await context.store.read(record.id, { deviceId: 'device-a', projectId: 'project-a' })).toMatchObject({ offset: 0, state: 'uploading' });
    expect(await readFile(path.join(context.directory, 'uploads', record.id, 'data'))).toHaveLength(0);
    context.store.writeMetadata = originalWriteMetadata;
    await context.store.close();
    const restored = new TransferStore({ directory: path.join(context.directory, 'uploads'), projectExists: () => true });
    await restored.ready;
    expect(await restored.read(record.id, { deviceId: 'device-a', projectId: 'project-a' })).toMatchObject({ offset: 0, state: 'uploading' });
    await restored.close();
    context.store = { close: async () => {} };
  });

  it('rejects slow chunks and cancels queued work when a device is revoked', async () => {
    const context = await host({ storeOptions: { concurrency: 1, maxPendingChunks: 2, maxPendingChunksPerDevice: 2, readTimeoutMs: 25 } });
    const first = await context.store.reserve({ deviceId: 'device-a', projectId: 'project-a', name: 'one.txt', mimeType: 'text/plain', size: 2, sha256: digest(Buffer.from('ab')) });
    let authorized = true;
    const firstChunk = context.store.writeChunk({ transferId: first.id, deviceId: 'device-a', projectId: 'project-a', offset: 0, expectedHash: digest(Buffer.from('ab')), stream: blockedStream(), contentLength: 2, authorized: () => authorized });
    const queuedChunk = context.store.writeChunk({ transferId: first.id, deviceId: 'device-a', projectId: 'project-a', offset: 0, expectedHash: digest(Buffer.from('ab')), stream: bodyStream(Buffer.from('ab')), contentLength: 2 });
    const firstOutcome = firstChunk.then(() => null, (error) => error);
    const queuedOutcome = queuedChunk.then(() => null, (error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    expect(context.store.pendingChunkCount).toBe(2);
    authorized = false;
    await context.store.invalidateDevice('device-a');
    expect(await firstOutcome).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await queuedOutcome).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(context.store.pendingChunkCount).toBe(0);
    expect(context.store.records.size).toBe(0);
  });

  it('rejects a download path swapped after resolution without emitting outside bytes', async () => {
    const context = await host();
    const allowedPath = path.join(context.projectRoot, 'swap.txt');
    const outsidePath = path.join(context.directory, 'outside.txt');
    await writeFile(allowedPath, 'allowed');
    await writeFile(outsidePath, 'outside-secret');
    const originalResolve = context.server.resolveFile;
    let swapped = false;
    context.server.resolveFile = (projectId, reference, allowExternal) => {
      const target = originalResolve(projectId, reference, allowExternal);
      if (reference === 'swap.txt') {
        swapped = true;
        renameSync(allowedPath, `${allowedPath}.original`);
        symlinkSync(outsidePath, allowedPath);
      }
      return target;
    };
    const device = await context.pair();
    const response = await context.request('/api/connect/download?projectId=project-a&path=swap.txt', { token: device.token });
    expect(swapped).toBe(true);
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain('outside-secret');
  });

  it('releases download admission after rejected preflight requests', async () => {
    const context = await host({ serverOptions: { maxConcurrentDownloads: 1 } });
    const device = await context.pair();
    await writeFile(path.join(context.projectRoot, 'visible.txt'), 'visible');
    const originalResolve = context.server.resolveFile;
    context.server.resolveFile = () => null;
    expect(await context.request('/api/connect/download?projectId=project-a&path=missing.txt', { token: device.token })).toMatchObject({ status: 404 });
    context.server.resolveFile = originalResolve;
    expect(await context.request('/api/connect/download?projectId=project-a&path=visible.txt', { token: device.token })).toMatchObject({ status: 200, body: 'visible' });
  });

  it('rechecks the current origin before sending a delayed download', async () => {
    const clientOrigin = 'https://client.example';
    const context = await host({ serverOptions: { initialState: { origins: [clientOrigin] } } });
    const device = await context.pair();
    const artifact = Buffer.from('must not cross the policy race');
    await writeFile(path.join(context.projectRoot, 'policy-race.txt'), artifact);

    let reached;
    const authorizationReached = new Promise((resolve) => { reached = resolve; });
    let release;
    const authorizationRelease = new Promise((resolve) => { release = resolve; });
    const originalTransferAuthorized = context.server.transferAuthorized.bind(context.server);
    let paused = false;
    context.server.transferAuthorized = async (...args) => {
      const result = await originalTransferAuthorized(...args);
      if (!paused) {
        paused = true;
        reached();
        await authorizationRelease;
      }
      return result;
    };

    const responsePromise = context.request('/api/connect/download?projectId=project-a&path=policy-race.txt', { token: device.token, headers: { Origin: clientOrigin } });
    await authorizationReached;
    context.server.state.origins = [];
    release();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(artifact.toString('utf8'));
    expect(response.response.headers.get('content-length')).not.toBe(String(artifact.length));
  });
});
