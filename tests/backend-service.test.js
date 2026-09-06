import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startService } from '../electron/backend/service.mjs';
import { ApplicationClient, requestJson } from '../electron/connect/application-client.mjs';
import { BackendFixtureProvider } from './fixtures/backend-provider.mjs';
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(directory) {
  const root = directory ?? await mkdtemp(path.join(tmpdir(), 'pixice-service-test-'));
  if (!directory) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = new BackendFixtureProvider();
  const service = await startService({ dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test',
    providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider('claude') } });
  cleanup.push(() => service.stop({ force: true }));
  await service.ready;
  const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: 'service.status' });
  cleanup.push(() => client.close()); await client.connect();
  return { root, service, client, provider };
}
describe('standalone application service', () => {
  it('runs workflows and the application API in plain Node without an Electron host', async () => {
    const { client, service, root } = await fixture();
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
});
