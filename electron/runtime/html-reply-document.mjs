// T3 Code's released HTML render bootstrap is the functional reference. Pixice
// exposes only resize and link suggestions; HTML never gets an application RPC.
export const HTML_REPLY_MIN_HEIGHT = 80;
export const HTML_REPLY_MAX_HEIGHT = 2000;
export const HTML_REPLY_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_REPLY_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
const LANGUAGES = new Set(["pixice-html", "pixice-html-reply"]);
const ID = /^[a-f\d]{64}$/;

export function clampHtmlReplyHeight(value, maximum = HTML_REPLY_MAX_HEIGHT) {
  return Math.max(HTML_REPLY_MIN_HEIGHT, Math.min(maximum, Math.round(Number.isFinite(value) ? value : 420)));
}
export function parseHtmlReplyReference(reference) {
  if (typeof reference !== "string") return null;
  const match = reference.match(/^pixice-html:\/\/([^/]+)\/([a-f\d]{64})$/);
  if (!match) return null;
  let threadId;
  try { threadId = decodeURIComponent(match[1]); } catch { return null; }
  if (!threadId || threadId.length > 500) return null;
  return { threadId, id: match[2], reference };
}
export function normalizeHtmlReplySpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "Interactive reply";
  const height = clampHtmlReplyHeight(input.height ?? 1200);
  if (typeof input.html === "string" && input.html.length > 0 && input.html.length <= HTML_REPLY_MAX_BYTES) return { title: title || "Interactive reply", height, html: input.html };
  const reference = parseHtmlReplyReference(input.reference);
  const id = input.id ?? reference?.id;
  const threadId = input.threadId ?? reference?.threadId;
  if (typeof id !== "string" || !ID.test(id) || typeof threadId !== "string" || !threadId || threadId.length > 500) return null;
  if (reference && (reference.id !== id || reference.threadId !== threadId)) return null;
  return { id, threadId, title: title || "Interactive reply", height, reference: `pixice-html://${encodeURIComponent(threadId)}/${id}` };
}
export function parseHtmlReplySpec(source, language) {
  if (!LANGUAGES.has(String(language).toLowerCase()) || typeof source !== "string" || source.length > 1024 * 1024) return null;
  const value = source.trim();
  if (!value) return null;
  if (value.startsWith("{")) {
    try { return normalizeHtmlReplySpec(JSON.parse(value)); } catch { return null; }
  }
  const reference = parseHtmlReplyReference(value);
  if (reference) return normalizeHtmlReplySpec(reference);
  if (/<[a-z!][\s\S]*>/i.test(value)) return normalizeHtmlReplySpec({ html: source });
  return null;
}

