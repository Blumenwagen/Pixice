// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HtmlReply, HtmlReplyContext, HtmlReplyFrame, parseHtmlReplySpec } from "../src/components/HtmlReply.jsx";
import { buildHtmlReplyDocument, HTML_REPLY_CSP, readHtmlReplyMessage } from "../src/components/html-reply-document.js";

const reference = { id: "a".repeat(64), threadId: "thread-1", title: "Interactive comparison", height: 600 };
describe("interactive HTML replies", () => {
  it("recognizes explicit HTML replies without executing ordinary HTML code examples", () => {
    expect(parseHtmlReplySpec("<button>Try it</button>", "html")).toBeNull();
    expect(parseHtmlReplySpec("<button>Try it</button>", "pixice-html")).toMatchObject({ html: "<button>Try it</button>" });
    expect(parseHtmlReplySpec(JSON.stringify(reference), "pixice-html")).toMatchObject(reference);
    expect(parseHtmlReplySpec('{"id":"../../escape"}', "pixice-html")).toBeNull();
    expect(parseHtmlReplySpec("<p>Large</p>" + "x".repeat(1024 * 1024), "pixice-html")).toBeNull();
  });
  it("places network restrictions before authored markup and keeps arbitrary inline scripts within an opaque sandbox", () => {
    const source = '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="file:///"><script>document.body.textContent="Local interactive content"</script>';
    const documentSource = buildHtmlReplyDocument(source, { nonce: "nonce" });
    expect(documentSource.indexOf("Content-Security-Policy")).toBeLessThan(documentSource.indexOf("Local interactive content"));
    expect(documentSource).not.toContain('<base href="file:///">');
    expect(documentSource).not.toContain('http-equiv="refresh"');
    const { container } = render(<HtmlReplyFrame html={source} title="Sandboxed reply" />);
    const frame = container.querySelector("iframe");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("csp", HTML_REPLY_CSP);
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain("frame-src 'none'");
    expect(frame.srcdoc).toContain("Local interactive content");
  });
  it("accepts only bounded frame messages from the actual iframe and exposes no tool or file bridge", () => {
    const frame = {};
    const message = (data, source = frame) => readHtmlReplyMessage({ source, data: { type: "pixice-html", nonce: "nonce", ...data } }, frame, "nonce");
    expect(message({ kind: "size", height: 720 })).toEqual({ kind: "size", height: 720 });
    expect(message({ kind: "size", height: 9000 })).toEqual({ kind: "size", height: 2000 });
    expect(message({ kind: "size", height: Infinity })).toBeNull();
    expect(message({ kind: "size", height: 200001 })).toBeNull();
    expect(message({ kind: "size", height: 720 }, {})).toBeNull();
    expect(message({ kind: "tool", name: "write_file", path: "/secret" })).toBeNull();
    expect(message({ kind: "link", url: "javascript:alert(1)" })).toBeNull();
    expect(message({ kind: "link", url: "file:///etc/passwd" })).toBeNull();
    expect(message({ kind: "link", url: "https://user:password@example.com/" })).toBeNull();
    expect(message({ kind: "link", url: "https://example.com/page" })).toEqual({ kind: "link", url: "https://example.com/page" });
  });
  it("requires an outer user click to follow a frame link and clamps reported size", () => {
    const { container } = render(<HtmlReplyFrame html="<p>Page</p>" title="Reply" height={600} />);
    const frame = container.querySelector("iframe");
    const nonce = /var nonce=("[^"]+")/.exec(frame.srcdoc)[1];
    const post = (data) => fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "pixice-html", nonce: JSON.parse(nonce), ...data } }));
    post({ kind: "size", height: 880 });
    expect(frame.style.height).toBe("600px");
    post({ kind: "link", url: "https://example.com/page" });
    expect(screen.getByText("Open example.com?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open link" })).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss link" }));
    expect(screen.queryByRole("link", { name: "Open link" })).not.toBeInTheDocument();
  });
  it("loads persisted replies, opens Preview through the host, and can inspect escaped source", async () => {
    const html = '<button onclick="this.textContent=\'Selected\'">Choose</button>';
    const load = vi.fn().mockResolvedValue({ ...reference, html });
    const open = vi.fn();
    render(<HtmlReplyContext.Provider value={{ load, open }}><HtmlReply spec={reference} /></HtmlReplyContext.Provider>);
    await waitFor(() => expect(screen.getByTitle(reference.title)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Open ${reference.title} in Preview` }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ...reference, html }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(html)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose" })).not.toBeInTheDocument();
  });
  it("rejects a loader substituting another thread and keeps an honest fallback", async () => {
    render(<HtmlReplyContext.Provider value={{ load: vi.fn().mockResolvedValue({ ...reference, threadId: "other-thread", html: "<p>Wrong thread</p>" }) }}><HtmlReply spec={reference} /></HtmlReplyContext.Provider>);
    expect(await screen.findByText("The HTML reply does not match this conversation.")).toBeInTheDocument();
    expect(screen.queryByTitle(reference.title)).not.toBeInTheDocument();
  });
  it("resolves copied source references through host metadata while loading only the destination thread", async () => {
    const currentReference = { ...reference, threadId: "fork-thread", reference: `pixice-html://fork-thread/${reference.id}` };
    const load = vi.fn().mockResolvedValue({ ...currentReference, html: "<p>Copied reply</p>" });
    const resolveSpec = vi.fn((input) => ({ ...input, threadId: currentReference.threadId, reference: currentReference.reference }));
    render(<HtmlReplyContext.Provider value={{ load, resolveSpec }}><HtmlReply spec={reference} /></HtmlReplyContext.Provider>);
    await waitFor(() => expect(screen.getByTitle(reference.title)).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ threadId: "fork-thread", id: reference.id }));
  });
  it("loads executable pages by scoped backend URL so the shell's strict CSP is preserved", async () => {
    const url = `http://127.0.0.1:43187/api/html-replies/document/${"a".repeat(43)}`;
    const documentUrl = vi.fn().mockResolvedValue({ url });
    render(<HtmlReplyContext.Provider value={{ documentUrl }}><HtmlReplyFrame html="<button>Interactive</button>" title="Page" /></HtmlReplyContext.Provider>);
    const frame = await screen.findByTitle("Page");
    expect(frame).toHaveAttribute("src", url);
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(documentUrl).toHaveBeenCalledWith(expect.objectContaining({ html: "<button>Interactive</button>", nonce: expect.any(String) }));
  });
});
