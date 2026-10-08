import { app, BrowserWindow, screen } from 'electron';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CompanionWindow } from '../../electron/voice/companion-window.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
app.setPath('userData', await mkdtemp(path.join(os.tmpdir(), 'pixice-compact-voice-')));
app.on('window-all-closed', () => {});
const result = { fixture: 'presentation-only; no microphone, transport or account', platform: process.platform, checks: [], layouts: {} };
const pause = () => new Promise(resolve => setTimeout(resolve, 170));
app.whenReady().then(async () => {
  const main = new BrowserWindow({ width: 1000, height: 700, show: false });
  const presentation = new CompanionWindow({ BrowserWindow, screen, mainWindow: main,
    load: (window) => window.loadURL('http://127.0.0.1:5188/work/voice-companion/compact-preview.html') });
  await presentation.open(); presentation.detach();
  const window = presentation.window, contents = window.webContents;
  await pause();
  const update = async (patch) => { await contents.executeJavaScript(`__compactPreview.update(${JSON.stringify(patch)})`); await pause(); };
  const inspect = async (name) => {
    const layout = await contents.executeJavaScript(`(() => {
      const main = document.querySelector('.voice-companion');
      const buttons = [...document.querySelectorAll('button:not([disabled])')];
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
      return { width:innerWidth,height:innerHeight,background:getComputedStyle(main).backgroundColor,
        overflow:document.documentElement.scrollWidth>innerWidth || document.documentElement.scrollHeight>innerHeight,
        controlsOpacity:getComputedStyle(document.querySelector('.voice-companion-controls')).opacity,
        dragRegion:getComputedStyle(document.querySelector('.voice-companion-orb')).webkitAppRegion,
        buttons:buttons.map(el=>({label:el.getAttribute('aria-label')||el.textContent,...rect(el),region:getComputedStyle(el).webkitAppRegion})) };
    })()`);
    assert.equal(layout.width,224); assert.equal(layout.height,240); assert.equal(layout.background,'rgba(0, 0, 0, 0)'); assert.equal(layout.overflow,false);
    for (const b of layout.buttons) { assert.ok(b.x>=0 && b.y>=0 && b.x+b.width<=224 && b.y+b.height<=240, `${name}: ${b.label} clipped`); assert.equal(b.region,'no-drag'); }
    assert.equal(layout.dragRegion,'drag'); result.layouts[name]=layout;
    await writeFile(path.join(directory,name), (await contents.capturePage()).toPNG());
  };
  await update({phase:'connected',speakerLevel:0.18});
  await inspect('native-detached.png');
  // A real Tab key reaches controls even while their visual chrome is hidden.
  contents.sendInputEvent({type:'keyDown',keyCode:'Tab'}); contents.sendInputEvent({type:'keyUp',keyCode:'Tab'}); await pause();
  const focus=await contents.executeJavaScript('document.activeElement.getAttribute("aria-label")'); assert.equal(focus,'Mute microphone');
  await inspect('native-compact-controls.png'); assert.equal(result.layouts['native-compact-controls.png'].controlsOpacity,'1');
  const tabLabels=[focus];
  for(let i=0;i<3;i++){ contents.sendInputEvent({type:'keyDown',keyCode:'Tab'}); contents.sendInputEvent({type:'keyUp',keyCode:'Tab'}); await pause(); tabLabels.push(await contents.executeJavaScript('document.activeElement.getAttribute("aria-label")')); }
  assert.deepEqual(tabLabels,['Mute microphone','End Voice conversation','Return to pinned conversation in Pixice','Attach to Pixice']); result.tabOrder=tabLabels;
  await contents.executeJavaScript('document.activeElement.blur()');
  await update({detached:false,speakerLevel:0,micLevel:0.08}); await inspect('native-attached.png');
  await update({detached:true,muted:true,needsApproval:true,micLevel:0}); await inspect('native-approval.png');
  await update({phase:'playback-blocked',muted:false,needsApproval:false,speakerLevel:0,error:'Audio is still blocked. Enable audio to retry.'}); await inspect('native-playback-recovery.png');
  await update({phase:'cleanup-failed',muted:false,needsApproval:false,speakerLevel:0,error:'Microphone stopped. Codex cleanup needs retry: Connection offline.'}); await inspect('native-cleanup-retry.png');
  assert.equal(result.layouts['native-cleanup-retry.png'].controlsOpacity,'1');
  result.bounds=window.getBounds(); result.checks=['224 × 240 native window','transparent root','all mini controls fit','native drag and click areas distinct','Tab reveals controls and reaches all actions','muted/approval/recovery status visible'];
  await writeFile(path.join(directory,'compact-native-evidence.json'),JSON.stringify(result,null,2));
  presentation.dispose(); main.destroy(); app.exit(0);
}).catch(async error=>{ console.error(error); await writeFile(path.join(directory,'compact-native-error.txt'),error.stack); app.exit(1); });
