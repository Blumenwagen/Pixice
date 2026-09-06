import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
export function defaultDataDirectory(environment = process.env, platform = process.platform) {
  if (environment.PIXICE_DATA_DIR) return path.resolve(environment.PIXICE_DATA_DIR);
  if (platform === 'darwin') return path.join(homedir(), 'Library/Application Support/Pixice');
  if (platform === 'win32') return path.join(environment.APPDATA || path.join(homedir(), 'AppData/Roaming'), 'Pixice');
  return path.join(environment.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'pixice');
}
export function servicePaths(dataDirectory = defaultDataDirectory()) {
  const data = path.resolve(dataDirectory);
  return { data, directory: path.join(data, 'service'), descriptor: path.join(data, 'service/instance.json'), lock: path.join(data, 'service/owner.lock'), log: path.join(data, 'service/service.log') };
}
export function sourceConfiguration() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return { resourcesPath: root.endsWith('.asar') ? path.dirname(root) : path.join(root, 'resources'), clientDirectory: path.join(root, 'dist/client'), version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version };
}
