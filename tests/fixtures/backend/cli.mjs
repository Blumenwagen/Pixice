// Isolated service process for crash/force-recovery tests. It owns no providers.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { acquireServiceOwnership } from '../../../electron/backend/ownership.mjs';
import { ConnectServer } from '../../../electron/connect/server.mjs';
import { APPLICATION_OPERATIONS } from '../../../electron/connect/application-protocol.mjs';
import { PROTOCOL_VERSION } from '../../../electron/connect/protocol.mjs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(`--${name}`) + 1];
const directory = value('data-dir');
const buildId = value('build-id');
const ownership = await acquireServiceOwnership(directory);
const hostFile = path.join(directory, 'host-id');
const hostId = await readFile(hostFile, 'utf8').catch(() => randomUUID());
await writeFile(hostFile, hostId, { mode: 0o600 });
const token = randomBytes(32).toString('base64url');
const ignoreStop = () => existsSync(path.join(directory, 'ignore-stop'));
let stopping;
const server = new ConnectServer({ directory: ownership.paths.directory, persist: false, operations: APPLICATION_OPERATIONS,
  initialState: { enabled: true, host: '127.0.0.1', port: 0, hostId, devices: [{ id: 'owner', name: 'Test owner', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Number.MAX_SAFE_INTEGER }] },
  invoke: async operation => {
    if (operation === 'service.status') return { phase: 'ready', buildId, pid: process.pid, activeTurns: 0, startingTurns: 0, activeWorkflows: 0 };
    if (operation === 'service.stop') {
      if (ignoreStop()) return new Promise(() => {});
      setTimeout(() => void stop(), 25);
      return { stopping: true };
    }
    throw new Error(`Unexpected test operation: ${operation}`);
  }
});
await server.start();
const descriptor = { pid: process.pid, ownerNonce: ownership.owner.nonce, hostId, endpoint: `http://127.0.0.1:${server.status().port}`, token, buildId, protocol: PROTOCOL_VERSION };
await writeFile(ownership.paths.descriptor, JSON.stringify(descriptor), { mode: 0o600 });
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => { await server.stop(); await unlink(ownership.paths.descriptor); await ownership.release(); })();
  return stopping;
}
process.on('SIGTERM', () => { if (!ignoreStop()) void stop(); });
process.on('SIGINT', () => void stop());
