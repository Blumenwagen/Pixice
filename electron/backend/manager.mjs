import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { servicePaths } from './paths.mjs';
import { requestJson } from '../connect/application-client.mjs';
import { PROTOCOL_VERSION } from '../connect/protocol.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const starts = new Map();
const identities = new WeakMap();
export function backendBuildId(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')) {
  const hash = createHash('sha256');
  if (root.endsWith('.asar')) {
    // Electron's patched fs treats the archive as a virtual directory.
    const readArchive = process.versions.electron ? createRequire(import.meta.url)('original-fs').readFileSync : readFileSync;
    return hash.update(readArchive(root)).digest('hex');
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (/\.(mjs|cjs)$/.test(name)) hash.update(path.relative(root, name)).update(readFileSync(name));
    }
  };
  walk(path.join(root, 'electron')); return hash.digest('hex');
}
export async function readServiceDescriptor(directory) {
  const filename = servicePaths(directory).descriptor;
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('The service descriptor must be a private, regular file.');
  const value = JSON.parse(await readFile(filename, 'utf8'));
  const url = new URL(value.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.hostId !== 'string' || value.protocol !== PROTOCOL_VERSION) throw new Error('Invalid local Pixice service descriptor.');
  return value;
}
export const descriptorInstance = (descriptor) => ({ id: descriptor.hostId, endpoint: descriptor.endpoint, token: descriptor.token, name: 'This device' });
export async function serviceCall(descriptor, operation, payload, { timeout = 15_000 } = {}) {
  const info = identities.get(descriptor) ?? await requestJson(descriptor.endpoint, 'info', { signal: AbortSignal.timeout(timeout) });
  if (info.hostId !== descriptor.hostId || info.protocol !== PROTOCOL_VERSION) throw new Error('The local service identity changed.');
  identities.set(descriptor, info);
  const response = await requestJson(descriptor.endpoint, 'call', { token: descriptor.token, signal: AbortSignal.timeout(timeout),
    body: { operation, payload, id: randomUUID(), issuedAt: Date.now(), instanceId: info.instanceId } });
  return response.result;
}
export async function discoverService(directory) {
  const descriptor = await readServiceDescriptor(directory);
  return { descriptor, status: await serviceCall(descriptor, 'service.status', undefined, { timeout: 2000 }) };
}
export async function stopService(directory, { force = false, update = false, restart = false, keepDesktop = false, timeoutMs = 45_000 } = {}) {
  let descriptor;
  try { descriptor = await readServiceDescriptor(directory); } catch (error) { if (error.code === 'ENOENT') return { stopped: true }; throw error; }
  await serviceCall(descriptor, update ? 'service.prepareUpdate' : 'service.stop', { force, restart, keepDesktop }, { timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const current = await readServiceDescriptor(directory); if (current.ownerNonce !== descriptor.ownerNonce) throw new Error('A replacement service is already running.'); }
    catch (error) { if (error.code === 'ENOENT') return { stopped: true }; throw error; }
    await sleep(100);
  }
  throw new Error('The Pixice service did not stop in time. The app was not replaced.');
}
export function launchNativeHelper(configuration, dataDirectory) {
  if (!configuration?.command) throw new Error('Configure a Pixice native helper executable for browser and OS features.');
  const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
  const child = spawn(configuration.command, [...(configuration.args ?? []), '--pixice-native-helper', '--pixice-data-dir', dataDirectory], {
    env: environment, detached: true, stdio: 'ignore', windowsHide: true
  });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
export function ensureService(options) {
  const key = path.resolve(options.dataDirectory);
  if (!starts.has(key)) starts.set(key, ensure(options).finally(() => starts.delete(key)));
  return starts.get(key);
}
async function ensure({ dataDirectory, resourcesPath, clientDirectory, version, nativeConfiguration, buildId = backendBuildId(),
  nodeExecutable = process.execPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)), runAsNode = false, waitForReady = true, timeoutMs = 60_000 }) {
  const paths = servicePaths(dataDirectory);
  let existing;
  try { existing = await discoverService(paths.data); } catch { /* A crashed service leaves a harmless stale descriptor. */ }
  if (existing && existing.status.buildId !== buildId) {
    if (existing.status.activeTurns || existing.status.startingTurns || existing.status.activeWorkflows) throw new Error('The running backend has active work from an earlier Pixice build. Finish it before updating the service.');
    await stopService(paths.data); existing = null;
  }
  let child; let spawnError;
  if (!existing) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const output = openSync(paths.log, 'a', 0o600);
    try {
      child = spawn(nodeExecutable, [cliPath, 'serve', '--data-dir', paths.data, '--resources', resourcesPath, '--client', clientDirectory,
        '--version', version, '--build-id', buildId, ...(nativeConfiguration ? ['--native-config', JSON.stringify(nativeConfiguration)] : ['--no-native'])], {
        env: { ...process.env, ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, detached: true, stdio: ['ignore', output, output], windowsHide: true
      });
      child.once('error', (error) => { spawnError = error; }); child.unref();
    } finally { closeSync(output); }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      const found = await discoverService(paths.data);
      if (found.status.buildId !== buildId) throw new Error('A different Pixice build owns the service.');
      if (found.status.phase === 'ready' || (!waitForReady && found.status.phase === 'starting')) return found.descriptor;
    } catch (error) { if (/different Pixice build/.test(error.message)) throw error; }
    await sleep(200);
  }
  throw new Error(`The Pixice service did not become ready. See ${paths.log}`);
}
