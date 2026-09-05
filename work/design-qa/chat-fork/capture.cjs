const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");

const evidenceDirectory = __dirname;
const sourceFullPath = path.join(evidenceDirectory, "01-source-answer-full.png");
const sourceDetailPath = path.join(evidenceDirectory, "02-source-answer-detail.png");
const forkFullPath = path.join(evidenceDirectory, "03-fork-selected-main-full.png");
const forkSidebarPath = path.join(evidenceDirectory, "04-fork-sidebar-detail.png");
const forkAnswerPath = path.join(evidenceDirectory, "05-fork-answer-detail.png");
const evidencePath = path.join(evidenceDirectory, "evidence.json");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(window, expression, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function capture(window, outputPath, selector = null, padding = 0) {
  let rectangle;
  if (selector) {
    rectangle = await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const padding = ${Number(padding)};
      const x = Math.max(0, Math.floor(bounds.x - padding));
      const y = Math.max(0, Math.floor(bounds.y - padding));
      const width = Math.min(window.innerWidth - x, Math.ceil(bounds.width + padding * 2));
      const height = Math.min(window.innerHeight - y, Math.ceil(bounds.height + padding * 2));
      return { x, y, width, height };
    })()`);
    if (!rectangle) throw new Error(`Could not capture missing selector: ${selector}`);
  }
  const image = await window.webContents.capturePage(rectangle ?? undefined);
  await writeFile(outputPath, image.toPNG());
  return { path: outputPath, pixels: image.getSize(), rectangle: rectangle ?? null };
}

async function captureBetween(window, outputPath, firstSelector, lastSelector, padding = 0) {
  const rectangle = await window.webContents.executeJavaScript(`(() => {
    const first = document.querySelector(${JSON.stringify(firstSelector)});
    const last = document.querySelector(${JSON.stringify(lastSelector)});
    if (!first || !last) return null;
    const firstBounds = first.getBoundingClientRect();
    const lastBounds = last.getBoundingClientRect();
    const padding = ${Number(padding)};
    const left = Math.min(firstBounds.left, lastBounds.left);
    const right = Math.max(firstBounds.right, lastBounds.right);
    const top = Math.min(firstBounds.top, lastBounds.top);
    const bottom = Math.max(firstBounds.bottom, lastBounds.bottom);
    const x = Math.max(0, Math.floor(left - padding));
    const y = Math.max(0, Math.floor(top - padding));
    const width = Math.min(window.innerWidth - x, Math.ceil(right - left + padding * 2));
    const height = Math.min(window.innerHeight - y, Math.ceil(bottom - top + padding * 2));
    return { x, y, width, height };
  })()`);
  if (!rectangle) throw new Error(`Could not capture range: ${firstSelector} to ${lastSelector}`);
  const image = await window.webContents.capturePage(rectangle);
  await writeFile(outputPath, image.toPNG());
  return { path: outputPath, pixels: image.getSize(), rectangle };
}

async function domState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const app = document.querySelector(".pixice-app");
    const activeRow = document.querySelector('.task-row [aria-current="page"]')?.closest(".task-row");
    const forkButton = document.querySelector('.fork-response-button[aria-label="Fork from this answer"]');
    const sidebar = document.querySelector(".sidebar");
    const turn = forkButton?.closest(".conversation-turn");
    const finalAnswer = turn?.querySelector(".assistant-message-block");
    const images = turn ? [...turn.querySelectorAll('figure[data-state="complete"]')] : [];
    const actions = turn?.querySelector(".assistant-answer-actions.detached");
    const timestamp = actions?.querySelector(".message-timestamp");
    const children = turn ? [...turn.children] : [];
    return {
      activeThreadId: app?.getAttribute("data-active-thread-id") ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      previewWorkspaceCount: document.querySelectorAll('[aria-label="Preview workspace"]').length,
      previewForkTabCount: [...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.textContent.includes("Refine chat forking (fork)")).length,
      activeRowThreadId: activeRow?.getAttribute("data-thread-id") ?? null,
      activeRowText: activeRow?.innerText.replace(/\\s+/g, " ").trim() ?? null,
      activeRowForkIcons: activeRow?.querySelectorAll(".task-fork-icon").length ?? 0,
      totalForkRows: document.querySelectorAll(".task-fork-icon").length,
      forkButton: forkButton ? {
        label: forkButton.getAttribute("aria-label"),
        title: forkButton.title,
        width: forkButton.getBoundingClientRect().width,
        height: forkButton.getBoundingClientRect().height,
        disabled: forkButton.disabled
      } : null,
      answerOutputOrder: {
        finalAnswerIndex: finalAnswer ? children.indexOf(finalAnswer) : -1,
        imageIndexes: images.map((image) => children.indexOf(image)),
        actionIndex: actions ? children.indexOf(actions) : -1,
        imageCount: images.length,
        actionsDetached: Boolean(actions),
        answerBeforeImages: Boolean(finalAnswer && images.length && finalAnswer.getBoundingClientRect().bottom <= images[0].getBoundingClientRect().top),
        actionsBelowImages: Boolean(actions && images.length && actions.getBoundingClientRect().top >= images.at(-1).getBoundingClientRect().bottom),
        forkBeforeTimestamp: Boolean(actions && forkButton && timestamp && [...actions.children].indexOf(forkButton) < [...actions.children].indexOf(timestamp)),
        actionGapAfterImage: actions && images.length ? Math.round((actions.getBoundingClientRect().top - images.at(-1).getBoundingClientRect().bottom) * 10) / 10 : null
      },
      sidebarExpanded: sidebar?.getAttribute("data-expanded") ?? null,
      sourceAnswerVisible: document.body.innerText.includes("Forking now starts from the selected agent answer."),
      forkPayload: window.__chatForkPayload ?? null
    };
  })()`);
}

