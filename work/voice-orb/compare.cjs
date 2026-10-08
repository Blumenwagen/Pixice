const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const source = nativeImage.createFromPath(path.join(__dirname, 'reference.png'));
  const result = nativeImage.createFromPath(path.join(__dirname, 'desktop.png'));
  const light = nativeImage.createFromPath(path.join(__dirname, 'light.png'));
  console.log(JSON.stringify({ source: source.getSize(), result: result.getSize() }));
  const sourceCrop = source.crop({ x: 1080, y: 610, width: 580, height: 580 }).resize({ width: 420, height: 420 });
  const resultCrop = result.crop({ x: 780, y: 435, width: 640, height: 640 }).resize({ width: 420, height: 420 });
  const lightCrop = light.crop({ x: 780, y: 435, width: 640, height: 640 }).resize({ width: 420, height: 420 });
  const win = new BrowserWindow({ width: 1280, height: 520, show: false, webPreferences: { backgroundThrottling: false } });
  const html = `<body style="margin:0;background:#202023;color:#ddd;font:14px system-ui"><div style="display:flex">${[[sourceCrop,'Pipecat reference'],[resultCrop,'Pixice coral / dark'],[lightCrop,'Pixice blue / light']].map(([im,label]) => `<div style="width:420px;text-align:center"><p>${label}</p><img width="420" height="420" src="${im.toDataURL()}"></div>`).join('')}</div></body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.debugger.attach('1.3');
  const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'comparison.png'), Buffer.from(data, 'base64'));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
