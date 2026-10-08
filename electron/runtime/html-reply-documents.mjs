import { randomBytes } from "node:crypto";
import { z } from "zod";
import { buildHtmlReplyDocument, HTML_REPLY_MAX_BYTES } from "./html-reply-document.mjs";

export const HTML_REPLY_DOCUMENT_LIFETIME_MS = 10 * 60_000;
export const htmlReplyDocumentSchema = z.object({
  projectId: z.string().trim().min(1).max(500),
  threadId: z.string().trim().min(1).max(500),
  html: z.string().min(1).max(HTML_REPLY_MAX_BYTES),
  title: z.string().max(200).optional(),
  nonce: z.string().min(1).max(160),
  theme: z.object({ appearance: z.enum(["light", "dark"]), variables: z.record(z.string().max(500)) }).strict().optional()
}).strict();

// A token grants only this rendered document. It never grants the Connect API,
// provider, project files, or another attachment. Nothing is written to disk.
export class HtmlReplyDocuments {
  constructor({ now = Date.now, maxDocuments = 64, maxBytes = 128 * 1024 * 1024 } = {}) {
    this.now = now; this.maxDocuments = maxDocuments; this.maxBytes = maxBytes;
    this.documents = new Map(); this.bytes = 0;
  }
  #remove(token) {
    const entry = this.documents.get(token);
    if (!entry) return;
    this.bytes -= entry.bytes; this.documents.delete(token);
  }
  prune() { for (const [token, entry] of this.documents) if (entry.expiresAt <= this.now()) this.#remove(token); }
  create(input, deviceId) {
    const value = htmlReplyDocumentSchema.parse(input);
    if (Buffer.byteLength(value.html) > HTML_REPLY_MAX_BYTES) throw new Error("The HTML reply exceeds 25 MiB");
    if (value.theme && Object.keys(value.theme.variables).length > 48) throw new Error("The HTML reply theme has too many variables");
    const html = buildHtmlReplyDocument(value.html, { nonce: value.nonce, theme: value.theme });
    const bytes = Buffer.byteLength(html);
    if (bytes > this.maxBytes) throw new Error("The HTML reply exceeds the document cache limit");
    this.prune();
    while (this.documents.size >= this.maxDocuments || this.bytes + bytes > this.maxBytes) this.#remove(this.documents.keys().next().value);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + HTML_REPLY_DOCUMENT_LIFETIME_MS;
    this.documents.set(token, { html, bytes, expiresAt, deviceId, projectId: value.projectId, threadId: value.threadId }); this.bytes += bytes;
    return { path: `/api/html-replies/document/${token}`, expiresAt };
  }
  read(token) { this.prune(); return this.documents.get(token) ?? null; }
  revokeDevice(deviceId) { for (const [token, entry] of this.documents) if (entry.deviceId === deviceId) this.#remove(token); }
  clear() { this.documents.clear(); this.bytes = 0; }
}
