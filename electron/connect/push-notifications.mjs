import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import webPush from 'web-push';
import { createConnectDeepLink } from './connect-links.mjs';
import {
  normalizeExternalOrigin,
  normalizePushSubscription,
  validOpaqueIdentifier,
  validVapidKeyPair,
  validatePushSubscription as validateSharedPushSubscription,
} from './push-contract.mjs';

export const MAX_PUSH_SUBSCRIPTIONS = 100;
export const PUSH_TTL_SECONDS = 60;
export const PUSH_TIMEOUT_MS = 5_000;
export const PUSH_EVENT_TYPES = Object.freeze(new Set(['attention', 'task-completed']));
const STATE_FILE = 'push-subscriptions.json';
const VAPID_FILE = 'vapid.json';

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function validateVapidSubject({ publicUrl, contact } = {}) {
  if (typeof publicUrl === 'string') {
    try {
      const url = new URL(publicUrl);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !net.isIP(url.hostname) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return url.origin;
    } catch { /* Try the explicit contact below. */ }
  }
  if (typeof contact === 'string') {
    const value = contact.trim().replace(/^mailto:/i, '');
    const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(value);
    if (match && !['localhost', '127.0.0.1'].includes(match[2].toLowerCase()) && !net.isIP(match[2])) return `mailto:${value}`;
  }
  return null;
}

export function validatePushSubscription(input, options = {}) {
  try { return validateSharedPushSubscription(input, options); }
  catch (cause) { throw error(cause.message); }
}

function readJsonFile(file) {
  return readFile(file, 'utf8').then((source) => JSON.parse(source)).catch((cause) => {
    if (cause?.code === 'ENOENT' || cause instanceof SyntaxError) return null;
    throw cause;
  });
}

function trustedEvent(event, serviceHostId) {
  const type = event?.type;
  if (!PUSH_EVENT_TYPES.has(type)) throw error('This event type cannot trigger a push notification.');
  const target = event.target || event;
  const hostId = target.hostId || serviceHostId;
  const projectId = target.projectId;
  const threadId = target.threadId;
  const eventId = target.eventId;
  if (![hostId, projectId, threadId].every(validOpaqueIdentifier)) throw error('Push targets must be bounded opaque identifiers.');
  if (eventId !== undefined && !validOpaqueIdentifier(eventId)) throw error('Push events must have a bounded opaque event identifier.');
  if (target.hostId && target.hostId !== serviceHostId) throw error('The push event belongs to a different host.');
  return { type, hostId, projectId, threadId, eventId: eventId || `${type}:${hostId}:${projectId}:${threadId}` };
}

function eventKey(entry, target) {
  return [entry.deviceId, entry.origin, entry.subscription.endpoint, target.type, target.hostId, target.projectId, target.threadId, target.eventId].join('|');
}

function abortError() {
  return Object.assign(new Error('Push delivery timed out.'), { name: 'AbortError', status: 504 });
}

async function sendWithTimeout(start, controller, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    controller.signal.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); finish(reject, abortError()); }, timeoutMs);
    Promise.resolve().then(start).then((value) => finish(resolve, value), (cause) => finish(reject, cause));
  });
}

