import { createHash, randomUUID } from 'node:crypto';
import { constants as FS_CONSTANTS, createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONNECT_LIMITS } from './protocol.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_GLOBAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_GLOBAL_FILES = 1000;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024;
const META_NAME = 'metadata.json';
const DATA_NAME = 'data';

function transferError(status, message, code = status === 409 ? 'CONFLICT' : status === 413 ? 'REQUEST_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST') {
  return Object.assign(new Error(message), { status, code });
}

function boundedString(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw transferError(400, `${label} is invalid.`);
  return value;
}

function safeName(value) {
  const name = boundedString(value, 180, 'File name').replaceAll('\\', '/');
  if (name.includes('/') || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name)) throw transferError(400, 'File name must be a single safe path segment.');
  return name;
}

function normalizedMime(value) {
  const mime = boundedString(value, 160, 'MIME type').toLowerCase();
  if (!MIME_PATTERN.test(mime)) throw transferError(400, 'MIME type is invalid.');
  return mime;
}

function normalizedHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw transferError(400, 'SHA-256 must be a 64-character hexadecimal digest.');
  return value.toLowerCase();
}

function id(value) {
  if (!UUID_PATTERN.test(String(value ?? ''))) throw transferError(400, 'The transfer ID is invalid.');
  return String(value).toLowerCase();
}

function isRegularFile(metadata) { return metadata?.isFile?.() === true; }

async function consumeStream(stream, { onChunk, maxBytes, timeoutMs = DEFAULT_READ_TIMEOUT_MS }) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw transferError(400, 'A transfer request body is required.');
  const iterator = stream[Symbol.asyncIterator]();
  let timer;
  let timedOut = false;
  const nextWithTimeout = () => new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = transferError(408, 'The transfer request body timed out.', 'REQUEST_ABORTED');
      stream.destroy?.(error);
      reject(error);
    }, timeoutMs);
    Promise.resolve(iterator.next()).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let total = 0;
  try {
    while (true) {
      const { value, done } = await nextWithTimeout();
      if (done) break;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += buffer.byteLength;
      if (total > maxBytes) throw transferError(413, `A transfer chunk is larger than ${Math.ceil(maxBytes / 1024 / 1024)} MiB.`, 'REQUEST_TOO_LARGE');
      await onChunk(buffer, total);
    }
    return total;
  } finally {
    clearTimeout(timer);
    if (timedOut && typeof iterator.return === 'function') {
      try { await iterator.return(); } catch { /* The body may already be closed. */ }
    }
  }
}

function drainInput(stream) {
  try { stream?.resume?.(); } catch { /* The client may already have disconnected. */ }
}

function abortInput(stream, error) {
  try { stream?.destroy?.(); } catch { /* The client may already have disconnected. */ }
  drainInput(stream);
}

