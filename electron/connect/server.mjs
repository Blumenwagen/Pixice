import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as FS_CONSTANTS, createReadStream, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { CONNECT_ERROR_CODES, CONNECT_LIMITS, CONNECT_RECOVERY_LIMITS, PROTOCOL_VERSION, OPERATIONS, REMOTE_EVENTS, READ_OPERATIONS, normalizeEndpoint } from './protocol.mjs';
import { canAccessProject, filterAttention, filterEventOrCursor, filterObserverReadiness, filterObserverResult, isObserver, normalizePairingAccess, operationAllowed, operationNeedsProject, persistedDeviceAccess, statusAccess, OBSERVER_OPERATIONS } from './access-policy.mjs';
import { normalizeExternalOrigin } from './push-contract.mjs';
import { TRANSFER_LIMITS } from './transfer-store.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const statusCode = (status) => ({
  400: CONNECT_ERROR_CODES.INVALID_REQUEST,
  401: CONNECT_ERROR_CODES.AUTH_REQUIRED,
  403: CONNECT_ERROR_CODES.FORBIDDEN,
  404: CONNECT_ERROR_CODES.NOT_FOUND,
  405: CONNECT_ERROR_CODES.METHOD_NOT_ALLOWED,
  409: CONNECT_ERROR_CODES.CONFLICT,
  413: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE,
  429: CONNECT_ERROR_CODES.RATE_LIMITED
}[status] ?? CONNECT_ERROR_CODES.INTERNAL_ERROR);
const fail = (status, message, code = statusCode(status)) => Object.assign(new Error(message), { status, code });
const MAX_BODY = CONNECT_LIMITS.maxBodyBytes;
const MAX_COMMAND_RESULT_BYTES = 256 * 1024;
const MAX_POLL_EVENTS = 100;
const MAX_PRIORITY_BURST = 512;
const MAX_PENDING_OPERATIONS = 64;
const MAX_PENDING_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_POLL_COALESCE_MS = 150;
const MAX_BODY_READERS = 8;
const MAX_PUSH_BODY = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 8;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REPLAY_PENDING_EVENTS = 512;
const MAX_REPLAY_PENDING_BYTES = 1024 * 1024;
const REPLAY_DRAIN_TIMEOUT_MS = 1_500;
const DEFAULT_PREAUTH_RATE_LIMIT = 120;
const PRIORITY_EVENT_TYPES = new Set(['AttentionRequired', 'AttentionResolved', 'AttentionReset', 'RuntimeError', 'BrowserOpenRequested', 'TaskPreviewOpenRequested', 'InstrumentInteractionUpdated']);
const PRIORITY_EVENT_METHOD = /approval|question|elicitation|interrupt/i;
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function decodedDataUrlBytes(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:[^;,]*;base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || match[1].length % 4 === 1) return null;
  const encoded = match[1];
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

function validatePayloadLimits(operation, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (operation === 'files.write' && typeof payload.content === 'string' && Buffer.byteLength(payload.content, 'utf8') > CONNECT_LIMITS.maxAttachmentBytes) {
    throw fail(413, `A file must be ${CONNECT_LIMITS.maxAttachmentBytes / 1024 / 1024} MiB or smaller.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
  }
  const attachmentIdCount = Array.isArray(payload.attachmentIds) ? payload.attachmentIds.length : 0;
  if (attachmentIdCount > CONNECT_LIMITS.maxAttachments || (attachmentIdCount && payload.attachmentIds.some((value) => typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)))) {
    throw fail(413, `A request may contain at most ${CONNECT_LIMITS.maxAttachments} valid attachment IDs.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
  }
  const attachmentCount = attachmentIdCount + (Array.isArray(payload.attachments) ? payload.attachments.length : 0) + (Array.isArray(payload.images) ? payload.images.length : 0);
  if (attachmentCount > CONNECT_LIMITS.maxAttachments) throw fail(413, `A request may contain at most ${CONNECT_LIMITS.maxAttachments} attachments.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
  for (const [field, values] of [['attachments', payload.attachments], ['images', payload.images]]) {
    if (values === undefined) continue;
    if (!Array.isArray(values)) continue;
    if (values.length > CONNECT_LIMITS.maxAttachments) throw fail(413, `A request may contain at most ${CONNECT_LIMITS.maxAttachments} attachments.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
    values.forEach((value, index) => {
      const dataUrl = typeof value === 'string' ? value : value?.dataUrl;
      const declaredBytes = typeof value === 'object' && Number.isFinite(value?.size) ? value.size : null;
      if (declaredBytes !== null && declaredBytes > CONNECT_LIMITS.maxAttachmentBytes) {
        throw fail(413, `${field}[${index}] is larger than ${CONNECT_LIMITS.maxAttachmentBytes / 1024 / 1024} MiB.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
      }
      const bytes = decodedDataUrlBytes(dataUrl);
      if (bytes !== null && bytes > CONNECT_LIMITS.maxAttachmentBytes) {
        throw fail(413, `${field}[${index}] is larger than ${CONNECT_LIMITS.maxAttachmentBytes / 1024 / 1024} MiB.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
      }
    });
  }
}

function boundedMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return {
    ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId.slice(0, CONNECT_RECOVERY_LIMITS.maxIdentifierLength) } : {}),
    ...(typeof payload.threadId === 'string' ? { threadId: payload.threadId.slice(0, CONNECT_RECOVERY_LIMITS.maxIdentifierLength) } : {})
  };
}