async function neutralForkState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-thread-id="preview-task-fork"]');
    const icon = row?.querySelector(".task-fork-icon");
    const probe = document.createElement("span");
    probe.style.color = "var(--quiet)";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const quietColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      activeThreadId: document.querySelector(".pixice-app")?.getAttribute("data-active-thread-id") ?? null,
      forkRowActive: row?.classList.contains("active") ?? false,
      forkRowHovered: row?.matches(":hover") ?? false,
      forkIconColor: icon ? getComputedStyle(icon).color : null,
      quietColor,
      usesQuietColor: Boolean(icon) && getComputedStyle(icon).color === quietColor,
      forkRowTitle: row?.querySelector(".task-select")?.title ?? null,
      forkRowDescription: row?.querySelector(".task-select")?.getAttribute("aria-description") ?? null
    };
  })()`);
}

async function run() {
  const consoleErrors = [];
  const window = new BrowserWindow({
    width: 1480,
    height: 950,
    useContentSize: true,
    show: false,
    backgroundColor: "#242424",
    webPreferences: {
      preload: path.join(evidenceDirectory, "preload.cjs"),
      partition: "chat-fork-design-qa",
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });

  try {
    await window.loadURL("http://127.0.0.1:5173/?task-progress-preview");
    await waitFor(window, `document.querySelector(".pixice-app")`, "Pixice app shell");
    await waitFor(window, `document.querySelector('.fork-response-button[aria-label="Fork from this answer"]') && document.querySelector('figure[data-state="complete"] img')`, "source answer, generated image, and fork button");
    await window.webContents.executeJavaScript(`(() => {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar?.getAttribute("data-expanded") !== "true") {
        const toggle = [...document.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") || "").includes("Expand sidebar"));
        toggle?.click();
      }
    })()`);
    await window.webContents.executeJavaScript(`document.querySelector(".assistant-message-block")?.scrollIntoView({ block: "start" })`);
    await wait(650);

    const sourceState = await domState(window);
    if (sourceState.answerOutputOrder.imageCount !== 1) throw new Error("Expected one completed generated image after the final answer");
    if (!sourceState.answerOutputOrder.actionsDetached) throw new Error("Fork action was not detached below the generated image");
    if (!sourceState.answerOutputOrder.answerBeforeImages) throw new Error("Generated image did not render after the final answer text");
    if (!sourceState.answerOutputOrder.actionsBelowImages) throw new Error("Fork action did not render below the generated image");
    if (!sourceState.answerOutputOrder.forkBeforeTimestamp) throw new Error("Fork action did not render before the answer timestamp");
    const sourceFull = await capture(window, sourceFullPath);
    const sourceDetail = await captureBetween(window, sourceDetailPath, ".assistant-message-block", ".assistant-answer-actions.detached", 20);

    const clicked = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.fork-response-button[aria-label="Fork from this answer"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error("Could not click the answer fork button");

    await waitFor(window, `document.querySelector(".pixice-app")?.getAttribute("data-active-thread-id") === "preview-task-fork"`, "fork selection");
    await window.webContents.executeJavaScript(`document.querySelector(".assistant-message-block")?.scrollIntoView({ block: "start" })`);
    await wait(800);
    const forkState = await domState(window);
    if (forkState.previewWorkspaceCount !== 0) throw new Error("Fork opened Preview instead of staying in main chat");
    if (forkState.previewForkTabCount !== 0) throw new Error("Fork appeared as a Preview tab");
    if (forkState.activeRowThreadId !== "preview-task-fork") throw new Error("Forked sidebar row is not selected");
    if (forkState.activeRowForkIcons !== 1) throw new Error("Selected fork row does not show exactly one branch icon");

    const forkFull = await capture(window, forkFullPath);
    const forkAnswer = await captureBetween(window, forkAnswerPath, ".assistant-message-block", ".assistant-answer-actions.detached", 20);

    const returnedToSource = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-thread-id="preview-task"] .task-select');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!returnedToSource) throw new Error("Could not return to the source thread for neutral lineage capture");
    await waitFor(window, `document.querySelector(".pixice-app")?.getAttribute("data-active-thread-id") === "preview-task"`, "source thread reselection");
    await wait(500);
    const neutralState = await neutralForkState(window);
    if (neutralState.forkRowActive) throw new Error("Fork row remained active during neutral-state capture");
    if (neutralState.forkRowHovered) throw new Error("Fork row was hovered during neutral-state capture");
    if (!neutralState.usesQuietColor) throw new Error(`Fork lineage icon is not neutral at rest: ${neutralState.forkIconColor} versus ${neutralState.quietColor}`);
    const forkSidebar = await capture(window, forkSidebarPath, ".sidebar", 0);
    const evidence = {
      capturedAt: new Date().toISOString(),
      targetUrl: "http://127.0.0.1:5173/?task-progress-preview",
      sourceVisualTruth: "User-provided Codex answer-action screenshot in the lead Pixice thread",
      interaction: "Clicked the compact answer fork button and waited for the fork to become the active main thread",
      sourceState,
      forkState,
      neutralState,
      consoleErrors,
      captures: { sourceFull, sourceDetail, forkFull, forkSidebar, forkAnswer }
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(run).then(() => app.quit()).catch((error) => {
  console.error(error);
  app.exit(1);
});
