// Isolated renderer for visual evidence. Does not connect to Pixice's runtime.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const reference = process.argv.includes('--reference');
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [], warnings = [];
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); if (details.level === 'warning') warnings.push(details.message); });
  await win.loadURL(reference ? 'https://voiceuikit.pipecat.ai/visualizers/plasma-visualizer' : 'http://127.0.0.1:5193/work/voice-orb/');
  await new Promise(resolve => setTimeout(resolve, 1800));
  if (reference) {
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Show Example')?.click();`);
    await new Promise(resolve => setTimeout(resolve, 2500));
    await win.webContents.executeJavaScript(`document.querySelector('canvas')?.scrollIntoView({block:'center'});`);
  }
  win.webContents.debugger.attach('1.3');
  const capture = async name => {
    const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(data, 'base64'));
  };
  await capture(reference ? 'reference' : 'desktop');
  if (!reference) {
    const report = await win.webContents.executeJavaScript(`window.orbCheck()`);
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="accent"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 400));
    await capture('alternate-accent');
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="theme"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await capture('light');
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="theme"]').click()`);
    win.setContentSize(390, 844);
    await new Promise(resolve => setTimeout(resolve, 300));
    await capture('mobile');
    await win.webContents.executeJavaScript(`window.scrollTo(0, document.body.scrollHeight)`);
    await capture('mobile-phases');
    await win.webContents.executeJavaScript(`window.scrollTo(0, 0)`);
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="motion"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await capture('reduced-motion');
    const mobile = await win.webContents.executeJavaScript(`window.orbCheck()`);
    await win.webContents.executeJavaScript(`window.orbLost = Array.from(document.querySelectorAll('.voice-orb canvas:first-child'), c => c.getContext('webgl')?.getExtension('WEBGL_lose_context')); window.orbLost.forEach(e => e?.loseContext());`);
    await new Promise(resolve => setTimeout(resolve, 400));
    await capture('context-loss');
    const lost = await win.webContents.executeJavaScript(`window.orbCheck()`);
    await win.webContents.executeJavaScript(`window.orbLost.forEach(e => e?.restoreContext())`);
    await new Promise(resolve => setTimeout(resolve, 400));
    const restored = await win.webContents.executeJavaScript(`window.orbCheck()`);
    fs.writeFileSync(path.join(__dirname, 'browser-check.json'), JSON.stringify({ desktop: report, mobile, contextLoss: lost, contextRestored: restored, errors, warnings }, null, 2));
  }
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
