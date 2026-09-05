import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, chmod, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const exec = promisify(execFile);
const VERSION = '2026.8.3';
// Official Cloudflare release asset SHA-256 digests, verified 2026-09-05.
const ASSETS = {
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99'],
  'linux-x64': ['cloudflared-linux-amd64', 'f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e'],
  'linux-arm64': ['cloudflared-linux-arm64', '4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391'],
  'win32-x64': ['cloudflared-windows-amd64.exe', '83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae']
};
export class ConnectTunnel {
  constructor({ directory, server, onChange = () => {}, spawnProcess = spawn }) { this.spawnProcess = spawnProcess; this.directory = directory; this.server = server; this.onChange = onChange; this.state = { state: 'stopped', url: null }; this.generation = 0;
    if (this.server.state.temporaryEndpoint) { this.server.state.publicUrl = this.server.state.previousEndpoint || ''; delete this.server.state.temporaryEndpoint; delete this.server.state.previousEndpoint; this.server.save(); }
  }
  status() { return this.state; }
  set(value) { this.state = value; this.onChange(value); }
  async binary() {
    const asset = ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error('Automatic tunnels are unavailable on this platform. Configure an HTTPS reverse proxy.');
    const directory = path.join(this.directory, `cloudflared-${VERSION}`);
    const binary = path.join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'verified.json'), 'utf8'));
      if (hash(await readFile(binary)) === metadata.binaryHash && metadata.assetHash === asset[1]) return binary;
    } catch { /* Download a verified release below. */ }
    this.set({ state: 'installing', url: null });
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset[0]}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Could not download Cloudflare tunnel. Check the host network and retry.');
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) { length += chunk.length; if (length > 100 * 1024 * 1024) throw new Error('Tunnel download exceeds the size limit'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    if (bytes.length > 100 * 1024 * 1024 || hash(bytes) !== asset[1]) throw new Error('Tunnel download failed integrity verification');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (asset[0].endsWith('.tgz')) {
      const archive = path.join(directory, 'release.tgz');
      await writeFile(archive, bytes, { mode: 0o600 });
      await exec('/usr/bin/tar', ['-xzf', archive, '-C', directory, 'cloudflared'], { timeout: 30_000 });
      await rm(archive);
    } else {
      await writeFile(`${binary}.tmp`, bytes, { mode: 0o700 });
      await rename(`${binary}.tmp`, binary);
    }
    await chmod(binary, 0o700);
    await writeFile(path.join(directory, 'verified.json'), JSON.stringify({ assetHash: asset[1], binaryHash: hash(await readFile(binary)) }), { mode: 0o600 });
    return binary;
  }
  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve(this.status());
    this.starting = this.launch(++this.generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch(generation) {
    try {
      if (!this.server.status().running) throw new Error('Enable remote access first');
      if (this.server.tls) throw new Error('Use your configured HTTPS endpoint with direct TLS access');
      const binary = await this.binary();
      if (generation !== this.generation || !this.server.status().running) throw new Error('Tunnel startup was cancelled');
      this.set({ state: 'starting', url: null });
      const config = path.join(this.directory, 'quick-tunnel.yml');
      await writeFile(config, '{}\n', { mode: 0o600 });
      if (generation !== this.generation || !this.server.status().running) throw new Error('Tunnel startup was cancelled');
      const child = this.spawnProcess(binary, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://${this.server.state.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.server.status().port}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      this.child = child;
      this.previousUrl = this.server.state.publicUrl;
      await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('The tunnel did not become ready. Check connectivity and retry.')), 60_000);
        const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        child.once('error', finish);
        child.once('exit', () => {
          if (this.child !== child) { finish(new Error('Tunnel startup was cancelled')); return; }
          this.child = null;
          this.restoreEndpoint();
          this.set({ state: 'error', url: null, error: 'The tunnel stopped. Start it again to create a new address.' });
          finish(new Error('The tunnel stopped before connecting'));
        });
        child.stderr.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-6000);
          const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
          if (!url || this.child !== child || generation !== this.generation || this.state.state === 'ready') return;
          this.server.state.previousEndpoint = this.previousUrl || '';
          this.server.state.temporaryEndpoint = true;
          this.server.state.publicUrl = url;
          this.server.save();
          this.set({ state: 'ready', url });
          finish();
        });
      });
      return this.status();
    } catch (error) {
      if (generation !== this.generation) throw error;
      await this.stop();
      this.set({ state: 'error', url: null, error: error.message });
      throw error;
    }
  }
  restoreEndpoint() {
    this.server.state.publicUrl = this.previousUrl || '';
    delete this.server.state.temporaryEndpoint;
    delete this.server.state.previousEndpoint;
    this.server.save();
  }
  async stop() {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill();
      let timer;
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); timer.unref(); })]);
      clearTimeout(timer);
      this.restoreEndpoint();
    }
    this.set({ state: 'stopped', url: null });
    return this.status();
  }
}
