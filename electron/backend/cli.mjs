#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startService } from './service.mjs';
import { defaultDataDirectory, sourceConfiguration } from './paths.mjs';
import { backendBuildId, discoverService, ensureService, launchNativeHelper, serviceCall, stopService } from './manager.mjs';

export function parseArguments(args) {
  const commands = new Set(['serve', 'start', 'status', 'stop', 'restart', 'pair', 'configure', 'tunnel', 'help']);
  const command = args[0]?.startsWith('-') ? 'help' : args.shift() || 'help';
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  const options = {};
  const values = new Set(['data-dir', 'resources', 'client', 'version', 'build-id', 'native-config', 'native-executable', 'port', 'host', 'endpoint', 'name']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, '');
    if (['force', 'no-native', 'update', 'enable', 'disable', 'stop'].includes(name)) options[name] = true;
    else if (values.has(name) && args[index + 1] && !args[index + 1].startsWith('--')) options[name] = args[++index];
    else if (name !== 'help') throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  return { command, options };
}
function defaultNativeConfiguration(root) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1' && root.endsWith('.asar')) return { command: process.execPath, args: [] };
  try { return { command: createRequire(import.meta.url)('electron'), args: [root] }; } catch { return undefined; }
}
export async function main(args = process.argv.slice(2)) {
  const { command, options } = parseArguments([...args]);
  if (command === 'help') {
    console.log('Pixice service\n\nserve     Run the backend in this terminal\nstart     Start or reuse the background backend\nstatus    Inspect the running backend\nstop      Stop an idle backend (--force interrupts active work)\nrestart   Restart an idle backend\npair      Create a one-time link for an enabled remote listener\nconfigure Enable/disable remote access (--enable or --disable)\ntunnel    Start a temporary HTTPS tunnel (--stop to stop it)\n\nOptions: --data-dir PATH, --native-executable PATH, --no-native, --force');
    return;
  }
  const defaults = sourceConfiguration();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dataDirectory = path.resolve(options['data-dir'] || defaultDataDirectory());
  const nativeConfiguration = options['no-native'] ? undefined : options['native-config'] ? JSON.parse(options['native-config'])
    : options['native-executable'] ? { command: path.resolve(options['native-executable']), args: [] } : defaultNativeConfiguration(root);
  const configuration = { dataDirectory, resourcesPath: path.resolve(options.resources || defaults.resourcesPath), clientDirectory: path.resolve(options.client || defaults.clientDirectory),
    version: options.version || defaults.version, buildId: options['build-id'] || backendBuildId(root), nativeConfiguration,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1' };
  if (command === 'status') { console.log(JSON.stringify((await discoverService(dataDirectory)).status, null, 2)); return; }
  if (command === 'configure' || command === 'tunnel') {
    const { descriptor } = await discoverService(dataDirectory);
    if (command === 'tunnel') { console.log(JSON.stringify(await serviceCall(descriptor, options.stop ? 'connect.stopTunnel' : 'connect.startTunnel', undefined, { timeout: 180_000 }))); return; }
    if (Boolean(options.enable) === Boolean(options.disable)) throw new Error('Choose --enable or --disable for remote access.');
    const current = await serviceCall(descriptor, 'connect.status');
    const result = await serviceCall(descriptor, 'connect.configure', { enabled: Boolean(options.enable), port: options.port ? Number(options.port) : current.port,
      host: options.host || current.host, publicUrl: options.endpoint ?? current.publicUrl, name: options.name || current.name, origins: current.origins });
    console.log(JSON.stringify({ enabled: result.enabled, running: result.running, host: result.host, port: result.port, publicUrl: result.publicUrl, name: result.name })); return;
  }
  if (command === 'pair') {
    const { descriptor } = await discoverService(dataDirectory); const result = await serviceCall(descriptor, 'connect.pair');
    console.log(result.url); console.log(`Expires: ${new Date(result.expiresAt).toISOString()}`); return;
  }
  if (command === 'stop' || command === 'restart') {
    await stopService(dataDirectory, { force: Boolean(options.force), update: Boolean(options.update), restart: command === 'restart' });
    if (command === 'stop') { console.log('Pixice service stopped.'); return; }
  }
  if (command === 'start' || command === 'restart') {
    const descriptor = await ensureService(configuration);
    console.log(JSON.stringify({ running: true, pid: descriptor.pid, dataDirectory, version: descriptor.version })); return;
  }
  const service = await startService({ ...configuration,
    launchNative: nativeConfiguration ? () => launchNativeHelper(nativeConfiguration, dataDirectory) : undefined,
    onStopped: () => { process.exitCode = 0; } });
  const stop = () => { void service.stop({ force: true }).catch((error) => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await service.ready;
  console.log(JSON.stringify({ ready: true, pid: process.pid, version: configuration.version, dataDirectory }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
