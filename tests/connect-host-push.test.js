import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import { createPushNotificationService, PUSH_TTL_SECONDS, validateVapidSubject } from '../electron/connect/push-notifications.mjs';

const directories = [];
const vapid = webPush.generateVAPIDKeys();
const subscriptionKeys = webPush.generateVAPIDKeys();
const auth = Buffer.from('1234567890123456').toString('base64url');
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/opaque?token=windows', expirationTime: null, keys: { p256dh: subscriptionKeys.publicKey, auth } };
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function service(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-push-test-')); directories.push(directory);
  const webPushImpl = { generateVAPIDKeys: vi.fn(() => vapid), sendNotification: vi.fn(async () => ({})) };
  const authorizeDelivery = options.authorizeDelivery || vi.fn(async () => true);
  const value = createPushNotificationService({ directory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl, sender: options.sender, authorizeDelivery, ...options });
  await value.ready;
  return { value, webPushImpl, directory, authorizeDelivery };
}

describe('host push notifications', () => {
  it('requires a real external VAPID subject and never exposes the private key', async () => {
    expect(validateVapidSubject({ publicUrl: 'http://localhost:43187' })).toBeNull();
    expect(validateVapidSubject({ contact: 'mailto:pixice@localhost' })).toBeNull();
    expect(validateVapidSubject({ contact: 'ops@example.com' })).toBe('mailto:ops@example.com');
    const { value, directory, webPushImpl } = await service({ publicUrl: 'http://localhost:43187' });
    await expect(value.status({ deviceId: 'device-1', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'unavailable', publicKey: null, readiness: 'unavailable' });
    expect(webPushImpl.generateVAPIDKeys).not.toHaveBeenCalled();
    const saved = await readFile(path.join(directory, 'vapid.json')).catch(() => '');
    expect(saved).toBe('');
  });

  it('persists valid registrations, scopes status, filters events, deduplicates event identities, and removes expired endpoints', async () => {
    const sender = vi.fn(async () => undefined);
    const { value, webPushImpl, authorizeDelivery } = await service({ sender });
    await expect(value.status({ deviceId: 'device-1', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'ready', publicKey: vapid.publicKey, registered: false });
    const registered = await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    expect(registered).toMatchObject({ state: 'enabled', registered: true });
    await expect(value.status({ deviceId: 'device-1', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'enabled', registered: true });
    await expect(value.status({ deviceId: 'other-device', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'ready', registered: false });
    await expect(value.sendEvent({ type: 'unsupported', projectId: 'project-1', threadId: 'thread-1' })).rejects.toThrow('event type');
    await expect(value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'attention-1' })).resolves.toHaveLength(1);
    await expect(value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'attention-1' })).resolves.toEqual([]);
    await expect(value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'attention-2' })).resolves.toHaveLength(1);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(authorizeDelivery).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', origin: 'https://app.example', projectId: 'project-1', threadId: 'thread-1' }));
    expect(sender.mock.calls[0][2]).toMatchObject({ TTL: 60, timeout: 5000, vapidDetails: { subject: 'https://host.example', publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
    expect(webPushImpl.setVapidDetails).toBeUndefined();
    const removed = await value.unsubscribe({ deviceId: 'device-1', origin: 'https://app.example' });
    expect(removed).toMatchObject({ removed: 1, registered: false });
  });

  it('revalidates queued authorization and resolves queued work on close', async () => {
    let release;
    const firstSend = new Promise((resolve) => { release = resolve; });
    const sender = vi.fn(async () => firstSend);
    let checks = 0;
    const { value } = await service({ sender, authorizeDelivery: async () => ++checks <= 3 });
    await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const first = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'first' });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
    const queued = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'queued' });
    await vi.waitFor(() => expect(checks).toBe(3));
    await value.revokeDevice('device-1');
    release();
    await expect(first).resolves.toMatchObject([{ state: 'sent' }]);
    await expect(queued).resolves.toMatchObject([{ state: 'skipped', reason: 'not-authorized' }]);

    const blockedSender = vi.fn(() => new Promise(() => {}));
    const closed = await service({ sender: blockedSender });
    await closed.value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const pending = closed.value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'close' });
    await vi.waitFor(() => expect(blockedSender).toHaveBeenCalledOnce());
    await closed.value.close();
    await expect(pending).resolves.toMatchObject([{ state: 'closed' }]);
  });

  it('does not invoke the sender when close finishes an awaited preflight', async () => {
    let releaseAuthorization;
    let checks = 0;
    const authorizeDelivery = vi.fn(async () => {
      checks += 1;
      if (checks === 2) await new Promise((resolve) => { releaseAuthorization = resolve; });
      return true;
    });
    const sender = vi.fn(async () => undefined);
    const { value } = await service({ sender, authorizeDelivery });
    await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const pending = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'close-preflight' });
    await vi.waitFor(() => expect(authorizeDelivery).toHaveBeenCalledTimes(2));
    await value.close();
    releaseAuthorization();
    await expect(pending).resolves.toMatchObject([{ state: 'closed' }]);
    expect(sender).not.toHaveBeenCalled();
  });

  it('keeps unchanged queued registrations deliverable across status revalidation, but skips a rotated registration', async () => {
    let release;
    const firstSend = new Promise((resolve) => { release = resolve; });
    const sender = vi.fn(async () => sender.mock.calls.length === 1 ? firstSend : undefined);
    const { value } = await service({ sender });
    await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const first = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'first-stable' });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
    const queuedStable = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'second-stable' });
    await vi.waitFor(() => expect(value.queue).toHaveLength(1));
    await value.status({ deviceId: 'device-1', origin: 'https://app.example' });
    release();
    await expect(first).resolves.toMatchObject([{ state: 'sent' }]);
    await expect(queuedStable).resolves.toMatchObject([{ state: 'sent' }]);
    expect(sender).toHaveBeenCalledTimes(2);

    let rotateRelease;
    const rotatedSender = vi.fn(async () => rotatedSender.mock.calls.length === 1 ? new Promise((resolve) => { rotateRelease = resolve; }) : undefined);
    const rotated = await service({ sender: rotatedSender });
    await rotated.value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const rotatedFirst = rotated.value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'first-rotated' });
    await vi.waitFor(() => expect(rotatedSender).toHaveBeenCalledOnce());
    const rotatedQueued = rotated.value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'second-rotated' });
    await vi.waitFor(() => expect(rotated.value.queue).toHaveLength(1));
    await rotated.value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription: { ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/rotated?token=other' } });
    rotateRelease();
    await expect(rotatedFirst).resolves.toMatchObject([{ state: 'sent' }]);
    await expect(rotatedQueued).resolves.toMatchObject([{ state: 'skipped', reason: 'not-authorized' }]);
    expect(rotatedSender).toHaveBeenCalledOnce();
  });

  it('settles a job whose config preflight fails and continues with later queued work', async () => {
    let failConfig = false;
    let release;
    const firstSend = new Promise((resolve) => { release = resolve; });
    const sender = vi.fn(async () => sender.mock.calls.length === 1 ? firstSend : undefined);
    const { value } = await service({ sender, getCurrentConfig: vi.fn(async () => { if (failConfig) { failConfig = false; throw new Error('config read failed'); } return { publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'] }; }) });
    await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const first = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'config-first' });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
    const failed = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'config-failure' });
    const later = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'config-recovery' });
    await vi.waitFor(() => expect(value.queue).toHaveLength(2));
    failConfig = true;
    release();
    await expect(first).resolves.toMatchObject([{ state: 'sent' }]);
    await expect(failed).resolves.toMatchObject([{ state: 'failed', error: 'config read failed' }]);
    await expect(later).resolves.toMatchObject([{ state: 'sent' }]);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('waits for load before status can inspect persisted registrations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-push-status-load-')); directories.push(directory);
    await writeFile(path.join(directory, 'push-subscriptions.json'), JSON.stringify([{ deviceId: 'device-1', origin: 'https://app.example', subscription, createdAt: 1, lastUsedAt: 1 }]));
    const value = createPushNotificationService({ directory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl: { generateVAPIDKeys: () => vapid }, authorizeDelivery: async () => true });
    await expect(value.status({ deviceId: 'device-1', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'enabled', registered: true });
  });

  it('expires queued jobs by enqueue time instead of sending stale events', async () => {
    let now = 0;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const sender = vi.fn(async () => blocked);
    const { value } = await service({ sender, now: () => now });
    await value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    const first = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'first' });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
    const queued = value.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'queued' });
    await vi.waitFor(() => expect(value.queue).toHaveLength(1));
    now = PUSH_TTL_SECONDS * 1000 + 1;
    release();
    await expect(first).resolves.toMatchObject([{ state: 'sent' }]);
    await expect(queued).resolves.toMatchObject([{ state: 'dropped', reason: 'expired' }]);
    expect(sender).toHaveBeenCalledOnce();
  });

  it('serializes concurrent persistence and ignores malformed persisted data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-push-persist-')); directories.push(directory);
    await writeFile(path.join(directory, 'push-subscriptions.json'), JSON.stringify([{ deviceId: 'bad', origin: 'https://app.example', subscription: { endpoint: 'https://fcm.googleapis.com/push', keys: { p256dh: 'bad', auth: 'bad' } } }]));
    await writeFile(path.join(directory, 'vapid.json'), JSON.stringify({ publicKey: 'bad', privateKey: 'bad' }));
    const value = createPushNotificationService({ directory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl: { generateVAPIDKeys: () => vapid }, authorizeDelivery: async () => true });
    await value.ready;
    expect(value.subscriptions).toEqual([]);
    await Promise.all([
      value.register({ deviceId: 'device-1', origin: 'https://app.example', subscription }),
      value.register({ deviceId: 'device-2', origin: 'https://app.example', subscription: { ...subscription, endpoint: `${subscription.endpoint}-two` } }),
    ]);
    const saved = JSON.parse(await readFile(path.join(directory, 'push-subscriptions.json'), 'utf8'));
    expect(saved.map((entry) => entry.deviceId).sort()).toEqual(['device-1', 'device-2']);
  });

  it('uses persisted keys after restart and keeps service instances isolated', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-push-restart-')); directories.push(directory);
    const firstKeys = webPush.generateVAPIDKeys();
    const firstSender = vi.fn(async () => undefined);
    const first = createPushNotificationService({ directory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl: { generateVAPIDKeys: () => firstKeys }, sender: firstSender, authorizeDelivery: async () => true });
    await first.ready;
    await first.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    await first.close();
    const secondKeys = webPush.generateVAPIDKeys();
    const secondSender = vi.fn(async () => undefined);
    const restarted = createPushNotificationService({ directory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl: { generateVAPIDKeys: () => secondKeys }, sender: secondSender, authorizeDelivery: async () => true });
    await restarted.ready;
    await expect(restarted.status({ deviceId: 'device-1', origin: 'https://app.example' })).resolves.toMatchObject({ state: 'enabled', publicKey: firstKeys.publicKey });
    await restarted.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'restart' });
    expect(secondSender.mock.calls[0][2].vapidDetails.publicKey).toBe(firstKeys.publicKey);

    const isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), 'pixice-push-isolated-')); directories.push(isolatedDirectory);
    const isolatedKeys = webPush.generateVAPIDKeys();
    const isolatedSender = vi.fn(async () => undefined);
    const isolated = createPushNotificationService({ directory: isolatedDirectory, hostId: 'host-1', publicUrl: 'https://host.example', allowedOrigins: ['https://app.example'], webPushImpl: { generateVAPIDKeys: () => isolatedKeys }, sender: isolatedSender, authorizeDelivery: async () => true });
    await isolated.ready;
    await isolated.register({ deviceId: 'device-1', origin: 'https://app.example', subscription });
    await isolated.sendEvent({ type: 'attention', hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', eventId: 'isolated' });
    expect(isolatedSender.mock.calls[0][2].vapidDetails.publicKey).toBe(isolatedKeys.publicKey);
  });
});
