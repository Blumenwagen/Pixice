import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = path.resolve(process.env.LOOM_CAPTURE_PATH || "artifacts/workflow-preview.png");
const previewUrl = process.env.LOOM_PREVIEW_URL || "http://127.0.0.1:5173/?workflow-preview";

function deadline(promise, label, timeoutMs = 12_000) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    })
  ]);
}

if (process.env.CI) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
}

console.log("workflow-capture: waiting for Electron");
await deadline(app.whenReady(), "Electron readiness");
console.log("workflow-capture: Electron ready");

const window = new BrowserWindow({
  width: Number(process.env.LOOM_CAPTURE_WIDTH || 1440),
  height: Number(process.env.LOOM_CAPTURE_HEIGHT || 960),
  show: Boolean(process.env.CI),
  backgroundColor: "#151515",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false
  }
});

let exitCode = 0;
try {
  console.log(`workflow-capture: loading ${previewUrl}`);
  await deadline(window.loadURL(previewUrl), "Preview page load", 15_000);
  console.log("workflow-capture: page loaded");

  await deadline(window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let clicked = false;
      const open = () => {
        const button = document.querySelector('[aria-label="Workflows"]');
        if (button && !clicked) {
          clicked = true;
          button.click();
        }
        if (document.querySelector('[data-workflow-workspace="true"]')) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > 7000) {
          reject(new Error('The Workflows workspace did not mount'));
          return;
        }
        setTimeout(open, 50);
      };
      open();
    });
  `), "Workflows workspace mount", 10_000);
  console.log("workflow-capture: Workflows mounted");

  await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log("workflow-capture: capturing page");
  const image = await deadline(window.webContents.capturePage(), "Electron capturePage", 10_000);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, image.toPNG());
  console.log(`workflow-capture: wrote ${outputPath}`);
} catch (error) {
  exitCode = 1;
  console.error("workflow-capture: failed", error);
} finally {
  if (!window.isDestroyed()) window.destroy();
  console.log(`workflow-capture: exiting ${exitCode}`);
  app.exit(exitCode);
}