export class TransferStore {
  constructor({
    directory,
    projectExists = () => true,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxFileBytes = CONNECT_LIMITS.maxAttachmentBytes,
    maxFiles = DEFAULT_MAX_FILES,
    maxGlobalFiles = DEFAULT_MAX_GLOBAL_FILES,
    maxDeviceBytes = DEFAULT_MAX_PROJECT_BYTES,
    maxProjectBytes = DEFAULT_MAX_PROJECT_BYTES,
    maxGlobalBytes = DEFAULT_MAX_GLOBAL_BYTES,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    concurrency = 4,
    maxPendingChunks = null,
    maxPendingChunksPerDevice = null,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
  } = {}) {
    if (!directory) throw new Error('A private transfer directory is required.');
    this.directory = directory;
    this.projectExists = projectExists;
    this.now = now;
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
    this.maxFileBytes = Math.max(0, Number(maxFileBytes) || CONNECT_LIMITS.maxAttachmentBytes);
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
    this.maxGlobalFiles = Math.max(1, Number(maxGlobalFiles) || DEFAULT_MAX_GLOBAL_FILES);
    this.maxDeviceBytes = Math.max(0, Number(maxDeviceBytes) || DEFAULT_MAX_PROJECT_BYTES);
    this.maxProjectBytes = Math.max(0, Number(maxProjectBytes) || DEFAULT_MAX_PROJECT_BYTES);
    this.maxGlobalBytes = Math.max(0, Number(maxGlobalBytes) || DEFAULT_MAX_GLOBAL_BYTES);
    this.chunkBytes = Math.max(1, Math.min(DEFAULT_CHUNK_BYTES, Number(chunkBytes) || DEFAULT_CHUNK_BYTES));
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.maxPendingChunks = Math.max(1, Number(maxPendingChunks) || this.concurrency * 4);
    this.maxPendingChunksPerDevice = Math.max(1, Math.min(this.maxPendingChunks, Number(maxPendingChunksPerDevice) || Math.max(2, this.concurrency * 2)));
    this.readTimeoutMs = Math.max(1, Number(readTimeoutMs) || DEFAULT_READ_TIMEOUT_MS);
    this.records = new Map();
    this.queues = new Map();
    this.pendingReservations = new Set();
    this.pendingChunkCount = 0;
    this.pendingChunksByDevice = new Map();
    this.activeChunkCount = 0;
    this.runningChunkTasks = new Set();
    this.stateChain = Promise.resolve();
    this.globalBytes = 0;
    this.closed = false;
    this.closePromise = null;
    this.ready = this.restore();
    this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, Math.min(this.ttlMs, 5 * 60 * 1000));
    this.cleanupTimer.unref?.();
  }

  limits() {
    return {
      maxFileBytes: this.maxFileBytes,
      maxFiles: this.maxFiles,
      maxProjectBytes: this.maxProjectBytes,
      maxGlobalBytes: this.maxGlobalBytes,
      chunkBytes: this.chunkBytes,
      ttlMs: this.ttlMs,
    };
  }

  withStateLock(operation) {
    const next = this.stateChain.then(operation);
    this.stateChain = next.catch(() => {});
    return next;
  }

  assertOpen() {
    if (this.closed) throw transferError(503, 'File transfers are stopping.', 'REQUEST_ABORTED');
  }

  async restore() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink?.()) throw new Error('Transfer directory is not a private directory.');
    await chmod(this.directory, 0o700);
    const root = await realpath(this.directory);
    this.root = root;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const folder = path.join(root, entry.name);
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
        if (entry.isDirectory() || entry.isSymbolicLink()) await rm(folder, { recursive: true, force: true });
        continue;
      }
      try {
        await chmod(folder, 0o700);
        const folderInfo = await lstat(folder);
        const canonicalFolder = await realpath(folder);
        if (!folderInfo.isDirectory() || canonicalFolder !== folder || !isWithin(root, canonicalFolder)) throw new Error('Invalid transfer folder');
        const metadataPath = path.join(folder, META_NAME);
        const dataPath = path.join(folder, DATA_NAME);
        const metadataInfo = await lstat(metadataPath);
        if (!isRegularFile(metadataInfo) || metadataInfo.size > MAX_METADATA_BYTES || !isWithin(canonicalFolder, await realpath(metadataPath))) throw new Error('Invalid transfer metadata file');
        await chmod(metadataPath, 0o600);
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        const record = this.validateStoredMetadata(metadata, entry.name);
        const dataInfo = await lstat(dataPath);
        const canonicalData = await realpath(dataPath);
        if (!isRegularFile(dataInfo) || dataInfo.size !== record.offset || !isWithin(root, canonicalData) || canonicalData !== dataPath) throw new Error('Invalid transfer data');
        await chmod(dataPath, 0o600);
        if (record.expiresAt <= this.now() || !this.projectExists(record.projectId)) throw new Error('Expired transfer');
        const deviceBytes = [...this.records.values()].filter((candidate) => candidate.deviceId === record.deviceId).reduce((total, candidate) => total + candidate.size, 0);
        const projectBytes = [...this.records.values()].filter((candidate) => candidate.projectId === record.projectId).reduce((total, candidate) => total + candidate.size, 0);
        const scopedCount = [...this.records.values()].filter((candidate) => candidate.deviceId === record.deviceId && candidate.projectId === record.projectId).length;
        if (this.records.size >= this.maxGlobalFiles || scopedCount >= this.maxFiles || deviceBytes + record.size > this.maxDeviceBytes || projectBytes + record.size > this.maxProjectBytes || this.globalBytes + record.size > this.maxGlobalBytes) throw new Error('Transfer quotas exceeded');
        this.records.set(record.id, record);
        this.globalBytes += record.size;
      } catch { await rm(folder, { recursive: true, force: true }); }
    }
    await this.cleanupOrphansLocked(root);
  }

  validateStoredMetadata(value, folderId) {
    const record = {
      id: id(value?.id), deviceId: boundedString(value?.deviceId, 256, 'Device ID'), projectId: boundedString(value?.projectId, 256, 'Project ID'),
      name: safeName(value?.name), mimeType: normalizedMime(value?.mimeType), size: Number(value?.size), sha256: normalizedHash(value?.sha256),
      state: value?.state, offset: Number(value?.offset), createdAt: Number(value?.createdAt), updatedAt: Number(value?.updatedAt), expiresAt: Number(value?.expiresAt),
      lastChunk: value?.lastChunk && { offset: Number(value.lastChunk.offset), length: Number(value.lastChunk.length), sha256: normalizedHash(value.lastChunk.sha256) }
    };
    if (record.id !== id(folderId) || !['uploading', 'ready'].includes(record.state) || !Number.isInteger(record.size) || record.size < 0 || record.size > this.maxFileBytes
      || !Number.isInteger(record.offset) || record.offset < 0 || record.offset > record.size || ![record.createdAt, record.updatedAt, record.expiresAt].every(Number.isFinite)) throw new Error('Invalid transfer metadata');
    if (record.state === 'ready' && record.offset !== record.size) throw new Error('Invalid ready transfer');
    if (record.lastChunk && (!Number.isInteger(record.lastChunk.offset) || !Number.isInteger(record.lastChunk.length) || record.lastChunk.offset < 0 || record.lastChunk.length < 0 || record.lastChunk.offset + record.lastChunk.length !== record.offset)) throw new Error('Invalid last chunk metadata');
    return record;
  }

  async cleanupOrphansLocked(root = null) {
    root ??= await realpath(this.directory);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const transferId = entry.name.toLowerCase();
      if (this.pendingReservations.has(transferId)) continue;
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name) || !this.records.has(transferId)) {
        if (entry.isDirectory() || entry.isSymbolicLink()) await rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.cleanupTimer);
    const closedError = transferError(503, 'File transfers are stopping.', 'REQUEST_ABORTED');
    this.cancelQueuedChunks(closedError);
    for (const task of this.runningChunkTasks) abortInput(task.stream, closedError);
    this.closePromise = (async () => {
      await this.ready.catch(() => {});
      await Promise.allSettled([...this.runningChunkTasks].map((task) => task.promise));
      await this.stateChain.catch(() => {});
    })();
    return this.closePromise;
  }

  async cleanup() {
    if (this.closed) return;
    return this.withStateLock(async () => {
      if (this.closed) return;
      await this.ready;
      const root = await realpath(this.directory);
      const cutoff = this.now();
      for (const record of [...this.records.values()]) {
        if (record.expiresAt <= cutoff) {
          this.cancelRecordChunks(record.id, transferError(404, 'Transfer expired.', 'NOT_FOUND'));
          await this.removeRecordLocked(record, 'expired');
        }
      }
      await this.cleanupOrphansLocked(root);
    });
  }

  filePath(record) { return path.join(this.root ?? this.directory, record.id, DATA_NAME); }
  metadataPath(record) { return path.join(this.root ?? this.directory, record.id, META_NAME); }

  publicRecord(record) {
    return { id: record.id, offset: record.offset, size: record.size, state: record.state, expiresAt: record.expiresAt, chunkBytes: this.chunkBytes };
  }

  async touch(record) {
    const previous = { ...record, lastChunk: record.lastChunk ? { ...record.lastChunk } : null };
    const now = this.now();
    const next = { ...record, updatedAt: now, expiresAt: now + this.ttlMs };
    try {
      await this.writeMetadata(next);
      Object.assign(record, next);
    } catch (error) {
      if (this.records.get(record.id) === record) await this.writeMetadata(previous).catch(() => {});
      throw error;
    }
  }

  async writeMetadata(record) {
    const target = this.metadataPath(record);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...record }), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async reserve(input) {
    return this.withStateLock(async () => {
      await this.ready;
      this.assertOpen();
      await this.cleanupLockedWithoutReentering();
      return this.reserveOne(input);
    });
  }

  async cleanupLockedWithoutReentering() {
    const cutoff = this.now();
    for (const record of [...this.records.values()]) {
      if (record.expiresAt <= cutoff) {
        this.cancelRecordChunks(record.id, transferError(404, 'Transfer expired.', 'NOT_FOUND'));
        await this.removeRecordLocked(record, 'expired');
      }
    }
  }

  async reserveOne({ deviceId, projectId, name, mimeType, size, sha256, authorized = () => true }) {
    const device = boundedString(deviceId, 256, 'Device ID');
    const project = boundedString(projectId, 256, 'Project ID');
    if (!this.projectExists(project)) throw transferError(404, 'Project not found.', 'NOT_FOUND');
    const filename = safeName(name);
    const type = normalizedMime(mimeType);
    const bytes = Number(size);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.maxFileBytes) throw transferError(413, `A file must be ${this.maxFileBytes / 1024 / 1024} MiB or smaller.`, 'REQUEST_TOO_LARGE');
    const digest = normalizedHash(sha256);
    const active = [...this.records.values()].filter((record) => record.deviceId === device && record.projectId === project);
    if (active.length >= this.maxFiles || this.records.size >= this.maxGlobalFiles) throw transferError(429, 'The transfer file limit has been reached.', 'RATE_LIMITED');
    const deviceBytes = [...this.records.values()].filter((record) => record.deviceId === device).reduce((total, record) => total + record.size, 0);
    const projectBytes = [...this.records.values()].filter((record) => record.projectId === project).reduce((total, record) => total + record.size, 0);
    if (deviceBytes + bytes > this.maxDeviceBytes || projectBytes + bytes > this.maxProjectBytes || this.globalBytes + bytes > this.maxGlobalBytes) {
      throw transferError(429, 'The transfer storage quota has been reached.', 'RATE_LIMITED');
    }
    if (!(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
    const now = this.now();
    const record = { id: randomUUID(), deviceId: device, projectId: project, name: filename, mimeType: type, size: bytes, sha256: digest, state: 'uploading', offset: 0,
      createdAt: now, updatedAt: now, expiresAt: now + this.ttlMs, lastChunk: null };
    const folder = path.join(this.directory, record.id);
    this.pendingReservations.add(record.id);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const dataPath = this.filePath(record);
      const handle = await open(dataPath, 'wx', 0o600);
      await handle.close();
      await chmod(dataPath, 0o600);
      await this.writeMetadata(record);
      if (this.closed) throw transferError(503, 'File transfers are stopping.', 'REQUEST_ABORTED');
      if (!(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
      this.records.set(record.id, record);
      this.globalBytes += bytes;
      return this.publicRecord(record);
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally { this.pendingReservations.delete(record.id); }
  }

  recordFor({ id: transferId, deviceId, projectId }) {
    const record = this.records.get(id(transferId));
    if (!record || record.deviceId !== deviceId || record.projectId !== projectId) throw transferError(404, 'Transfer not found.', 'NOT_FOUND');
    if (record.expiresAt <= this.now()) throw transferError(404, 'Transfer expired.', 'NOT_FOUND');
    return record;
  }

  pendingForDevice(deviceId) { return this.pendingChunksByDevice.get(deviceId) ?? 0; }

  enqueue(record, { deviceId, stream = null, run }) {
    this.assertOpen();
    if (this.pendingChunkCount >= this.maxPendingChunks || this.pendingForDevice(deviceId) >= this.maxPendingChunksPerDevice) {
      drainInput(stream);
      throw transferError(429, 'Too many transfer operations are pending for this device.', 'RATE_LIMITED');
    }
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    promise.catch(() => {});
    const task = { record, deviceId, stream, run, promise, resolve: resolveTask, reject: rejectTask, released: false, started: false };
    const queue = this.queues.get(record.id) ?? { running: false, pending: [] };
    queue.pending.push(task);
    this.queues.set(record.id, queue);
    this.pendingChunkCount += 1;
    this.pendingChunksByDevice.set(deviceId, this.pendingForDevice(deviceId) + 1);
    this.pumpChunks();
    return promise;
  }

  pumpChunks() {
    while (!this.closed && this.activeChunkCount < this.concurrency) {
      const candidate = [...this.queues.values()].find((queue) => !queue.running && queue.pending.length);
      if (!candidate) return;
      const task = candidate.pending.shift();
      candidate.running = true;
      task.started = true;
      this.activeChunkCount += 1;
      this.runningChunkTasks.add(task);
      Promise.resolve().then(() => task.run()).then(task.resolve, task.reject).finally(() => {
        this.runningChunkTasks.delete(task);
        this.activeChunkCount = Math.max(0, this.activeChunkCount - 1);
        candidate.running = false;
        if (!candidate.pending.length) this.queues.delete(task.record.id);
        this.releaseTask(task);
        this.pumpChunks();
      });
    }
  }

  releaseTask(task) {
    if (task.released) return;
    task.released = true;
    this.pendingChunkCount = Math.max(0, this.pendingChunkCount - 1);
    const remaining = this.pendingForDevice(task.deviceId) - 1;
    if (remaining > 0) this.pendingChunksByDevice.set(task.deviceId, remaining);
    else this.pendingChunksByDevice.delete(task.deviceId);
  }

  cancelQueuedChunks(error) {
    for (const queue of this.queues.values()) {
      for (const task of queue.pending.splice(0)) {
        abortInput(task.stream, error);
        task.reject(error);
        this.releaseTask(task);
      }
    }
    for (const [recordId, queue] of this.queues) if (!queue.running && !queue.pending.length) this.queues.delete(recordId);
  }

  cancelRecordChunks(recordId, error) {
    const queue = this.queues.get(recordId);
    if (!queue) return;
    for (const task of queue.pending.splice(0)) {
      abortInput(task.stream, error);
      task.reject(error);
      this.releaseTask(task);
    }
    if (queue.running) {
      for (const task of this.runningChunkTasks) if (task.record.id === recordId) abortInput(task.stream, error);
    } else this.queues.delete(recordId);
  }

  async writeChunk({ transferId, deviceId, projectId, offset, expectedHash, stream, contentLength, authorized = () => true }) {
    await this.ready;
    const record = this.recordFor({ id: transferId, deviceId, projectId });
    return this.enqueue(record, { deviceId, stream, run: async () => {
      const current = this.records.get(record.id);
      if (current !== record || record.state !== 'uploading' || record.expiresAt <= this.now()) { drainInput(stream); throw transferError(404, 'Transfer not found or expired.', 'NOT_FOUND'); }
      if (!(await authorized())) { drainInput(stream); throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED'); }
      if (!Number.isInteger(offset) || offset < 0) { drainInput(stream); throw transferError(400, 'The chunk offset is invalid.'); }
      const declared = contentLength === undefined || contentLength === null ? null : Number(contentLength);
      if (declared !== null && (!Number.isInteger(declared) || declared < 0 || declared > this.chunkBytes)) { drainInput(stream); throw transferError(413, `A transfer chunk is larger than ${this.chunkBytes / 1024 / 1024} MiB.`, 'REQUEST_TOO_LARGE'); }
      const normalizedExpectedHash = String(expectedHash ?? '').toLowerCase();
      if (!HASH_PATTERN.test(normalizedExpectedHash)) { drainInput(stream); throw transferError(400, 'X-Pixice-Chunk-Sha256 is required.'); }
      if (offset !== record.offset) {
        const replay = record.lastChunk && offset === record.lastChunk.offset && declared === record.lastChunk.length && normalizedExpectedHash === record.lastChunk.sha256;
        const hash = createHash('sha256');
        let consumed = 0;
        await consumeStream(stream, { maxBytes: this.chunkBytes, timeoutMs: this.readTimeoutMs, onChunk: async (chunk) => { hash.update(chunk); consumed += chunk.length; } });
        if (replay && consumed === record.lastChunk.length && hash.digest('hex') === record.lastChunk.sha256 && await authorized()) return this.publicRecord(record);
        throw transferError(409, `The next chunk must start at offset ${record.offset}.`, 'CONFLICT');
      }
      if (record.offset + (declared ?? 0) > record.size) { drainInput(stream); throw transferError(409, `The chunk exceeds the expected file size at offset ${record.offset}.`, 'CONFLICT'); }
      const handle = await open(this.filePath(record), 'r+');
      const previous = { ...record, lastChunk: record.lastChunk ? { ...record.lastChunk } : null };
      const start = record.offset;
      const hash = createHash('sha256');
      let written = 0;
      try {
        await consumeStream(stream, { maxBytes: this.chunkBytes, timeoutMs: this.readTimeoutMs, onChunk: async (chunk) => {
          written += chunk.length; hash.update(chunk);
          if (start + written > record.size) throw transferError(409, 'The chunk exceeds the expected file size.', 'CONFLICT');
          await handle.write(chunk, 0, chunk.length, start + written - chunk.length);
        } });
        if (!(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
        if (declared !== null && written !== declared) throw transferError(409, 'The chunk length does not match Content-Length.', 'CONFLICT');
        if (hash.digest('hex') !== normalizedExpectedHash) throw transferError(409, 'The chunk hash does not match.', 'CONFLICT');
        const next = { ...record, offset: start + written, lastChunk: { offset: start, length: written, sha256: normalizedExpectedHash }, updatedAt: this.now(), expiresAt: this.now() + this.ttlMs };
        await this.withStateLock(async () => {
          if (this.closed || this.records.get(record.id) !== record || record.state !== 'uploading' || record.expiresAt <= this.now() || !(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
          await this.writeMetadata(next);
          if (!(await authorized())) {
            await this.writeMetadata(previous).catch(() => {});
            throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
          }
          Object.assign(record, next);
        });
        return this.publicRecord(record);
      } catch (error) {
        await handle.truncate(start).catch(() => {});
        Object.assign(record, previous);
        if (this.records.get(record.id) === record) await this.writeMetadata(previous).catch(() => {});
        throw error;
      } finally { await handle.close(); }
    } });
  }

  async complete({ transferId, deviceId, projectId, authorized = () => true }) {
    await this.ready;
    const record = this.recordFor({ id: transferId, deviceId, projectId });
    return this.enqueue(record, { deviceId, run: async () => {
      if (this.records.get(record.id) !== record || record.expiresAt <= this.now()) throw transferError(404, 'Transfer expired.', 'NOT_FOUND');
      if (record.state === 'ready') return this.publicRecord(record);
      if (record.state !== 'uploading' || record.offset !== record.size) throw transferError(409, `The transfer is incomplete at offset ${record.offset}.`, 'CONFLICT');
      if (!(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
      const dataInfo = await lstat(this.filePath(record));
      if (!isRegularFile(dataInfo) || dataInfo.size !== record.size) throw transferError(409, 'The completed file changed before verification.', 'CONFLICT');
      const hash = createHash('sha256');
      const handle = await open(this.filePath(record), 'r');
      try {
        if (record.size > 0) for await (const chunk of createReadStream(null, { fd: handle.fd, autoClose: false, start: 0, end: record.size - 1 })) hash.update(chunk);
      } finally { await handle.close(); }
      if (hash.digest('hex') !== record.sha256) {
        await this.withStateLock(() => this.removeRecordLocked(record, 'hash-mismatch'));
        throw transferError(409, 'The completed file hash does not match.', 'CONFLICT');
      }
      await this.withStateLock(async () => {
        if (this.records.get(record.id) !== record || !(await authorized())) throw transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
        const next = { ...record, state: 'ready', updatedAt: this.now(), expiresAt: this.now() + this.ttlMs };
        try {
          await this.writeMetadata(next);
          Object.assign(record, next);
        } catch (error) {
          await this.writeMetadata(record).catch(() => {});
          throw error;
        }
      });
      return this.publicRecord(record);
    } });
  }

  async removeRecord(record, reason = 'cancelled') {
    return this.withStateLock(() => this.removeRecordLocked(record, reason));
  }

  async removeRecordLocked(record, reason = 'cancelled') {
    if (!this.records.has(record.id)) return;
    this.records.delete(record.id);
    this.globalBytes = Math.max(0, this.globalBytes - record.size);
    await rm(path.join(this.directory, record.id), { recursive: true, force: true }).catch(() => {});
    return { id: record.id, state: reason };
  }

  async cancel({ transferId, deviceId, projectId }) {
    await this.ready;
    return this.withStateLock(async () => {
      const record = this.recordFor({ id: transferId, deviceId, projectId });
      const error = transferError(409, 'The transfer was cancelled.', 'CONFLICT');
      this.cancelRecordChunks(record.id, error);
      record.state = 'cancelled';
      await this.removeRecordLocked(record, 'cancelled');
      return { id: record.id, state: 'cancelled' };
    });
  }

  async invalidateDevice(deviceId) {
    await this.ready;
    return this.withStateLock(async () => {
      const records = [...this.records.values()].filter((record) => record.deviceId === deviceId);
      const error = transferError(401, 'Device access was revoked.', 'AUTH_REQUIRED');
      for (const record of records) {
        this.cancelRecordChunks(record.id, error);
        record.state = 'cancelled';
        await this.removeRecordLocked(record, 'revoked');
      }
    });
  }

  async resolveAttachmentIds({ deviceId, projectId, attachmentIds }) {
    await this.ready;
    return this.withStateLock(async () => {
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 10) throw transferError(400, 'At most ten attachment IDs are allowed.');
      const root = await realpath(this.directory);
      const seen = new Set();
      const result = [];
      for (const candidate of attachmentIds) {
        const transferId = id(candidate);
        if (seen.has(transferId)) throw transferError(400, 'Attachment IDs must be unique.');
        seen.add(transferId);
        const record = this.recordFor({ id: transferId, deviceId, projectId });
        if (record.state !== 'ready') throw transferError(409, 'Every attachment must finish uploading before the turn starts.', 'CONFLICT');
        const dataPath = this.filePath(record);
        const metadata = await lstat(dataPath);
        const canonical = await realpath(dataPath);
        if (!isRegularFile(metadata) || metadata.size !== record.size || canonical !== dataPath || !isWithin(root, canonical)) throw transferError(409, 'The staged attachment is no longer available.', 'CONFLICT');
        await this.touch(record);
        result.push({ id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, sha256: record.sha256, path: dataPath });
      }
      return result;
    });
  }

  async read(transferId, { deviceId, projectId } = {}) {
    await this.ready;
    return this.withStateLock(async () => {
      const record = this.recordFor({ id: transferId, deviceId, projectId });
      await this.touch(record);
      return this.publicRecord(record);
    });
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export const TRANSFER_LIMITS = Object.freeze({
  maxFileBytes: CONNECT_LIMITS.maxAttachmentBytes,
  maxFiles: DEFAULT_MAX_FILES,
  maxProjectBytes: DEFAULT_MAX_PROJECT_BYTES,
  maxGlobalBytes: DEFAULT_MAX_GLOBAL_BYTES,
  chunkBytes: DEFAULT_CHUNK_BYTES,
  ttlMs: DEFAULT_TTL_MS,
  maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
});

export const TRANSFER_READ_FLAGS = FS_CONSTANTS.O_NOFOLLOW ? FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW : FS_CONSTANTS.O_RDONLY;
