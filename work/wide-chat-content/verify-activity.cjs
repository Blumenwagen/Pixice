const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.setPath('userData', '/tmp/pixice-wide-chat-activity');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1920, height: 1200, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL('http://127.0.0.1:5183/work/wide-chat-content/preview.html?mode=focus');
    for (let i = 0; i < 100; i++) {
      if (await window.webContents.executeJavaScript("Boolean(document.querySelector('.message-table-wrap') && document.querySelector('.focus-coordination'))")) break;
      await wait(50);
    }
    await window.webContents.executeJavaScript('document.fonts.ready');
    await wait(300);
    await window.webContents.executeJavaScript("document.querySelector('.focus-conversation-scroll').scrollTop = 220");
    const measure = async () => window.webContents.executeJavaScript(`(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, height: r.height }; };
      const panel = document.querySelector('.focus-coordination');
      const table = document.querySelector('.message-table-wrap');
      const canvas = document.querySelector('.focus-conversation-scroll');
      const t = table.getBoundingClientRect();
      return {
        open: panel.dataset.open === 'true', activity: rect(panel), prose: rect(document.querySelector('.assistant-message .markdown-body > p')),
        composer: rect(document.querySelector('.composer')), rich: [...document.querySelectorAll('.message-rich-block')].map(rect),
        edgesVisible: [t.left + 4, t.right - 4].map(x => Boolean(document.elementFromPoint(x, t.top + 40)?.closest('.message-table-wrap'))),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        canvasOverflow: canvas.scrollWidth - canvas.clientWidth
      };
    })()`);
    const rows = [];
    for (const state of ['closed', 'open', 'closed-again']) {
      if (state === 'open') await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Open activity panel\"]').click()");
      if (state === 'closed-again') await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Close activity panel\"]').click()");
      await wait(250);
      const row = { state, ...await measure() };
      if (row.pageOverflow || row.canvasOverflow || row.edgesVisible.some(value => !value)) throw new Error('Overflow or clipped rich edge: ' + state);
      if (row.open && row.rich.some(r => r.right > row.activity.x - 11)) throw new Error('Activity covers rich content');
      if (rows.length) for (const key of ['prose', 'composer']) for (const axis of ['x', 'width']) {
        if (Math.abs(row[key][axis] - rows[0][key][axis]) > .5) throw new Error('Moved ' + key + '.' + axis);
      }
      rows.push(row);
      if (state !== 'closed-again') fs.writeFileSync(`${__dirname}/activity-${state}.png`, (await window.webContents.capturePage()).toPNG());
    }
    if (rows[1].rich[0].width >= rows[0].rich[0].width || rows[2].rich[0].width !== rows[0].rich[0].width) throw new Error('Activity clearance did not shrink and restore');
    // A toggle without transitions checks the mutation path independently of transitionend.
    await window.webContents.executeJavaScript("document.querySelector('.focus-coordination').style.transition = 'none'");
    for (const state of ['open', 'closed']) {
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label="${state === 'open' ? 'Open' : 'Close'} activity panel"]').click()`);
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const row = { state: 'no-transition-' + state, ...await measure() };
      const expected = state === 'open' ? rows[1] : rows[0];
      if (row.rich[0].width !== expected.rich[0].width) throw new Error('data-open mutation did not update bounds');
      rows.push(row);
    }
    fs.writeFileSync(`${__dirname}/activity-measurements.json`, JSON.stringify(rows, null, 2) + '\n');
    console.log(JSON.stringify(rows.map(r => ({ state: r.state, richWidth: r.rich[0].width, richRight: r.rich[0].right, activityLeft: r.activity.x, prose: {x:r.prose.x,width:r.prose.width}, composer: {x:r.composer.x,width:r.composer.width}, edgesVisible:r.edgesVisible, pageOverflow:r.pageOverflow,canvasOverflow:r.canvasOverflow })), null, 2));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
