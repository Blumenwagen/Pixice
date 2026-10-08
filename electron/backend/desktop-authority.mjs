import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, lstat } from 'node:fs/promises';
import { servicePaths } from './paths.mjs';

// Private OS bootstrap, never an RPC capability or a public service descriptor.
// This isolates ordinary RPC clients, not processes with arbitrary OS-user access.
const protectedFiles = new Set();
const identity = (info) => `${info.dev}:${info.ino}`;
export function assertPublicFile(info) {
  if (protectedFiles.has(identity(info))) throw new Error('Desktop bootstrap credentials are unavailable through application file APIs.');
}
export async function provisionDesktopAuthority(paths, ownerNonce) {
  const token = randomBytes(32).toString('base64url');
  const temporary = `${paths.desktopAuthority}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  let info;
  try {
    await handle.writeFile(JSON.stringify({ ownerNonce, token }));
    info = await handle.stat();
    protectedFiles.add(identity(info));
    await rename(temporary, paths.desktopAuthority);
  } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
  return { token, dispose: async () => {
    const current = await lstat(paths.desktopAuthority).catch(() => null);
    if (current && identity(current) === identity(info)) await unlink(paths.desktopAuthority);
    // NativeBridge revokes this proof before disposal. Retired aliases cannot
    // authorize a replacement service; release the inode to avoid reuse blocks.
    protectedFiles.delete(identity(info));
  } };
}
export async function readDesktopAuthority(directory, descriptor) {
  let handle;
  try {
    handle = await open(servicePaths(directory).desktopAuthority, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error();
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value.ownerNonce !== descriptor.ownerNonce || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error();
    return value.token;
  } catch { throw new Error('The private desktop bootstrap is unavailable or belongs to another service.'); }
  finally { await handle?.close(); }
}
