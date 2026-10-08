import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateJournal } from '../electron/updater/update-journal.mjs';

const directories = [];
async function journal() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-update-journal-'));
  directories.push(directory);
  return { directory, journal: new UpdateJournal(directory) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('update installation receipts', () => {
  it('confirms installation only when the relaunched binary has the expected version', async () => {
    const { journal: history, directory } = await journal();
    await history.pending({ currentVersion: '0.1.0', availableVersion: '0.2.0' });
    const restarted = new UpdateJournal(directory);
    await expect(restarted.reconcile('0.2.0')).resolves.toMatchObject({ state: 'installed' });
    expect(JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8'))).toMatchObject({ state: 'installed', runningVersion: '0.2.0', targetVersion: '0.2.0' });
    await expect(restarted.reconcile('0.2.0')).resolves.toBeNull();
  });

  it('exposes a failed bundle replacement when the old version is launched manually', async () => {
    const { journal: history, directory } = await journal();
    await history.pending({ currentVersion: '0.1.0-beta.2', availableVersion: '0.1.0-beta.7' });
    await expect(new UpdateJournal(directory).reconcile('0.1.0-beta.2')).resolves.toMatchObject({ state: 'error', message: expect.stringContaining('still running 0.1.0-beta.2') });
    expect(JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8')).state).toBe('failed');
  });

  it('does not claim a native preparation failure was a successful restart', async () => {
    const { journal: history } = await journal();
    await history.pending({ currentVersion: '0.1.0', availableVersion: '0.2.0' });
    await history.failed({ currentVersion: '0.1.0', availableVersion: '0.2.0', message: 'native failure' });
    await expect(history.reconcile('0.1.0')).resolves.toBeNull();
  });
});
