import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = path.resolve(process.env.LOOM_CAPTURE_PATH || "artifacts/workflow-preview.png");
const previewUrl = process.env.LOOM_PREVIEW_URL || "http://127.0.0.1:5173/?workflow-preview";

if (process.env.CI) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
}

await app.whenReady();
const window = new BrowserWindow({
  width: Number(process.env.LOOM_CAPTURE_WIDTH || 1440),
  height: Number(process.env.LOOM_CAPTURE_HEIGHT || 960),
  show: false,
  backgroundColor: "#151515",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
});

let exitCode = 0;
try {
  await window.loadURL(previewUrl);
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const open = () => {
        const button = document.querySelector('[aria-label="Workflows"]');
        if (button) {
          button.click();
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error('The Workflows navigation item did not mount'));
          return;
        }
        setTimeout(open, 50);
      };
      open();
    });
  `);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const image = await window.webContents.capturePage();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, image.toPNG());
  console.log(`Workflow preview written to ${outputPath}`);
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  window.destroy();
  app.exit(exitCode);
}