export class PushNotificationService {
  constructor({
    directory,
    publicUrl,
    contact,
    hostId = 'local',
    allowedOrigins = [],
    currentConfig,
    getCurrentConfig,
    authorizeDelivery,
    authorize,
    sender,
    webPushImpl = webPush,
    now = () => Date.now(),
    maxSubscriptions = MAX_PUSH_SUBSCRIPTIONS,
    pushTimeoutMs = PUSH_TIMEOUT_MS,
    maxQueue = maxSubscriptions,
  } = {}) {
    if (!directory) throw new Error('A user-only push directory is required.');
    this.directory = directory;
    this.publicUrl = publicUrl;
    this.contact = contact;
    this.hostId = hostId;
    this.allowedOrigins = allowedOrigins;
    this.getCurrentConfig = typeof getCurrentConfig === 'function' ? getCurrentConfig : (typeof currentConfig === 'function' ? currentConfig : null);
    if (currentConfig && typeof currentConfig === 'object') {
      if (currentConfig.publicUrl !== undefined) this.publicUrl = currentConfig.publicUrl;
      if (currentConfig.contact !== undefined) this.contact = currentConfig.contact;
      if (Array.isArray(currentConfig.allowedOrigins)) this.allowedOrigins = currentConfig.allowedOrigins;
    }
    this.authorizeDelivery = typeof (authorizeDelivery || authorize) === 'function' ? (authorizeDelivery || authorize) : null;
    this.sender = sender;
    this.webPush = webPushImpl;
    this.now = now;
    this.maxSubscriptions = Math.max(1, Math.min(Number(maxSubscriptions) || MAX_PUSH_SUBSCRIPTIONS, MAX_PUSH_SUBSCRIPTIONS));
    this.maxQueue = Math.max(1, Math.min(Number(maxQueue) || this.maxSubscriptions, this.maxSubscriptions * 4));
    this.pushTimeoutMs = Math.max(1, Number(pushTimeoutMs) || PUSH_TIMEOUT_MS);
    this.keys = null;
    this.subscriptions = [];
    this.queue = [];
    this.running = false;
    this.closed = false;
    this.dedupe = new Map();
    this.inflight = new Set();
    this.activeJobs = new Set();
    this.registrationSequence = 0;
    this.writeChain = Promise.resolve();
    this.stateChain = Promise.resolve();
    this.keyInitialization = null;
    this.ready = this.load();
  }

