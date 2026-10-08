#!/usr/bin/env node

// A disposable signed application uses the shipping updater and backup code.
// No production app, real user data, providers, or GitHub Release is modified.
import { build, Platform, Arch } from 'electron-builder';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyMacAppSignature } from './macos-signing.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('electron-updater'))('js-yaml');

export function smokeConfig({ fixture, output, version, feedUrl, electronVersion }) {
  return {
    appId: 'com.blumenwagen.pixice.update-smoke', productName: 'Pixice Update Smoke',
    electronVersion, asar: true, npmRebuild: false, forceCodeSigning: true,
    directories: { app: fixture, output },
    artifactName: 'Pixice-Update-Smoke-${version}-${arch}.${ext}',
    extraMetadata: { version, main: 'scripts/fixtures/macos-update/bootstrap.cjs' },
    files: ['scripts/fixtures/macos-update/**', 'electron/updater/**', 'electron/persistence/update-data-backup.mjs', 'package.json'],
    publish: [{ provider: 'generic', url: feedUrl }],
    mac: { target: ['zip'], hardenedRuntime: true, notarize: false, entitlements: path.join(root, 'build/entitlements.mac.plist'), entitlementsInherit: path.join(root, 'build/entitlements.mac.plist') }
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The signed updater smoke test requires macOS.');
  const packageOnly = process.argv.includes('--package-only');
  if (!packageOnly && !process.env.CSC_LINK && !process.env.CSC_NAME) throw new Error('The signed updater smoke test requires CSC_LINK or CSC_NAME. Ad-hoc signing cannot validate automatic updates.');
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixice-signed-update-')));
  const fixture = path.join(temporary, 'fixture');
  const output = path.join(temporary, 'candidate');
  const installed = path.join(temporary, 'installed', 'Pixice Update Smoke.app');
  const resultPath = path.join(temporary, 'result.json');
  const progressPath = path.join(temporary, 'progress.json');
  const dataDirectory = path.join(temporary, 'data');
  const appName = 'Pixice Update Smoke.app';
  const server = createServer(async (request, response) => {
    const filename = path.basename(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = path.join(output, filename);
    try {
      const details = await stat(file);
      if (!details.isFile()) throw new Error('Not an update artifact');
      response.writeHead(200, { 'Content-Length': details.size, 'Content-Type': filename.endsWith('.zip') ? 'application/zip' : 'text/yaml' });
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  });
  let child;
  let passed = false;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const feedUrl = `http://127.0.0.1:${server.address().port}`;
    await mkdir(dataDirectory, { recursive: true });
    await mkdir(path.join(fixture, 'scripts/fixtures/macos-update'), { recursive: true });
    await mkdir(path.join(fixture, 'electron/persistence'), { recursive: true });
    await cp(path.join(root, 'electron/updater'), path.join(fixture, 'electron/updater'), { recursive: true });
    await cp(path.join(root, 'electron/persistence/update-data-backup.mjs'), path.join(fixture, 'electron/persistence/update-data-backup.mjs'));
    await cp(path.join(root, 'scripts/fixtures/macos-update/main.mjs'), path.join(fixture, 'scripts/fixtures/macos-update/main.mjs'));
    await cp(path.join(root, 'scripts/fixtures/macos-update/bootstrap.cjs'), path.join(fixture, 'scripts/fixtures/macos-update/bootstrap.cjs'));
    await writeFile(path.join(fixture, 'scripts/fixtures/macos-update/configuration.json'), JSON.stringify({ dataDirectory, resultPath, progressPath, feedUrl }));
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const dependencies = { 'electron-updater': packageJson.dependencies['electron-updater'], ms: packageJson.dependencies.ms };
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'pixice-update-smoke', version: '0.0.1', type: 'module', description: 'Disposable Pixice updater verification', author: packageJson.author, dependencies }));
    // Retain the pinned dependency snapshots while limiting the fixture's
    // importer to updater dependencies. ms also has to be explicit, as in
    // Pixice, because electron-builder 26 loses a deduplicated debug dependency.
    const lock = yaml.load(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
    lock.importers = { '.': { dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, lock.importers['.'].dependencies[name]])) } };
    await writeFile(path.join(fixture, 'pnpm-lock.yaml'), yaml.dump(lock));
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    const baseline = path.join(temporary, 'baseline');
    const versions = packageOnly ? [['0.0.1', baseline]] : [['0.0.1', baseline], ['0.0.2', output]];
    for (const [version, destination] of versions) {
      const config = smokeConfig({ fixture, output: destination, version, feedUrl, electronVersion: packageJson.devDependencies.electron });
      if (packageOnly) { config.forceCodeSigning = false; config.mac.identity = null; }
      // Use the fixture project so Pixice's packaging hooks and dependencies
      // cannot accidentally replace this test application's configuration.
      await build({ projectDir: fixture, targets: Platform.MAC.createTarget(packageOnly ? ['dir'] : ['zip'], process.arch === 'arm64' ? Arch.arm64 : Arch.x64), publish: 'never', config });
      const bundle = path.join(destination, process.arch === 'arm64' ? 'mac-arm64' : 'mac', appName);
      if (packageOnly) await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', path.join(root, 'build/entitlements.mac.plist'), bundle]);
      await verifyMacAppSignature(bundle, { expectedAppId: 'com.blumenwagen.pixice.update-smoke', requireTeamIdentifier: !packageOnly });
      if (version === '0.0.1') {
        await mkdir(path.dirname(installed), { recursive: true });
        await run('/usr/bin/ditto', [bundle, installed]);
      }
    }
    child = spawn(path.join(installed, 'Contents/MacOS/Pixice Update Smoke'), [], { stdio: 'inherit' });
    let launchError;
    child.once('error', (error) => { launchError = error; });
    const deadline = Date.now() + (packageOnly ? 30_000 : 180_000);
    let result;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try { result = JSON.parse(await readFile(resultPath, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (packageOnly) {
      if (!result?.error?.includes('ad-hoc signature')) throw new Error(`The packaged fixture did not reject ad-hoc installation: ${result?.error || 'timed out'}. Last phase: ${await readFile(progressPath, 'utf8').catch(() => 'not loaded')}. Evidence: ${temporary}`);
      passed = true;
      console.log('Verified packaged updater dependencies, launch, and rejection of an ad-hoc copy. Signed upgrade verification still requires a signing identity.');
      return;
    }
    if (!result?.ok || result.version !== '0.0.2' || !result.dataPreserved) throw new Error(`Signed update did not replace and relaunch the app: ${result?.error || 'timed out'}. Evidence: ${temporary}`);
    const { stdout: installedVersion } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(installed, 'Contents/Info.plist')]);
    if (installedVersion.trim() !== '0.0.2') throw new Error('The app reported an update without replacing the installed bundle.');
    await verifyMacAppSignature(installed, { expectedAppId: 'com.blumenwagen.pixice.update-smoke' });
    passed = true;
    console.log('Verified signed macOS ZIP download, native handoff, bundle replacement, single-instance relaunch, running version, and preserved WAL database.');
  } finally {
    child?.kill('SIGTERM');
    const { stdout = '' } = await run('/bin/ps', ['-ax', '-o', 'pid=,command=']).catch(() => ({}));
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match?.[2] === path.join(installed, 'Contents/MacOS/Pixice Update Smoke')) { try { process.kill(Number(match[1]), 'SIGTERM'); } catch {} }
    }
    await new Promise((resolve) => server.close(resolve));
    // Keep failed-run evidence for CI logs and local investigation.
    if (passed) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
