const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");

const auditDir = __dirname;
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

async function clickButton(window, names) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const names = ${JSON.stringify(names)};
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      const label = candidate.getAttribute("aria-label") || candidate.innerText?.trim() || candidate.getAttribute("title") || "";
      return names.includes(label);
    });
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Button not found: ${names.join(", ")}`);
  await wait(500);
}

async function run() {
  process.stdout.write("loading preview\n");
  await mkdir(auditDir, { recursive: true });
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await window.loadURL(previewUrl);
    await wait(1000);

    process.stdout.write("opening preview workspace\n");
    await clickButton(window, ["Open preview workspace"]);
    const collapsed = await snapshot(window, "preview open, sidebar collapsed");
    collapsed.screenshot = await capture(window, "01-preview-open-sidebar-collapsed.png");

    process.stdout.write("expanding sidebar\n");
    await clickButton(window, ["Expand navigation labels"]);
    const expanded = await snapshot(window, "preview open, sidebar expanded");
    expanded.screenshot = await capture(window, "02-preview-open-sidebar-expanded.png");

    process.stdout.write("checking keyboard focus\n");
    await window.webContents.executeJavaScript(`document.body.focus()`);
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await wait(250);
    const focused = await snapshot(window, "preview open, first control keyboard focused");
    focused.screenshot = await capture(window, "03-first-control-keyboard-focus.png");

    process.stdout.write("activating sidebar toggle from keyboard\n");
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await wait(500);
    const afterEnter = await snapshot(window, "after Enter activation");
    if (afterEnter.sidebarToggle?.ariaLabel === "Collapse navigation labels") {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
      window.webContents.sendInputEvent({ type: "char", keyCode: " " });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
      await wait(500);
    }
    const collapsedAgain = await snapshot(window, "preview open, sidebar collapsed by keyboard activation");
    collapsedAgain.screenshot = await capture(window, "04-sidebar-collapsed-by-keyboard.png");

    process.stdout.write("checking narrow reflow\n");
    window.setContentSize(1024, 736);
    await wait(500);
    const narrowCollapsed = await snapshot(window, "narrow viewport, preview open, sidebar collapsed");
    narrowCollapsed.screenshot = await capture(window, "05-narrow-preview-open-sidebar-collapsed.png");

    await clickButton(window, ["Expand navigation labels"]);
    const narrowExpanded = await snapshot(window, "narrow viewport, preview open, sidebar expanded");
    narrowExpanded.screenshot = await capture(window, "06-narrow-preview-open-sidebar-expanded.png");

    const scrollCheck = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.innerText?.trim() === "Open task map");
      if (!button) return { found: false, ancestors: [] };
      const ancestors = [];
      let element = button.parentElement;
      while (element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        ancestors.push({
          tag: element.tagName,
          className: element.className,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          overflowY: style.overflowY,
        });
        element = element.parentElement;
      }
      const scrollable = ancestors.find((ancestor) => ["auto", "scroll"].includes(ancestor.overflowY) && ancestor.scrollHeight > ancestor.clientHeight);
      const scrollElement = [...button.parentElement.closest("body").querySelectorAll("*")].find((candidate) => {
        const style = getComputedStyle(candidate);
        return candidate.contains(button) && ["auto", "scroll"].includes(style.overflowY) && candidate.scrollHeight > candidate.clientHeight;
      });
      if (scrollElement) scrollElement.scrollTop = scrollElement.scrollHeight;
      return { found: true, ancestors, scrolled: Boolean(scrollElement), selectedScrollable: scrollable || null };
    })()`);
    await wait(350);
    const narrowExpandedScrolled = await snapshot(window, "narrow viewport, sidebar expanded, task content scrolled to bottom");
    narrowExpandedScrolled.screenshot = await capture(window, "07-narrow-expanded-task-content-scrolled-bottom.png");

    const evidence = { previewUrl, scrollCheck, states: [collapsed, expanded, focused, collapsedAgain, narrowCollapsed, narrowExpanded, narrowExpandedScrolled] };
    await writeFile(join(auditDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.commandLine.appendSwitch("disable-gpu");
app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
