import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CompanionWindow } from '../../electron/voice/companion-window.mjs';
import { VoiceCompanionService, registerVoiceCompanionIpc } from '../../electron/voice/companion-service.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
app.setPath('userData', await mkdtemp(path.join(os.tmpdir(), 'pixice-voice-harness-')));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const evidence = { platform: process.platform, syntheticMicrophone: true, backend: 'fake, no account', checks: [] };
const context = { projectId: 'f53f8280-c934-4b8f-b812-57ef3daa89a8', threadId: 'native-voice-harness', accent: 'coral' };
let service, quitting = false;
const calls = [];
function check(name, value) { assert.ok(value, name); evidence.checks.push(name); }
async function waitFor(predicate, label) { const start = Date.now(); while (!await predicate()) { if (Date.now() - start > 12000) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 60)); } }
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void service.end().then(async () => {
    check('Quit stops backend and destroys media owner', !service.ownsMedia() && !service.presentation.window);
    evidence.calls = calls;
    await writeFile(path.join(directory, 'native-evidence.json'), JSON.stringify(evidence, null, 2));
    quitting = true; app.quit();
  }).catch(fail);
});
async function fail(error) { console.error(error); await writeFile(path.join(directory, 'native-error.txt'), error.stack ?? String(error)); quitting = true; app.exit(1); }
app.whenReady().then(async () => {
  const main = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await main.loadURL('data:text/html,<body style="background:%23202225;color:white;font:20px system-ui;padding:40px">Isolated Pixice window<br><small>Native Voice lifecycle harness. No live account.</small></body>'); main.show();
  const presentation = new CompanionWindow({ BrowserWindow, screen, mainWindow: main, load: (window) => window.loadURL(`${process.env.PIXICE_VOICE_HARNESS_URL ?? 'http://127.0.0.1:5188'}/work/voice-companion/harness.html`) });
  let session = null, failStop = false;
  service = new VoiceCompanionService({ presentation, call: async (op, payload) => {
    calls.push(op);
    if (op === 'voice.state') return { available: true, session };
    if (op === 'voice.start') { session = { id: 'fake-session', ...context }; setTimeout(() => service.handle({ type: 'VoiceEvent', payload: { ...session, method: 'thread/realtime/sdp', sdp: 'fake-answer' } }), 10); return session; }
    if (op === 'voice.stop') { assert.equal(payload.sessionId, session.id); if (failStop) { failStop = false; throw new Error('Synthetic offline cleanup'); } session = null; return { stopped: true }; }
  }, describeContext: async () => ({ projectName: 'Pixice', threadName: 'Voice companion' }), returnToMain: async (target) => { evidence.returnDestination = target; main.show(); main.focus(); } });
  registerVoiceCompanionIpc({ ipcMain, service, mainWindow: main });
  main.on('close', (event) => { if (!quitting) { event.preventDefault(); main.hide(); } });
  await service.open(context);
  await waitFor(() => service.state().phase === 'connected', 'connected');
  await waitFor(() => service.state().speakerLevel > 0, 'remote audio analysis');
  const owner = presentation.window, contents = owner.webContents;
  check('sandbox and isolated narrow preload', contents.getLastWebPreferences().sandbox && contents.getLastWebPreferences().contextIsolation && !contents.getLastWebPreferences().nodeIntegration);
  check('no full Pixice API or tokens in renderer', await contents.executeJavaScript('!window.pixice && Object.keys(window.pixiceVoiceCompanion).length === 10'));
  await new Promise(r => setTimeout(r, 300));
  await writeFile(path.join(directory, 'native-attached.png'), (await contents.capturePage()).toPNG());
  main.close();
  check('main close detaches and keeps visible active voice', service.state().detached && owner.isVisible() && service.state().phase === 'connected');
  await waitFor(() => contents.executeJavaScript('document.querySelector(".voice-companion-mode")?.textContent === "Floating"'), 'detached label');
  check('always-on-top companion', owner.isAlwaysOnTop());
  await writeFile(path.join(directory, 'native-detached.png'), (await contents.capturePage()).toPNG());
  await service.attach();
  check('reattach keeps same native window and webContents', !service.state().detached && presentation.window === owner && presentation.window.webContents === contents);
  service.detach(); await service.attach();
  const media = await contents.executeJavaScript('({ captures: __voiceHarness.captures, peers: __voiceHarness.peers, playback: __voiceHarness.playback, analysisContexts: __voiceHarness.analysisContexts, live: __voiceHarness.media.getAudioTracks()[0].readyState })');
  evidence.media = media;
  check('exactly one capture, peer, analysis owner across moves', media.captures === 1 && media.peers === 1 && media.analysisContexts === 1 && media.live === 'live');
  service.mute({ muted: true });
  await waitFor(() => contents.executeJavaScript('!__voiceHarness.media.getAudioTracks()[0].enabled'), 'mute');
  check('mute disables actual synthetic microphone track', service.state().muted && service.state().micLevel === 0);
  service.handle({ type: 'AttentionRequired', payload: { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: context.threadId } } });
  await service.returnToPixice(); check('approval Return requests actual approval destination', evidence.returnDestination.needsApproval === true);
  await new Promise(r => setTimeout(r, 180));
  await writeFile(path.join(directory, 'native-approval.png'), (await contents.capturePage()).toPNG());
  service.handle({ type: 'AttentionResolved', payload: { requestId: 'approval' } });
  owner.setPosition(100000, 100000); presentation.clampToDisplay();
  const bounds = owner.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  check('display bounds clamp to work area', bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
  await service.end(); check('explicit End destroys media owner and stops backend', owner.isDestroyed() && !session);
  await service.open(context); await waitFor(() => service.state().phase === 'connected', 'restarted');
  failStop = true;
  await service.end().catch(() => {});
  check('failed backend cleanup retains no media window', service.state().phase === 'cleanup-failed' && !presentation.window && session);
  await service.open(context);
  await waitFor(() => presentation.window.webContents.executeJavaScript('Boolean(window.__voiceHarness)'), 'recovery controls');
  await new Promise(r => setTimeout(r, 180));
  const recovery = await presentation.window.webContents.executeJavaScript('({captures: __voiceHarness.captures, peers: __voiceHarness.peers, retry: [...document.querySelectorAll("button")].some(button => button.textContent === "Retry End")})');
  check('recovery-only controls never reacquire mic or peer', recovery.captures === 0 && recovery.peers === 0 && recovery.retry);
  await writeFile(path.join(directory, 'native-cleanup-retry.png'), (await presentation.window.webContents.capturePage()).toPNG());
  await service.end(); check('explicit retry confirms backend cleanup', !session && service.state().phase === 'ended');
  await service.open(context); await waitFor(() => service.state().phase === 'connected', 'companion close fixture');
  const replacement = presentation.window; replacement.close(); await waitFor(() => service.state().phase === 'ended', 'companion close');
  check('companion close stops capture and backend', replacement.isDestroyed() && !session);
  await service.open(context); await waitFor(() => service.state().phase === 'connected', 'quit fixture');
  app.quit();
}).catch(fail);
