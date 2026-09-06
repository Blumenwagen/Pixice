import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { NativeBridge } from '../electron/backend/native-bridge.mjs';
import { createCredentialCrypto } from '../electron/backend/credential-crypto.mjs';
import { createUpdateDataBackup, recoverUpdateDataFromBackup } from '../electron/persistence/update-data-backup.mjs';
const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() { const value = await mkdtemp(path.join(tmpdir(), 'pixice-native-test-')); cleanup.push(() => rm(value, { recursive: true, force: true })); return value; }
describe('native helper boundary', () => {
  it('requires the helper lease and rejects unknown native methods', async () => {
    const bridge = new NativeBridge(); cleanup.push(() => bridge.close());
    const lease = bridge.register({ clientId: randomUUID(), capabilities: ['browser.snapshot'] });
    expect(() => bridge.poll({ leaseId: randomUUID() })).toThrow('lease expired');
    expect(() => bridge.register({ clientId: randomUUID(), capabilities: [] })).toThrow('Another native helper');
    await expect(bridge.invoke('shell.execute', ['command'])).rejects.toThrow('Unsupported');
    const promise = bridge.invoke('browser.snapshot', ['task']);
    const { commands } = await bridge.poll(lease);
    bridge.respond({ ...lease, id: commands[0].id, result: { tabs: [] } });
    expect(await promise).toEqual({ tabs: [] });
  });
  it('fails in-flight actions on helper loss without replaying them to its replacement', async () => {
    const bridge = new NativeBridge(); cleanup.push(() => bridge.close());
    const first = bridge.register({ clientId: randomUUID(), capabilities: [] });
    const action = bridge.invoke('browser.navigate', [{ url: 'https://example.test' }]);
    const rejection = expect(action).rejects.toThrow('may have completed');
    await bridge.poll(first); bridge.disconnect(first); await rejection;
    const next = bridge.register({ clientId: randomUUID(), capabilities: [] });
    expect(bridge.queue).toHaveLength(0);
    expect(() => bridge.respond({ ...first, id: randomUUID(), result: true })).toThrow('lease expired');
    expect(next.leaseId).not.toBe(first.leaseId);
  });
});
describe('backend workflow credential encryption', () => {
  it('persists encrypted values across restart and rejects a different environment key before writing', async () => {
    const root = await directory();
    const environment = { PIXICE_CREDENTIAL_KEY: randomBytes(32).toString('base64') };
    const first = createCredentialCrypto({ directory: root, environment }); await first.ready();
    const encrypted = first.encryptString('private test value'); first.close();
    const second = createCredentialCrypto({ directory: root, environment }); await second.ready();
    expect(second.decryptString(encrypted)).toBe('private test value'); second.close();
    const wrong = createCredentialCrypto({ directory: root, environment: { PIXICE_CREDENTIAL_KEY: randomBytes(32).toString('base64') } });
    await expect(wrong.ready()).rejects.toThrow('does not match');
    expect(() => wrong.encryptString('replacement')).toThrow('not been initialized');
    expect(await readFile(path.join(root, 'service/credential-key.json'), 'utf8')).not.toContain(environment.PIXICE_CREDENTIAL_KEY);
  });
  it('reads legacy OS-encrypted credentials unchanged and protects the envelope key in update backups', async () => {
    const root = await directory(); const legacy = Buffer.from('legacy ciphertext').toString('base64');
    await writeFile(path.join(root, 'pixice-workflow-credentials.json'), JSON.stringify({ credentials: [{ id: 'test', encrypted: legacy }] }));
    const wrapped = new Map();
    const native = { invoke: vi.fn(async (method, [value]) => {
      if (method === 'crypto.encrypt') { const opaque = randomBytes(48).toString('base64'); wrapped.set(opaque, value); return opaque; }
      if (value === legacy) return 'legacy secret';
      return wrapped.get(value);
    }) };
    const crypto = createCredentialCrypto({ directory: root, native, environment: {} }); await crypto.ready();
    expect(crypto.decryptString(Buffer.from(legacy, 'base64'))).toBe('legacy secret');
    expect(JSON.parse(await readFile(path.join(root, 'pixice-workflow-credentials.json'))).credentials[0].encrypted).toBe(legacy);
    const encrypted = crypto.encryptString('updated secret'); crypto.close();
    const backup = await createUpdateDataBackup({ userDataPath: root, currentVersion: '1', targetVersion: '2' });
    expect(backup.path).toBeTruthy();
    await rm(path.join(root, 'service/credential-key.json'));
    expect(recoverUpdateDataFromBackup({ userDataPath: root })).toContainEqual(expect.objectContaining({ name: 'service/credential-key.json' }));
    const reopened = createCredentialCrypto({ directory: root, native, environment: {} }); await reopened.ready();
    expect(reopened.decryptString(encrypted)).toBe('updated secret'); reopened.close();
  });
});
