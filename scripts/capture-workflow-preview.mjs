import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = path.resolve(process.env.LOOM_CAPTURE_PATH || "artifacts/workflow-preview.png");
const previewUrl = process.env.LOOM_PREVIEW_URL || "http://127.0.0.1:5173/?workflow-preview";

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
} finally {
  window.destroy();
  app.quit();
}