function contentDispositionFilename(value) {
  const filename = Array.from(path.basename(String(value ?? ''))).slice(0, 180).join('') || 'download';
  const fallback = Array.from(filename, (character) => /^[\x20-\x7E]$/u.test(character) && character !== '"' && character !== '\\' ? character : '_').join('') || 'download';
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export class ConnectServer {
  constructor({ directory, clientDirectory, invoke, attention = () => [], readiness = () => ({}), knownProjectIds = () => [], projectExists = (projectId) => knownProjectIds().includes(projectId), resolveFile = null, resolveEventProject = (event) => event?.payload?.projectId ?? null, version = 'development', tls, tlsFiles, onChange = () => {}, initialState, persist = true, apiRateLimit = 1200, preauthRateLimit = DEFAULT_PREAUTH_RATE_LIMIT, deviceRateLimits = {}, pollBatchSize = MAX_POLL_EVENTS, pollCoalesceMs = DEFAULT_POLL_COALESCE_MS, commandResultBytes = MAX_COMMAND_RESULT_BYTES, operations = OPERATIONS, readOperations = READ_OPERATIONS, eventFilter = (event) => REMOTE_EVENTS.has(event.type) && !(event.type === 'FilePreviewOpenRequested' && event.payload?.file?.external), transferStore = null, pushService = null, onDeviceRevoked = () => {}, maxDownloadBytes = MAX_DOWNLOAD_BYTES, maxConcurrentDownloads = DEFAULT_MAX_CONCURRENT_DOWNLOADS, downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS }) {
    this.directory = directory;
    this.apiRateLimit = apiRateLimit; this.replayFloor = 0;
    this.preauthRateLimit = preauthRateLimit;
    const scale = Math.max(1, Number(apiRateLimit) || 1);
    this.deviceRateLimits = {
      poll: Math.max(1200, Math.floor(scale)),
      read: Math.max(1200, Math.floor(scale)),
      mutation: Math.max(120, Math.floor(scale / 4)),
      control: Math.max(120, Math.floor(scale / 8)),
      ...deviceRateLimits
    };
    this.pollBatchSize = Math.min(MAX_PRIORITY_BURST, Math.max(1, Number(pollBatchSize) || MAX_POLL_EVENTS));
    this.pollCoalesceMs = Math.min(200, Math.max(100, Number(pollCoalesceMs) || DEFAULT_POLL_COALESCE_MS));
    this.commandResultBytes = Math.min(1024 * 1024, Math.max(1, Number(commandResultBytes) || MAX_COMMAND_RESULT_BYTES));
    this.persist = persist; this.allowedOperations = operations; this.readOperations = readOperations; this.eventFilter = eventFilter;
    this.readiness = readiness;
    this.knownProjectIds = knownProjectIds;
    this.projectExists = projectExists;
    this.resolveFile = resolveFile;
    this.transferStore = transferStore;
    this.pushService = pushService;
    this.maxDownloadBytes = Math.max(0, Number(maxDownloadBytes) || MAX_DOWNLOAD_BYTES);
    this.maxConcurrentDownloads = Math.max(1, Number(maxConcurrentDownloads) || DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    this.downloadTimeoutMs = Math.max(1, Number(downloadTimeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS);
    this.downloads = new Set();
    this.downloadCount = 0;
    this.stopping = false;
    this.onDeviceRevoked = onDeviceRevoked;
    this.resolveEventProject = resolveEventProject;
    this.clientDirectory = clientDirectory;
    this.invoke = invoke;
    this.attention = attention;
    this.version = version;
    this.tls = tls;
    if (tlsFiles) {
      try {
        if (!tlsFiles.cert || !tlsFiles.key) throw new Error('Both certificate and key are required');
        this.tls = { cert: readFileSync(tlsFiles.cert), key: readFileSync(tlsFiles.key) };
      } catch {
        this.tlsError = 'Connect TLS files could not be read. Restore the certificate and key, then restart Pixice.';
        this.error = this.tlsError;
      }
    }
    this.onChange = onChange;
    this.instanceId = randomUUID();
    this.sequence = 0;
    this.events = [];
    this.eventBytes = 0;
    this.streams = new Set();
    this.polls = new Set();
    this.operations = new Map();
    this.operationBytes = 0;
    this.pendingOperations = 0;
    this.pendingRequestBytes = 0;
    this.readAudit = new Map();
    this.rates = new Map();
    this.deviceRates = new Map();
    this.bodyReaders = 0;
    this.state = { hostId: randomUUID(), name: hostname(), enabled: false, port: 43187, host: '127.0.0.1', publicUrl: '', origins: [], devices: [], offers: [], audit: [] };
    const file = path.join(directory, 'connect.json');
    // Corrupt credentials must never silently reset or enable the listener.
    if (persist && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (!saved || typeof saved.enabled !== 'boolean' || typeof saved.hostId !== 'string' || !Array.isArray(saved.devices) || !Array.isArray(saved.offers) || !Array.isArray(saved.audit)) throw new Error('Invalid connection settings');
        this.state = { ...this.state, ...saved };
      } catch {
        this.error = 'Connect settings could not be read. Save connection settings to reset remote access.';
      }
    }
    if (initialState) Object.assign(this.state, initialState);
  }

  save() {
    if (!this.persist) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'connect.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  audit(action, deviceId, result = 'ok') {
    this.state.audit.push({ at: new Date().toISOString(), action, deviceId, result });
    this.state.audit = this.state.audit.slice(-500);
    this.save();
  }
  status() {
    return { hostId: this.state.hostId, name: this.state.name, enabled: this.state.enabled, running: Boolean(this.server?.listening), port: this.server?.address()?.port ?? this.state.port, host: this.state.host, publicUrl: this.state.publicUrl, origins: this.state.origins, pairing: { roles: ['operator', 'observer'], renew: true }, error: this.error ?? null, devices: this.state.devices.map(({ tokenHash, ...device }) => ({ ...device, ...statusAccess(device) })), offers: this.state.offers.map(({ tokenHash, ...offer }) => ({ ...offer, ...statusAccess(offer) })), audit: this.state.audit.slice(-30).reverse(), protocol: PROTOCOL_VERSION };
  }
  supportedOperations(access = { role: 'operator', projectIds: null }) {
    const operations = isObserver(access)
      ? [...OBSERVER_OPERATIONS]
      : this.allowedOperations instanceof Map ? [...this.allowedOperations.keys()] : [...this.allowedOperations];
    if (!isObserver(access) && !operations.includes('projects.directories')) operations.push('projects.directories');
    return operations.filter((operation) => typeof operation === 'string' && operation.length <= 100).slice(0, 500).sort();
  }
  session(device = null) {
    const access = device ? persistedDeviceAccess(device) : { role: 'operator', projectIds: null };
    const name = String(this.state.name ?? '').slice(0, 80);
    const version = String(this.version ?? '').slice(0, 80);
    return {
      protocol: PROTOCOL_VERSION,
      hostId: String(this.state.hostId).slice(0, 100),
      instanceId: String(this.instanceId).slice(0, 100),
      host: { id: String(this.state.hostId).slice(0, 100), name, version },
      name,
      version,
      operations: this.supportedOperations(access),
      role: access?.role ?? null,
      projectIds: access?.projectIds ?? null,
      expiresAt: device?.expiresAt ?? null,
      readiness: isObserver(access) ? filterObserverReadiness(this.readiness()) : this.readiness(),
      limits: { ...CONNECT_LIMITS },
      transport: { poll: true, sse: true },
      transfers: {
        uploads: Boolean(this.transferStore) && !isObserver(access) && Boolean(device && this.operationAllowed(device, 'files.write')),
        downloads: Boolean(this.resolveFile) && Boolean(device && this.operationAllowed(device, 'files.read')),
        limits: { ...TRANSFER_LIMITS, ...(this.transferStore?.limits?.() ?? {}), maxDownloadBytes: this.maxDownloadBytes }
      },
      push: { supported: Boolean(this.pushService) },
      pairing: { roles: ['operator', 'observer'], renew: true }
    };
  }
  boundedCommandResult(value, record = null) {
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); } catch { return { truncated: true, reason: 'unserializable' }; }
    if (bytes <= this.commandResultBytes) return value ?? null;
    const threadId = value && typeof value === 'object' && typeof value.thread?.id === 'string' ? value.thread.id : null;
    return {
      truncated: true, bytes, maxBytes: this.commandResultBytes,
      ...(record?.projectId ? { projectId: record.projectId } : {}),
      ...(threadId ? { resultSummary: { threadId: threadId.slice(0, CONNECT_RECOVERY_LIMITS.maxIdentifierLength) } } : {})
    };
  }
  pruneOperations(now = Date.now()) {
    for (const [id, operation] of this.operations) {
      if (!operation.completed || operation.until >= now) continue;
      this.operations.delete(id);
      this.operationBytes = Math.max(0, this.operationBytes - (operation.bytes ?? 0));
    }
  }
  eventBatch(entries) {
    if (entries.length <= this.pollBatchSize) return entries;
    const priorityIndex = entries.findIndex((entry) => this.isPriorityEvent(entry.envelope ?? entry));
    const end = priorityIndex >= this.pollBatchSize && priorityIndex < this.pollBatchSize + MAX_PRIORITY_BURST ? priorityIndex + 1 : this.pollBatchSize;
    return entries.slice(0, end);
  }
  async configure(value) {
    if (!value || typeof value.enabled !== 'boolean') throw new Error('Choose whether remote access is enabled');
    const port = Number(value.port ?? this.state.port);
    const host = value.host ?? this.state.host;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
    if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('Unsupported bind address');
    if (host === '0.0.0.0' && !this.tls) throw new Error('Direct network access requires a TLS certificate. Use the loopback listener with an HTTPS tunnel.');
    const publicUrl = value.publicUrl ? normalizeEndpoint(value.publicUrl) : '';
    const origins = (value.origins ?? []).map(normalizeEndpoint);
    if (origins.length > 10) throw new Error('At most ten client origins are supported');
    await this.stop();
    Object.assign(this.state, { enabled: value.enabled, port, host, publicUrl, origins, name: String(value.name || this.state.name).trim().slice(0, 80) });
    this.save();
    if (this.state.enabled) await this.start();
    this.onChange(this.status());
    return this.status();
  }
  async start() {
    if (!this.state.enabled || this.server) return;
    if (this.tlsError) throw new Error(this.tlsError);
    if (!['127.0.0.1', '::1'].includes(this.state.host) && !this.tls) { this.error = 'Network access requires a TLS certificate. Restore the certificate or select a loopback listener.'; throw new Error(this.error); }
    if (this.state.publicUrl) normalizeEndpoint(this.state.publicUrl);
    this.error = null;
    this.stopping = false;
    const handler = (req, res) => { void this.route(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      const status = error.status ?? 500;
      this.json(res, status, {
        error: error.status ? error.message : 'The host could not complete this request.',
        code: error.code ?? statusCode(status),
        status
      });
    }); };
    const server = this.tls ? https.createServer(this.tls, handler) : http.createServer(handler);
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.maxConnections = 100;
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.state.port, this.state.host, resolve); });
      server.on('error', (error) => { this.error = error.message; this.onChange(this.status()); });
      this.heartbeat = setInterval(() => {
        for (const stream of this.streams) {
          if (!this.device(stream.deviceId)) stream.res.end();
          else if (!stream.res.write(': heartbeat\n\n')) stream.res.end();
        }
      }, 15_000);
      this.heartbeat.unref();
    } catch (error) {
      this.server = null;
      this.error = `Could not listen on ${this.state.host}:${this.state.port}: ${error.code ?? error.message}`;
      throw new Error(this.error);
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.heartbeat);
    for (const download of [...this.downloads]) download.stop();
    this.downloads.clear();
    for (const stream of this.streams) stream.res.end();
    this.streams.clear();
    for (const poll of this.polls) { clearTimeout(poll.timer); clearTimeout(poll.flushTimer); poll.res.end(); }
    this.polls.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }
  pairOffer(accessValue = {}) {
    if (!this.server?.listening) throw new Error('Enable remote access first');
    const access = normalizePairingAccess(accessValue, { knownProjectIds: this.knownProjectIds() });
    const token = secret();
    const offer = { id: randomUUID(), tokenHash: digest(token), expiresAt: Date.now() + 5 * 60_000, ...access };
    this.state.offers = this.state.offers.filter((o) => o.expiresAt > Date.now()).slice(-9);
    this.state.offers.push(offer);
    this.audit('pairing.created');
    const endpoint = this.state.publicUrl || `${this.tls ? 'https' : 'http'}://${this.state.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.server.address().port}`;
    return { id: offer.id, expiresAt: offer.expiresAt, url: `${endpoint}/#pair=${token}`, endpoint };
  }
  renew({ id }) {
    if (typeof id !== 'string' || !id.trim()) throw fail(400, 'A device ID is required.');
    const device = this.state.devices.find((candidate) => candidate.id === id);
    if (!device || !persistedDeviceAccess(device)) throw fail(404, 'Device not found.', CONNECT_ERROR_CODES.NOT_FOUND);
    device.expiresAt = Date.now() + SESSION_AGE;
    this.audit('access.renewed', id);
    this.onChange(this.status());
    return this.status();
  }
  revoke({ id, all = false }) {
    const revoked = all ? this.state.devices.map((device) => device.id) : [id];
    this.state.devices = all ? [] : this.state.devices.filter((d) => d.id !== id);
    this.state.offers = all ? [] : this.state.offers.filter((o) => o.id !== id);
    for (const stream of this.streams) if (all || stream.deviceId === id) stream.res.end();
    for (const download of [...this.downloads]) if (all || download.deviceId === id) download.stop();
    for (const poll of this.polls) if (all || poll.deviceId === id) { clearTimeout(poll.timer); clearTimeout(poll.flushTimer); this.errorJson(poll.res, 401, 'Device access was revoked', CONNECT_ERROR_CODES.AUTH_REQUIRED); this.polls.delete(poll); }
    for (const deviceId of revoked) {
      void this.transferStore?.invalidateDevice(deviceId);
      void Promise.resolve().then(() => this.onDeviceRevoked(deviceId)).catch(() => {});
    }
    this.audit(all ? 'access.revoked-all' : 'access.revoked', id);
    return this.status();
  }
  publish(event) {
    if (!this.eventFilter(event)) return;
    const envelope = { ...event, instanceId: this.instanceId, sequence: ++this.sequence, protocol: PROTOCOL_VERSION };
    const encoded = JSON.stringify(envelope);
    // Large outputs are recovered from the authoritative snapshot instead of filling stream buffers.
    if (encoded.length > 512_000) {
      this.events = []; this.eventBytes = 0; this.replayFloor = this.sequence;
      // Return a valid reset envelope instead of an empty HTTP response. Large
      // model outputs must not look like a broken backend connection.
      for (const stream of this.streams) {
        const device = this.device(stream.deviceId);
        if (device && stream.replaying) {
          stream.replayAborted = true;
          stream.pending.length = 0;
          stream.pendingBytes = 0;
          stream.replayReset = this.resetEvent('large-event', device);
        } else if (device) this.writeEvent(stream.res, JSON.stringify(this.resetEvent('large-event', device)));
        else stream.res.end();
      }
      for (const poll of this.polls) {
        clearTimeout(poll.timer); clearTimeout(poll.flushTimer);
        const device = this.device(poll.deviceId);
        if (device) this.json(poll.res, 200, { events: [this.resetEvent('large-event', device)] });
        else this.errorJson(poll.res, 401, 'Device access expired', CONNECT_ERROR_CODES.AUTH_REQUIRED);
      }
      this.polls.clear(); return;
    }
    this.events.push({ envelope, encoded });
    this.eventBytes += encoded.length;
    while (this.events.length > 2000 || this.eventBytes > 4 * 1024 * 1024) this.eventBytes -= this.events.shift().encoded.length;
    for (const stream of this.streams) {
      const device = this.device(stream.deviceId);
      if (!device) stream.res.end();
      else if (stream.replaying) {
        const eventForDevice = this.eventForDevice(envelope, device);
        if (eventForDevice) {
          const bytes = Buffer.byteLength(JSON.stringify(eventForDevice), 'utf8');
          if (stream.pending.length >= MAX_REPLAY_PENDING_EVENTS || stream.pendingBytes + bytes > MAX_REPLAY_PENDING_BYTES) {
            stream.replayAborted = true;
            stream.pending.length = 0;
            stream.pendingBytes = 0;
            stream.replayReset = this.resetEvent('slow-replay', device);
          } else {
            stream.pending.push(eventForDevice);
            stream.pendingBytes += bytes;
          }
        }
      } else {
        const filtered = this.eventForDevice(envelope, device);
        if (filtered) this.writeEvent(stream.res, JSON.stringify(filtered));
      }
    }
    for (const poll of this.polls) this.schedulePollFlush(poll, this.isPriorityEvent(event));
  }
  isPriorityEvent(event) {
    return PRIORITY_EVENT_TYPES.has(event.type) || PRIORITY_EVENT_METHOD.test(String(event.type ?? '')) || PRIORITY_EVENT_METHOD.test(String(event.payload?.method ?? ''));
  }
  schedulePollFlush(poll, priority = false) {
    if (!this.polls.has(poll)) return;
    if (priority) return this.flushPoll(poll);
    if (poll.flushTimer) return;
    poll.flushTimer = setTimeout(() => this.flushPoll(poll), this.pollCoalesceMs);
  }
  flushPoll(poll) {
    if (!this.polls.delete(poll)) return;
    clearTimeout(poll.timer); clearTimeout(poll.flushTimer);
    const device = this.device(poll.deviceId);
    if (!device) return this.errorJson(poll.res, 401, 'Device access expired', CONNECT_ERROR_CODES.AUTH_REQUIRED);
    const instanceId = poll.instanceId;
    if (!this.canResume(poll.cursor, instanceId)) return this.json(poll.res, 200, { events: [this.resetEvent(instanceId === this.instanceId ? 'event-gap' : 'instance-changed', device)] });
    return this.json(poll.res, 200, { events: this.eventsForDevice(device, poll.cursor) });
  }
  device(deviceId) {
    const device = this.state.devices.find((candidate) => candidate.id === deviceId);
    return device && persistedDeviceAccess(device) && device.expiresAt > Date.now() ? device : null;
  }
  eventForDevice(event, device) {
    const access = persistedDeviceAccess(device);
    return access ? filterEventOrCursor(event, access, this.resolveEventProject) : null;
  }
  resetEvent(reason = 'event-gap', device = null) {
    const access = device ? persistedDeviceAccess(device) : { role: 'operator', projectIds: null };
    const attention = access ? filterAttention(this.attention(), access, this.resolveEventProject) : [];
    return { type: 'ConnectReset', payload: { attention, reason }, instanceId: this.instanceId, sequence: this.sequence, protocol: PROTOCOL_VERSION };
  }
  eventsForDevice(device, cursor, { batch = true, throughSequence = Number.POSITIVE_INFINITY } = {}) {
    const events = this.events.filter((entry) => entry.envelope.sequence > cursor && entry.envelope.sequence <= throughSequence)
      .map((entry) => this.eventForDevice(entry.envelope, device)).filter(Boolean);
    return batch ? this.eventBatch(events) : events;
  }
  operationAllowed(device, operation) {
    const access = persistedDeviceAccess(device);
    return access && operationAllowed(access, operation, (candidate) => this.allowedOperations.has(candidate));
  }
  projectAllowed(device, operation, payload) {
    const access = persistedDeviceAccess(device);
    if (!access || !isObserver(access) || !operationNeedsProject(operation)) return true;
    return canAccessProject(access, payload?.projectId);
  }
  canResume(cursor, instanceId) {
    return instanceId === this.instanceId && Number.isInteger(cursor) && cursor >= this.replayFloor && cursor <= this.sequence
      && cursor >= (this.events[0]?.envelope.sequence ?? this.sequence + 1) - 1;
  }
  async writeEvent(res, encoded, { waitForDrain = false, beforeWrite = null, timeoutMs = REPLAY_DRAIN_TIMEOUT_MS } = {}) {
    if (res.writableEnded || res.destroyed) return false;
    if (beforeWrite && !(await beforeWrite())) { res.end(); return false; }
    if (res.write(`data: ${encoded}\n\n`)) return true;
    if (!waitForDrain) { res.end(); return false; }
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        res.off('drain', finish); res.off('close', finish); res.off('error', finish);
        resolve(!res.writableEnded && !res.destroyed);
      };
      timer = setTimeout(() => { res.end(); finish(); }, timeoutMs);
      res.once('drain', finish); res.once('close', finish); res.once('error', finish);
    });
  }
  async writeEvents(res, events, options = {}) {
    for (const event of events) {
      if (options.shouldContinue && !options.shouldContinue()) return false;
      if (!await this.writeEvent(res, JSON.stringify(event), { waitForDrain: true, ...options })) return false;
    }
    return true;
  }
  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  errorJson(res, status, message, code = statusCode(status)) {
    return this.json(res, status, { error: message, code, status });
  }
  rate(req, kind, maximum) {
    const now = Date.now();
    for (const [key, bucket] of this.rates) if (bucket.until < now) this.rates.delete(key);
    // A proxy may give every client the same socket address. Do not trust
    // forwarded headers for an access-control or rate-limit identity.
    const key = `${req.socket?.remoteAddress ?? 'unknown'}:${kind}`;
    const bucket = this.rates.get(key) ?? { count: 0, until: now + 60_000 };
    if (++bucket.count > maximum || this.rates.size > 5000) throw fail(429, 'Too many requests. Try again in a minute.', CONNECT_ERROR_CODES.RATE_LIMITED);
    this.rates.set(key, bucket);
  }
  rateDevice(device, kind, maximum = this.deviceRateLimits[kind]) {
    const now = Date.now();
    for (const [key, bucket] of this.deviceRates) if (bucket.until < now) this.deviceRates.delete(key);
    const key = `${device.id}:${kind}`;
    const bucket = this.deviceRates.get(key) ?? { count: 0, until: now + 60_000 };
    if (++bucket.count > maximum || this.deviceRates.size > 10_000) throw fail(429, 'This device is sending too many requests. Try again in a minute.', CONNECT_ERROR_CODES.RATE_LIMITED);
    this.deviceRates.set(key, bucket);
  }
  authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const device = token && this.state.devices.find((d) => d.tokenHash === digest(token) && d.expiresAt > Date.now());
    if (!device || !persistedDeviceAccess(device)) throw fail(401, 'Pair this device again. Its access has expired or was revoked.', CONNECT_ERROR_CODES.AUTH_REQUIRED);
    if (Date.now() - (device.lastSeen ?? 0) > 60_000) { device.lastSeen = Date.now(); this.save(); }
    return device;
  }
  authenticateMutationResult(req) {
    try { return this.authenticate(req); }
    catch { throw fail(503, 'The action ran, but its result is no longer available to this device.', CONNECT_ERROR_CODES.OUTCOME_UNAVAILABLE); }
  }
  async body(req) {
    if (this.bodyReaders >= MAX_BODY_READERS) { req.resume?.(); throw fail(429, 'Too many request bodies are being processed.', CONNECT_ERROR_CODES.RATE_LIMITED); }
    this.bodyReaders += 1;
    try {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY) {
        req.resume?.();
        throw fail(413, `Request body exceeds the ${MAX_BODY / 1024 / 1024} MiB maximum total size.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { req.resume?.(); throw fail(413, `Request body exceeds the ${MAX_BODY / 1024 / 1024} MiB maximum total size.`, CONNECT_ERROR_CODES.REQUEST_TOO_LARGE); } chunks.push(chunk); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
    } finally { this.bodyReaders -= 1; }
  }
  async pushBody(req) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_PUSH_BODY) throw fail(413, 'The push registration payload is too large.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
    const value = await this.body(req);
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { throw fail(400, 'The push registration payload is invalid.', CONNECT_ERROR_CODES.INVALID_REQUEST); }
    if (bytes > MAX_PUSH_BODY) throw fail(413, 'The push registration payload is too large.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
    return value;
  }
  pushOrigin(req) {
    const origin = normalizeExternalOrigin(req.headers.origin);
    if (!origin || !this.pushService) throw fail(403, 'Push requests require an allowed external HTTPS origin.', CONNECT_ERROR_CODES.FORBIDDEN);
    return origin;
  }
  transferProject(url) {
    const projectId = url.searchParams.get('projectId');
    if (!projectId || projectId.length > 256 || !this.projectExists(projectId)) throw fail(404, 'Project not found.', CONNECT_ERROR_CODES.NOT_FOUND);
    return projectId;
  }
  ensureUploadAccess(device, projectId) {
    const access = persistedDeviceAccess(device);
    if (!access || isObserver(access) || !canAccessProject(access, projectId) || !this.transferStore || !this.operationAllowed(device, 'files.write')) throw fail(403, 'This device cannot upload files for the selected project.', CONNECT_ERROR_CODES.FORBIDDEN);
  }
  ensureDownloadAccess(device, projectId) {
    const access = persistedDeviceAccess(device);
    if (!access || !canAccessProject(access, projectId)) throw fail(403, 'This device cannot read files for the selected project.', CONNECT_ERROR_CODES.FORBIDDEN);
    if (!this.operationAllowed(device, 'files.read')) throw fail(404, 'File downloads are not available for this device.', CONNECT_ERROR_CODES.NOT_FOUND);
  }
  localOrigin() {
    return `${this.tls ? 'https' : 'http'}://${this.state.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.server?.address()?.port}`;
  }
  allowedOrigins() {
    const localOrigin = this.localOrigin();
    return new Set([localOrigin, localOrigin.replace('127.0.0.1', 'localhost'), this.state.publicUrl, ...this.state.origins, 'null']);
  }
  assertAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins().has(origin)) throw fail(403, 'This client origin is not allowed by the host', CONNECT_ERROR_CODES.FORBIDDEN);
    return origin;
  }
  async transferAuthorized(req, device, projectId, kind = 'download') {
    const current = this.authenticate(req);
    if (current.id !== device.id) throw fail(401, 'Device access was revoked.', CONNECT_ERROR_CODES.AUTH_REQUIRED);
    this.assertAllowedOrigin(req);
    if (!this.projectExists(projectId)) throw fail(404, 'Project not found.', CONNECT_ERROR_CODES.NOT_FOUND);
    const access = persistedDeviceAccess(current);
    const operation = kind === 'upload' ? 'files.write' : 'files.read';
    if (!access || (kind === 'upload' && isObserver(access)) || !canAccessProject(access, projectId) || !this.operationAllowed(current, operation)) throw fail(403, 'This device cannot access that project.', CONNECT_ERROR_CODES.FORBIDDEN);
    return true;
  }
  async route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const localOrigin = this.localOrigin();
    const authorities = new Set([new URL(localOrigin).host, `localhost:${this.server?.address()?.port}`, ...(this.state.publicUrl ? [new URL(this.state.publicUrl).host] : [])]);
    if (!authorities.has(req.headers.host)) throw fail(403, 'Unrecognized host');
    const origin = this.assertAllowedOrigin(req);
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Pixice-Chunk-Sha256', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const url = new URL(req.url, localOrigin);
    if (url.pathname === '/api/connect/info' && req.method === 'GET') {
      this.rate(req, 'info', 120);
      return this.json(res, 200, { protocol: PROTOCOL_VERSION, hostId: this.state.hostId, instanceId: this.instanceId, name: String(this.state.name ?? '').slice(0, 80), version: String(this.version ?? '').slice(0, 80) });
    }
    if (url.pathname === '/api/connect/pair' && req.method === 'POST') {
      this.rate(req, 'pair', 15);
      const body = await this.body(req);
      if (typeof body.token !== 'string' || body.token.length !== 43 || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw fail(400, 'A pairing token and device name are required');
      const offer = this.state.offers.find((o) => o.tokenHash === digest(body.token) && o.expiresAt > Date.now());
      if (!offer) throw fail(401, 'This pairing link expired or has already been used. Create a new link on the host.', CONNECT_ERROR_CODES.AUTH_REQUIRED);
      if (this.state.devices.length >= 100) throw fail(409, 'Revoke an old device before pairing another', CONNECT_ERROR_CODES.CONFLICT);
      const token = secret();
      const access = persistedDeviceAccess(offer);
      if (!access) throw fail(401, 'This pairing offer is invalid. Create a new link on the host.', CONNECT_ERROR_CODES.AUTH_REQUIRED);
      const device = { id: randomUUID(), name: body.name.trim(), tokenHash: digest(token), createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + SESSION_AGE, ...access };
      this.state.offers = this.state.offers.filter((o) => o !== offer);
      this.state.devices.push(device);
      this.audit('device.paired', device.id);
      this.onChange(this.status());
      return this.json(res, 200, { token, deviceId: device.id, expiresAt: device.expiresAt, hostId: this.state.hostId, name: this.state.name });
    }
    if (url.pathname.startsWith('/api/')) {
      let device;
      try { device = this.authenticate(req); }
      catch (error) { this.rate(req, 'preauth', this.preauthRateLimit); throw error; }
      if (url.pathname === '/api/connect/session' && req.method === 'GET') {
        this.rateDevice(device, 'read');
        return this.json(res, 200, this.session(device));
      }
      if (url.pathname === '/api/connect/push' && req.method === 'GET') {
        this.rateDevice(device, 'read');
        const origin = this.pushOrigin(req);
        return this.json(res, 200, await this.pushService.status({ deviceId: device.id, origin }));
      }
      if (url.pathname === '/api/connect/push/subscribe' && req.method === 'POST') {
        this.rateDevice(device, 'mutation');
        const origin = this.pushOrigin(req);
        const body = await this.pushBody(req);
        device = this.authenticate(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !body.subscription) throw fail(400, 'A push subscription is required.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        const result = await this.pushService.register({ deviceId: device.id, origin, subscription: body.subscription });
        try { this.authenticate(req); }
        catch (error) { await this.pushService.revokeDevice(device.id).catch(() => {}); throw error; }
        return this.json(res, 200, result);
      }
      if (url.pathname === '/api/connect/push/unsubscribe' && req.method === 'POST') {
        this.rateDevice(device, 'mutation');
        const origin = this.pushOrigin(req);
        const body = await this.pushBody(req);
        if (body && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw fail(400, 'Unsubscribe does not accept a device or project payload.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        return this.json(res, 200, await this.pushService.unsubscribe({ deviceId: device.id, origin }));
      }
      if (url.pathname === '/api/connect/uploads' && req.method === 'POST') {
        this.rateDevice(device, 'mutation');
        if (!this.transferStore) throw fail(404, 'File uploads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        const body = await this.body(req);
        device = this.authenticate(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['projectId', 'name', 'mimeType', 'size', 'sha256'].includes(key))) throw fail(400, 'The upload metadata is invalid.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        const projectId = body.projectId;
        this.ensureUploadAccess(device, projectId);
        if (!this.projectExists(projectId)) throw fail(404, 'Project not found.', CONNECT_ERROR_CODES.NOT_FOUND);
        const result = await this.transferStore.reserve({ deviceId: device.id, projectId, name: body.name, mimeType: body.mimeType, size: body.size, sha256: body.sha256, authorized: () => this.transferAuthorized(req, device, projectId, 'upload') });
        try { await this.transferAuthorized(req, device, projectId, 'upload'); }
        catch (error) { await this.transferStore.cancel({ transferId: result.id, deviceId: device.id, projectId }).catch(() => {}); throw error; }
        return this.json(res, 200, result);
      }
      const uploadStatus = /^\/api\/connect\/uploads\/([^/]+)$/.exec(url.pathname);
      if (uploadStatus && req.method === 'GET') {
        this.rateDevice(device, 'read');
        if (!this.transferStore) throw fail(404, 'File uploads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        const projectId = this.transferProject(url);
        this.ensureUploadAccess(device, projectId);
        const result = await this.transferStore.read(uploadStatus[1], { deviceId: device.id, projectId });
        await this.transferAuthorized(req, device, projectId, 'upload');
        return this.json(res, 200, result);
      }
      const uploadChunk = /^\/api\/connect\/uploads\/([^/]+)\/chunk$/.exec(url.pathname);
      if (uploadChunk && req.method === 'POST') {
        this.rateDevice(device, 'mutation');
        if (!this.transferStore) throw fail(404, 'File uploads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        const projectId = this.transferProject(url);
        this.ensureUploadAccess(device, projectId);
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) throw fail(400, 'Upload chunks must use application/octet-stream.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        const offset = Number(url.searchParams.get('offset'));
        const hash = req.headers['x-pixice-chunk-sha256'];
        const result = await this.transferStore.writeChunk({ transferId: uploadChunk[1], deviceId: device.id, projectId, offset, expectedHash: hash, stream: req, contentLength: req.headers['content-length'], authorized: () => this.transferAuthorized(req, device, projectId, 'upload') });
        await this.transferAuthorized(req, device, projectId, 'upload');
        return this.json(res, 200, result);
      }
      const uploadComplete = /^\/api\/connect\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
      if (uploadComplete && req.method === 'POST') {
        this.rateDevice(device, 'mutation');
        if (!this.transferStore) throw fail(404, 'File uploads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        const body = await this.body(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.projectId !== 'string') throw fail(400, 'The upload completion payload is invalid.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        const projectId = body.projectId;
        this.ensureUploadAccess(device, projectId);
        const result = await this.transferStore.complete({ transferId: uploadComplete[1], deviceId: device.id, projectId, authorized: () => this.transferAuthorized(req, device, projectId, 'upload') });
        await this.transferAuthorized(req, device, projectId, 'upload');
        return this.json(res, 200, result);
      }
      const uploadCancel = /^\/api\/connect\/uploads\/([^/]+)\/cancel$/.exec(url.pathname);
      if (uploadCancel && req.method === 'POST') {
        this.rateDevice(device, 'control');
        if (!this.transferStore) throw fail(404, 'File uploads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        const body = await this.body(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.projectId !== 'string') throw fail(400, 'The upload cancellation payload is invalid.', CONNECT_ERROR_CODES.INVALID_REQUEST);
        const projectId = body.projectId;
        this.ensureUploadAccess(device, projectId);
        return this.json(res, 200, await this.transferStore.cancel({ transferId: uploadCancel[1], deviceId: device.id, projectId }));
      }
      if (url.pathname === '/api/connect/download' && req.method === 'GET') {
        this.rateDevice(device, 'read');
        const projectId = this.transferProject(url);
        this.ensureDownloadAccess(device, projectId);
        if (!this.resolveFile) throw fail(404, 'File downloads are unavailable.', CONNECT_ERROR_CODES.NOT_FOUND);
        if (this.downloadCount >= this.maxConcurrentDownloads) throw fail(429, 'Too many downloads are active. Try again later.', CONNECT_ERROR_CODES.RATE_LIMITED);
        this.downloadCount += 1;
        let handle;
        let stream;
        let entry;
        let released = false;
        let lifetimeTimer;
        let authTimer;
        const release = () => {
          if (released) return;
          released = true;
          this.downloadCount = Math.max(0, this.downloadCount - 1);
          clearTimeout(lifetimeTimer);
          clearInterval(authTimer);
          if (entry) this.downloads.delete(entry);
          if (handle) void handle.close().catch(() => {});
        };
        const stop = () => {
          if (released) return;
          stream?.destroy();
          if (res && !res.writableEnded && !res.destroyed) res.destroy();
          release();
        };
        try {
          const reference = url.searchParams.get('path');
          let target;
          try { target = this.resolveFile(projectId, reference, false); }
          catch { throw fail(404, 'The requested file is not available in this project.', CONNECT_ERROR_CODES.NOT_FOUND); }
          if (!target?.resolved || !target?.metadata?.isFile?.()) throw fail(404, 'The requested file is not available in this project.', CONNECT_ERROR_CODES.NOT_FOUND);
          const expectedMtime = url.searchParams.get('expectedMtimeMs');
          if (expectedMtime !== null && (!Number.isFinite(Number(expectedMtime)) || Number(expectedMtime) !== target.metadata.mtimeMs)) throw fail(409, 'The file changed before the download started.', CONNECT_ERROR_CODES.CONFLICT);
          if (target.metadata.size > this.maxDownloadBytes) throw fail(413, 'The requested file is too large to download.', CONNECT_ERROR_CODES.REQUEST_TOO_LARGE);
          await this.transferAuthorized(req, device, projectId, 'download');
          if (this.stopping) throw fail(503, 'The host is stopping.', CONNECT_ERROR_CODES.REQUEST_ABORTED);
          const noFollow = FS_CONSTANTS.O_NOFOLLOW ?? 0;
          handle = await open(target.resolved, FS_CONSTANTS.O_RDONLY | noFollow);
          const opened = await handle.stat();
          const sameFile = opened.isFile() && opened.size === target.metadata.size
            && (!Number.isFinite(target.metadata.dev) || opened.dev === target.metadata.dev)
            && (!Number.isFinite(target.metadata.ino) || opened.ino === target.metadata.ino)
            && (!Number.isFinite(target.metadata.mtimeMs) || opened.mtimeMs === target.metadata.mtimeMs)
            && (expectedMtime === null || opened.mtimeMs === Number(expectedMtime));
          if (!sameFile || opened.size > this.maxDownloadBytes) throw fail(409, 'The file changed before the download started.', CONNECT_ERROR_CODES.CONFLICT);
          await this.transferAuthorized(req, device, projectId, 'download');
          if (this.stopping) throw fail(503, 'The host is stopping.', CONNECT_ERROR_CODES.REQUEST_ABORTED);
          entry = { deviceId: device.id, stop };
          this.downloads.add(entry);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': opened.size, 'Content-Disposition': contentDispositionFilename(target.resolved), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          if (opened.size === 0) {
            res.end();
            release();
            return;
          }
          stream = createReadStream(null, { fd: handle.fd, autoClose: false, start: 0, end: opened.size - 1 });
          let checked = 0;
          lifetimeTimer = setTimeout(stop, this.downloadTimeoutMs);
          lifetimeTimer.unref?.();
          authTimer = setInterval(() => { void this.transferAuthorized(req, device, projectId, 'download').catch(stop); }, Math.min(5_000, Math.max(250, this.downloadTimeoutMs / 4)));
          authTimer.unref?.();
          stream.on('data', (chunk) => { checked += chunk.length; if (checked >= 1024 * 1024) { checked = 0; void this.transferAuthorized(req, device, projectId, 'download').catch(stop); } });
          stream.on('end', release);
          stream.on('close', release);
          stream.on('error', () => { release(); if (!res.writableEnded && !res.destroyed) res.destroy(); });
          res.on('close', () => { if (!stream.readableEnded) stream.destroy(); release(); });
          res.on('finish', release);
          stream.pipe(res);
        } catch (error) {
          release();
          if (error?.status) throw error;
          throw fail(409, 'The file changed before the download started.', CONNECT_ERROR_CODES.CONFLICT);
        }
        return;
      }
      const commandMatch = /^\/api\/connect\/commands\/([^/]+)$/.exec(url.pathname);
      if (commandMatch && req.method === 'GET') {
        this.rateDevice(device, 'read');
        if (!/^[a-f0-9-]{36}$/.test(commandMatch[1])) throw fail(400, 'The command ID is invalid.');
        this.pruneOperations();
        const requestedInstance = url.searchParams.get('instanceId');
        const record = this.operations.get(`${device.id}:${commandMatch[1]}`);
        if (!record || (requestedInstance && record.instanceId !== requestedInstance)) {
          return this.json(res, 200, { id: commandMatch[1], status: 'unknown', outcome: 'unknown', meaning: 'The command outcome is unknown. This does not mean it was never sent.', instanceId: requestedInstance || null, requestedInstanceId: requestedInstance || null, currentInstanceId: this.instanceId, result: null });
        }
        return this.json(res, 200, {
          id: record.id,
          operation: record.operation,
          issuedAt: record.issuedAt,
          instanceId: record.instanceId,
          currentInstanceId: this.instanceId,
          requestedInstanceId: requestedInstance || null,
          status: record.status,
          outcome: record.status === 'completed' ? 'completed' : record.status === 'failed' ? 'failed' : 'still-running',
          meaning: record.status === 'completed' ? 'The command completed. Agent task state is separate.' : record.status === 'failed' ? 'The command failed, but side effects may have occurred.' : 'The command is still running.',
          error: record.status === 'failed' ? record.error : null,
          code: record.status === 'failed' ? record.errorCode : null,
          result: record.status === 'completed' ? record.result : null
        });
      }
      if (url.pathname === '/api/connect/poll' && req.method === 'GET') {
        this.rateDevice(device, 'poll');
        if (this.polls.size >= 40) throw fail(429, 'Too many live clients');
        const cursor = Number(url.searchParams.get('cursor'));
        const resume = this.canResume(cursor, url.searchParams.get('instanceId'));
        if (!resume) return this.json(res, 200, { events: [this.resetEvent(url.searchParams.get('instanceId') === this.instanceId ? 'event-gap' : 'instance-changed', device)] });
        const events = this.eventsForDevice(device, cursor);
        // A reconnect handshake must finish even when the host has no new events.
        if (events.length || url.searchParams.get('wait') === '0') return this.json(res, 200, { events });
        const poll = { deviceId: device.id, res, cursor, instanceId: url.searchParams.get('instanceId') };
        poll.timer = setTimeout(() => {
          this.polls.delete(poll); clearTimeout(poll.flushTimer);
          const current = this.device(poll.deviceId);
          if (current) this.json(res, 200, { events: [] });
          else this.errorJson(res, 401, 'Device access expired', CONNECT_ERROR_CODES.AUTH_REQUIRED);
        }, 20_000);
        this.polls.add(poll);
        res.on('close', () => { clearTimeout(poll.timer); clearTimeout(poll.flushTimer); this.polls.delete(poll); });
        return;
      }
      if (url.pathname === '/api/connect/events' && req.method === 'GET') {
        this.rateDevice(device, 'poll');
        if (this.streams.size >= 40) throw fail(429, 'Too many live clients');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        res.flushHeaders();
        const stream = { deviceId: device.id, res, replaying: true, pending: [], pendingBytes: 0, replayAborted: false, replayReset: null };
        this.streams.add(stream);
        res.on('close', () => this.streams.delete(stream));
        const cursor = Number(url.searchParams.get('cursor'));
        const resume = this.canResume(cursor, url.searchParams.get('instanceId'));
        stream.replayThrough = this.sequence;
        const beforeReplayWrite = async () => {
          const current = this.device(stream.deviceId);
          return Boolean(current && persistedDeviceAccess(current));
        };
        if (resume && !stream.replayAborted) await this.writeEvents(res, this.eventsForDevice(device, cursor, { batch: false, throughSequence: stream.replayThrough }), { beforeWrite: beforeReplayWrite, shouldContinue: () => !stream.replayAborted });
        else if (!stream.replayAborted) await this.writeEvent(res, JSON.stringify(this.resetEvent('event-gap', device)), { waitForDrain: true, beforeWrite: beforeReplayWrite });
        let resetSent = false;
        if (stream.replayAborted && !res.writableEnded && !res.destroyed) {
          const reset = stream.replayReset ?? this.resetEvent('slow-replay', this.device(stream.deviceId));
          await this.writeEvent(res, JSON.stringify(reset), { waitForDrain: true, beforeWrite: beforeReplayWrite });
          resetSent = true;
          stream.pending.length = 0;
          stream.pendingBytes = 0;
        }
        while (!stream.replayAborted && !res.writableEnded && !res.destroyed && stream.pending.length) {
          const next = stream.pending.shift();
          stream.pendingBytes = Math.max(0, stream.pendingBytes - Buffer.byteLength(JSON.stringify(next), 'utf8'));
          if (!await this.writeEvent(res, JSON.stringify(next), { waitForDrain: true, beforeWrite: beforeReplayWrite })) break;
        }
        if (stream.replayAborted && !resetSent && !res.writableEnded && !res.destroyed) {
          const reset = stream.replayReset ?? this.resetEvent('slow-replay', this.device(stream.deviceId));
          await this.writeEvent(res, JSON.stringify(reset), { waitForDrain: true, beforeWrite: beforeReplayWrite });
          stream.pending.length = 0;
          stream.pendingBytes = 0;
        }
        stream.replaying = false;
        if (!res.writableEnded && !res.destroyed) {
          await this.writeEvent(res, JSON.stringify({ type: 'ConnectReady', payload: {}, instanceId: this.instanceId, sequence: this.sequence, protocol: PROTOCOL_VERSION }), { waitForDrain: true });
        }
        return;
      }
      if (url.pathname === '/api/connect/call' && req.method === 'POST') {
        const body = await this.body(req);
        device = this.authenticate(req); // A device may have been revoked while uploading the body.
        if (!body || typeof body.operation !== 'string' || !this.operationAllowed(device, body.operation)) {
          const access = persistedDeviceAccess(device);
          throw fail(isObserver(access) ? 403 : 404, isObserver(access) ? 'This observer is not allowed to use that capability.' : 'This action is available only on the host.', isObserver(access) ? CONNECT_ERROR_CODES.FORBIDDEN : CONNECT_ERROR_CODES.NOT_FOUND);
        }
        if (!this.projectAllowed(device, body.operation, body.payload)) throw fail(403, 'This observer is not allowed to access that project.', CONNECT_ERROR_CODES.FORBIDDEN);
        const budget = this.readOperations.has(body.operation)
          ? 'read'
          : ['approvals.resolve', 'requests.respond', 'questions.respond', 'elicitations.respond', 'turns.interrupt'].includes(body.operation) ? 'control' : 'mutation';
        this.rateDevice(device, budget);
        if (body.instanceId !== this.instanceId) throw fail(409, 'The host restarted. Reconnect before sending this action.', CONNECT_ERROR_CODES.HOST_RESTARTED);
        if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id) || !Number.isFinite(body.issuedAt) || Math.abs(Date.now() - body.issuedAt) > 10 * 60_000) throw fail(400, 'This request is invalid or expired. Check the device clock.');
        validatePayloadLimits(body.operation, body.payload);
        if (this.readOperations.has(body.operation)) {
          const auditKey = `${device.id}:${body.operation}`;
          if (Date.now() - (this.readAudit.get(auditKey) ?? 0) > 60_000) { this.audit(body.operation, device.id); this.readAudit.set(auditKey, Date.now()); }
          try {
            const result = await this.invoke(body.operation, body.payload, { deviceId: device.id, device, access: persistedDeviceAccess(device) });
            this.authenticate(req); // Do not release a captured page after access is revoked.
            return this.json(res, 200, { result: filterObserverResult(body.operation, result, persistedDeviceAccess(device)) });
          } catch (error) {
            const access = persistedDeviceAccess(device);
            const message = isObserver(access) ? 'The selected Connect data could not be read.' : error.message?.slice(0, 1000) || 'Could not read host state';
            throw fail(error.status ?? 400, message, error.code ?? CONNECT_ERROR_CODES.ACTION_FAILED);
          }
        }
        const key = `${device.id}:${body.id}`;
        const commandInput = JSON.stringify([body.operation, body.payload]);
        const hash = digest(commandInput);
        this.pruneOperations();
        const previous = this.operations.get(key);
        if (previous && previous.hash !== hash) throw fail(409, 'Request identity was reused with different content', CONNECT_ERROR_CODES.COMMAND_ID_REUSED);
        if (previous) { const result = await previous.promise; this.authenticateMutationResult(req); return this.json(res, result.status, result.data); }
        const requestBytes = Buffer.byteLength(commandInput, 'utf8');
        if (this.pendingOperations >= MAX_PENDING_OPERATIONS || this.pendingRequestBytes + requestBytes > MAX_PENDING_REQUEST_BYTES || this.operations.size >= 10000 || this.operationBytes > 32 * 1024 * 1024) throw fail(429, 'The host is busy. Try again later.', CONNECT_ERROR_CODES.RATE_LIMITED);
        const metadata = boundedMetadata(body.payload);
        const record = { id: body.id, operation: body.operation, issuedAt: body.issuedAt, instanceId: body.instanceId, ...metadata, hash, requestBytes, until: Math.max(Date.now(), body.issuedAt) + 11 * 60_000, completed: false, status: 'pending', result: null, error: null, errorCode: null };
        this.pendingOperations += 1;
        this.pendingRequestBytes += requestBytes;
        record.promise = Promise.resolve().then(() => this.invoke(body.operation, body.payload, { deviceId: device.id, device, access: persistedDeviceAccess(device) })).then(
          (result) => { record.status = 'completed'; record.result = this.boundedCommandResult(result, record); return { status: 200, data: { result } }; },
          (error) => { record.status = 'failed'; record.error = error.message?.slice(0, Math.min(1000, this.commandResultBytes)) || 'The action could not be completed'; record.errorCode = error.code ?? CONNECT_ERROR_CODES.ACTION_FAILED; return { status: 400, data: { error: record.error, code: record.errorCode, status: 400 } }; }
        ).then((result) => {
          record.completed = true;
          this.pendingOperations = Math.max(0, this.pendingOperations - 1);
          this.pendingRequestBytes = Math.max(0, this.pendingRequestBytes - record.requestBytes);
          try { record.bytes = Buffer.byteLength(JSON.stringify({ status: result.status, result: record.result, error: record.error, code: record.errorCode }), 'utf8'); }
          catch { record.bytes = 0; }
          this.operationBytes += record.bytes;
          try { this.audit(body.operation, device.id, result.status === 200 ? 'ok' : 'failed'); } catch { /* An audit write must not make an executed command look pending. */ }
          return result;
        });
        this.operations.set(key, record);
        const result = await record.promise;
        // A completed record only needs the bounded status result. Do not keep
        // a full provider response alive through the promise retained for
        // duplicate command lookups.
        if (record.completed) record.promise = Promise.resolve(record.status === 'completed'
          ? { status: 200, data: { result: record.result } }
          : { status: 400, data: { error: record.error, code: record.errorCode, status: 400 } });
        this.authenticateMutationResult(req); // Do not return a mutation result after access is revoked.
        return this.json(res, result.status, result.data);
      }
      throw fail(404, 'Unknown endpoint');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-src 'self' blob: data: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (relative.includes('\0')) throw fail(400, 'Invalid path');
    const root = await realpath(this.clientDirectory);
    let target;
    try { target = await realpath(path.join(root, relative)); } catch { throw fail(404, 'Client file not found. Build the Pixice web client first.'); }
    if (!target.startsWith(`${root}${path.sep}`) || !(await stat(target)).isFile()) throw fail(404, 'Not found');
    const extension = path.extname(target);
    res.setHeader('Content-Type', MIME[extension] ?? 'application/octet-stream');
    const isServiceWorker = relative === '/connect-sw.js';
    res.setHeader('Cache-Control', extension === '.html' || isServiceWorker ? 'no-store' : 'public, max-age=3600');
    if (isServiceWorker) res.setHeader('Service-Worker-Allowed', '/');
    return res.end(req.method === 'HEAD' ? undefined : await readFile(target));
  }
}
