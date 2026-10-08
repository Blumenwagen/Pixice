import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startService } from '../electron/backend/service.mjs';
import { BackendFixtureProvider } from './fixtures/backend-provider.mjs';
import { CodexProvider } from '../electron/providers/codex-provider.mjs';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { CodexCloud } from '../electron/providers/codex-cloud.mjs';

describe('DevDay host integration', () => {
  it('registers the real backend handlers and rejects remote administration before effects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pixice-devday-host-'));
    let service;
    try {
      service = await startService({ dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test', providerFactories: { codex: () => new BackendFixtureProvider(), claude: () => new BackendFixtureProvider('claude') } });
      await service.ready;
      const handlers = service.application.handlers;
      expect(await handlers.invoke('chatgpt:state', {})).toMatchObject({ profiles: [], selectedProfileId: null, pending: false });
      expect(await handlers.invoke('voice:state', {})).toMatchObject({ available: false });
      for (const operation of ['chatgpt:sign-in', 'chatgpt:select', 'voice:start', 'cloud:submit', 'cloud:apply']) await expect(handlers.invoke(operation, {}, { remote: true })).rejects.toThrow('host desktop');
      const folder = path.join(root, 'project'); await mkdir(folder);
      const project = await handlers.invoke('projects:create', { displayName: 'DevDay', icon: 'folder', color: 'gray', folders: [folder] });
      expect(await handlers.invoke('cloud:environment:save', { projectId: project.id, environment: { id: 'env_1', name: 'Project' } })).toMatchObject({ environments: [{ id: 'env_1', name: 'Project' }] });
      const settings = (await handlers.invoke('app:bootstrap')).settings;
      expect(settings.codexCloudEnvironments[project.id]).toHaveLength(1);
      expect(JSON.stringify(settings)).not.toMatch(/access_token|refresh_token|id_token/);
      const { thread } = await handlers.invoke('threads:create', { projectId: project.id, model: 'codex:fixture-model' });
      const inspect = vi.spyOn(CodexCloud.prototype, 'inspect').mockResolvedValue({ output: 'reviewed patch', warnings: '' });
      let finishApply;
      const apply = vi.spyOn(CodexCloud.prototype, 'apply').mockImplementation(() => new Promise((resolve) => { finishApply = resolve; }));
      const review = await handlers.invoke('cloud:diff', { projectId: project.id, taskId: 'task_1', attempt: 1 });
      const args = { projectId: project.id, taskId: 'task_1', reviewId: review.reviewId, expectedDiffHash: review.diffHash };
      const applying = handlers.invoke('cloud:apply', args);
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
      await expect(handlers.invoke('turns:start', { projectId: project.id, threadId: thread.id, text: 'work' })).rejects.toThrow('Cloud patch is being applied');
      await expect(handlers.invoke('cloud:apply', args)).rejects.toThrow('already being applied');
      finishApply({ output: 'applied', warnings: '' }); await applying;
      expect(inspect).toHaveBeenCalledOnce(); // Apply never re-fetches mutable remote bytes.
    } finally { vi.restoreAllMocks(); await service?.stop({ force: true }); await rm(root, { recursive: true, force: true }); }
  });
  it('routes resumed Codex threads through the app plan and restores their original provider without touching CLI OAuth', async () => {
    const runtime = new EventEmitter(); runtime.request = vi.fn(async () => ({}));
    let selected = true;
    const provider = new CodexProvider(runtime, { chatgptAccount: async () => selected ? { planEnabled: true, email: 'person@example.test' } : null, originalModelProvider: () => 'openai' });
    await provider.request('thread/resume', { threadId: 'thread' });
    expect(runtime.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'thread', modelProvider: 'openai_chatgpt_plan' });
    expect((await provider.account()).authSource).toBe('chatgptApp');
    await expect(provider.login()).rejects.toThrow('existing Codex');
    selected = false;
    await provider.request('thread/resume', { threadId: 'thread' });
    expect(runtime.request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'thread', modelProvider: 'openai' });
    await provider.login(); expect(runtime.request).toHaveBeenLastCalledWith('account/login/start', expect.objectContaining({ type: 'chatgpt', appBrand: 'codex' }));
  });
});