  async readCurrentConfig() {
    if (!this.getCurrentConfig) return;
    const config = await this.getCurrentConfig();
    if (!config || typeof config !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(config, 'publicUrl')) this.publicUrl = config.publicUrl;
    if (Object.prototype.hasOwnProperty.call(config, 'contact')) this.contact = config.contact;
    if (Array.isArray(config.allowedOrigins)) this.allowedOrigins = config.allowedOrigins;
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.readCurrentConfig();
    const saved = await readJsonFile(path.join(this.directory, STATE_FILE));
    if (Array.isArray(saved)) {
      const valid = [];
      for (const entry of saved) {
        try {
          const origin = normalizeExternalOrigin(entry?.origin);
          const subscription = validatePushSubscription(entry?.subscription, { deviceId: entry?.deviceId, origin, allowedOrigins: this.allowedOrigins });
          valid.push({
            deviceId: entry.deviceId,
            origin,
            subscription,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : this.now(),
            lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : this.now(),
            registrationId: ++this.registrationSequence,
            generation: 1,
          });
        } catch { /* Ignore malformed or now-disallowed persisted registrations. */ }
      }
      const seen = new Set();
      this.subscriptions = valid.filter((entry) => {
        const key = `${entry.deviceId}|${entry.origin}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(-this.maxSubscriptions);
    }
    const keys = await readJsonFile(path.join(this.directory, VAPID_FILE));
    if (validVapidKeyPair(keys)) this.keys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  }

  subject() { return validateVapidSubject({ publicUrl: this.publicUrl, contact: this.contact }); }

  writeJson(fileName, value) {
    const target = path.join(this.directory, fileName);
    const operation = this.writeChain.then(async () => {
      const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  saveSubscriptions() { return this.writeJson(STATE_FILE, this.subscriptions); }

  mutateState(operation) {
    const next = this.stateChain.then(operation);
    this.stateChain = next.catch(() => {});
    return next;
  }

  async initializeKeys(subject) {
    const generated = this.webPush.generateVAPIDKeys();
    if (!validVapidKeyPair(generated)) throw new Error('The push provider returned invalid VAPID keys.');
    this.keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    await this.writeJson(VAPID_FILE, this.keys);
    return { subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey };
  }

  async ensureKeys() {
    await this.ready;
    await this.readCurrentConfig();
    const subject = this.subject();
    if (!subject) return null;
    if (this.keys && !validVapidKeyPair(this.keys)) this.keys = null;
    if (!this.keys) {
      this.keyInitialization ||= this.initializeKeys(subject).finally(() => { this.keyInitialization = null; });
      await this.keyInitialization;
    }
    return { subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey };
  }

  async revalidateSubscriptionsNow() {
    await this.ready;
    await this.readCurrentConfig();
    let changed = false;
    const valid = [];
    for (const entry of this.subscriptions) {
      try {
        const subscription = validatePushSubscription(entry.subscription, { deviceId: entry.deviceId, origin: entry.origin, allowedOrigins: this.allowedOrigins });
        if (JSON.stringify(subscription) !== JSON.stringify(entry.subscription)) {
          entry.subscription = subscription;
          entry.generation += 1;
          changed = true;
        }
        valid.push(entry);
      } catch { changed = true; }
    }
    if (valid.length !== this.subscriptions.length) changed = true;
    this.subscriptions = valid.slice(-this.maxSubscriptions);
    if (changed) await this.saveSubscriptions();
  }

  revalidateSubscriptions() { return this.mutateState(() => this.revalidateSubscriptionsNow()); }

  async status({ deviceId, origin } = {}) {
    await this.revalidateSubscriptions();
    const vapid = await this.ensureKeys();
    const receivingOrigin = normalizeExternalOrigin(origin);
    const own = validOpaqueIdentifier(deviceId) && receivingOrigin
      ? this.subscriptions.some((entry) => entry.deviceId === deviceId && entry.origin === receivingOrigin)
      : false;
    return vapid
      ? { state: own ? 'enabled' : 'ready', publicKey: vapid.publicKey, readiness: 'ready', registered: own }
      : { state: 'unavailable', publicKey: null, readiness: 'unavailable', registered: false, message: 'Configure an external HTTPS public address or a real contact address before enabling notifications.' };
  }

  async register({ deviceId, origin, subscription } = {}) {
    if (this.closed) throw error('The push service is closed.', 503);
    const vapid = await this.ensureKeys();
    if (!vapid) throw error('Push is unavailable until the host has an external HTTPS public address or real contact address.', 503);
    return this.mutateState(async () => {
      if (this.closed) throw error('The push service is closed.', 503);
      await this.readCurrentConfig();
      const receivingOrigin = normalizeExternalOrigin(origin);
      const normalized = validatePushSubscription(subscription, { deviceId, origin: receivingOrigin, allowedOrigins: this.allowedOrigins });
      const existing = this.subscriptions.findIndex((entry) => entry.deviceId === deviceId && entry.origin === receivingOrigin);
      if (existing < 0 && this.subscriptions.length >= this.maxSubscriptions) throw error('This host has reached its browser push registration limit.', 409);
      const value = existing < 0
        ? { deviceId, origin: receivingOrigin, subscription: normalized, createdAt: this.now(), lastUsedAt: this.now(), registrationId: ++this.registrationSequence, generation: 1 }
        : { ...this.subscriptions[existing], subscription: normalized, lastUsedAt: this.now(), generation: this.subscriptions[existing].generation + 1 };
      if (existing < 0) this.subscriptions.push(value); else this.subscriptions[existing] = value;
      await this.saveSubscriptions();
      return { state: 'enabled', publicKey: vapid.publicKey, registered: true };
    });
  }

  async unsubscribe({ deviceId, origin } = {}) {
    return this.mutateState(async () => {
      await this.ready;
      if (!validOpaqueIdentifier(deviceId)) throw error('A trusted device identifier is required.');
      const receivingOrigin = normalizeExternalOrigin(origin);
      if (!receivingOrigin) throw error('The receiving client origin is invalid.');
      const before = this.subscriptions.length;
      this.subscriptions = this.subscriptions.filter((entry) => !(entry.deviceId === deviceId && entry.origin === receivingOrigin));
      if (before !== this.subscriptions.length) await this.saveSubscriptions();
      return { state: 'disabled', removed: before - this.subscriptions.length, registered: false };
    });
  }

  async revokeDevice(deviceId) {
    return this.mutateState(async () => {
      await this.ready;
      if (!validOpaqueIdentifier(deviceId)) throw error('A trusted device identifier is required.');
      const before = this.subscriptions.length;
      this.subscriptions = this.subscriptions.filter((entry) => entry.deviceId !== deviceId);
      if (before !== this.subscriptions.length) await this.saveSubscriptions();
      return { removed: before - this.subscriptions.length };
    });
  }

  async allowedDelivery(entry, target) {
    if (!this.authorizeDelivery) return false;
    try {
      return (await this.authorizeDelivery({
        deviceId: entry.deviceId,
        origin: entry.origin,
        hostId: target.hostId,
        projectId: target.projectId,
        threadId: target.threadId,
        type: target.type,
        eventId: target.eventId,
      })) === true;
    } catch { return false; }
  }

  pruneDedupe(now) {
    for (const [key, expiry] of this.dedupe) if (expiry <= now) this.dedupe.delete(key);
    const max = this.maxSubscriptions * 10;
    while (this.dedupe.size > max) this.dedupe.delete(this.dedupe.keys().next().value);
  }

  currentJobEntry(job) {
    return this.subscriptions.find((entry) => entry.registrationId === job.registrationId && entry.generation === job.generation) || null;
  }

  deliveryResult(job) {
    if (job.settled || this.closed) return { state: 'closed', deviceId: job.deviceId };
    if (this.now() >= job.expiresAt) return { state: 'dropped', reason: 'expired', deviceId: job.deviceId };
    if (!this.currentJobEntry(job)) return { state: 'skipped', reason: 'not-authorized', deviceId: job.deviceId };
    return null;
  }

  resolveJob(job, result) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
  }

  async sendEvent(event) {
    if (this.closed) throw error('The push service is closed.', 503);
    await this.ready;
    await this.revalidateSubscriptions();
    const target = trustedEvent(event, this.hostId);
    const now = this.now();
    this.pruneDedupe(now);
    const jobs = [];
    for (const entry of [...this.subscriptions]) {
      if (!await this.allowedDelivery(entry, target)) continue;
      const key = eventKey(entry, target);
      if (this.dedupe.has(key)) continue;
      this.dedupe.set(key, now + PUSH_TTL_SECONDS * 1000);
      jobs.push(this.enqueue(entry, target));
    }
    return Promise.all(jobs);
  }

  async enqueue(entry, target) {
    await this.ready;
    if (this.closed) return { state: 'closed', deviceId: entry.deviceId };
    if (this.queue.length >= this.maxQueue) return { state: 'dropped', reason: 'queue-full', deviceId: entry.deviceId };
    return new Promise((resolve) => {
      const enqueueTime = this.now();
      const job = {
        deviceId: entry.deviceId,
        registrationId: entry.registrationId,
        generation: entry.generation,
        target,
        resolve,
        enqueueTime,
        expiresAt: enqueueTime + PUSH_TTL_SECONDS * 1000,
        settled: false,
      };
      this.queue.push(job);
      this.activeJobs.add(job);
      void this.pump().catch(() => {});
    });
  }

  async deliver(job) {
    let controller = null;
    try {
      if (job.settled) return;
      if (this.closed) return this.resolveJob(job, { state: 'closed', deviceId: job.deviceId });
      if (this.now() >= job.expiresAt) return this.resolveJob(job, { state: 'dropped', reason: 'expired', deviceId: job.deviceId });

      // Config and key reads can invalidate a registration. Keep all of that
      // work inside this job so a failure settles it and the pump continues.
      await this.revalidateSubscriptions();
      const afterRevalidate = this.deliveryResult(job);
      if (afterRevalidate) return this.resolveJob(job, afterRevalidate);
      let entry = this.currentJobEntry(job);
      if (!entry) return this.resolveJob(job, { state: 'skipped', reason: 'not-authorized', deviceId: job.deviceId });
      const vapid = await this.ensureKeys();
      const afterKeys = this.deliveryResult(job);
      if (afterKeys) return this.resolveJob(job, afterKeys);
      if (!vapid) return this.resolveJob(job, { state: 'skipped', reason: 'unavailable', deviceId: entry.deviceId });

      // Resolve and authorize again after preflight. Re-registration, revoke,
      // or a scope change must invalidate the queued delivery.
      entry = this.currentJobEntry(job);
      if (!entry) {
        return this.resolveJob(job, { state: 'skipped', reason: 'not-authorized', deviceId: entry?.deviceId || job.deviceId });
      }
      const allowed = await this.allowedDelivery(entry, job.target);
      const afterAuthorization = this.deliveryResult(job);
      if (afterAuthorization) return this.resolveJob(job, afterAuthorization);
      if (!allowed) return this.resolveJob(job, { state: 'skipped', reason: 'not-authorized', deviceId: entry.deviceId });
      entry = this.currentJobEntry(job);
      if (!entry) return this.resolveJob(job, { state: 'skipped', reason: 'not-authorized', deviceId: job.deviceId });

      const beforeSender = this.deliveryResult(job);
      if (beforeSender) return this.resolveJob(job, beforeSender);
      controller = new AbortController();
      this.inflight.add(controller);
      const url = createConnectDeepLink({ origin: entry.origin, hostId: job.target.hostId, projectId: job.target.projectId, threadId: job.target.threadId });
      const payload = { title: 'Pixice Connect', body: 'Activity needs your attention in Pixice Connect.', url };
      const sender = this.sender || ((subscription, body, options) => this.webPush.sendNotification(subscription, body, options));
      await sendWithTimeout(() => {
        // sendWithTimeout starts its callback in a microtask. Check again
        // there so close() cannot resolve the job and still invoke sender.
        const beforeInvocation = this.deliveryResult(job);
        if (beforeInvocation) throw Object.assign(new Error('Push delivery was invalidated before sending.'), { deliveryResult: beforeInvocation });
        return sender(entry.subscription, JSON.stringify(payload), {
          TTL: PUSH_TTL_SECONDS,
          timeout: this.pushTimeoutMs,
          signal: controller.signal,
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        });
      }, controller, this.pushTimeoutMs);
      const current = this.currentJobEntry(job);
      if (current) current.lastUsedAt = this.now();
      this.resolveJob(job, { state: this.closed ? 'closed' : 'sent', deviceId: entry.deviceId });
    } catch (cause) {
      if (cause?.deliveryResult) {
        this.resolveJob(job, cause.deliveryResult);
        return;
      }
      const statusCode = cause?.statusCode || cause?.status;
      if (statusCode === 404 || statusCode === 410) {
        try {
          await this.mutateState(async () => {
            const current = this.currentJobEntry(job);
            if (!current) return;
            this.subscriptions = this.subscriptions.filter((candidate) => candidate !== current);
            await this.saveSubscriptions();
          });
        } catch (persistenceError) {
          this.resolveJob(job, { state: this.closed ? 'closed' : 'failed', deviceId: job.deviceId, status: statusCode, error: persistenceError.message });
          return;
        }
      }
      this.resolveJob(job, { state: this.closed ? 'closed' : 'failed', deviceId: job.deviceId, status: statusCode || null, error: cause?.message });
    } finally {
      if (controller) this.inflight.delete(controller);
      this.activeJobs.delete(job);
    }
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        await this.deliver(job);
      }
    } finally { this.running = false; }
  }

  configure({ publicUrl, contact, allowedOrigins } = {}) {
    if (publicUrl !== undefined) this.publicUrl = publicUrl;
    if (contact !== undefined) this.contact = contact;
    if (Array.isArray(allowedOrigins)) this.allowedOrigins = allowedOrigins;
    return this.revalidateSubscriptions();
  }

  setCurrentConfig(callback) {
    this.getCurrentConfig = typeof callback === 'function' ? callback : null;
    return this.revalidateSubscriptions();
  }

  close() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const job of this.activeJobs) this.resolveJob(job, { state: 'closed', deviceId: job.deviceId });
    this.queue.splice(0);
    for (const controller of this.inflight) controller.abort();
    return Promise.resolve();
  }
}

export function createPushNotificationService(options) {
  return new PushNotificationService(options);
}
