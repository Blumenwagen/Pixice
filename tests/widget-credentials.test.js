import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WidgetCredentials } from '../electron/backend/widget-credentials.mjs';

test('API key is encrypted at rest and never returned by status', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixice-widget-key-'));
  const crypto = { ready: async () => {}, isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).reverse(), decryptString: (bytes) => Buffer.from(bytes).reverse().toString() };
  try {
    const store = new WidgetCredentials(dir, crypto);
    assert.deepEqual(await store.save('secret-value'), { configured: true });
    assert.ok(!readFileSync(store.path, 'utf8').includes('secret-value'));
    assert.equal(await store.resolve(), 'secret-value');
    assert.deepEqual(store.remove(), { configured: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
