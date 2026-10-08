// Opaque iframe sandboxing protects Pixice's session, while this Electron hook
// also stops authored JavaScript replacing a self-contained srcdoc with a remote
// page. CSP navigation directives are not implemented uniformly by browsers.
export function guardHtmlReplyNavigation(webContents) {
  const onNavigate = (event) => {
    if (event.isMainFrame) return;
    const sourceUrl = event.initiator?.url ?? event.frame?.url;
    let isReply = sourceUrl === "about:srcdoc";
    try { isReply ||= /^\/api\/html-replies\/document\/[A-Za-z0-9_-]{43}$/.test(new URL(sourceUrl).pathname); } catch { /* about:srcdoc has no HTTP path. */ }
    if (!isReply) return;
    if (event.url === "about:srcdoc" || event.url === "about:blank") return;
    event.preventDefault();
  };
  webContents.on("will-frame-navigate", onNavigate);
  return () => webContents.removeListener("will-frame-navigate", onNavigate);
}
