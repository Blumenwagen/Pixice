import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRuntime } from '../electron/runtime/codex-runtime.mjs';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => { const actual = await importOriginal(); const spawn = vi.fn(); return { ...actual, spawn, default: { ...actual.default, spawn } }; });
const runtimes = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop())); vi.clearAllMocks(); });
function fixture() {
  const children = [];
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = (signal) => { child.signalCode = signal; child.stdout.end(); child.emit('exit', null, signal); };
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      if (request.id) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
    });
    children.push(child); return child;
  });
  let token = 'private-token-one'; let idle = true;
  const runtime = new CodexRuntime({ executablePath: process.execPath, clientVersion: 'test', environment: { PATH: '/test', ACCESS_TOKEN: 'inherited-secret' }, authentication: async () => token ? { accessToken: token } : null, canRestartAuthentication: () => idle });
  runtimes.push(runtime);
  return { runtime, children, setToken: (value) => { token = value; }, setIdle: (value) => { idle = value; } };
}
describe('App-owned credential runtime', () => {
  it('puts tokens only in the child environment and suppresses credential-bearing diagnostics', async () => {
    const { runtime, children, setToken } = fixture(); const diagnostics = vi.fn(); runtime.on('diagnostic', diagnostics);
    await runtime.start();
    expect(spawn.mock.calls[0][2].env.ACCESS_TOKEN).toBe('private-token-one');
    expect(JSON.stringify(spawn.mock.calls[0][1])).not.toContain('private-token');
    expect(spawn.mock.calls[0][1]).toContain('model_provider="openai_chatgpt_plan"');
    children[0].stderr.write('Bearer private-token-one'); expect(diagnostics).not.toHaveBeenCalled();
    await runtime.stop(); setToken(null); await runtime.start();
    expect(spawn.mock.calls[1][2].env).not.toHaveProperty('ACCESS_TOKEN');
    expect(spawn.mock.calls[1][1]).not.toContain('model_provider="openai_chatgpt_plan"');
  });
  it('refuses an active-work restart and requires thread restoration after a renewed turn', async () => {
    const { runtime, setToken, setIdle } = fixture(); await runtime.start(); setToken('private-token-two'); setIdle(false);
    await expect(runtime.prepareAuthentication()).rejects.toThrow('Finish active Codex'); expect(spawn).toHaveBeenCalledTimes(1);
    setIdle(true);
    await expect(runtime.request('turn/start', { threadId: 'thread', input: [] })).rejects.toThrow('restores its project tools');
    expect(spawn).toHaveBeenCalledTimes(2); expect(spawn.mock.calls[1][2].env.ACCESS_TOKEN).toBe('private-token-two');
    await expect(runtime.request('thread/resume', { threadId: 'thread' })).resolves.toEqual({});
  });
});
