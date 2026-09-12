import { CONNECT_ERROR_CODES, CONNECT_LIMITS, PROTOCOL_VERSION } from '../../electron/connect/protocol.mjs';

export const DEFAULT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const TRANSFER_SCOPE_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ABORT_NAME = 'AbortError';

function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function errorWithCode(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, uncertain: false, ...extra });
}

function isAbortError(cause) {
  return cause?.name === ABORT_NAME || cause?.code === CONNECT_ERROR_CODES.REQUEST_ABORTED;
}

function normalizeScope(scope = {}) {
  return {
    hostId: typeof scope.hostId === 'string' ? scope.hostId : '',
    deviceId: typeof scope.deviceId === 'string' ? scope.deviceId : '',
    projectId: typeof scope.projectId === 'string' ? scope.projectId : ''
  };
}

export function transferScopeKey(scope = {}) {
  const normalized = normalizeScope(scope);
  return [normalized.hostId, normalized.deviceId, normalized.projectId].join(':');
}

export function createAttachmentScope({ api, hostId, projectId, deviceId } = {}) {
  const remote = api?.remote;
  return {
    hostId: hostId ?? remote?.hostId ?? 'local',
    deviceId: deviceId ?? remote?.deviceId ?? 'local',
    projectId: projectId ?? ''
  };
}

function advertisedCapabilities(api) {
  return api?.remote?.capabilities ?? api?.remote ?? null;
}

export function transferLimits(api) {
  const advertised = advertisedCapabilities(api)?.transfers?.limits ?? {};
  const legacy = advertisedCapabilities(api)?.limits ?? {};
  return {
    maxFileBytes: Number.isFinite(advertised.maxFileBytes) ? advertised.maxFileBytes : CONNECT_LIMITS.maxAttachmentBytes,
    maxFiles: Number.isFinite(advertised.maxFiles) ? advertised.maxFiles : CONNECT_LIMITS.maxAttachments,
    maxProjectBytes: Number.isFinite(advertised.maxProjectBytes) ? advertised.maxProjectBytes : CONNECT_LIMITS.maxBodyBytes,
    maxGlobalBytes: Number.isFinite(advertised.maxGlobalBytes) ? advertised.maxGlobalBytes : CONNECT_LIMITS.maxBodyBytes,
    chunkBytes: Number.isFinite(advertised.chunkBytes) ? Math.max(1, advertised.chunkBytes) : 1024 * 1024,
    ttlMs: Number.isFinite(advertised.ttlMs) ? advertised.ttlMs : 30 * 60 * 1000,
    maxDownloadBytes: Number.isFinite(advertised.maxDownloadBytes) ? advertised.maxDownloadBytes : DEFAULT_DOWNLOAD_BYTES,
    maxBodyBytes: Number.isFinite(legacy.maxBodyBytes) ? legacy.maxBodyBytes : CONNECT_LIMITS.maxBodyBytes
  };
}

export function transferMode(api) {
  return advertisedCapabilities(api)?.transfers?.uploads === true ? 'chunked' : 'legacy';
}

export function attachmentPolicy({ api, hostId, projectId, deviceId } = {}) {
  const scope = createAttachmentScope({ api, hostId, projectId, deviceId });
  const capabilities = advertisedCapabilities(api);
  const limits = transferLimits(api);
  return {
    mode: transferMode(api),
    uploads: capabilities?.transfers?.uploads === true,
    downloads: capabilities?.transfers?.downloads === true,
    limits,
    scope,
    scopeKey: transferScopeKey(scope)
  };
}

function objectUrlFor(file) {
  if (!file) return '';
  try {
    return globalThis.URL?.createObjectURL?.(file) ?? '';
  } catch {
    return '';
  }
}

export function createComposerAttachment(file, metadata = {}) {
  const url = objectUrlFor(file);
  return {
    id: metadata.id ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file?.name || metadata.name || 'Attachment',
    type: file?.type || metadata.type || 'application/octet-stream',
    size: Number.isInteger(file?.size) ? file.size : Number(metadata.size) || 0,
    file: file ?? null,
    url,
    sha256: metadata.sha256 ?? null,
    transferId: metadata.transferId ?? null,
    transferState: metadata.transferState ?? (metadata.transferId ? 'uploading' : null),
    uploadOffset: Number.isInteger(metadata.uploadOffset) ? metadata.uploadOffset : 0,
    scopeKey: metadata.scopeKey ?? null,
    needsReselect: !file
  };
}

export function disposeComposerAttachment(attachment) {
  const url = attachment?.url;
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try { globalThis.URL?.revokeObjectURL?.(url); } catch { /* A preview URL is already gone. */ }
  }
}

function safeStoredAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255) return null;
  const size = Number(value.size);
  if (!Number.isInteger(size) || size < 0 || size > CONNECT_LIMITS.maxAttachmentBytes) return null;
  const scope = normalizeScope(value.scope);
  const scopeKey = typeof value.scopeKey === 'string' && value.scopeKey.length <= 800 ? value.scopeKey : transferScopeKey(scope);
  return {
    id: typeof value.id === 'string' && value.id.length <= 100 ? value.id : undefined,
    name: value.name.trim().slice(0, 255),
    type: typeof value.type === 'string' ? value.type.slice(0, 255) : 'application/octet-stream',
    size,
    sha256: HASH_PATTERN.test(value.sha256 ?? '') ? value.sha256.toLowerCase() : null,
    transferId: UUID_PATTERN.test(value.transferId ?? '') ? value.transferId : null,
    transferState: ['uploading', 'ready', 'cancelled', 'failed'].includes(value.transferState) ? value.transferState : null,
    uploadOffset: Number.isInteger(value.uploadOffset) && value.uploadOffset >= 0 ? value.uploadOffset : 0,
    scope,
    scopeKey,
    needsReselect: true
  };
}

export function serializeAttachmentMetadata(attachments, scope = null) {
  const fallbackScope = normalizeScope(scope ?? {});
  return (attachments ?? []).slice(0, CONNECT_LIMITS.maxAttachments).map((attachment) => {
    const attachmentScope = normalizeScope(attachment.scope ?? fallbackScope);
    return {
      id: typeof attachment.id === 'string' ? attachment.id.slice(0, 100) : undefined,
      name: String(attachment.name ?? 'Attachment').slice(0, 255),
      type: String(attachment.type ?? 'application/octet-stream').slice(0, 255),
      size: Math.max(0, Math.min(CONNECT_LIMITS.maxAttachmentBytes, Number(attachment.size) || 0)),
      ...(HASH_PATTERN.test(attachment.sha256 ?? '') ? { sha256: attachment.sha256.toLowerCase() } : {}),
      ...(UUID_PATTERN.test(attachment.transferId ?? '') ? { transferId: attachment.transferId } : {}),
      ...(attachment.transferState ? { transferState: attachment.transferState } : {}),
      uploadOffset: Number.isInteger(attachment.uploadOffset) ? Math.max(0, attachment.uploadOffset) : 0,
      scope: attachmentScope,
      scopeKey: transferScopeKey(attachmentScope),
      version: TRANSFER_SCOPE_VERSION
    };
  });
}

export function restoreAttachmentMetadata(value, scope = null) {
  if (!Array.isArray(value)) return [];
  const currentScope = normalizeScope(scope ?? {});
  const currentScopeKey = transferScopeKey(currentScope);
  return value.slice(0, CONNECT_LIMITS.maxAttachments).map(safeStoredAttachment).filter(Boolean).map((metadata, index) => ({
    ...metadata,
    id: metadata.id ?? `restored:${index}:${metadata.name}`,
    // A staged ID is useful only to the exact device, host, and project that created it.
    transferId: metadata.scopeKey === currentScopeKey ? metadata.transferId : null,
    transferState: metadata.scopeKey === currentScopeKey ? metadata.transferState : null,
    scope: currentScope,
    scopeKey: currentScopeKey,
    file: null,
    url: '',
    needsReselect: true
  }));
}

export async function sha256Bytes(bytes) {
  if (!globalThis.crypto?.subtle) throw errorWithCode('This browser cannot verify file hashes.', CONNECT_ERROR_CODES.INVALID_RESPONSE);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256File(file, expectedHash = null) {
  if (!file || typeof file.arrayBuffer !== 'function') throw errorWithCode('Reselect the file before uploading it.', CONNECT_ERROR_CODES.INVALID_REQUEST);
  if (expectedHash !== undefined && expectedHash !== null && !HASH_PATTERN.test(String(expectedHash))) {
    throw errorWithCode('The saved attachment hash is invalid. Reselect the file before uploading it.', CONNECT_ERROR_CODES.INVALID_REQUEST);
  }
  const actualHash = await sha256Bytes(await file.arrayBuffer());
  if (expectedHash && actualHash !== String(expectedHash).toLowerCase()) {
    throw errorWithCode('The reselected file does not match the saved upload.', CONNECT_ERROR_CODES.CONFLICT, { expectedHash: String(expectedHash).toLowerCase(), actualHash });
  }
  return actualHash;
}

export async function verifyAttachmentFile(file, expectedHash) {
  return sha256File(file, expectedHash);
}

export function encodeFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(errorWithCode('Reselect the file before sending it.', CONNECT_ERROR_CODES.INVALID_REQUEST)); return; }
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? errorWithCode('Could not read attachment.', CONNECT_ERROR_CODES.INVALID_REQUEST)));
    reader.readAsDataURL(file);
  });
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', ABORT_NAME)), timeoutMs);
  const forward = () => controller.abort(signal?.reason ?? new DOMException('The request was aborted.', ABORT_NAME));
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', forward); }
  };
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch { return null; }
}