export const HTML_REPLY_DEFAULT_THEME = {
  appearance: "dark",
  variables: {
    "--background": "#242628", "--foreground": "#e7e7e8", "--muted": "#303236", "--muted-foreground": "#a4a7ad",
    "--card": "#2d3034", "--card-foreground": "#e7e7e8", "--border": "#45484e", "--input": "#45484e", "--ring": "#999fa9",
    "--primary": "#e7e7e8", "--primary-foreground": "#242628", "--accent": "#a5a0e8", "--accent-foreground": "#242628",
    "--chart-1": "#999fe0", "--chart-2": "#78b6bd", "--chart-3": "#c4ad75", "--chart-4": "#c692a7", "--chart-5": "#90b591", "--chart-6": "#b59ad0",
    "--radius": "10px", "--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    "--font-mono": '"SF Mono", Menlo, Consolas, monospace'
  }
};
const THEME_TOKENS = {
  "--background": "--canvas", "--foreground": "--foreground", "--muted": "--surface-raised", "--muted-foreground": "--muted",
  "--card": "--surface", "--card-foreground": "--foreground", "--border": "--border", "--input": "--border", "--ring": "--primary",
  "--primary": "--foreground", "--primary-foreground": "--canvas", "--accent": "--primary", "--accent-foreground": "--foreground",
  "--chart-1": "--dither-blue", "--chart-2": "--dither-green", "--chart-3": "--dither-orange", "--chart-4": "--dither-pink", "--chart-5": "--dither-purple", "--chart-6": "--dither-red"
};
export function readHtmlReplyTheme(element) {
  if (!element || typeof getComputedStyle !== "function") return HTML_REPLY_DEFAULT_THEME;
  const style = getComputedStyle(element);
  const variables = { ...HTML_REPLY_DEFAULT_THEME.variables };
  for (const [name, source] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(source).trim();
    if (value) variables[name] = value;
  }
  return { appearance: style.colorScheme === "light" ? "light" : "dark", variables };
}
function safeTheme(theme) {
  return {
    appearance: theme?.appearance === "light" ? "light" : "dark",
    variables: Object.fromEntries(Object.entries({ ...HTML_REPLY_DEFAULT_THEME.variables, ...theme?.variables }).filter(([name, value]) => /^--[a-z\d-]+$/.test(name) && typeof value === "string" && value.length <= 500).map(([name, value]) => [name, value.replace(/[;{}<>]/g, "")]))
  };
}
function scriptJson(value) { return JSON.stringify(value).replace(/</g, "\\u003c"); }
export function buildHtmlReplyDocument(html, { nonce, theme = HTML_REPLY_DEFAULT_THEME } = {}) {
  if (typeof html !== "string" || html.length > HTML_REPLY_MAX_BYTES) throw new Error("The HTML reply is too large to display");
  const initialTheme = safeTheme(theme);
  const themeCss = `:root{color-scheme:${initialTheme.appearance};${Object.entries(initialTheme.variables).map(([name, value]) => `${name}:${value};`).join("")}}`;
  const bootstrap = `(function(){"use strict";var nonce=${scriptJson(nonce ?? "")},last=0,scheduled=false;var style=document.getElementById("pixice-html-theme");function send(kind,value){parent.postMessage({type:"pixice-html",nonce:nonce,kind:kind,...value},"*");}function resize(){scheduled=false;var body=document.body;if(!body)return;var height=Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height));if(Number.isFinite(height)&&height>0&&height!==last){last=height;send("size",{height:height});}}function requestSize(){if(scheduled)return;scheduled=true;requestAnimationFrame(resize);}window.addEventListener("message",function(event){var d=event.data;if(event.source!==parent||!d||d.type!=="pixice-html-theme"||d.nonce!==nonce||!d.theme)return;var t=d.theme,c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";if(t.variables&&typeof t.variables==="object"){Object.keys(t.variables).slice(0,48).forEach(function(k){var v=t.variables[k];if(/^--[a-z0-9-]+$/.test(k)&&typeof v==="string"&&v.length<501)c+=k+":"+v.replace(/[;{}<>]/g,"")+";";});}if(style)style.textContent=c+"}";requestSize();});document.addEventListener("click",function(event){var target=event.target;var a=target&&target.closest?target.closest("a[href]"):null;if(!a)return;var href=a.getAttribute("href")||"";if(href.charAt(0)==="#")return;event.preventDefault();event.stopImmediatePropagation();try{var u=new URL(href);if((u.protocol==="http:"||u.protocol==="https:")&&!u.username&&!u.password)send("link",{url:u.href});}catch(e){}},true);document.addEventListener("submit",function(event){event.preventDefault();},true);window.open=function(url){try{var u=new URL(String(url));if((u.protocol==="http:"||u.protocol==="https:")&&!u.username&&!u.password)send("link",{url:u.href});}catch(e){}return null;};document.addEventListener("DOMContentLoaded",function(){if(typeof ResizeObserver!=="undefined")new ResizeObserver(requestSize).observe(document.body);new MutationObserver(requestSize).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});document.addEventListener("load",requestSize,true);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(requestSize);requestSize();});window.addEventListener("resize",requestSize);})();`;
  // The policy is always before authored markup. Later CSP declarations can
  // only add restrictions. No filesystem or signed asset URL enters the frame.
  const content = html.replace(/<base\b[^>]*>/gi, "").replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b[^>]*>/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_REPLY_CSP}"><style id="pixice-html-theme">${themeCss}</style><style>html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;color-scheme:${initialTheme.appearance}}body{margin:0}*{box-sizing:border-box}code,kbd,pre,samp{font-family:var(--font-mono)}html{scrollbar-width:thin}html::-webkit-scrollbar{width:6px;height:6px}html::-webkit-scrollbar-thumb{background:var(--border);border-radius:6px}</style><script>${bootstrap}</script></head><body>${content}</body></html>`;
}
export function readHtmlReplyMessage(event, contentWindow, nonce) {
  if (!contentWindow || event.source !== contentWindow) return null;
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "pixice-html" || data.nonce !== nonce) return null;
  if (data.kind === "size" && typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0 && data.height <= 100000) return { kind: "size", height: clampHtmlReplyHeight(data.height) };
  if (data.kind === "link" && typeof data.url === "string" && data.url.length <= 4096) {
    try { const url = new URL(data.url); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return { kind: "link", url: url.href }; } catch { /* Reject malformed links. */ }
  }
  return null;
}
