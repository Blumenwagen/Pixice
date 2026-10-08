import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class UpdateJournal {
  #directory;
  #writes = Promise.resolve();

  constructor(directory) { this.#directory = directory; }

  async reconcile(currentVersion) {
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(this.#directory, 'installation.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (receipt.state !== 'pending' || typeof receipt.targetVersion !== 'string') return null;
    const installed = currentVersion === receipt.targetVersion;
    const result = { ...receipt, state: installed ? 'installed' : 'failed', runningVersion: currentVersion, verifiedAt: new Date().toISOString() };
    await this.#receipt(result);
    await this.record({ state: result.state, currentVersion, availableVersion: receipt.targetVersion });
    return installed
      ? { state: 'installed', message: `Pixice ${currentVersion} was installed successfully.` }
      : { state: 'error', availableVersion: receipt.targetVersion, message: `Pixice ${receipt.targetVersion} did not replace this copy. You are still running ${currentVersion}. Check for updates to retry; your saved data is preserved.` };
  }

  pending({ currentVersion, availableVersion }) {
    return this.#receipt({ state: 'pending', currentVersion, targetVersion: availableVersion, requestedAt: new Date().toISOString() });
  }

  failed({ currentVersion, availableVersion, message }) {
    return this.#receipt({ state: 'failed', currentVersion, targetVersion: availableVersion, message, verifiedAt: new Date().toISOString() });
  }

  async #receipt(value) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.#directory, 'installation.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  record({ state, currentVersion, availableVersion, percent, message }) {
    this.#writes = this.#writes.then(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.#directory, 'updater.log');
      if ((await stat(file).catch(() => null))?.size > 256_000) await rename(file, `${file}.previous`);
      // No task contents, credentials, feed headers, or archive contents.
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), state, currentVersion, availableVersion, percent: Math.floor(percent || 0), message })}\n`, { mode: 0o600 });
    }).catch(() => {});
    return this.#writes;
  }
}
