import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const mocks = { spawn: vi.fn() };
import { ConnectTunnel } from '../electron/connect/tunnel.mjs';
const directories = [];
afterEach(async () => { vi.restoreAllMocks(); mocks.spawn.mockReset(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function tunnel() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-tunnel-test-')); directories.push(directory);
  const server = { state: { publicUrl: 'https://permanent.example', host: '127.0.0.1' }, status: () => ({ running: true, port: 43187 }), save: vi.fn() };
  const manager = new ConnectTunnel({ directory, server, spawnProcess: mocks.spawn });
  vi.spyOn(manager, 'binary').mockResolvedValue('/verified/cloudflared');
  return { manager, server };
}
function process() {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn(() => queueMicrotask(() => child.emit('exit', 0))); return child;
}

describe('temporary tunnel lifecycle', () => {
  it('reuses an in-flight startup and restores the permanent endpoint on stop', async () => {
    const { manager, server } = await tunnel(); const child = process(); mocks.spawn.mockReturnValue(child);
    const first = manager.start(); const second = manager.start(); expect(first).toBe(second);
    let failure; first.catch((error) => { failure = error.message; });
    await vi.waitFor(() => expect({ failure, calls: mocks.spawn.mock.calls.length, state: manager.status().state }).toEqual({ failure: undefined, calls: 1, state: 'starting' }));
    child.stderr.emit('data', Buffer.from('Tunnel ready: https://synthetic-test.trycloudflare.com'));
    expect(await first).toEqual({ state: 'ready', url: 'https://synthetic-test.trycloudflare.com' });
    expect(server.state.publicUrl).toContain('trycloudflare');
    await manager.stop();
    expect(server.state.publicUrl).toBe('https://permanent.example');
    expect(server.state.temporaryEndpoint).toBeUndefined();
    expect(child.kill).toHaveBeenCalled();
  });
  it('cancels installation without later opening a tunnel', async () => {
    const { manager } = await tunnel(); let finish;
    manager.binary.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const startup = manager.start(); const rejected = expect(startup).rejects.toThrow('cancelled');
    await manager.stop(); finish('/verified/cloudflared'); await rejected;
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(manager.status().state).toBe('stopped');
  });
  it('settles startup promptly on stop and ignores late tunnel output', async () => {
    const { manager, server } = await tunnel(); const child = process(); mocks.spawn.mockReturnValue(child);
    const rejected = expect(manager.start()).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    await manager.stop();
    child.stderr.emit('data', Buffer.from('https://late.trycloudflare.com'));
    await rejected;
    expect(manager.status().state).toBe('stopped');
    expect(server.state.publicUrl).toBe('https://permanent.example');
  });
  it('clears a temporary address left by a crashed process', async () => {
    const { server } = await tunnel(); server.state.temporaryEndpoint = true; server.state.previousEndpoint = 'https://restored.example'; server.state.publicUrl = 'https://old.trycloudflare.com';
    new ConnectTunnel({ directory: '.', server });
    expect(server.state.publicUrl).toBe('https://restored.example'); expect(server.save).toHaveBeenCalledOnce();
  });
});
