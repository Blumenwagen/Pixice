import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { PROTOCOL_VERSION, OPERATIONS, REMOTE_EVENTS, READ_OPERATIONS, normalizeEndpoint } from './protocol.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_BODY = 48 * 1024 * 1024;
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export class ConnectServer {
  constructor({ directory, clientDirectory, invoke, attention = () => [], version = 'development', tls, tlsFiles, onChange = () => {}, initialState, persist = true, apiRateLimit = 1200, operations = OPERATIONS, readOperations = READ_OPERATIONS, eventFilter = (event) => REMOTE_EVENTS.has(event.type) && !(event.type === 'FilePreviewOpenRequested' && event.payload?.file?.external) }) {
    this.directory = directory;
    this.apiRateLimit = apiRateLimit; this.replayFloor = 0;
    this.persist = persist; this.allowedOperations = operations; this.readOperations = readOperations; this.eventFilter = eventFilter;
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
    this.readAudit = new Map();
    this.rates = new Map();
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
    return { hostId: this.state.hostId, name: this.state.name, enabled: this.state.enabled, running: Boolean(this.server?.listening), port: this.server?.address()?.port ?? this.state.port, host: this.state.host, publicUrl: this.state.publicUrl, origins: this.state.origins, error: this.error ?? null, devices: this.state.devices.map(({ tokenHash, ...device }) => device), offers: this.state.offers.map(({ tokenHash, ...offer }) => offer), audit: this.state.audit.slice(-30).reverse(), protocol: PROTOCOL_VERSION };
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
    const handler = (req, res) => { void this.route(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      this.json(res, error.status ?? 500, { error: error.status ? error.message : 'The host could not complete this request.' });
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
          if (!this.state.devices.some((d) => d.id === stream.deviceId && d.expiresAt > Date.now())) stream.res.end();
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
    clearInterval(this.heartbeat);
    for (const stream of this.streams) stream.res.end();
    this.streams.clear();
    for (const poll of this.polls) { clearTimeout(poll.timer); poll.res.end(); }
    this.polls.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }
  pairOffer() {
    if (!this.server?.listening) throw new Error('Enable remote access first');
    const token = secret();
    const offer = { id: randomUUID(), tokenHash: digest(token), expiresAt: Date.now() + 5 * 60_000 };
    this.state.offers = this.state.offers.filter((o) => o.expiresAt > Date.now()).slice(-9);
    this.state.offers.push(offer);
    this.audit('pairing.created');
    const endpoint = this.state.publicUrl || `${this.tls ? 'https' : 'http'}://${this.state.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.server.address().port}`;
    return { id: offer.id, expiresAt: offer.expiresAt, url: `${endpoint}/#pair=${token}`, endpoint };
  }
  revoke({ id, all = false }) {
    this.state.devices = all ? [] : this.state.devices.filter((d) => d.id !== id);
    this.state.offers = all ? [] : this.state.offers.filter((o) => o.id !== id);
    for (const stream of this.streams) if (all || stream.deviceId === id) stream.res.end();
    for (const poll of this.polls) if (all || poll.deviceId === id) { clearTimeout(poll.timer); this.json(poll.res, 401, { error: 'Device access was revoked' }); this.polls.delete(poll); }
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
      const reset = this.resetEvent('large-event');
      for (const stream of this.streams) {
        if (this.state.devices.some((d) => d.id === stream.deviceId && d.expiresAt > Date.now())) this.writeEvent(stream.res, JSON.stringify(reset));
        else stream.res.end();
      }
      for (const poll of this.polls) {
        clearTimeout(poll.timer);
        const valid = this.state.devices.some((d) => d.id === poll.deviceId && d.expiresAt > Date.now());
        this.json(poll.res, valid ? 200 : 401, valid ? { events: [reset] } : { error: 'Device access expired' });
      }
      this.polls.clear(); return;
    }
    this.events.push({ envelope, encoded });
    this.eventBytes += encoded.length;
    while (this.events.length > 2000 || this.eventBytes > 4 * 1024 * 1024) this.eventBytes -= this.events.shift().encoded.length;
    for (const stream of this.streams) {
      if (!this.state.devices.some((device) => device.id === stream.deviceId && device.expiresAt > Date.now())) stream.res.end();
      else this.writeEvent(stream.res, encoded);
    }
    for (const poll of this.polls) {
      clearTimeout(poll.timer);
      if (!this.state.devices.some((device) => device.id === poll.deviceId && device.expiresAt > Date.now())) { this.json(poll.res, 401, { error: 'Device access expired' }); this.polls.delete(poll); continue; }
      this.json(poll.res, 200, { events: this.events.filter((entry) => entry.envelope.sequence > poll.cursor).map((entry) => entry.envelope) });
      this.polls.delete(poll);
    }
  }
  resetEvent(reason = 'event-gap') { return { type: 'ConnectReset', payload: { attention: this.attention(), reason }, instanceId: this.instanceId, sequence: this.sequence, protocol: PROTOCOL_VERSION }; }
  canResume(cursor, instanceId) {
    return instanceId === this.instanceId && Number.isInteger(cursor) && cursor >= this.replayFloor && cursor <= this.sequence
      && cursor >= (this.events[0]?.envelope.sequence ?? this.sequence + 1) - 1;
  }
  writeEvent(res, encoded) { if (!res.write(`data: ${encoded}\n\n`)) res.end(); }
  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  rate(req, kind, maximum) {
    const now = Date.now();
    for (const [key, bucket] of this.rates) if (bucket.until < now) this.rates.delete(key);
    const key = `${req.socket.remoteAddress}:${kind}`;
    const bucket = this.rates.get(key) ?? { count: 0, until: now + 60_000 };
    if (++bucket.count > maximum || this.rates.size > 5000) throw fail(429, 'Too many requests. Try again in a minute.');
    this.rates.set(key, bucket);
  }
  authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const device = token && this.state.devices.find((d) => d.tokenHash === digest(token) && d.expiresAt > Date.now());
    if (!device) throw fail(401, 'Pair this device again. Its access has expired or was revoked.');
    if (Date.now() - (device.lastSeen ?? 0) > 60_000) { device.lastSeen = Date.now(); this.save(); }
    return device;
  }
  async body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw fail(413, 'Request is too large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
  }
  async route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const localOrigin = `${this.tls ? 'https' : 'http'}://${this.state.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.server?.address()?.port}`;
    const authorities = new Set([new URL(localOrigin).host, `localhost:${this.server?.address()?.port}`, ...(this.state.publicUrl ? [new URL(this.state.publicUrl).host] : [])]);
    if (!authorities.has(req.headers.host)) throw fail(403, 'Unrecognized host');
    const origins = new Set([localOrigin, localOrigin.replace('127.0.0.1', 'localhost'), this.state.publicUrl, ...this.state.origins, 'null']);
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) throw fail(403, 'This client origin is not allowed by the host');
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const url = new URL(req.url, localOrigin);
    if (url.pathname === '/api/connect/info' && req.method === 'GET') {
      this.rate(req, 'info', 120);
      return this.json(res, 200, { protocol: PROTOCOL_VERSION, hostId: this.state.hostId, instanceId: this.instanceId, name: this.state.name, version: this.version });
    }
    if (url.pathname === '/api/connect/pair' && req.method === 'POST') {
      this.rate(req, 'pair', 15);
      const body = await this.body(req);
      if (typeof body.token !== 'string' || body.token.length !== 43 || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw fail(400, 'A pairing token and device name are required');
      const offer = this.state.offers.find((o) => o.tokenHash === digest(body.token) && o.expiresAt > Date.now());
      if (!offer) throw fail(401, 'This pairing link expired or has already been used. Create a new link on the host.');
      if (this.state.devices.length >= 100) throw fail(409, 'Revoke an old device before pairing another');
      const token = secret();
      const device = { id: randomUUID(), name: body.name.trim(), tokenHash: digest(token), createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + SESSION_AGE };
      this.state.offers = this.state.offers.filter((o) => o !== offer);
      this.state.devices.push(device);
      this.audit('device.paired', device.id);
      this.onChange(this.status());
      return this.json(res, 200, { token, deviceId: device.id, expiresAt: device.expiresAt, hostId: this.state.hostId, name: this.state.name });
    }
    if (url.pathname.startsWith('/api/')) {
      this.rate(req, 'api', this.apiRateLimit);
      const device = this.authenticate(req);
      if (url.pathname === '/api/connect/poll' && req.method === 'GET') {
        if (this.polls.size >= 40) throw fail(429, 'Too many live clients');
        const cursor = Number(url.searchParams.get('cursor'));
        const resume = this.canResume(cursor, url.searchParams.get('instanceId'));
        if (!resume) return this.json(res, 200, { events: [this.resetEvent(url.searchParams.get('instanceId') === this.instanceId ? 'event-gap' : 'instance-changed')] });
        const events = this.events.filter((entry) => entry.envelope.sequence > cursor).map((entry) => entry.envelope);
        // A reconnect handshake must finish even when the host has no new events.
        if (events.length || url.searchParams.get('wait') === '0') return this.json(res, 200, { events });
        const poll = { deviceId: device.id, res, cursor };
        poll.timer = setTimeout(() => { this.polls.delete(poll); this.json(res, 200, { events: [] }); }, 20_000);
        this.polls.add(poll);
        res.on('close', () => { clearTimeout(poll.timer); this.polls.delete(poll); });
        return;
      }
      if (url.pathname === '/api/connect/events' && req.method === 'GET') {
        if (this.streams.size >= 40) throw fail(429, 'Too many live clients');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        res.flushHeaders();
        const stream = { deviceId: device.id, res };
        this.streams.add(stream);
        res.on('close', () => this.streams.delete(stream));
        const cursor = Number(url.searchParams.get('cursor'));
        const resume = this.canResume(cursor, url.searchParams.get('instanceId'));
        if (resume) for (const entry of this.events) { if (entry.envelope.sequence > cursor) this.writeEvent(res, entry.encoded); }
        else this.writeEvent(res, JSON.stringify({ type: 'ConnectReset', payload: { attention: this.attention() }, instanceId: this.instanceId, sequence: this.sequence, protocol: PROTOCOL_VERSION }));
        this.writeEvent(res, JSON.stringify({ type: 'ConnectReady', payload: {}, instanceId: this.instanceId, sequence: this.sequence, protocol: PROTOCOL_VERSION }));
        return;
      }
      if (url.pathname === '/api/connect/call' && req.method === 'POST') {
        const body = await this.body(req);
        this.authenticate(req); // A device may have been revoked while uploading the body.
        if (!body || typeof body.operation !== 'string' || (!this.allowedOperations.has(body.operation) && body.operation !== 'projects.directories')) throw fail(404, 'This action is available only on the host');
        if (body.instanceId !== this.instanceId) throw fail(409, 'The host restarted. Reconnect before sending this action.');
        if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id) || !Number.isFinite(body.issuedAt) || Math.abs(Date.now() - body.issuedAt) > 10 * 60_000) throw fail(400, 'This request is invalid or expired. Check the device clock.');
        if (this.readOperations.has(body.operation)) {
          const auditKey = `${device.id}:${body.operation}`;
          if (Date.now() - (this.readAudit.get(auditKey) ?? 0) > 60_000) { this.audit(body.operation, device.id); this.readAudit.set(auditKey, Date.now()); }
          try {
            const result = await this.invoke(body.operation, body.payload, { deviceId: device.id });
            this.authenticate(req); // Do not release a captured page after access is revoked.
            return this.json(res, 200, { result });
          } catch (error) { throw fail(error.status ?? 400, error.message?.slice(0, 1000) || 'Could not read host state'); }
        }
        const key = `${device.id}:${body.id}`;
        const hash = digest(JSON.stringify([body.operation, body.payload]));
        const previous = this.operations.get(key);
        if (previous && previous.hash !== hash) throw fail(409, 'Request identity was reused with different content');
        if (previous) { const result = await previous.promise; return this.json(res, result.status, result.data); }
        for (const [id, op] of this.operations) if (op.completed && op.until < Date.now()) { this.operations.delete(id); this.operationBytes -= op.bytes ?? 0; }
        if (this.operations.size >= 10000 || this.operationBytes > 32 * 1024 * 1024) throw fail(429, 'The host is busy. Try again later.');
        const record = { hash, until: Math.max(Date.now(), body.issuedAt) + 11 * 60_000, completed: false };
        record.promise = Promise.resolve().then(() => this.invoke(body.operation, body.payload, { deviceId: device.id })).then(
          (result) => ({ status: 200, data: { result: result ?? null } }),
          (error) => ({ status: 400, data: { error: error.message?.slice(0, 1000) || 'The action could not be completed' } })
        ).then((result) => { record.completed = true; record.bytes = JSON.stringify(result).length; this.operationBytes += record.bytes; this.audit(body.operation, device.id, result.status === 200 ? 'ok' : 'failed'); return result; });
        this.operations.set(key, record);
        const result = await record.promise;
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
    res.setHeader('Content-Type', MIME[path.extname(target)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', path.extname(target) === '.html' ? 'no-store' : 'public, max-age=3600');
    return res.end(req.method === 'HEAD' ? undefined : await readFile(target));
  }
}
