import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteInvoker, createRemoteThreadValidator } from '../electron/connect/remote-operations.mjs';
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function setup(extra = {}) {
  const handlers = new Map();
  const invoke = createRemoteInvoker({ handlers, pendingRequest: () => ({ generation: 3 }), generation: () => 3, activeTurnId: () => 'turn-current', hostId: () => 'host', ...extra });
  return { handlers, invoke };
}

describe('remote domain authorization', () => {
  it('rejects approvals from an earlier runtime generation without calling the provider', async () => {
    const { handlers, invoke } = setup();
    const resolve = vi.fn(async () => ({ ok: true }));
    handlers.set('approvals:resolve', resolve);
    await expect(invoke('approvals.resolve', { requestId: 5, requestGeneration: 2, decision: 'accept' })).rejects.toThrow('no longer current');
    expect(resolve).not.toHaveBeenCalled();
    await expect(invoke('approvals.resolve', { requestId: 5, requestGeneration: 3, decision: 'accept' })).resolves.toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledOnce();
  });
  it('validates thread ownership and current turns before steering or interruption', async () => {
    const { handlers, invoke } = setup({ validateThread: async (value) => { if (value.projectId !== 'correct') throw new Error('Wrong project'); } });
    const steer = vi.fn();
    handlers.set('turns:steer', steer);
    await expect(invoke('turns.steer', { projectId: 'wrong', threadId: 'thread', turnId: 'turn-current' })).rejects.toThrow('Wrong project');
    await expect(invoke('turns.steer', { projectId: 'correct', threadId: 'thread', turnId: 'turn-old' })).rejects.toThrow('no longer active');
    expect(steer).not.toHaveBeenCalled();
  });
  it('refreshes receipts and starts a remote turn without requesting unsupported turn history', async () => {
    const request = vi.fn(async (_method, params) => {
      if (params.includeTurns) throw new Error('list_turns is not supported yet');
      return { thread: { id: params.threadId, cwd: '/project' } };
    });
    const validateThread = createRemoteThreadValidator({ getProject: (id) => ({ id }), request, contains: (project, cwd) => project.id === 'p' && cwd === '/project' });
    const { handlers, invoke } = setup({ validateThread });
    const fullRead = vi.fn(() => request('thread/read', { threadId: 'new', includeTurns: true }));
    handlers.set('threads:read', fullRead);
    const receipt = vi.fn(async () => null);
    const start = vi.fn(async () => ({ turn: { id: 'first-turn' } }));
    handlers.set('tasks:receipt', receipt);
    handlers.set('turns:start', start);
    await expect(invoke('tasks.receipt', { projectId: 'p', threadId: 'new' })).resolves.toBeNull();
    await expect(invoke('turns.start', { projectId: 'p', threadId: 'new', text: 'Hey' })).resolves.toEqual({ turn: { id: 'first-turn' } });
    expect(receipt).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fullRead).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'new', includeTurns: false });
    await expect(invoke('turns.start', { projectId: 'other', threadId: 'new' })).rejects.toThrow('outside');
    expect(start).toHaveBeenCalledOnce();
  });
  it('fails closed when thread metadata is missing, mismatched, or unreadable', async () => {
    const request = vi.fn();
    const validate = createRemoteThreadValidator({ getProject: () => ({}), request, contains: () => true });
    for (const thread of [null, { id: 't' }, { id: 'another', cwd: '/project' }]) {
      request.mockResolvedValueOnce({ thread });
      await expect(validate({ projectId: 'p', threadId: 't' })).rejects.toThrow('outside');
    }
    request.mockRejectedValueOnce(new Error('Thread unavailable'));
    await expect(validate({ projectId: 'p', threadId: 't' })).rejects.toThrow('Thread unavailable');
  });
  it('confines file reads and writes to project roots, including symlinks, and requires a save revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixice-remote-files-')); directories.push(root);
    const project = path.join(root, 'project'); await mkdir(project);
    const inside = path.join(project, 'file.txt'); const outside = path.join(root, 'secret.txt');
    await writeFile(inside, 'project'); await writeFile(outside, 'secret');
    await symlink(outside, path.join(project, 'escape.txt'));
    const { handlers, invoke } = setup({ fileOptions: (_id, reference) => ({ reference, primaryRoot: project, roots: [project] }) });
    const read = vi.fn(async () => ({ content: 'project' })); const write = vi.fn(async () => ({ ok: true }));
    handlers.set('files:read', read); handlers.set('files:write', write);
    await expect(invoke('files.read', { projectId: 'p', path: outside })).rejects.toThrow('outside');
    await expect(invoke('files.read', { projectId: 'p', path: 'escape.txt' })).rejects.toThrow('outside');
    expect(read).not.toHaveBeenCalled();
    await expect(invoke('files.read', { projectId: 'p', path: inside })).resolves.toEqual({ content: 'project' });
    await expect(invoke('files.write', { projectId: 'p', path: inside, content: 'new' })).rejects.toThrow('Read the current file');
    expect(write).not.toHaveBeenCalled();
    await invoke('files.write', { projectId: 'p', path: inside, content: 'new', expectedMtimeMs: (await stat(inside)).mtimeMs });
    expect(write).toHaveBeenCalledOnce();
  });
  it('does not expose native channels or provider secrets even when handlers exist', async () => {
    const { handlers, invoke } = setup();
    const native = vi.fn(); handlers.set('providers:login', native);
    await expect(invoke('providers.login', {})).rejects.toThrow('not ready');
    expect(native).not.toHaveBeenCalled();
    handlers.set('providers:list', async () => [{ id: 'codex', executablePath: '/private/runtime', account: { email: 'owner@example.com', accessToken: 'secret-token' }, health: { environment: 'private' }, actions: { login: true } }]);
    const providers = await invoke('providers.list');
    expect(JSON.stringify(providers)).not.toContain('secret-token');
    expect(JSON.stringify(providers)).not.toContain('/private/runtime');
    expect(providers[0].actions.login).toBe(false);
    handlers.set('app:bootstrap', async () => ({ settings: { providerExecutablePaths: { codex: '/secret' }, defaultModel: 'model' } }));
    expect((await invoke('app.bootstrap')).settings).toEqual({ defaultModel: 'model' });
  });
});
