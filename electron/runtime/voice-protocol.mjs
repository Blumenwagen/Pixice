import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CODEX_0159_VOICE_CAPABILITIES } from './voice-session.mjs';

const execute = promisify(execFile);
function stable(value) {
  return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function validateVoiceProtocol(version, schemas, descriptors = {}) {
  if (version !== '0.159.0' || digest(schemas) !== '10bcac171348fd2d975256588cf4d53630c9b40540015718e1ca319c18c9aaee'
    || digest(descriptors.requests ?? []) !== 'af8ca9201acafdf40cdffb1c04654c446eb86075588a2c78d52f1b0b9501a6e0'
    || digest(descriptors.notifications ?? []) !== '5fa969c7229b1c82373073fa7c3c0bcb5684d4bf44b37108917e9ae9e117e575') {
    throw Object.assign(new Error('Native voice requires the verified Codex 0.159.0 experimental protocol. This executable is unsupported.'), { code: 'voice_protocol_unsupported' });
  }
  return CODEX_0159_VOICE_CAPABILITIES;
}
// These CLI commands generate local metadata only, never an authenticated session.
export async function inspectVoiceProtocol(executable, environment) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pixice-voice-schema-'));
  try {
    const options = { env: environment, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true };
    const { stdout } = await execute(executable, ['--version'], options);
    const version = stdout.trim().match(/^codex-cli (\S+)$/)?.[1];
    if (version !== '0.159.0') return validateVoiceProtocol(version, {});
    await execute(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], options);
    const schemas = {};
    for (const name of (await readdir(path.join(directory, 'v2'))).filter((name) => /^ThreadRealtime.*\.json$/.test(name))) {
      schemas[name] = JSON.parse(await readFile(path.join(directory, 'v2', name), 'utf8'));
    }
    const descriptors = {};
    for (const [key, name] of [['requests', 'ClientRequest.json'], ['notifications', 'ServerNotification.json']]) {
      const bundle = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      descriptors[key] = bundle.oneOf.filter((entry) => entry.properties?.method?.enum?.[0]?.startsWith('thread/realtime/'));
    }
    return validateVoiceProtocol(version, schemas, descriptors);
  } catch (error) {
    if (error.code === 'voice_protocol_unsupported') throw error;
    throw Object.assign(new Error('The local Codex voice protocol could not be verified.'), { code: 'voice_protocol_unverified' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
