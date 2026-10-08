const { app } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const configuration = JSON.parse(readFileSync(path.join(__dirname, 'configuration.json'), 'utf8'));
app.setPath('userData', configuration.dataDirectory);
writeFileSync(configuration.progressPath, JSON.stringify({ phase: 'bootstrap', at: new Date().toISOString() }));
app.whenReady().then(() => import('./main.mjs')).catch((error) => {
  writeFileSync(configuration.resultPath, JSON.stringify({ ok: false, error: error.stack }));
  app.exit(1);
});
