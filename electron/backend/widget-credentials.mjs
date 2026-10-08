import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class WidgetCredentials {
  constructor(directory, crypto) {
    this.path = path.join(directory, 'pixice-widget-credential.json');
    this.crypto = crypto;
  }
  status() { return { configured: existsSync(this.path) }; }
  async save(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new Error('Enter a valid TypeSafe API key');
    await this.crypto?.ready?.();
    if (!this.crypto?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable');
    const encrypted = Buffer.from(this.crypto.encryptString(key.trim())).toString('base64');
    mkdirSync(path.dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
    renameSync(temporary, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* unsupported filesystem */ }
    return this.status();
  }
  remove() {
    if (existsSync(this.path)) {
      unlinkSync(this.path);
    }
    return this.status();
  }
  async resolve() {
    if (!existsSync(this.path)) return null;
    await this.crypto?.ready?.();
    if (!this.crypto?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable');
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      return this.crypto.decryptString(Buffer.from(value.encrypted, 'base64'));
    } catch { throw new Error('TypeSafe credential could not be read'); }
  }
}
