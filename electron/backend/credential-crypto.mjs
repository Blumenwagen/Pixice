import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
const keyCheck = (key) => createHmac('sha256', key).update('Pixice workflow credential key verification v1').digest('base64');
const PREFIX = Buffer.from('PIXICE-GCM-1:');
// Only the envelope key is unwrapped by the native OS key store. Credential
// encryption stays synchronous inside the core; initialization is explicit and lazy.
export function createCredentialCrypto({ directory, native, environment = process.env }) {
  let key; let loading; const legacy = new Map();
  const keyFile = path.join(directory, 'service/credential-key.json');
  async function initialize() {
    let stored;
    try { stored = JSON.parse(await readFile(keyFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stored) {
      if (stored.kind === 'environment') {
        if (!environment.PIXICE_CREDENTIAL_KEY) throw new Error('Set the same PIXICE_CREDENTIAL_KEY used to encrypt workflow credentials.');
        key = Buffer.from(environment.PIXICE_CREDENTIAL_KEY, 'base64');
      } else if (stored.kind === 'native' && typeof stored.wrapped === 'string') {
        key = Buffer.from(await native.invoke('crypto.decrypt', [stored.wrapped]), 'base64');
      } else throw new Error('The workflow encryption key record is invalid.');
    } else {
      key = environment.PIXICE_CREDENTIAL_KEY ? Buffer.from(environment.PIXICE_CREDENTIAL_KEY, 'base64') : randomBytes(32);
      if (key.length !== 32) throw new Error('PIXICE_CREDENTIAL_KEY must contain a base64-encoded 32-byte key.');
      const record = environment.PIXICE_CREDENTIAL_KEY ? { kind: 'environment' } : { kind: 'native', wrapped: await native.invoke('crypto.encrypt', [key.toString('base64')]) };
      record.verification = keyCheck(key);
      await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      await writeFile(`${keyFile}.tmp`, JSON.stringify(record), { mode: 0o600 }); await rename(`${keyFile}.tmp`, keyFile);
    }
    if (key.length !== 32) throw new Error('The workflow encryption key has the wrong length.');
    if (stored?.verification) {
      const actual = Buffer.from(keyCheck(key)); const expected = Buffer.from(stored.verification);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('The workflow credential key does not match this data directory.');
    }
    // Existing safeStorage records remain untouched and readable. Updated records
    // use the envelope format, so migration never destroys an old credential.
    let records = [];
    try { records = JSON.parse(await readFile(path.join(directory, 'pixice-workflow-credentials.json'), 'utf8')).credentials ?? []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const record of records) {
      if (record.encrypted && !Buffer.from(record.encrypted, 'base64').subarray(0, PREFIX.length).equals(PREFIX)) {
        legacy.set(record.encrypted, await native.invoke('crypto.decrypt', [record.encrypted]));
      }
    }
  }
  const ready = () => {
    if (!loading) loading = initialize().catch((error) => { key = null; loading = null; throw error; });
    return loading;
  };
  return {
    ready,
    isEncryptionAvailable: () => Boolean(key),
    encryptString(value) {
      if (!key) throw new Error('Secure credential storage has not been initialized');
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([PREFIX, iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const buffer = Buffer.from(bytes);
      if (!buffer.subarray(0, PREFIX.length).equals(PREFIX)) {
        const value = legacy.get(buffer.toString('base64')); if (value === undefined) throw new Error('Legacy credential is unavailable in the OS key store'); return value;
      }
      if (!key) throw new Error('Secure credential storage has not been initialized');
      const offset = PREFIX.length; const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(offset, offset + 12));
      cipher.setAuthTag(buffer.subarray(offset + 12, offset + 28));
      return Buffer.concat([cipher.update(buffer.subarray(offset + 28)), cipher.final()]).toString('utf8');
    },
    close() { key?.fill(0); key = null; legacy.clear(); loading = null; }
  };
}
