import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_ERROR_CODES, CONNECT_LIMITS } from '../electron/connect/protocol.mjs';
import {
  assertSubmissionRequestBudget,
  downloadRemoteFile,
  prepareSubmissionAttachments,
  resumeAttachmentUploads,
  transferScopeKey
} from '../src/connect/transfer-client.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const PROJECT = 'project-a';

const jsonResponse = (value, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  json: async () => value
});

const fileFrom = (value, name = 'note.txt', type = 'text/plain') => {
  const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new TextEncoder().encode(value);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
    slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer })
  };
};

const apiFor = (overrides = {}) => ({
  remote: {
    endpoint: 'https://connect.example',
    hostId: 'host-a',
    deviceId: 'device-a',
    token: 'token',
    capabilities: {
      transfers: {
        uploads: true,
        downloads: true,
        limits: {
          maxFileBytes: 25 * 1024 * 1024,
          maxFiles: 10,
          maxProjectBytes: 250 * 1024 * 1024,
          chunkBytes: 2,
          maxDownloadBytes: 100
        }
      }
    },
    ...overrides
  }
});

const record = (id, size, offset = 0, state = 'uploading') => ({ id, size, offset, state, chunkBytes: 2, expiresAt: Date.now() + 60_000 });

function attachment(file, metadata = {}) {
  return {
    id: metadata.id ?? `attachment-${file?.name ?? 'missing'}`,
    name: file?.name ?? metadata.name ?? 'note.txt',
    type: file?.type ?? metadata.type ?? 'text/plain',
    size: file?.size ?? metadata.size ?? 0,
    file: file ?? null,
    sha256: metadata.sha256 ?? null,
    transferId: metadata.transferId ?? null,
    transferState: metadata.transferState ?? null,
    uploadOffset: metadata.uploadOffset ?? 0,
    scopeKey: metadata.scopeKey ?? transferScopeKey({ hostId: 'host-a', deviceId: 'device-a', projectId: PROJECT }),
    dataUrl: metadata.dataUrl
  };
}

