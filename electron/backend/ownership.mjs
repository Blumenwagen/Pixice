import { mkdir, realpath, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { servicePaths } from './paths.mjs';
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireServiceOwnership(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const paths = servicePaths(await realpath(directory));
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(paths.lock);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (pid INTEGER, nonce TEXT)');
    const owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
    lock.prepare('INSERT INTO ownership VALUES (?, ?)').run(owner.pid, owner.nonce);
    await chmod(paths.lock, 0o600).catch((error) => { if (process.platform !== 'win32') throw error; });
    let released = false;
    return { paths, owner, release: async () => { if (!released) { released = true; lock.close(); } } };
  } catch (error) {
    lock.close();
    if (/locked|busy/i.test(error.message)) throw Object.assign(new Error('A Pixice service already owns this data directory.'), { code: 'SERVICE_RUNNING' });
    throw error;
  }
}
