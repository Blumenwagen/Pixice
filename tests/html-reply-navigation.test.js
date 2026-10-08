import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { guardHtmlReplyNavigation } from "../electron/browser/html-reply-navigation.mjs";

describe("native HTML reply navigation isolation", () => {
  it("blocks remote, file, and data navigation initiated inside a reply while allowing the shell and initial srcdoc", () => {
    const contents = new EventEmitter();
    const cleanup = guardHtmlReplyNavigation(contents);
    for (const url of ["https://example.com", "file:///etc/passwd", "data:text/html,hello"]) {
      const preventDefault = vi.fn();
      contents.emit("will-frame-navigate", { isMainFrame: false, url, frame: { url: "about:srcdoc" }, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      const hostedPrevent = vi.fn();
      contents.emit("will-frame-navigate", { isMainFrame: false, url, frame: { url: `http://127.0.0.1:43187/api/html-replies/document/${"a".repeat(43)}` }, preventDefault: hostedPrevent });
      expect(hostedPrevent).toHaveBeenCalledOnce();
    }
    for (const event of [
      { isMainFrame: true, url: "http://localhost:5173", frame: { url: "about:srcdoc" } },
      { isMainFrame: false, url: "about:srcdoc", frame: { url: "about:srcdoc" } },
      { isMainFrame: false, url: "https://example.com", frame: { url: "https://example.com/start" } }
    ]) {
      const preventDefault = vi.fn(); contents.emit("will-frame-navigate", { ...event, preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
    }
    cleanup(); expect(contents.listenerCount("will-frame-navigate")).toBe(0);
  });
});