function routeOf(url) {
  return new URL(url).pathname;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transfer client uploads', () => {
  it('ends the original send after a lost chunk response and reconciles metadata once', async () => {
    const api = apiFor();
    const file = fileFrom('abcd');
    const item = attachment(file);
    let chunkAttempts = 0;
    let statusReads = 0;
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/uploads') return jsonResponse(record(ID_A, file.size));
      if (route.endsWith('/chunk')) {
        chunkAttempts += 1;
        throw new TypeError('peer stopped');
      }
      if (route === `/api/connect/uploads/${ID_A}`) {
        statusReads += 1;
        return jsonResponse(record(ID_A, file.size, 2));
      }
      throw new Error(`unexpected route ${route}`);
    });

    await expect(prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [item], fetchImpl })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.NETWORK_ERROR });
    expect(chunkAttempts).toBe(1);
    expect(statusReads).toBe(1);
    expect(item.transferId).toBe(ID_A);
    expect(item.uploadOffset).toBe(2);
    expect(item.transferState).toBe('uploading');
    expect(fetchImpl.mock.calls.some(([url]) => routeOf(url).endsWith('/complete'))).toBe(false);
  });

  it('resumes bytes without completing, then an explicit send reuses the ready upload', async () => {
    const api = apiFor();
    const file = fileFrom('abcd');
    const item = attachment(file, { id: 'attachment-a', transferId: ID_A, transferState: 'uploading', uploadOffset: 2 });
    const calls = [];
    let remoteOffset = 2;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const route = routeOf(url);
      calls.push({ route, options });
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === `/api/connect/uploads/${ID_A}`) return jsonResponse(record(ID_A, 4, remoteOffset));
      if (route.endsWith('/chunk')) { remoteOffset = 4; return jsonResponse(record(ID_A, 4, 4)); }
      if (route.endsWith('/complete')) return jsonResponse(record(ID_A, 4, 4, 'ready'));
      throw new Error(`unexpected route ${route}`);
    });

    await resumeAttachmentUploads({ api, projectId: PROJECT, attachments: [item], fetchImpl });
    expect(item.transferId).toBe(ID_A);
    expect(item.uploadOffset).toBe(4);
    expect(item.transferState).toBe('uploading');
    expect(calls.filter(({ route }) => route.endsWith('/chunk'))).toHaveLength(1);
    expect(calls.some(({ route }) => route.endsWith('/complete'))).toBe(false);

    await prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [item], fetchImpl });
    expect(item.transferState).toBe('ready');
    expect(calls.filter(({ route }) => route.endsWith('/chunk'))).toHaveLength(1);
    expect(calls.filter(({ route }) => route.endsWith('/complete'))).toHaveLength(1);
  });

  it('rejects restored metadata without a reselected file before any request', async () => {
    const fetchImpl = vi.fn();
    const item = attachment(null, { name: 'restored.txt', size: 4, transferId: ID_A, transferState: 'uploading' });

    await expect(prepareSubmissionAttachments({ api: apiFor(), projectId: PROJECT, attachments: [item], fetchImpl })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.INVALID_REQUEST, message: expect.stringContaining('Reselect') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports aggregate progress for all files while running no more than two uploads', async () => {
    const api = apiFor();
    const first = attachment(fileFrom('abcd', 'first.txt'));
    const second = attachment(fileFrom('wxyz', 'second.txt'));
    let activeChunks = 0;
    let maxActiveChunks = 0;
    let nextId = 0;
    const progress = [];
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/uploads') {
        const id = nextId++ === 0 ? ID_A : ID_B;
        return jsonResponse(record(id, 4));
      }
      if (route.endsWith('/chunk')) {
        activeChunks += 1;
        maxActiveChunks = Math.max(maxActiveChunks, activeChunks);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeChunks -= 1;
        const id = route.split('/').at(-2);
        const offset = Number(new URL(url).searchParams.get('offset'));
        return jsonResponse(record(id, 4, offset + 2));
      }
      if (route.endsWith('/complete')) {
        const id = route.split('/').at(-2);
        return jsonResponse(record(id, 4, 4, 'ready'));
      }
      throw new Error(`unexpected route ${route}`);
    });

    await prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [first, second], fetchImpl, onProgress: (value) => progress.push(value) });
    expect(maxActiveChunks).toBeLessThanOrEqual(2);
    expect(progress.every((value) => value.files)).toBe(true);
    expect(progress.some((value) => value.files.length === 2 && value.totalBytes === 8)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ totalBytes: 8, uploadedBytes: 8, activeCount: 0, files: [{ state: 'ready' }, { state: 'ready' }] });
  });

  it('cancels every ID returned during an external abort, including IDs initialized in flight', async () => {
    const api = apiFor();
    const controller = new AbortController();
    const first = attachment(fileFrom('ab', 'first.txt'));
    const second = attachment(fileFrom('cd', 'second.txt'));
    let initialized = 0;
    const cancelled = [];
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/uploads') {
        initialized += 1;
        const id = initialized === 1 ? ID_A : ID_B;
        const value = record(id, 2);
        return { ...jsonResponse(value), json: async () => { if (id === ID_B) controller.abort(new DOMException('user cancelled', 'AbortError')); return value; } };
      }
      if (route.endsWith('/cancel')) {
        cancelled.push(route.split('/').at(-2));
        return jsonResponse({ id: route.split('/').at(-2), state: 'cancelled' });
      }
      throw new Error(`unexpected route ${route}`);
    });
    const pending = prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [first, second], signal: controller.signal, fetchImpl });

    await expect(pending).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.REQUEST_ABORTED });
    expect(cancelled.sort()).toEqual([ID_A, ID_B].sort());
    expect(first.file).toBeTruthy();
    expect(second.file).toBeTruthy();
  });

  it('stops peer uploads without cancelling or losing an ID initialized by the peer', async () => {
    const api = apiFor();
    const first = attachment(fileFrom('ab', 'first.txt'));
    const second = attachment(fileFrom('cd', 'second.txt'));
    let firstChunkFailed;
    const chunkFailed = new Promise((resolve) => { firstChunkFailed = resolve; });
    let secondChunkStarted;
    const secondChunk = new Promise((resolve) => { secondChunkStarted = resolve; });
    const cancelled = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/uploads') {
        const body = JSON.parse(options.body);
        const id = body.name === 'first.txt' ? ID_A : ID_B;
        return jsonResponse(record(id, 2));
      }
      if (route.endsWith(`/uploads/${ID_A}/chunk`)) {
        await secondChunk;
        firstChunkFailed();
        throw new TypeError('peer stopped');
      }
      if (route.endsWith(`/uploads/${ID_B}/chunk`)) {
        secondChunkStarted();
        return new Promise(() => {});
      }
      if (route.endsWith('/cancel')) {
        cancelled.push(route.split('/').at(-2));
        return jsonResponse({ id: route.split('/').at(-2), state: 'cancelled' });
      }
      throw new Error(`unexpected route ${route}`);
    });

    const pending = prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [first, second], fetchImpl });
    await chunkFailed;
    await expect(pending).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.NETWORK_ERROR });
    expect(cancelled).toEqual([]);
    expect(second.transferId).toBe(ID_B);
    expect(second.file).toBeTruthy();
  });

  it('preserves a staged ID after a network failure and rejects equal offsets without retrying', async () => {
    const api = apiFor();
    const item = attachment(fileFrom('abcd'), { transferId: ID_A, transferState: 'uploading' });
    let chunks = 0;
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === `/api/connect/uploads/${ID_A}`) return jsonResponse(record(ID_A, 4, 0));
      if (route.endsWith('/chunk')) {
        chunks += 1;
        return jsonResponse(record(ID_A, 4, 0));
      }
      throw new Error(`unexpected route ${route}`);
    });

    await expect(prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [item], fetchImpl })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.INVALID_RESPONSE });
    expect(chunks).toBe(1);
    expect(item.transferId).toBe(ID_A);
    expect(item.file).toBeTruthy();
  });

  it('does not reuse an ID from another transfer scope', async () => {
    const api = apiFor({ hostId: 'host-b' });
    const item = attachment(fileFrom('abcd'), { transferId: ID_A, transferState: 'uploading', scopeKey: transferScopeKey({ hostId: 'host-a', deviceId: 'device-a', projectId: PROJECT }) });
    const routes = [];
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      routes.push(route);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-b' });
      if (route === '/api/connect/uploads') return jsonResponse(record(ID_B, 4, 0));
      if (route.endsWith('/chunk')) return jsonResponse(record(ID_B, 4, 4));
      if (route.endsWith('/complete')) return jsonResponse(record(ID_B, 4, 4, 'ready'));
      throw new Error(`unexpected route ${route}`);
    });

    await prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [item], fetchImpl });
    expect(routes).not.toContain(`/api/connect/uploads/${ID_A}`);
    expect(item.transferId).toBe(ID_B);
    expect(item.scopeKey).toBe(transferScopeKey({ hostId: 'host-b', deviceId: 'device-a', projectId: PROJECT }));
  });

  it('verifies the reselected file against its persisted hash before reusing an ID', async () => {
    const api = apiFor();
    const item = attachment(fileFrom('abcd'), { transferId: ID_A, transferState: 'uploading', sha256: 'f'.repeat(64) });
    const fetchImpl = vi.fn();

    await expect(prepareSubmissionAttachments({ api, projectId: PROJECT, attachments: [item], fetchImpl })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.CONFLICT });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('transfer client request and download limits', () => {
  it('checks the exact envelope boundary and reserves room for an unknown future thread ID', () => {
    const api = apiFor({ instanceId: 'backend-instance' });
    const payload = { projectId: PROJECT, text: 'hello' };
    const conservativeSize = assertSubmissionRequestBudget({ api, operation: 'turns.start', payload, maxBodyBytes: CONNECT_LIMITS.maxBodyBytes });
    expect(() => assertSubmissionRequestBudget({ api, operation: 'turns.start', payload, maxBodyBytes: conservativeSize - 1 })).toThrow(expect.objectContaining({ code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE }));
    expect(assertSubmissionRequestBudget({ api, operation: 'turns.start', payload: { ...payload, threadId: 'thread-1' }, maxBodyBytes: CONNECT_LIMITS.maxBodyBytes })).toBeLessThan(conservativeSize);
    expect(assertSubmissionRequestBudget({ api, operation: 'turns.start', payload, maxBodyBytes: conservativeSize })).toBe(conservativeSize);
  });

  it('accepts a streamed download without content-length and preserves its Unicode filename', async () => {
    const api = apiFor();
    const chunks = [new TextEncoder().encode('hello '), new TextEncoder().encode('東京😀')];
    let index = 0;
    const progress = [];
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/download') return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === 'content-disposition' ? "attachment; filename=report.pdf; filename*=UTF-8''report-%E6%9D%B1%E4%BA%AC%F0%9F%98%80.pdf" : name === 'content-type' ? 'application/pdf' : null },
        body: { getReader: () => ({ read: async () => index < chunks.length ? { value: chunks[index++], done: false } : { done: true }, cancel: vi.fn(), releaseLock: vi.fn() }) }
      };
      throw new Error(`unexpected route ${route}`);
    });

    const result = await downloadRemoteFile({ api, projectId: PROJECT, path: 'report.pdf', fetchImpl, onProgress: (value) => progress.push(value) });
    expect(result.filename).toBe('report-東京😀.pdf');
    expect(result.size).toBe(new TextEncoder().encode('hello 東京😀').byteLength);
    expect(progress.at(-1).total).toBeNull();
    expect(result.blob.size).toBe(result.size);
  });

  it('caps actual download bytes and cancels a reader when the caller aborts', async () => {
    const api = apiFor({ capabilities: { transfers: { uploads: false, downloads: true, limits: { maxDownloadBytes: 5 } } } });
    let cancel;
    let releaseLock;
    let rejectRead;
    const fetchImpl = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/download') return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { cancel: vi.fn((cause) => { cancel = cause; }), getReader: () => ({ read: async () => ({ value: new Uint8Array(6), done: false }), cancel: vi.fn((cause) => { cancel = cause; }), releaseLock: vi.fn(() => { releaseLock = true; }) }) }
      };
      throw new Error(`unexpected route ${route}`);
    });
    await expect(downloadRemoteFile({ api, projectId: PROJECT, path: 'too-large.bin', fetchImpl })).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE });
    expect(cancel).toBeTruthy();
    expect(releaseLock).toBe(true);

    const controller = new AbortController();
    let readerCancelled = false;
    let readerReleased = false;
    const blockedFetch = vi.fn(async (url) => {
      const route = routeOf(url);
      if (route.endsWith('/info')) return jsonResponse({ protocol: 1, hostId: 'host-a' });
      if (route === '/api/connect/download') return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: () => new Promise((resolve, reject) => { rejectRead = reject; }), cancel: () => { readerCancelled = true; }, releaseLock: () => { readerReleased = true; } }) }
      };
      throw new Error(`unexpected route ${route}`);
    });
    const pending = downloadRemoteFile({ api, projectId: PROJECT, path: 'blocked.bin', signal: controller.signal, fetchImpl: blockedFetch });
    await vi.waitFor(() => expect(rejectRead).toBeTypeOf('function'));
    controller.abort(new DOMException('user cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ code: CONNECT_ERROR_CODES.REQUEST_ABORTED });
    expect(readerCancelled).toBe(true);
    expect(readerReleased).toBe(true);
  });
});
