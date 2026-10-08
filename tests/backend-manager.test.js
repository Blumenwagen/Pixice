// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureService, inspectService, readServiceDescriptor, stopService } from '../electron/backend/manager.mjs';
import { acquireServiceOwnership } from '../electron/backend/ownership.mjs';
import { servicePaths } from '../electron/backend/paths.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'pixice-manager-'));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  cleanup.push(async () => { await rm(path.join(dataDirectory, 'ignore-stop'), { force: true }); await stopService(dataDirectory, { force: true, timeoutMs: 3000 }); });
  const configuration = { dataDirectory, buildId: 'manager-test', version: 'test', resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'),
    cliPath: path.resolve('tests/fixtures/backend/cli.mjs'), nodeExecutable: process.execPath, timeoutMs: 3000 };
  const descriptor = await ensureService(configuration);
  return { dataDirectory, configuration, descriptor };
}
describe('desktop backend process recovery', () => {
  it('does not start a replacement after an intentional stop cancels discovery', async () => {
    const { dataDirectory, configuration } = await fixture();
    await stopService(dataDirectory);
    const ownership = await acquireServiceOwnership(dataDirectory);
    let enabled = true;
    const shouldStart = vi.fn(() => enabled);
    const pending = ensureService({ ...configuration, shouldStart });
    const rejected = expect(pending).rejects.toThrow('intentionally stopped');
    try {
      await vi.waitFor(() => expect(shouldStart.mock.calls.length).toBeGreaterThanOrEqual(2));
      enabled = false;
    } finally { await ownership.release(); }
    await rejected;
    await expect(readServiceDescriptor(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes a crashed descriptor without calling the dead endpoint and can start again', async () => {
    const { dataDirectory, configuration, descriptor } = await fixture();
    await stopService(dataDirectory);
    await writeFile(servicePaths(dataDirectory).descriptor, JSON.stringify(descriptor), { mode: 0o600 });
    expect(await inspectService(dataDirectory)).toMatchObject({ phase: 'stopped' });
    await expect(stopService(dataDirectory, { timeoutMs: 100 })).resolves.toEqual({ stopped: true });
    await expect(readServiceDescriptor(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await ensureService(configuration);
    expect(next.hostId).toBe(descriptor.hostId);
    expect(next.ownerNonce).not.toBe(descriptor.ownerNonce);
  });
  it('recovers after abrupt process death without losing the host identity', async () => {
    const { dataDirectory, configuration, descriptor } = await fixture();
    process.kill(descriptor.pid, 'SIGKILL');
    const next = await ensureService(configuration);
    expect(next.hostId).toBe(descriptor.hostId);
    expect(next.pid).not.toBe(descriptor.pid);
    expect(await inspectService(dataDirectory)).toMatchObject({ phase: 'ready' });
  });
  it('allows explicit force recovery when RPC and graceful termination cannot finish', async () => {
    const { dataDirectory, configuration, descriptor } = await fixture();
    await writeFile(path.join(dataDirectory, 'ignore-stop'), 'true');
    await expect(stopService(dataDirectory, { force: true, timeoutMs: 3000 })).resolves.toEqual({ stopped: true });
    const next = await ensureService(configuration);
    expect(next.pid).not.toBe(descriptor.pid);
    expect(next.hostId).toBe(descriptor.hostId);
  }, 10_000);
  it('refuses to terminate an unrelated process from a stale descriptor', async () => {
    const { dataDirectory, descriptor } = await fixture();
    await stopService(dataDirectory);
    const ownership = await acquireServiceOwnership(dataDirectory);
    cleanup.push(() => ownership.release());
    await writeFile(servicePaths(dataDirectory).descriptor, JSON.stringify({ ...descriptor, pid: process.pid }), { mode: 0o600 });
    await expect(stopService(dataDirectory, { force: true, timeoutMs: 100 })).rejects.toThrow('Could not verify');
  });
});
