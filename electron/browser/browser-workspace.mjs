import { createHash, randomUUID } from "node:crypto";

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;color:#85858b;background:#171717;font:14px system-ui,sans-serif}.home{text-align:center}.mark{width:42px;height:42px;margin:0 auto 14px;display:grid;place-items:center;color:#c9c9ce;background:#252527;border:1px solid #343438;border-radius:13px;font-size:20px}strong{display:block;color:#e8e8eb;font-size:15px}p{margin:7px 0 0;font-size:12px}</style></head><body><div class="home"><div class="mark">◎</div><strong>Browse with Pixice</strong><p>Enter an address above or ask Codex to investigate a page.</p></div></body></html>`;
const HOME_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HOME_HTML)}`;
const INTERACTIVE_SELECTOR = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
const NATIVE_PREVIEW_RADIUS = 14;

function functionTool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  };
}

export const browserDynamicTools = [{
  type: "namespace",
  name: "pixice_browser",
  description: "Operate the current Codex thread's isolated Pixice in-app preview browser. Use this namespace when the user asks for Pixice's in-app or preview browser; it is separate from external Browser and Chrome plugins. Inspect before interacting and use the returned element indexes.",
  tools: [
    functionTool("navigate", "Navigate the active tab, or open the URL in a new tab.", {
      url: { type: "string", description: "An http(s) URL or localhost address." },
      newTab: { type: "boolean", description: "Open the URL in a new tab instead of the active tab." }
    }, ["url"]),
    functionTool("inspect", "Read the active page's title, URL, visible text, and indexed interactive elements.", {
      maxChars: { type: "integer", minimum: 1000, maximum: 30000, description: "Maximum visible-text characters to return." }
    }),
    functionTool("click", "Click an indexed interactive element returned by inspect.", {
      index: { type: "integer", minimum: 0 }
    }, ["index"]),
    functionTool("type", "Replace the value of an indexed input and optionally submit its form.", {
      index: { type: "integer", minimum: 0 },
      text: { type: "string" },
      submit: { type: "boolean" }
    }, ["index", "text"]),
    functionTool("scroll", "Scroll the active page by a relative number of pixels.", {
      x: { type: "integer" },
      y: { type: "integer" }
    }, ["y"]),
    functionTool("tabs", "List, create, activate, or close Pixice browser tabs.", {
      action: { type: "string", enum: ["list", "new", "activate", "close"] },
      tabId: { type: "string" },
      url: { type: "string" }
    }, ["action"]),
    functionTool("screenshot", "Capture the visible active page for visual UI inspection.")
  ]
}];

export function normalizeBrowserUrl(candidate) {
  const value = String(candidate ?? "").trim();
  if (!value) return HOME_URL;
  if (value === HOME_URL) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}

function textResult(value, success = true) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { success, contentItems: [{ type: "inputText", text }] };
}

function publicUrl(url) {
  return url === HOME_URL || url?.startsWith("data:text/html") ? "" : url;
}

export class BrowserWorkspace {
  #window;
  #WebContentsView;
  #emit;
  #workspaces = new Map();
  #visibleWorkspaceId = null;
  #attached = null;
  #visible = false;
  #bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor({ window, WebContentsView, emit }) {
    this.#window = window;
    this.#WebContentsView = WebContentsView;
    this.#emit = emit;
  }

  snapshot(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    return {
      native: true,
      workspaceId,
      activeTabId: workspace?.activeTabId ?? null,
      tabs: [...(workspace?.tabs.values() ?? [])].map(({ view: _view, pendingUrl: _pendingUrl, ...tab }) => ({ ...tab, url: publicUrl(tab.url) }))
    };
  }

  createTab(workspaceId, url = HOME_URL) {
    const workspace = this.#workspace(workspaceId);
    const id = randomUUID();
    const view = new this.#WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: workspace.partition
      }
    });
    view.setBackgroundColor("#171717");
    view.setBorderRadius(NATIVE_PREVIEW_RADIUS);
    const initialUrl = normalizeBrowserUrl(url);
    const tab = { id, view, title: "New tab", url: HOME_URL, pendingUrl: initialUrl, loading: false, error: null, canGoBack: false, canGoForward: false };
    workspace.tabs.set(id, tab);
    workspace.activeTabId = id;

    const update = () => {
      if (view.webContents.isDestroyed()) return;
      tab.url = view.webContents.getURL() || tab.url;
      tab.title = publicUrl(tab.url) ? view.webContents.getTitle() || "Untitled" : "New tab";
      tab.canGoBack = view.webContents.navigationHistory.canGoBack();
      tab.canGoForward = view.webContents.navigationHistory.canGoForward();
      this.#publish(workspaceId);
    };
    view.webContents.on("did-start-loading", () => { tab.loading = true; tab.error = null; update(); });
    view.webContents.on("did-stop-loading", () => { tab.loading = false; update(); });
    view.webContents.on("did-navigate", update);
    view.webContents.on("did-navigate-in-page", update);
    view.webContents.on("page-title-updated", update);
    view.webContents.on("will-navigate", (event, nextUrl) => {
      let protocol;
      try { protocol = new URL(nextUrl).protocol; } catch { protocol = ""; }
      if (["http:", "https:", "data:", "about:"].includes(protocol)) {
        tab.pendingUrl = nextUrl;
        tab.error = null;
        return;
      }
      event.preventDefault();
      tab.error = `Blocked navigation to ${protocol || "an invalid URL"}`;
      this.#publish(workspaceId);
    });
    view.webContents.on("will-redirect", (_event, nextUrl, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      tab.pendingUrl = nextUrl;
      tab.error = null;
    });
    view.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (validatedUrl && validatedUrl !== tab.pendingUrl) return;
      tab.loading = false;
      tab.error = description;
      tab.url = validatedUrl || tab.url;
      this.#publish(workspaceId);
    });
    view.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
      this.createTab(workspaceId, nextUrl);
      return { action: "deny" };
    });
    void view.webContents.loadURL(initialUrl).catch((error) => {
      if (tab.pendingUrl !== initialUrl) return;
      tab.loading = false;
      tab.error = error.message;
      this.#publish(workspaceId);
    });
    this.#attachActive();
    this.#publish(workspaceId);
    return this.snapshot(workspaceId);
  }

  closeTab(workspaceId, tabId) {
    const workspace = this.#workspace(workspaceId);
    const id = tabId || workspace.activeTabId;
    const tab = workspace.tabs.get(id);
    if (!tab) return this.snapshot(workspaceId);
    if (this.#attached?.workspaceId === workspaceId && this.#attached?.tabId === id) this.#detachAttached();
    workspace.tabs.delete(id);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (workspace.activeTabId === id) workspace.activeTabId = [...workspace.tabs.keys()].at(-1) ?? null;
    if (workspace.activeTabId) this.#attachActive();
    this.#publish(workspaceId);
    return this.snapshot(workspaceId);
  }

  activateTab(workspaceId, tabId) {
    const workspace = this.#workspace(workspaceId);
    if (!workspace.tabs.has(tabId)) throw new Error("Browser tab not found");
    workspace.activeTabId = tabId;
    this.#attachActive();
    this.#publish(workspaceId);
    return this.snapshot(workspaceId);
  }

  async navigate({ workspaceId, tabId, url }) {
    const tab = this.#tab(workspaceId, tabId);
    const nextUrl = normalizeBrowserUrl(url);
    tab.pendingUrl = nextUrl;
    tab.error = null;
    await tab.view.webContents.loadURL(nextUrl);
    return this.snapshot(workspaceId);
  }

  history(workspaceId, action) {
    const contents = this.#tab(workspaceId).view.webContents;
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
    if (action === "stop") contents.stop();
    return this.snapshot(workspaceId);
  }

  setViewport({ workspaceId, visible, bounds }) {
    if (visible) {
      this.#visible = true;
      this.#visibleWorkspaceId = workspaceId;
    }
    if (bounds) {
      this.#bounds = {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(0, Math.round(bounds.width)),
        height: Math.max(0, Math.round(bounds.height))
      };
    }
    if (visible) {
      const workspace = this.#workspace(workspaceId);
      if (!workspace.activeTabId) this.createTab(workspaceId);
      else this.#attachActive();
    } else if (!this.#visibleWorkspaceId || this.#visibleWorkspaceId === workspaceId) {
      this.#visible = false;
      this.#detachAttached();
      this.#visibleWorkspaceId = null;
    }
    return this.snapshot(workspaceId);
  }

  async handleToolCall(params) {
    const workspaceId = params.threadId;
    if (!workspaceId) return textResult("Pixice browser tools require a thread-scoped call.", false);
    this.#emit("BrowserOpenRequested", { threadId: workspaceId, workspaceId, source: "codex" });
    const workspace = this.#workspace(workspaceId);
    if (!workspace.activeTabId) this.createTab(workspaceId);
    const args = params.arguments ?? {};
    try {
      if (params.tool === "navigate") {
        if (args.newTab) this.createTab(workspaceId, args.url);
        else await this.navigate({ workspaceId, url: args.url });
        return textResult(this.snapshot(workspaceId));
      }
      if (params.tool === "inspect") return textResult(await this.#inspect(workspaceId, args.maxChars));
      if (params.tool === "click") return textResult(await this.#click(workspaceId, args.index));
      if (params.tool === "type") return textResult(await this.#type(workspaceId, args.index, args.text, args.submit));
      if (params.tool === "scroll") return textResult(await this.#scroll(workspaceId, args.x, args.y));
      if (params.tool === "tabs") return this.#tabsTool(workspaceId, args);
      if (params.tool === "screenshot") {
        const tab = this.#tab(workspaceId);
        if (this.#bounds.width < 1 || this.#bounds.height < 1) {
          tab.view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
        }
        const image = await tab.view.webContents.capturePage();
        return { success: true, contentItems: [{ type: "inputImage", imageUrl: image.toDataURL() }] };
      }
      return textResult(`Unknown Pixice browser tool: ${params.tool}`, false);
    } catch (error) {
      return textResult(error.message, false);
    }
  }

  adoptWorkspace(fromWorkspaceId, toWorkspaceId) {
    if (fromWorkspaceId === toWorkspaceId) return this.snapshot(toWorkspaceId);
    const source = this.#workspaces.get(fromWorkspaceId);
    if (!source) return this.snapshot(toWorkspaceId);
    if (this.#workspaces.has(toWorkspaceId)) throw new Error("The destination preview workspace already exists");
    this.#workspaces.delete(fromWorkspaceId);
    source.id = toWorkspaceId;
    this.#workspaces.set(toWorkspaceId, source);
    if (this.#visibleWorkspaceId === fromWorkspaceId) this.#visibleWorkspaceId = toWorkspaceId;
    if (this.#attached?.workspaceId === fromWorkspaceId) this.#attached.workspaceId = toWorkspaceId;
    this.#publish(toWorkspaceId);
    return this.snapshot(toWorkspaceId);
  }

  destroyWorkspace(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return;
    if (this.#attached?.workspaceId === workspaceId) this.#detachAttached();
    for (const tab of workspace.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.#workspaces.delete(workspaceId);
    if (this.#visibleWorkspaceId === workspaceId) {
      this.#visibleWorkspaceId = null;
      this.#visible = false;
    }
  }

  destroy() {
    this.#detachAttached();
    for (const workspace of this.#workspaces.values()) {
      for (const tab of workspace.tabs.values()) {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
    }
    this.#workspaces.clear();
    this.#visibleWorkspaceId = null;
  }

  #workspace(workspaceId) {
    if (!workspaceId) throw new Error("A preview workspace is required");
    let workspace = this.#workspaces.get(workspaceId);
    if (!workspace) {
      const partitionKey = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
      workspace = { id: workspaceId, partition: `persist:pixice-browser-${partitionKey}`, tabs: new Map(), activeTabId: null };
      this.#workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  #tab(workspaceId, tabId) {
    const workspace = this.#workspace(workspaceId);
    const tab = workspace.tabs.get(tabId ?? workspace.activeTabId);
    if (!tab) throw new Error("No active browser tab");
    return tab;
  }

  #publish(workspaceId) {
    this.#emit("BrowserState", this.snapshot(workspaceId));
  }

  #detachAttached() {
    if (!this.#attached || this.#window.isDestroyed()) return;
    const workspace = this.#workspaces.get(this.#attached.workspaceId);
    const tab = workspace?.tabs.get(this.#attached.tabId);
    if (tab) this.#window.contentView.removeChildView(tab.view);
    this.#attached = null;
  }

  #attachActive() {
    if (!this.#visible || !this.#visibleWorkspaceId || this.#window.isDestroyed()) return;
    const workspace = this.#workspace(this.#visibleWorkspaceId);
    if (!workspace.activeTabId) return;
    if (this.#attached?.workspaceId !== workspace.id || this.#attached?.tabId !== workspace.activeTabId) {
      this.#detachAttached();
      const tab = this.#tab(workspace.id);
      this.#window.contentView.addChildView(tab.view);
      this.#attached = { workspaceId: workspace.id, tabId: tab.id };
    }
    this.#tab(workspace.id).view.setBounds(this.#bounds);
  }

  async #inspect(workspaceId, maxChars = 14000) {
    const limit = Math.min(30000, Math.max(1000, Number(maxChars) || 14000));
    const script = `(() => {
      const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
      const elements = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})].filter(visible).slice(0, 160).map((element, index) => ({ index, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), type: element.getAttribute('type'), text: (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 180), href: element.href || null }));
      return { title: document.title, url: location.href, text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${limit}), elements };
    })()`;
    return this.#tab(workspaceId).view.webContents.executeJavaScript(script, true);
  }

  async #click(workspaceId, index) {
    const script = `(() => { const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }; const elements = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})].filter(visible); const element = elements[${Number(index)}]; if (!element) throw new Error('Interactive element not found'); element.scrollIntoView({block:'center',inline:'center'}); element.focus(); element.click(); return { clicked: ${Number(index)}, text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0,180) }; })()`;
    return this.#tab(workspaceId).view.webContents.executeJavaScript(script, true);
  }

  async #type(workspaceId, index, text, submit) {
    const script = `(() => { const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }; const elements = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})].filter(visible); const element = elements[${Number(index)}]; if (!element) throw new Error('Input element not found'); const value = ${JSON.stringify(String(text ?? ""))}; element.focus(); if (element.isContentEditable) element.textContent = value; else if (element instanceof HTMLSelectElement) { const option = [...element.options].find((candidate) => candidate.value === value || candidate.label === value || candidate.text === value); if (!option) throw new Error('Select option not found'); element.value = option.value; } else { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (setter) setter.call(element, value); else element.value = value; } element.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:value})); element.dispatchEvent(new Event('change', {bubbles:true})); if (${Boolean(submit)}) element.form?.requestSubmit(); return { typed: ${Number(index)}, submitted: ${Boolean(submit)} }; })()`;
    return this.#tab(workspaceId).view.webContents.executeJavaScript(script, true);
  }

  async #scroll(workspaceId, x = 0, y = 600) {
    const script = `(() => { window.scrollBy({left:${Number(x) || 0},top:${Number(y) || 0},behavior:'instant'}); return {x:window.scrollX,y:window.scrollY}; })()`;
    return this.#tab(workspaceId).view.webContents.executeJavaScript(script, true);
  }

  #tabsTool(workspaceId, args) {
    if (args.action === "new") this.createTab(workspaceId, args.url);
    if (args.action === "activate") this.activateTab(workspaceId, args.tabId);
    if (args.action === "close") this.closeTab(workspaceId, args.tabId);
    return textResult(this.snapshot(workspaceId));
  }
}