function fetchWithAbort(fetchImpl, url, options) {
  const signal = options?.signal;
  if (!signal) return fetchImpl(url, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('The request was aborted.', ABORT_NAME));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(fetchImpl(url, options)).then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

async function verifyRemoteIdentity(api, fetchImpl, timeoutMs = 15_000) {
  const remote = api?.remote;
  if (!remote?.endpoint || !remote.hostId) throw errorWithCode('The transfer host identity is unavailable.', CONNECT_ERROR_CODES.INVALID_REQUEST);
  if (remote.identityVerified === true) return;
  const timeout = timeoutSignal(null, timeoutMs);
  try {
    const response = await fetchWithAbort(fetchImpl, new URL('/api/connect/info', remote.endpoint), {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: timeout.signal
    });
    const info = await readJsonResponse(response);
    if (!response.ok || info?.protocol !== PROTOCOL_VERSION || info?.hostId !== remote.hostId) {
      throw errorWithCode('The transfer address belongs to a different Pixice host. Pair again before transferring files.', CONNECT_ERROR_CODES.INVALID_RESPONSE, { status: response.status });
    }
    remote.identityVerified = true;
  } catch (cause) {
    if (isAbortError(cause) || timeout.signal.aborted) throw errorWithCode('The transfer host identity check timed out.', CONNECT_ERROR_CODES.REQUEST_ABORTED, { cause });
    throw cause?.code ? cause : errorWithCode('The transfer host identity could not be verified.', CONNECT_ERROR_CODES.NETWORK_ERROR, { cause });
  } finally { timeout.dispose(); }
}

async function transferJson(api, route, { method = 'GET', body, signal, fetchImpl = globalThis.fetch, timeoutMs = 120_000, mutation = method !== 'GET', binary = false, chunkHash } = {}) {
  await verifyRemoteIdentity(api, fetchImpl);
  const remote = api.remote;
  const timeout = timeoutSignal(signal, timeoutMs);
  try {
    const response = await fetchWithAbort(fetchImpl, new URL(`/api/connect/${route}`, remote.endpoint), {
      method,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${remote.token}`,
        ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}),
        ...(chunkHash ? { 'X-Pixice-Chunk-Sha256': chunkHash } : {})
      },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
      signal: timeout.signal
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw Object.assign(new Error(result?.error || `Transfer failed (${response.status})`), { status: response.status, code: result?.code || `HTTP_${response.status}`, uncertain: Boolean(mutation) });
    return result;
  } catch (cause) {
    if (isAbortError(cause) || timeout.signal.aborted) throw errorWithCode('The file transfer was cancelled or timed out.', CONNECT_ERROR_CODES.REQUEST_ABORTED, { cause });
    if (!cause?.code && !cause?.status) throw errorWithCode('The file transfer could not be completed.', CONNECT_ERROR_CODES.NETWORK_ERROR, { cause, uncertain: Boolean(mutation) });
    throw cause;
  } finally { timeout.dispose(); }
}

function currentScopeFor(attachment, scopeKey) {
  return attachment?.scopeKey === scopeKey;
}

function isIntentionalDataUrl(value) {
  return typeof value === 'string' && /^data:/i.test(value);
}

function attachmentSize(attachment) {
  return Number(attachment?.file?.size ?? attachment?.size);
}

function assertFileLimits(files, limits) {
  if (files.length > limits.maxFiles) throw errorWithCode(`You can attach up to ${limits.maxFiles} files on this host.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
  let total = 0;
  for (const attachment of files) {
    const size = attachmentSize(attachment);
    if (!Number.isInteger(size) || size < 0 || size > limits.maxFileBytes) throw errorWithCode(`${attachment.name || 'A file'} is larger than the ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB host limit.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
    total += size;
  }
  if (total > limits.maxProjectBytes) throw errorWithCode(`These files exceed the ${Math.floor(limits.maxProjectBytes / 1024 / 1024)} MB project transfer limit.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
}

function emitProgress(onProgress, attachments, states) {
  const files = attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    size: Number.isInteger(attachment.file?.size) ? attachment.file.size : Number(attachment.size) || 0,
    offset: states.get(attachment.id)?.offset ?? Math.max(0, Number(attachment.uploadOffset) || 0),
    state: states.get(attachment.id)?.state ?? 'pending'
  }));
  onProgress?.({
    files,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    uploadedBytes: files.reduce((total, file) => total + Math.min(file.size, file.offset), 0),
    activeCount: files.filter((file) => ['uploading', 'resuming'].includes(file.state)).length
  });
}

async function transferStatus(api, id, projectId, options) {
  return transferJson(api, `uploads/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, options);
}

function assertAttachmentFile(attachment, { reselect = false } = {}) {
  if (!attachment?.file || typeof attachment.file.arrayBuffer !== 'function' || typeof attachment.file.slice !== 'function') {
    throw errorWithCode(`Reselect ${attachment?.name || 'this file'}${reselect ? '' : ' before sending it'}.`, CONNECT_ERROR_CODES.INVALID_REQUEST);
  }
  const fileSize = Number(attachment.file.size);
  if (!Number.isInteger(fileSize) || fileSize < 0) throw errorWithCode(`The selected file ${attachment.name || 'is invalid'}.`, CONNECT_ERROR_CODES.INVALID_REQUEST);
  if (attachment.transferId && Number(attachment.size) !== fileSize) {
    throw errorWithCode(`The reselected file does not match the saved size for ${attachment.name || 'this file'}.`, CONNECT_ERROR_CODES.CONFLICT);
  }
  attachment.size = fileSize;
  return fileSize;
}

function throwIfAborted(signal, message = 'The file transfer was cancelled.') {
  if (signal?.aborted) throw errorWithCode(message, CONNECT_ERROR_CODES.REQUEST_ABORTED, { name: ABORT_NAME, cause: signal.reason });
}

function invalidTransferResponse(name, detail) {
  return errorWithCode(`The host returned invalid upload state for ${name}. ${detail}`, CONNECT_ERROR_CODES.INVALID_RESPONSE);
}

function validateTransferRecord(value, transferId, fileSize, name, { allowTerminal = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTransferResponse(name, '');
  if (typeof value.id !== 'string' || !UUID_PATTERN.test(value.id) || value.id.toLowerCase() !== String(transferId).toLowerCase()) throw invalidTransferResponse(name, 'The transfer ID is invalid.');
  if (!Number.isInteger(value.size) || value.size !== fileSize) throw invalidTransferResponse(name, 'The file size is invalid.');
  if (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > fileSize) throw invalidTransferResponse(name, 'The transfer offset is invalid.');
  const states = allowTerminal ? ['uploading', 'ready', 'cancelled', 'expired'] : ['uploading', 'ready'];
  if (!states.includes(value.state)) throw invalidTransferResponse(name, 'The transfer state is invalid.');
  if (value.state === 'ready' && value.offset !== fileSize) throw invalidTransferResponse(name, 'The ready transfer is incomplete.');
  return value;
}

function updateUploadMetadata(attachment, { transferId, scopeKey, state, offset, onAttachmentUpdate }) {
  if (transferId !== undefined) attachment.transferId = transferId;
  if (scopeKey !== undefined) attachment.scopeKey = scopeKey;
  if (state !== undefined) attachment.transferState = state;
  if (offset !== undefined) attachment.uploadOffset = offset;
  onAttachmentUpdate?.(attachment);
}

async function uploadOne(api, attachment, policy, { signal, resumeOnly, states, progressAttachments, onProgress, onAttachmentUpdate, fetchImpl, registerTransferId, unregisterTransferId }) {
  const scopeKey = policy.scopeKey;
  const fileSize = assertAttachmentFile(attachment, { reselect: Boolean(attachment.transferId) });
  throwIfAborted(signal);
  if (attachment.transferId && (typeof attachment.transferId !== 'string' || !UUID_PATTERN.test(attachment.transferId))) {
    if (resumeOnly) throw errorWithCode(`The saved upload ID for ${attachment.name || 'this file'} is invalid.`, CONNECT_ERROR_CODES.INVALID_REQUEST);
    attachment.transferId = null;
    attachment.transferState = null;
    attachment.uploadOffset = 0;
    onAttachmentUpdate?.(attachment);
  }
  if (attachment.transferId && !currentScopeFor(attachment, scopeKey)) {
    attachment.transferId = null;
    attachment.transferState = null;
    attachment.uploadOffset = 0;
    onAttachmentUpdate?.(attachment);
  }
  if (resumeOnly && !attachment.transferId) {
    throw errorWithCode(`There is no resumable upload for ${attachment.name || 'this file'}.`, CONNECT_ERROR_CODES.NOT_FOUND);
  }
  const expectedHash = attachment.sha256 ?? null;
  const actualHash = await verifyAttachmentFile(attachment.file, expectedHash);
  throwIfAborted(signal);
  if (attachment.sha256 !== actualHash) {
    attachment.sha256 = actualHash;
    onAttachmentUpdate?.(attachment);
  }
  let transferId = attachment.transferId;
  let status = null;
  if (transferId) {
    registerTransferId?.(transferId);
    try {
      status = await transferStatus(api, transferId, policy.scope.projectId, { signal, fetchImpl });
      throwIfAborted(signal);
      status = validateTransferRecord(status, transferId, fileSize, attachment.name || 'this file', { allowTerminal: true });
    } catch (cause) {
      if (cause.status !== 404) throw cause;
      throwIfAborted(signal);
      unregisterTransferId?.(transferId);
      transferId = null;
      attachment.transferId = null;
      attachment.transferState = null;
      attachment.uploadOffset = 0;
      onAttachmentUpdate?.(attachment);
    }
  }
  if (status?.state === 'cancelled' || status?.state === 'expired' || attachment.transferState === 'cancelled' || attachment.transferState === 'expired') {
    if (resumeOnly) throw errorWithCode(`${attachment.name || 'This file'} needs a new upload. Send it again to restart.`, CONNECT_ERROR_CODES.CONFLICT);
    unregisterTransferId?.(transferId);
    transferId = null;
    status = null;
    updateUploadMetadata(attachment, { transferId: null, state: null, offset: 0, scopeKey, onAttachmentUpdate });
  }
  if (status?.state === 'ready' && status.offset === fileSize) {
    throwIfAborted(signal);
    updateUploadMetadata(attachment, { state: 'ready', offset: fileSize, scopeKey, onAttachmentUpdate });
    states.set(attachment.id, { state: 'ready', offset: fileSize });
    emitProgress(onProgress, progressAttachments, states);
    throwIfAborted(signal);
    return transferId;
  }
  if (resumeOnly && !status) {
    throw errorWithCode(`The saved upload for ${attachment.name || 'this file'} is unavailable. Send it again to restart.`, CONNECT_ERROR_CODES.NOT_FOUND);
  }
  if (!transferId) {
    throwIfAborted(signal);
    await verifyRemoteIdentity(api, fetchImpl);
    throwIfAborted(signal);
    const initialized = await transferJson(api, 'uploads', {
      method: 'POST',
      body: { projectId: policy.scope.projectId, name: attachment.name, mimeType: attachment.type, size: fileSize, sha256: actualHash },
      fetchImpl
    });
    if (!initialized || typeof initialized !== 'object' || typeof initialized.id !== 'string' || !UUID_PATTERN.test(initialized.id)) throw errorWithCode('The host returned an invalid upload ID.', CONNECT_ERROR_CODES.INVALID_RESPONSE);
    transferId = initialized.id;
    registerTransferId?.(transferId);
    status = validateTransferRecord(initialized, transferId, fileSize, attachment.name || 'this file');
    updateUploadMetadata(attachment, { transferId, scopeKey, state: 'uploading', offset: status.offset, onAttachmentUpdate });
    throwIfAborted(signal);
  } else {
    status = validateTransferRecord(status, transferId, fileSize, attachment.name || 'this file');
    throwIfAborted(signal);
    updateUploadMetadata(attachment, { scopeKey, state: 'uploading', offset: status.offset, onAttachmentUpdate });
  }
  let offset = status.offset;
  if (!Number.isInteger(offset) || offset < 0 || offset > fileSize) throw invalidTransferResponse(attachment.name || 'this file', 'The transfer offset is invalid.');
  states.set(attachment.id, { state: 'uploading', offset });
  emitProgress(onProgress, progressAttachments, states);
  while (offset < fileSize) {
    throwIfAborted(signal);
    const end = Math.min(fileSize, offset + policy.limits.chunkBytes);
    const bytes = await attachment.file.slice(offset, end).arrayBuffer();
    throwIfAborted(signal);
    const hash = await sha256Bytes(bytes);
    throwIfAborted(signal);
    let result;
    try {
      result = await transferJson(api, `uploads/${encodeURIComponent(transferId)}/chunk?projectId=${encodeURIComponent(policy.scope.projectId)}&offset=${offset}`, {
        method: 'POST',
        body: bytes,
        signal,
        fetchImpl,
        binary: true,
        chunkHash: hash
      });
      throwIfAborted(signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      let recovered = null;
      try {
        recovered = await transferStatus(api, transferId, policy.scope.projectId, { signal, fetchImpl });
        recovered = validateTransferRecord(recovered, transferId, fileSize, attachment.name || 'this file', { allowTerminal: true });
        if (recovered.state === 'ready') {
          updateUploadMetadata(attachment, { state: 'ready', offset: fileSize, scopeKey, onAttachmentUpdate });
          states.set(attachment.id, { state: 'ready', offset: fileSize });
        } else if (recovered.state === 'cancelled' || recovered.state === 'expired') {
          updateUploadMetadata(attachment, { state: recovered.state, offset: recovered.offset, scopeKey, onAttachmentUpdate });
          states.set(attachment.id, { state: recovered.state, offset: recovered.offset });
        } else {
          updateUploadMetadata(attachment, { state: 'uploading', offset: recovered.offset, scopeKey, onAttachmentUpdate });
          states.set(attachment.id, { state: 'uploading', offset: recovered.offset });
        }
        emitProgress(onProgress, progressAttachments, states);
      } catch (statusError) {
        if (statusError?.code === CONNECT_ERROR_CODES.INVALID_RESPONSE) throw statusError;
      }
      throw cause;
    }
    const chunkRecord = validateTransferRecord(result, transferId, fileSize, attachment.name || 'this file');
    const nextOffset = chunkRecord.offset;
    if (nextOffset <= offset) throw errorWithCode(`The host returned an invalid offset for ${attachment.name}.`, CONNECT_ERROR_CODES.INVALID_RESPONSE);
    offset = nextOffset;
    updateUploadMetadata(attachment, { offset, state: 'uploading', scopeKey, onAttachmentUpdate });
    states.set(attachment.id, { state: 'uploading', offset });
    emitProgress(onProgress, progressAttachments, states);
  }
  if (resumeOnly) {
    throwIfAborted(signal);
    updateUploadMetadata(attachment, { offset: fileSize, state: 'uploading', scopeKey, onAttachmentUpdate });
    states.set(attachment.id, { state: 'uploading', offset: fileSize });
    emitProgress(onProgress, progressAttachments, states);
    throwIfAborted(signal);
    return transferId;
  }
  throwIfAborted(signal);
  const completed = await transferJson(api, `uploads/${encodeURIComponent(transferId)}/complete`, {
    method: 'POST', body: { projectId: policy.scope.projectId }, signal, fetchImpl
  });
  throwIfAborted(signal);
  const completedRecord = validateTransferRecord(completed, transferId, fileSize, attachment.name || 'this file');
  if (completedRecord.state !== 'ready' || completedRecord.offset !== fileSize) throw errorWithCode(`The host did not finish ${attachment.name}.`, CONNECT_ERROR_CODES.INVALID_RESPONSE);
  updateUploadMetadata(attachment, { state: 'ready', offset: fileSize, scopeKey, onAttachmentUpdate });
  states.set(attachment.id, { state: 'ready', offset: fileSize });
  emitProgress(onProgress, progressAttachments, states);
  throwIfAborted(signal);
  return transferId;
}

export async function cancelUpload(api, transferId, projectId, { fetchImpl = globalThis.fetch } = {}) {
  if (!transferId || !projectId || !api?.remote) return null;
  return transferJson(api, `uploads/${encodeURIComponent(transferId)}/cancel`, {
    method: 'POST', body: { projectId }, fetchImpl, mutation: false
  });
}

async function uploadChunked(api, attachments, policy, { signal, resumeOnly = false, onProgress, onAttachmentUpdate, fetchImpl = globalThis.fetch } = {}) {
  const files = attachments.filter((attachment) => attachment?.file);
  assertFileLimits(attachments, policy.limits);
  const states = new Map();
  emitProgress(onProgress, attachments, states);
  const internal = new AbortController();
  const forward = () => internal.abort(signal?.reason ?? new DOMException('The file transfer was cancelled.', ABORT_NAME));
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  let cursor = 0;
  const activeIds = new Set(files
    .filter((attachment) => currentScopeFor(attachment, policy.scopeKey) && UUID_PATTERN.test(attachment.transferId ?? ''))
    .map((attachment) => attachment.transferId));
  const registerTransferId = (transferId) => {
    if (UUID_PATTERN.test(transferId ?? '')) activeIds.add(transferId);
  };
  const unregisterTransferId = (transferId) => { if (transferId) activeIds.delete(transferId); };
  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const attachment = files[index];
      await uploadOne(api, attachment, policy, { signal: internal.signal, resumeOnly, states, progressAttachments: attachments, onProgress, onAttachmentUpdate, fetchImpl, registerTransferId, unregisterTransferId });
    }
  };
  const workers = Array.from({ length: Math.min(2, files.length) }, () => worker());
  try {
    await Promise.all(workers);
    return attachments;
  } catch (cause) {
    if (!internal.signal.aborted) internal.abort(new DOMException('Another upload failed.', ABORT_NAME));
    await Promise.allSettled(workers);
    if (signal?.aborted) {
      await Promise.allSettled([...activeIds].map((id) => cancelUpload(api, id, policy.scope.projectId, { fetchImpl })));
    }
    throw cause;
  } finally { signal?.removeEventListener?.('abort', forward); }
}

export async function prepareSubmissionAttachments({ api, projectId, hostId, deviceId, attachments = [], signal, onProgress, onAttachmentUpdate, resumeOnly = false, fetchImpl = globalThis.fetch } = {}) {
  const policy = attachmentPolicy({ api, hostId, projectId, deviceId });
  const selected = attachments.slice(0, policy.limits.maxFiles);
  if (attachments.length > policy.limits.maxFiles) throw errorWithCode(`You can attach up to ${policy.limits.maxFiles} files on this host.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
  for (const attachment of selected) {
    if (!attachment?.file && !isIntentionalDataUrl(attachment?.dataUrl)) {
      throw errorWithCode(`Reselect ${attachment?.name || 'this file'} before sending it.`, CONNECT_ERROR_CODES.INVALID_REQUEST);
    }
  }
  assertFileLimits(selected, policy.limits);
  if (policy.mode === 'chunked') {
    await uploadChunked(api, selected, policy, { signal, resumeOnly, onProgress, onAttachmentUpdate, fetchImpl });
    if (resumeOnly) return { attachments: [], attachmentIds: [], policy };
    const attachmentIds = [];
    const inline = [];
    for (const attachment of selected) {
      if (attachment.file) {
        if (!attachment.transferId || attachment.transferState !== 'ready' || !currentScopeFor(attachment, policy.scopeKey)) throw errorWithCode(`Every file must finish uploading before sending.`, CONNECT_ERROR_CODES.CONFLICT);
        attachmentIds.push(attachment.transferId);
      } else if (attachment.dataUrl) inline.push({ name: attachment.name, type: attachment.type, size: attachment.size, dataUrl: attachment.dataUrl });
    }
    return { attachments: inline, attachmentIds, policy };
  }
  if (resumeOnly) throw errorWithCode('This host does not support resumable uploads.', CONNECT_ERROR_CODES.NOT_FOUND);
  const inline = [];
  for (const attachment of selected) {
    if (attachment.file) {
      if (attachment.transferId) throw errorWithCode(`Resume ${attachment.name || 'this file'} before sending again.`, CONNECT_ERROR_CODES.CONFLICT);
      const dataUrl = /^data:/i.test(String(attachment.dataUrl ?? ''))
        ? attachment.dataUrl
        : await encodeFileAsDataUrl(attachment.file);
      inline.push({ name: attachment.name, type: attachment.type, size: attachment.size, dataUrl });
    } else if (attachment.dataUrl) inline.push({ name: attachment.name, type: attachment.type, size: attachment.size, dataUrl: attachment.dataUrl });
    else throw errorWithCode(`Reselect ${attachment.name || 'this file'} before sending it.`, CONNECT_ERROR_CODES.INVALID_REQUEST);
  }
  return { attachments: inline, attachmentIds: [], policy };
}

export async function resumeAttachmentUploads(options = {}) {
  return prepareSubmissionAttachments({ ...options, resumeOnly: true });
}

export function requestPayloadWithAttachments(payload, prepared) {
  return {
    ...payload,
    attachments: prepared?.attachments ?? [],
    ...(prepared?.attachmentIds?.length ? { attachmentIds: prepared.attachmentIds } : {})
  };
}

export function assertSubmissionRequestBudget({ api, operation, payload, maxBodyBytes } = {}) {
  const limits = transferLimits(api);
  const maximum = maxBodyBytes ?? limits.maxBodyBytes;
  const hasThreadId = typeof payload?.threadId === 'string' && payload.threadId.length > 0;
  const descriptor = {
    id: '00000000-0000-0000-0000-000000000000',
    operation,
    issuedAt: Date.now(),
    instanceId: api?.remote?.instanceId ?? ''
  };
  const budgetPayload = hasThreadId ? payload : { ...payload, threadId: 't'.repeat(256) };
  const body = JSON.stringify({ ...descriptor, payload: budgetPayload });
  const bodyBytes = byteLength(body);
  if (bodyBytes > maximum) throw errorWithCode(`The encoded request body is ${Math.ceil(bodyBytes / 1024 / 1024)} MiB, above the ${maximum / 1024 / 1024} MiB maximum total.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE, { bodyBytes, maxBodyBytes: maximum });
  return bodyBytes;
}

function safeFilename(value) {
  const fallback = 'download';
  const normalized = String(value ?? '').split(/[\\/]/).at(-1)?.replace(/["\r\n]/g, '_').slice(0, 180);
  return normalized || fallback;
}

function contentDispositionFilename(value) {
  const header = String(value ?? '');
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (utf) {
    try { return safeFilename(decodeURIComponent(utf)); } catch { /* Use the regular filename below. */ }
  }
  const regular = /filename="([^"]+)"/i.exec(header)?.[1] ?? /filename=([^;]+)/i.exec(header)?.[1];
  return regular ? safeFilename(regular) : null;
}

export function canDownloadRemoteFile(api, file) {
  return Boolean(api?.remote && advertisedCapabilities(api)?.transfers?.downloads === true && file?.path && file.external !== true);
}

function parseContentLength(headers) {
  const raw = headers?.get?.('content-length');
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) throw errorWithCode('The host returned an invalid download length.', CONNECT_ERROR_CODES.INVALID_RESPONSE);
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw errorWithCode('The host returned an invalid download length.', CONNECT_ERROR_CODES.INVALID_RESPONSE);
  return length;
}

function cancelDownloadBody(response, reader, cause) {
  try {
    const cancellation = reader?.cancel?.(cause) ?? response?.body?.cancel?.(cause);
    Promise.resolve(cancellation).catch(() => {});
  } catch { /* The body may already be closed. */ }
  try { reader?.releaseLock?.(); } catch { /* The reader may already be released. */ }
}

function readWithAbort(reader, signal) {
  if (!signal) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('The download was cancelled.', ABORT_NAME));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(reader.read()).then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

function valueWithAbort(valueFactory, signal) {
  if (!signal) return valueFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('The request was aborted.', ABORT_NAME));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve().then(valueFactory).then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

export async function downloadRemoteFile({ api, projectId, path, signal, onProgress, fetchImpl = globalThis.fetch } = {}) {
  if (!canDownloadRemoteFile(api, { path })) throw errorWithCode('Downloads are unavailable for this host or role.', CONNECT_ERROR_CODES.NOT_FOUND);
  throwIfAborted(signal, 'The download was cancelled.');
  const policy = attachmentPolicy({ api, projectId });
  await verifyRemoteIdentity(api, fetchImpl);
  const timeout = timeoutSignal(signal, 120_000);
  let response = null;
  let reader = null;
  let bodyCancelled = false;
  const stopBody = (cause) => {
    if (bodyCancelled) return;
    bodyCancelled = true;
    cancelDownloadBody(response, reader, cause);
  };
  try {
    const url = new URL('/api/connect/download', api.remote.endpoint);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('path', path);
    response = await fetchWithAbort(fetchImpl, url, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${api.remote.token}` }, signal: timeout.signal
    });
    if (!response.ok) {
      const result = await readJsonResponse(response);
      throw Object.assign(new Error(result?.error || `Download failed (${response.status})`), { status: response.status, code: result?.code || `HTTP_${response.status}` });
    }
    const declared = parseContentLength(response.headers);
    if (Number.isFinite(declared) && declared > policy.limits.maxDownloadBytes) {
      stopBody(new Error('The generated file is too large to download.'));
      throw errorWithCode('The generated file is too large to download.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
    }
    const chunks = [];
    let total = 0;
    reader = response.body?.getReader?.() ?? null;
    if (reader) {
      while (true) {
        if (timeout.signal.aborted) throw errorWithCode('The download was cancelled.', CONNECT_ERROR_CODES.REQUEST_ABORTED, { name: ABORT_NAME });
        const next = await readWithAbort(reader, timeout.signal);
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > policy.limits.maxDownloadBytes) { stopBody(new Error('The generated file is too large to download.')); throw errorWithCode('The generated file is too large to download.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE); }
        chunks.push(chunk);
        onProgress?.({ loaded: total, total: Number.isFinite(declared) ? declared : null });
      }
    } else {
      const bytes = await valueWithAbort(() => response.arrayBuffer(), timeout.signal);
      total = bytes.byteLength;
      if (total > policy.limits.maxDownloadBytes) { stopBody(new Error('The generated file is too large to download.')); throw errorWithCode('The generated file is too large to download.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE); }
      chunks.push(new Uint8Array(bytes));
      onProgress?.({ loaded: total, total: Number.isFinite(declared) ? declared : total });
    }
    if (Number.isFinite(declared) && declared !== total) throw errorWithCode('The download ended before the advertised file length.', CONNECT_ERROR_CODES.CONFLICT);
    return {
      blob: new Blob(chunks, { type: response.headers?.get?.('content-type') || 'application/octet-stream' }),
      filename: contentDispositionFilename(response.headers?.get?.('content-disposition'))
        || safeFilename(path),
      size: total
    };
  } catch (cause) {
    stopBody(cause);
    if (isAbortError(cause) || timeout.signal.aborted) throw errorWithCode('The download was cancelled or timed out.', CONNECT_ERROR_CODES.REQUEST_ABORTED, { cause });
    throw cause;
  } finally {
    try { reader?.releaseLock?.(); } catch { /* The reader may already be released. */ }
    timeout.dispose();
  }
}
