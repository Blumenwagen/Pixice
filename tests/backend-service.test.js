// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startService } from '../electron/backend/service.mjs';
import { ApplicationClient, requestJson } from '../electron/connect/application-client.mjs';
import { BackendFixtureProvider } from './fixtures/backend-provider.mjs';
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(directory, options = {}) {
  const root = directory ?? await mkdtemp(path.join(tmpdir(), 'pixice-service-test-'));
  if (!directory) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new BackendFixtureProvider();
  const service = await startService({ dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test',
    providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider('claude') }, ...options });
  cleanup.push(() => service.stop({ force: true }));
  await service.ready;
  const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: 'service.status' });
  cleanup.push(() => client.close()); await client.connect();
  return { root, service, client, provider };
}
describe('standalone application service', () => {
  it('loads saved projects even when the connected provider stalls model discovery', async () => {
    const { client, provider, root } = await fixture();
    const folder = path.join(root, 'model-stall'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Model stall', icon: 'folder', color: 'gray', folders: [folder] });
    const original = provider.request.bind(provider);
    provider.request = (method, payload) => method === 'model/list' ? new Promise(() => {}) : original(method, payload);
    const restored = await client.call('app.bootstrap');
    expect(restored.projects).toContainEqual(expect.objectContaining({ id: project.id }));
    expect(restored.models).toEqual([]);
  });
  it('loads saved projects while provider startup is still pending', async () => {
    const { client, service, root } = await fixture();
    const folder = path.join(root, 'slow-provider-project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Saved', icon: 'folder', color: 'gray', folders: [folder] });
    client.close(); await service.stop({ force: true });
    let resumeProvider;
    const barrier = new Promise(resolve => { resumeProvider = resolve; });
    const provider = new BackendFixtureProvider();
    const start = provider.start.bind(provider);
    provider.start = async () => { await barrier; return start(); };
    const next = await startService({ dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test',
      providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider('claude') } });
    cleanup.push(async () => { resumeProvider(); await next.ready; await next.stop({ force: true }); });
    const reader = new ApplicationClient({ id: next.descriptor.hostId, endpoint: next.descriptor.endpoint, token: next.descriptor.token }, { probe: 'service.status' });
    cleanup.push(() => reader.close()); await reader.connect();
    try {
      expect(next.status().phase).toBe('starting');
      expect((await reader.call('app.bootstrap')).projects).toContainEqual(expect.objectContaining({ id: project.id }));
      expect(await reader.call('workflows.list', { projectId: project.id })).toEqual({ data: [] });
    } finally { resumeProvider(); await next.ready; }
  });
  it('keeps saved projects visible when repository inspection fails', async () => {
    const { client, root } = await fixture();
    const folder = path.join(root, 'broken-repository'); await mkdir(folder);
    await promisify(execFile)('git', ['init'], { cwd: folder });
    const project = await client.call('projects.create', { displayName: 'Broken Git', icon: 'folder', color: 'gray', folders: [folder] });
    await writeFile(path.join(folder, '.git', 'config'), 'invalid git configuration\n');
    const restored = await client.call('app.bootstrap');
    expect(restored.projects).toContainEqual(expect.objectContaining({ id: project.id, repository: expect.objectContaining({ kind: 'unavailable' }) }));
  });
  it('restores every saved project even when one folder is unavailable after restart', async () => {
    const { client, service, root } = await fixture();
    const folders = [path.join(root, 'available'), path.join(root, 'external-drive')];
    for (const folder of folders) await mkdir(folder);
    const projects = [];
    for (const folder of folders) projects.push(await client.call('projects.create', { displayName: path.basename(folder), icon: 'folder', color: 'gray', folders: [folder] }));
    client.close(); await service.stop({ force: true });
    await rm(folders[1], { recursive: true });
    const next = await fixture(root);
    const restored = await next.client.call('app.bootstrap');
    expect(restored.projects.map(project => project.id).sort()).toEqual(projects.map(project => project.id).sort());
    expect(restored.projects.find(project => project.id === projects[1].id).repository).toMatchObject({ kind: 'unavailable', error: expect.any(String) });
    expect((await next.client.call('projects.list')).map(project => project.id)).toHaveLength(2);
  });
  it('creates and restores a project in a new Git repository before its first commit', async () => {
    const { client, root } = await fixture();
    const folder = path.join(root, 'new-repository'); await mkdir(folder);
    await promisify(execFile)('git', ['init'], { cwd: folder });
    const project = await client.call('projects.create', { displayName: 'New repository', icon: 'folder', color: 'gray', folders: [folder] });
    expect(project.repository).toMatchObject({ kind: 'git', baseCommit: null });
    expect((await client.call('app.bootstrap')).projects).toContainEqual(expect.objectContaining({ id: project.id }));
  });
  it('runs workflows and the application API in plain Node without an Electron host', async () => {
    const { client, service, root } = await fixture();
    expect(service.local.apiRateLimit).toBe(60_000);
    expect(service.remote.apiRateLimit).toBe(1200);
    expect(service.status()).toMatchObject({ phase: 'ready', workflowError: null, native: { connected: false } });
    const folder = path.join(root, 'project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Service project', icon: 'folder', color: 'gray', folders: [folder] });
    expect((await client.call('app.bootstrap')).projects).toContainEqual(expect.objectContaining({ id: project.id }));
    expect(await client.call('workflows.list', { projectId: project.id })).toEqual({ data: [] });
  });
  it('refuses a second service and keeps projects across an orderly backend restart', async () => {
    const { client, service, root } = await fixture();
    const folder = path.join(root, 'project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Persistent', icon: 'folder', color: 'gray', folders: [folder] });
    await expect(fixture(root)).rejects.toMatchObject({ code: 'SERVICE_RUNNING' });
    client.close(); await service.stop({ force: true });
    const next = await fixture(root);
    expect(next.service.descriptor.hostId).toBe(service.descriptor.hostId);
    expect((await next.client.call('projects.list')).map(p => p.id)).toContain(project.id);
  });
  it('keeps active work when a client closes and refuses to stop it implicitly', async () => {
    const { service, client, provider, root } = await fixture();
    const folder = path.join(root, 'project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Work', icon: 'folder', color: 'gray', folders: [folder] });
    const { thread } = await client.call('threads.create', { projectId: project.id });
    const { turn } = await client.call('turns.start', { projectId: project.id, threadId: thread.id, text: 'Continue independently', model: 'codex:fixture-model' });
    client.close();
    expect(service.status().activeTurns).toBe(1);
    const second = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: 'service.status' });
    cleanup.push(() => second.close()); await second.connect();
    expect((await second.call('threads.read', { projectId: project.id, threadId: thread.id })).thread.turns.at(-1).id).toBe(turn.id);
    await expect(second.call('service.stop')).rejects.toThrow('Active work');
    expect(provider.starts).toBe(1);
    await second.call('turns.interrupt', { projectId: project.id, threadId: thread.id, turnId: turn.id });
    expect(service.status().activeTurns).toBe(0);
  });

  it('returns a bounded durable overview while the provider is disconnected', async () => {
    const { client, provider, root } = await fixture();
    const folder = path.join(root, 'overview-project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Overview', icon: 'folder', color: 'gray', folders: [folder] });
    const { thread } = await client.call('threads.create', { projectId: project.id });
    await provider.stop();
    const overview = await client.call('app.overview');
    expect(overview.projects).toEqual([{ id: project.id, displayName: 'Overview', canonicalPath: expect.any(String) }]);
    expect(overview.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: thread.id, projectId: project.id, status: 'completed' })]));
    expect(overview.projects[0]).not.toHaveProperty('repository');
    expect(overview).toHaveProperty('checkedAt');
  });

  it('authorizes real service push delivery with legacy operator records and prunes revoked devices', async () => {
    const sender = vi.fn(async () => undefined);
    const { client, service, root } = await fixture(undefined, { pushSender: sender, pushWebPushImpl: { generateVAPIDKeys: () => webPush.generateVAPIDKeys() } });
    const folder = path.join(root, 'push-project'); await mkdir(folder);
    const project = await client.call('projects.create', { displayName: 'Push project', icon: 'folder', color: 'gray', folders: [folder] });
    const { thread } = await client.call('threads.create', { projectId: project.id });
    service.remote.state.enabled = true;
    service.remote.state.port = 0;
    service.remote.state.publicUrl = 'https://push.example';
    service.remote.state.origins = ['https://push.example'];
    await service.remote.start();
    const deviceId = 'legacy-operator';
    const token = 'test-token';
    service.remote.state.devices.push({ id: deviceId, name: 'Legacy', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 });
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
        auth: Buffer.alloc(16, 2).toString('base64url')
      }
    };
    await service.pushService.register({ deviceId, origin: 'https://push.example', subscription });
    await service.pushService.sendEvent({ type: 'attention', hostId: service.remote.state.hostId, projectId: project.id, threadId: thread.id, eventId: 'attention-1' });
    expect(sender).toHaveBeenCalledOnce();
    service.remote.revoke({ id: deviceId });
    await vi.waitFor(() => expect(service.pushService.subscriptions).toHaveLength(0));
    await service.pushService.sendEvent({ type: 'attention', hostId: service.remote.state.hostId, projectId: project.id, threadId: thread.id, eventId: 'attention-2' });
    expect(sender).toHaveBeenCalledOnce();
  });
});
