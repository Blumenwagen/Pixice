import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const auditDir = dirname(fileURLToPath(import.meta.url));
const previewUrl = "http://127.0.0.1:5173/?task-progress-preview";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function capture(window, filename) {
  const image = await window.webContents.capturePage();
  const outputPath = join(auditDir, filename);
  await writeFile(outputPath, image.toPNG());
  return outputPath;
}

async function snapshot(window, label) {
  return window.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const describe = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        text: element.innerText?.trim() || "",
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        outline: style.outline,
        outlineOffset: style.outlineOffset,
        boxShadow: style.boxShadow,
      };
    };
    const buttons = [...document.querySelectorAll("button")].filter(visible).map(describe);
    const previewClose = buttons.find((button) => button.ariaLabel === "Close preview workspace" || button.text === "Close preview workspace");
    const sidebarToggle = buttons.find((button) => ["Expand navigation labels", "Collapse navigation labels"].includes(button.ariaLabel || button.text));
    const clippedControls = buttons.filter((button) => {
      const { x, y, width, height } = button.rect;
      return x < 0 || y < 0 || x + width > innerWidth || y + height > innerHeight;
    });
    return {
      label: ${JSON.stringify(label)},
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: { scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight },
      activeElement: describe(document.activeElement),
      sidebarToggle,
      previewClose,
      visibleButtonCount: buttons.length,
      clippedControls,
    };
  })()`);
}

async function findButton(window, names) {
  return window.webContents.executeJavaScript(`(() => {
    const names = ${JSON.stringify(names)};
    const buttons = [...document.querySelectorAll("button")];
    const button = buttons.find((candidate) => {
      const label = candidate.getAttribute("aria-label") || candidate.innerText?.trim() || candidate.getAttribute("title") || "";
      return names.includes(label);
    });
    if (!button) return null;
    return { label: button.getAttribute("aria-label") || button.innerText?.trim() || button.getAttribute("title") || "" };
  })()`);
}

async function clickButton(window, names) {
  const target = await findButton(window, names);
  if (!target) throw new Error(`Button not found: ${names.join(", ")}`);
  await window.webContents.executeJavaScript(`(() => {
    const names = ${JSON.stringify(names)};
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      const label = candidate.getAttribute("aria-label") || candidate.innerText?.trim() || candidate.getAttribute("title") || "";
      return names.includes(label);
    });
    button.click();
  })()`);
  await wait(450);
}

app.commandLine.appendSwitch("disable-gpu");
await app.whenReady();
await mkdir(auditDir, { recursive: true });

const window = new BrowserWindow({
  width: 1440,
  height: 900,
  show: false,
  backgroundColor: "#ffffff",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
  },
});

try {
  await window.loadURL(previewUrl);
  await wait(800);

  await clickButton(window, ["Open preview workspace"]);
  const collapsed = await snapshot(window, "preview open, sidebar collapsed");
  collapsed.screenshot = await capture(window, "01-preview-open-sidebar-collapsed.png");

  await clickButton(window, ["Expand navigation labels"]);
  const expanded = await snapshot(window, "preview open, sidebar expanded");
  expanded.screenshot = await capture(window, "02-preview-open-sidebar-expanded.png");

  await window.webContents.executeJavaScript(`document.body.focus()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "TAB" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "TAB" });
  await wait(200);
  const focused = await snapshot(window, "preview open, sidebar toggle keyboard focused");
  focused.screenshot = await capture(window, "03-sidebar-toggle-keyboard-focus.png");

  await clickButton(window, ["Collapse navigation labels"]);
  const collapsedAgain = await snapshot(window, "preview open, sidebar collapsed again");
  collapsedAgain.screenshot = await capture(window, "04-preview-open-sidebar-collapsed-again.png");

  await writeFile(join(auditDir, "evidence.json"), JSON.stringify({ previewUrl, states: [collapsed, expanded, focused, collapsedAgain] }, null, 2));
  process.stdout.write(JSON.stringify({ auditDir, states: [collapsed, expanded, focused, collapsedAgain] }, null, 2));
} finally {
  window.destroy();
  app.quit();
}
