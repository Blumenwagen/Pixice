import { app, autoUpdater as nativeUpdater, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PixiceAppUpdater } from '../../../electron/updater/app-updater.mjs';
import { assertMacUpdateEligible } from '../../../electron/updater/macos-update.mjs';
import { UpdateJournal } from '../../../electron/updater/update-journal.mjs';
import { createUpdateDataBackup } from '../../../electron/persistence/update-data-backup.mjs';

const configuration = JSON.parse(readFileSync(new URL('./configuration.json', import.meta.url), 'utf8'));
app.setPath('userData', configuration.dataDirectory);
let quitting = false;
const report = (result) => writeFileSync(configuration.resultPath, JSON.stringify(result));
const progress = (phase) => writeFileSync(configuration.progressPath, JSON.stringify({ phase, ready: app.isReady(), at: new Date().toISOString() }));
progress('loaded');
app.on('before-quit', (event) => { if (!quitting) event.preventDefault(); });
if (!app.requestSingleInstanceLock()) app.exit(2);

app.whenReady().then(async () => {
  progress('ready');
  const window = new BrowserWindow({ show: false });
  progress('window-created');
  window.on('close', (event) => { if (!quitting) event.preventDefault(); });
  const journal = new UpdateJournal(path.join(configuration.dataDirectory, 'updates'));
  const updater = new PixiceAppUpdater({
    updater: electronUpdater.autoUpdater, nativeUpdater, app, journal,
    assertInstallable: () => assertMacUpdateEligible(process.execPath),
    prepareInstall: ({ currentVersion, availableVersion }) => createUpdateDataBackup({ userDataPath: configuration.dataDirectory, currentVersion, targetVersion: availableVersion }),
    beforeQuit: () => { quitting = true; }, recoverInstall: () => { quitting = false; }
  });
  electronUpdater.autoUpdater.setFeedURL({ provider: 'generic', url: configuration.feedUrl });
  await updater.start();
  progress('eligibility-checked');
  if (!updater.snapshot().supported) throw new Error(updater.snapshot().message);
  const databasePath = path.join(configuration.dataDirectory, 'pixice.sqlite');
  if (app.getVersion() === '0.0.2') {
    const database = new DatabaseSync(databasePath);
    const preserved = database.prepare('SELECT value FROM records').get()?.value === 'project-and-thread-survive';
    database.close();
    const receipt = JSON.parse(readFileSync(path.join(configuration.dataDirectory, 'updates/installation.json'), 'utf8'));
    if (!preserved || receipt.state !== 'installed') throw new Error('The update did not preserve data or confirm the running version.');
    report({ ok: true, version: app.getVersion(), dataPreserved: preserved, receipt });
    quitting = true; app.quit(); return;
  }
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT NOT NULL)');
  database.prepare('INSERT INTO records(value) VALUES (?)').run('project-and-thread-survive');
  // Keep the live WAL database open during backup, as in the real backend.
  await updater.check();
  if (updater.snapshot().state !== 'available') throw new Error(updater.snapshot().message);
  await updater.download(); await updater.install();
}).catch((error) => { report({ ok: false, error: error.stack }); app.exit(1); });
