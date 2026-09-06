import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { ApplicationRegistry } from './registry.mjs';
import { acquireServiceOwnership } from './ownership.mjs';
import { createApplication } from './application.mjs';
import { NativeBridge } from './native-bridge.mjs';
import { createNativePlatform } from './platform.mjs';
import { ConnectServer } from '../connect/server.mjs';
import { ConnectTunnel } from '../connect/tunnel.mjs';
import { APPLICATION_OPERATIONS, APPLICATION_READ_OPERATIONS } from '../connect/application-protocol.mjs';
import { PROTOCOL_VERSION } from '../connect/protocol.mjs';

export async function startService(options) {
  const ownership = await acquireServiceOwnership(options.dataDirectory);
  try { return await startOwnedService({ ...options, ownership }); }
  catch (error) { await ownership.release(); throw error; }
}
async function startOwnedService({ dataDirectory, resourcesPath, clientDirectory, version = 'development', buildId = version,
  launchNative, nativeConfiguration, providerFactories, ownership, platform: suppliedPlatform, environment = process.env, onStopped = () => {} }) {
  const { paths, owner } = ownership;
  const registry = new ApplicationRegistry(); const control = new ApplicationRegistry();
  const native = new NativeBridge({ launch: launchNative });
  const platform = suppliedPlatform ?? createNativePlatform({ native, directory: paths.data, environment });
  const application = createApplication({ userDataPath: paths.data, resourcesPath, version, platform, handlers: registry, providerFactories });
  let phase = 'starting'; let stopped = false; let shutdownPromise; let descriptor; let startupTask;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Consumers may attach while startup is still in progress, including the native
  // helper needed by a configured OS facility. Core calls wait for readiness.
  ready.catch(() => {});
  const remote = new ConnectServer({ directory: path.join(paths.data, 'connect'), clientDirectory, version,
    tlsFiles: environment.PIXICE_CONNECT_TLS_CERT || environment.PIXICE_CONNECT_TLS_KEY
      ? { cert: environment.PIXICE_CONNECT_TLS_CERT, key: environment.PIXICE_CONNECT_TLS_KEY } : undefined,
    attention: application.attention,
    invoke: application.remoteInvoker(() => remote.state.hostId),
    onChange: (status) => publish({ type: 'ConnectStatus', payload: { ...status, tunnel: tunnel.status() } }) });
  if (!existsSync(path.join(paths.data, 'connect/connect.json'))) remote.save();
  const token = randomBytes(32).toString('base64url');
  // Desktop/native RPC and streamed events share this private, authenticated
  // listener. Their normal traffic must not exhaust the public API's budget.
  const local = new ConnectServer({ directory: paths.directory, clientDirectory, version, persist: false, apiRateLimit: 60_000,
    initialState: { enabled: true, port: 0, host: '127.0.0.1', hostId: remote.state.hostId,
      devices: [{ id: 'local-owner', name: 'Local desktop and CLI', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Number.MAX_SAFE_INTEGER }] },
    operations: APPLICATION_OPERATIONS, readOperations: APPLICATION_READ_OPERATIONS, eventFilter: () => true,
    attention: application.attention,
    invoke: async (operation, payload) => {
      const channel = APPLICATION_OPERATIONS.get(operation);
      if (control.entries.has(channel)) return control.invoke(channel, payload, { local: true });
      await ready;
      return registry.invoke(channel, payload, { local: true });
    } });
  const tunnel = new ConnectTunnel({ directory: path.join(paths.data, 'connect'), server: remote,
    onChange: () => publish({ type: 'ConnectStatus', payload: { ...remote.status(), tunnel: tunnel.status() } }) });
  function publish(event) { const envelope = { at: new Date().toISOString(), ...event }; local.publish(envelope); remote.publish(envelope); }
  application.events.on('event', publish);
  native.on('event', publish);
  native.on('status', (status) => publish({ type: 'NativeState', payload: status }));
  const status = () => ({ phase, pid: process.pid, startedAt: owner.createdAt, version, buildId, protocol: PROTOCOL_VERSION,
    hostId: remote.state.hostId, dataDirectory: paths.data, ...application.state(), native: native.status(), remote: { enabled: remote.state.enabled, running: Boolean(remote.server?.listening), publicUrl: remote.state.publicUrl } });
  control.handle('service:status', status);
  control.handle('service:backup', async (_context, payload) => { await ready; return application.backup(z.object({ currentVersion: z.string(), targetVersion: z.string() }).strict().parse(payload)); });
  async function requestStop(payload, reason = 'user') {
    const { force, restart, keepDesktop } = z.object({ force: z.boolean().default(false), restart: z.boolean().default(false), keepDesktop: z.boolean().default(false) }).strict().parse(payload ?? {});
    if (restart) reason = 'restart';
    if (phase === 'stopping' || stopped) return { stopping: true };
    const oldPhase = phase; phase = 'stopping'; application.freeze(true);
    let state = application.state();
    if (!force && (state.activeTurns || state.startingTurns || state.activeWorkflows)) { phase = oldPhase; application.freeze(false); throw new Error('Active work is still running. Finish it first or explicitly interrupt it.'); }
    if (force) await application.quiesce();
    await registry.drain();
    state = application.state();
    if (!force && (state.activeTurns || state.startingTurns || state.activeWorkflows)) {
      phase = oldPhase; registry.closed = false; application.freeze(false);
      throw new Error('Active work is still running. Finish it first or explicitly interrupt it.');
    }
    setTimeout(() => { void stop({ force, reason, keepDesktop }).catch((error) => { console.error('Service shutdown failed:', error.message); }); }, 25);
    return { stopping: true, reason };
  }
  control.handle('service:stop', (_context, payload) => requestStop(payload));
  control.handle('service:prepare-update', (_context, payload) => requestStop(payload, 'update'));
  control.handle('connect:status', () => ({ ...remote.status(), tunnel: tunnel.status(), service: status() }));
  control.handle('connect:configure', async (_context, payload) => { await tunnel.stop(); return remote.configure(payload); });
  control.handle('connect:pair', () => remote.pairOffer());
  control.handle('connect:revoke', (_context, payload) => remote.revoke(z.object({ id: z.string().optional(), all: z.boolean().optional() }).strict().parse(payload)));
  control.handle('connect:tunnel:start', () => tunnel.start());
  control.handle('connect:tunnel:stop', () => tunnel.stop());
  for (const method of ['register', 'poll', 'respond', 'event', 'disconnect']) control.handle(`native:${method}`, (_context, payload) => native[method](payload));
  async function stop({ force = false, reason = 'user', keepDesktop = false } = {}) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (stopped) return;
      const current = application.state();
      if (!force && (current.activeTurns || current.startingTurns || current.activeWorkflows)) throw new Error('Active work is still running. Finish it first or explicitly interrupt it.');
      phase = 'stopping'; application.freeze(true);
      if (startupTask) { if (!native.status().connected) native.close(); await startupTask.catch(() => {}); }
      if (force) await application.quiesce();
      await registry.drain();
      try {
        await application.stop({ force });
        await tunnel.stop();
        await remote.stop();
        if (native.status().connected) {
          await native.invoke(reason === 'update' && !keepDesktop ? 'desktop.shutdown' : 'desktop.serviceStopped', [{ reason }], { timeoutMs: 3000 }).catch(() => {});
        }
        native.close(); platform.credentialCrypto?.close?.();
        await local.stop(); stopped = true; phase = 'stopped';
        try { const saved = JSON.parse(await readFile(paths.descriptor, 'utf8')); if (saved.ownerNonce === owner.nonce) await unlink(paths.descriptor); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await ownership.release(); onStopped();
      } catch (error) { shutdownPromise = null; throw error; }
    })();
    shutdownPromise = shutdownPromise.catch((error) => { shutdownPromise = null; throw error; });
    return shutdownPromise;
  }
  try {
    await local.start();
    descriptor = { pid: process.pid, ownerNonce: owner.nonce, hostId: remote.state.hostId,
      endpoint: `http://127.0.0.1:${local.status().port}`, token, version, buildId, protocol: PROTOCOL_VERSION,
      startedAt: owner.createdAt, resourcesPath, clientDirectory, nativeConfiguration };
    await writeFile(`${paths.descriptor}.tmp`, JSON.stringify(descriptor), { mode: 0o600 });
    await rename(`${paths.descriptor}.tmp`, paths.descriptor);
    startupTask = application.start();
    void startupTask.then(async () => {
      if (phase === 'stopping') { rejectReady(new Error('Service startup was cancelled')); return; }
      await remote.start().catch((error) => publish({ type: 'ConnectStatus', payload: { ...remote.status(), error: error.message } }));
      phase = 'ready'; resolveReady(); publish({ type: 'ServiceState', payload: status() });
    }).catch(async (error) => {
      rejectReady(error);
      if (phase === 'stopping') return;
      phase = 'failed'; console.error('Pixice service startup failed:', error.message);
      await stop({ force: true }).catch(() => {});
    });
    return { ready, stop, status, descriptor, paths, application, local, remote, native, tunnel };
  } catch (error) {
    rejectReady(error); await stop({ force: true }).catch(() => {}); throw error;
  }
}
