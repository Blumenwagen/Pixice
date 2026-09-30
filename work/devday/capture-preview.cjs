// Render only the local development fixture in a separate, hidden Electron test window.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData', path.join('/tmp', 'pixice-devday-ui-capture'));
const target = 'http://127.0.0.1:5175/?focus-v2-preview&devday-preview';
const output = path.resolve(__dirname);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(win, expression) {
  for (let n = 0; n < 60; n++) { if (await win.webContents.executeJavaScript(expression)) return; await wait(100); }
  throw new Error(`Preview did not reach expected state: ${expression}`);
}
async function click(win, text) {
  await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(text)} || e.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('Button not found'); b.click(); })()`);
}
async function shot(win, name) { await wait(600); const picture = await win.webContents.capturePage(); if (picture.isEmpty()) throw new Error('Empty capture'); writeFileSync(path.join(output, name), picture.toPNG()); }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1020, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    mkdirSync(output, { recursive: true });
    await win.loadURL(target);
    await ready(win, `Boolean(document.querySelector('.focus-composer-wrap textarea'))`);
    await shot(win, 'focus-voice-entry.png');
    const geometry = `(() => { const selectors=['.focus-conversation-scroll','.focus-composer-wrap','.focus-composer-wrap textarea']; return Object.fromEntries(selectors.map((s)=> { const r=document.querySelector(s).getBoundingClientRect();return [s,{x:r.x,y:r.y,width:r.width,height:r.height}]; })); })()`;
    const before = await win.webContents.executeJavaScript(geometry);
    await click(win, 'Conversational Voice'); await ready(win, `Boolean(document.querySelector('.voice-conversation-dialog'))`);
    await shot(win, 'focus-voice-dialog.png');
    const after = await win.webContents.executeJavaScript(geometry);
    writeFileSync(path.join(output, 'focus-geometry.json'), JSON.stringify({ before, after, unchanged: JSON.stringify(before) === JSON.stringify(after), viewport: { width: 1440, height: 1020 }, fixture: true }, null, 2));
    await click(win, 'Close Voice'); await click(win, 'Settings');
    await ready(win, `Boolean(document.querySelector('.settings-sidebar'))`);
    await win.webContents.executeJavaScript(`document.querySelector('.settings-sidebar button[aria-current="page"]')`);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-sidebar nav button')[4].click()`);
    await ready(win, `Boolean(document.querySelector('[aria-label="ChatGPT app sign-in"]'))`);
    await shot(win, 'chatgpt-settings.png');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-sidebar nav button')[5].click()`);
    await ready(win, `Boolean(document.querySelector('[aria-label="Cloud environments"]'))`);
    await shot(win, 'cloud-settings.png');
    console.log(JSON.stringify({ output, geometryUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
  } finally { win.destroy(); app.quit(); }
}).catch((error) => { console.error(error.message); app.exit(1); });
