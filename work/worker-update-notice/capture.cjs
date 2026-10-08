const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = __dirname;
app.setPath('userData', '/tmp/pixice-worker-update-notice-capture-data');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1320, height: 860, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL('http://127.0.0.1:5183/work/worker-update-notice/preview.html');
    for (let i = 0; i < 100; i++) {
      if (await window.webContents.executeJavaScript("Boolean(document.querySelector('.focus-update-notice'))")) break;
      await wait(100);
    }
    await window.webContents.executeJavaScript('document.fonts.ready');
    await wait(600);
    const evidence = await window.webContents.executeJavaScript(`(() => {
      const measure = selector => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Missing ' + selector);
        const c = getComputedStyle(el), r = el.getBoundingClientRect();
        return { text: el.textContent, role: el.getAttribute('role'), fontFamily: c.fontFamily, fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight, color: c.color, margin: c.margin, bounds: {x:r.x,y:r.y,width:r.width,height:r.height} };
      };
      return { fixture: 'Real App, synthetic completed Focus turn and persisted worker lifecycle message', viewport: {width:innerWidth,height:innerHeight}, notice: measure('.focus-update-notice'), thought: measure('.trace-toggle-label'), ordinaryText: measure('.assistant-message'), timestamp: measure('.message-timestamp') };
    })()`);
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error('Empty capture');
    fs.writeFileSync(path.join(out, 'focus-notice.png'), image.toPNG());
    fs.writeFileSync(path.join(out, 'typography.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
