import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);

export async function assertMacUpdateEligible(executable, { run = runCommand } = {}) {
  const bundle = path.resolve(path.dirname(executable), '../..');
  const { stderr = '', stdout = '' } = await run('/usr/bin/codesign', ['--display', '--verbose=2', bundle], { timeout: 10_000 });
  const details = `${stdout}\n${stderr}`;
  if (!/^TeamIdentifier=(?!not set\s*$).+$/m.test(details) || /^Signature=adhoc$/m.test(details)) {
    throw new Error('This copy of Pixice has an ad-hoc signature and cannot install automatic macOS updates. Replace it once with the signed Pixice release from GitHub to enable future updates.');
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30_000 });
}

// electron-updater's update-downloaded means the ZIP is cached. With manual
// installation, Squirrel has not yet unpacked or verified that ZIP. Keep the
// desktop alive until Electron's native update-downloaded confirms readiness.
export function stageMacUpdate(nativeUpdater, { signal, timeoutMs = 120_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer;
    function cleanup() {
      clearTimeout(timer);
      nativeUpdater.removeListener('update-downloaded', ready);
      nativeUpdater.removeListener('error', failed);
      nativeUpdater.removeListener('update-not-available', unavailable);
      signal?.removeEventListener('abort', aborted);
    }
    function ready() { cleanup(); resolve(); }
    function failed(error) { cleanup(); reject(error); }
    function unavailable() { failed(new Error('The macOS installer did not accept the downloaded update.')); }
    function aborted() { failed(signal.reason ?? new Error('Update preparation was cancelled.')); }
    nativeUpdater.once('update-downloaded', ready);
    nativeUpdater.once('error', failed);
    nativeUpdater.once('update-not-available', unavailable);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => failed(new Error('The macOS installer did not become ready in time. Pixice stayed open; retry the installation.')), timeoutMs);
    try { nativeUpdater.checkForUpdates(); } catch (error) { failed(error); }
  });
}
