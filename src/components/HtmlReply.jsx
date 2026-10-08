import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildHtmlReplyDocument, clampHtmlReplyHeight, HTML_REPLY_CSP, normalizeHtmlReplySpec, readHtmlReplyMessage, readHtmlReplyTheme } from "./html-reply-document.js";
import "./html-reply.css";
export { parseHtmlReplySpec, parseHtmlReplyReference } from "./html-reply-document.js";

// load(spec) reads only the active project/thread's attachment. open(spec)
// opens a normal unified Preview tab; neither callback is exposed to the page.
export const HtmlReplyContext = createContext(null);

export function HtmlReplyFrame({ html, title = "Interactive reply", height = 1200, expanded = false }) {
  const context = useContext(HtmlReplyContext);
  const frameRef = useRef(null);
  const rootRef = useRef(null);
  const nonce = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `html-${Math.random().toString(36).slice(2)}`, [html]);
  const [contentHeight, setContentHeight] = useState(420);
  const [pendingLink, setPendingLink] = useState(null);
  const [documentUrl, setDocumentUrl] = useState(null);
  const [documentError, setDocumentError] = useState(null);
  const [theme] = useState(() => readHtmlReplyTheme(typeof document === "undefined" ? null : document.documentElement));
  const hasDocumentTransport = Boolean(context?.documentUrl);
  const documentSource = useMemo(() => hasDocumentTransport ? undefined : buildHtmlReplyDocument(html, { nonce, theme }), [html, nonce, theme, hasDocumentTransport]);
  useEffect(() => {
    let current = true;
    setDocumentUrl(null); setDocumentError(null);
    if (!context?.documentUrl) return () => { current = false; };
    Promise.resolve().then(() => context.documentUrl({ html, title, nonce, theme })).then((result) => {
      const source = typeof result === "string" ? result : result?.url;
      if (typeof source !== "string" || !/^https?:\/\//i.test(source)) throw new Error("The HTML reply document URL is unavailable.");
      const url = new URL(source);
      if (url.username || url.password || !/^\/api\/html-replies\/document\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) throw new Error("The HTML reply document URL is invalid.");
      if (current) setDocumentUrl(url.href);
    }).catch((error) => { if (current) setDocumentError(error.message || "Unable to display this HTML reply."); });
    return () => { current = false; };
  }, [html, title, nonce, theme, context?.documentUrl]);
  const postTheme = () => frameRef.current?.contentWindow?.postMessage({ type: "pixice-html-theme", nonce, theme: readHtmlReplyTheme(rootRef.current ?? document.documentElement) }, "*");
  useLayoutEffect(() => {
    const listener = (event) => {
      const message = readHtmlReplyMessage(event, frameRef.current?.contentWindow, nonce);
      if (message?.kind === "size") setContentHeight((current) => current === message.height ? current : message.height);
      if (message?.kind === "link") setPendingLink(message.url);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [nonce]);
  useEffect(() => {
    postTheme();
    const observer = new MutationObserver(postTheme);
    // Pixice uses both root tokens and shell-level appearance attributes.
    for (let node = rootRef.current?.parentElement; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-appearance"] });
    const preference = window.matchMedia?.("(prefers-color-scheme: dark)");
    preference?.addEventListener?.("change", postTheme);
    return () => { observer.disconnect(); preference?.removeEventListener?.("change", postTheme); };
  }, [nonce]);
  const displayedHeight = expanded ? undefined : clampHtmlReplyHeight(Math.min(height, contentHeight));
  return <div className={`html-reply-document${expanded ? " is-expanded" : ""}`} ref={rootRef}>
    {context?.documentUrl && !documentUrl ? <div className="html-reply-placeholder" role="status" style={{ height: displayedHeight }}>{documentError || "Preparing interactive reply…"}</div> : <iframe
      ref={frameRef} title={title} src={documentUrl ?? undefined} srcDoc={documentUrl ? undefined : documentSource} sandbox="allow-scripts" csp={HTML_REPLY_CSP}
      referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      style={{ height: displayedHeight }} onLoad={postTheme} data-pixice-html-reply="true"
    />}
    {pendingLink && <div className="html-reply-link-request" role="status">
      <span>Open {new URL(pendingLink).hostname}?</span>
      <a href={pendingLink} target="_blank" rel="noopener noreferrer" onClick={() => setPendingLink(null)}>Open link</a>
      <button type="button" aria-label="Dismiss link" onClick={() => setPendingLink(null)}>Dismiss</button>
    </div>}
  </div>;
}

export function HtmlReply({ spec: input }) {
  const context = useContext(HtmlReplyContext);
  const spec = useMemo(() => normalizeHtmlReplySpec(context?.resolveSpec ? context.resolveSpec(input) : input), [input, context?.resolveSpec]);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [sourceVisible, setSourceVisible] = useState(false);
  useEffect(() => {
    let active = true;
    setLoaded(null); setError(null); setSourceVisible(false);
    if (!spec || spec.html) return () => { active = false; };
    if (!context?.load) { setError("This HTML reply cannot be loaded in this view."); return () => { active = false; }; }
    Promise.resolve().then(() => context.load(spec)).then((reply) => {
      if (!active) return;
      // A loader may not substitute a document from another thread.
      if (reply?.id !== spec.id || reply?.threadId !== spec.threadId || typeof reply?.html !== "string") throw new Error("The HTML reply does not match this conversation.");
      const normalized = normalizeHtmlReplySpec(reply);
      if (!normalized?.html) throw new Error("The HTML reply is invalid or too large.");
      setLoaded({ ...spec, ...normalized });
    }).catch((failure) => { if (active) setError(failure.message || "Unable to load this HTML reply."); });
    return () => { active = false; };
  }, [spec?.id, spec?.threadId, spec?.html, context?.load]);
  if (!spec) return null;
  const reply = spec.html ? spec : loaded;
  return <section className="html-reply" aria-label={spec.title}>
    <div className="html-reply-actions">
      <span>{spec.title}</span>
      {context?.open && reply && <button type="button" onClick={() => context.open(reply)} aria-label={`Open ${spec.title} in Preview`}>Open in Preview</button>}
      {reply && <button type="button" aria-pressed={sourceVisible} onClick={() => setSourceVisible((current) => !current)}>{sourceVisible ? "Hide source" : "Source"}</button>}
    </div>
    {reply ? sourceVisible ? <pre className="message-code html-reply-source"><code data-language="html">{reply.html}</code></pre> : <HtmlReplyFrame html={reply.html} title={reply.title} height={reply.height} /> : <div className="html-reply-placeholder" role="status">{error || "Loading interactive reply…"}{error && spec.reference && <code>{spec.reference}</code>}</div>}
  </section>;
}
