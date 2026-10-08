import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Functional reference: T3 Code's released HtmlRender service and HtmlRenderFrame,
// v0.0.46-nightly.20261008.2813. Pages are thread attachments, not application code.
export const PIXICE_HTML_NAMESPACE = "pixice_html";
export const MAX_HTML_REPLY_BYTES = 25 * 1024 * 1024;
export const MAX_HTML_SOURCE_BYTES = 1024 * 1024;
export const MAX_HTML_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_THREAD_PAGES = 96;
const MAX_THREAD_BYTES = 128 * 1024 * 1024;
const identifier = z.string().trim().min(1).max(500);
const publishShape = {
  html: z.string().min(1).max(MAX_HTML_SOURCE_BYTES).optional(),
  path: z.string().trim().min(1).max(4096).optional(),
  title: z.string().trim().min(1).max(200),
  height: z.number().int().min(80).max(2000).optional()
};
export const htmlReplyToolShapes = { publish: publishShape, list: {} };
export const PIXICE_HTML_MCP_TOOLS = new Set(Object.keys(htmlReplyToolShapes).map((name) => `mcp__${PIXICE_HTML_NAMESPACE}__${name}`));
export const htmlReplyToolSchemas = {
  publish: z.object(publishShape).strict().refine((value) => Boolean(value.html) !== Boolean(value.path), "Supply exactly one of html or path"),
  list: z.object({}).strict()
};
export const htmlReplyReadSchema = z.object({ projectId: identifier, threadId: identifier, id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const THEME_GUIDE = "Use CSS variables --background, --foreground, --muted, --muted-foreground, --card, --border, --primary, --primary-foreground, --accent, --accent-foreground, --font-sans, --font-mono, --radius, and --chart-1 through --chart-6. The active Pixice theme follows live. Body margin is zero. Use fluid widths, natural content height, and fixed pixel chart heights. Avoid 100vh and outer page cards or banner titles; the page is part of the reply.";
export const htmlReplyDynamicTools = [{
  type: "namespace", name: PIXICE_HTML_NAMESPACE,
  description: "Publish self-contained interactive HTML replies in the current conversation. Use for diagrams, charts, comparisons, calculators, mockups, and other answers improved by direct interaction. These are one-off reply attachments; reusable project controls belong in Pixice Tools.",
  tools: [{
    type: "function", name: "publish",
    description: `Publish a self-contained HTML/CSS/JavaScript page from html or a project file path. Scripts run in an isolated sandbox without app, file, or network access. Inline your scripts, styles, and data; external libraries, fetch, imports, forms, and remote images are blocked. Local raster images in img src or CSS url are embedded from the project's permitted roots and survive file deletion. ${THEME_GUIDE} After publishing, include the returned pixice-html fenced reference exactly once in the final reply at the relevant location. The user can open it as a Preview tab and inspect its source. Do not paste the full page into the reply.`,
    inputSchema: {
      type: "object", properties: {
        html: { type: "string", minLength: 1, maxLength: MAX_HTML_SOURCE_BYTES, description: "A self-contained document or fragment; supply this or path." },
        path: { type: "string", minLength: 1, maxLength: 4096, description: "HTML file inside this thread's permitted project roots; supply this or html." },
        title: { type: "string", minLength: 1, maxLength: 200 },
        height: { type: "integer", minimum: 80, maximum: 2000, description: "Optional maximum inline frame height. Default 1200; the frame fits shorter content." }
      }, required: ["title"], additionalProperties: false,
      oneOf: [{ required: ["html"], not: { required: ["path"] } }, { required: ["path"], not: { required: ["html"] } }]
    }
  }, {
    type: "function", name: "list", description: "List published HTML reply references in the current thread, including pages from earlier turns.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }]
}];

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[a-f\d]+|\d+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
function localImageReferences(html) {
  const references = [];
  const image = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const css = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi;
  for (const expression of [image, css]) {
    for (const match of html.matchAll(expression)) {
      const raw = match[1] ?? match[2] ?? match[3];
      const value = decodeAttribute(raw).trim();
      if (!value || /^(?:data:|https?:|blob:|\/\/|#)/i.test(value)) continue;
      if (/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("file://")) continue;
      const offset = match[0].lastIndexOf(raw);
      references.push({ start: match.index + offset, end: match.index + offset + raw.length, path: value });
    }
  }
  return references.sort((left, right) => left.start - right.start).filter((entry, index, all) => !index || entry.start >= all[index - 1].end);
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "image/x-icon";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp" && /^(avif|avis)$/.test(bytes.subarray(8, 12).toString("ascii"))) return "image/avif";
  return null;
}
async function permittedFile(reference, primaryRoot, roots) {
  let cleaned = reference;
  if (cleaned.startsWith("file://")) cleaned = fileURLToPath(cleaned);
  const permittedRoots = await Promise.all((roots?.length ? roots : [primaryRoot]).filter(Boolean).map((root) => realpath(root)));
  if (!permittedRoots.length || !primaryRoot) throw new Error("The thread has no permitted project root");
  const target = await realpath(path.isAbsolute(cleaned) ? cleaned : path.resolve(primaryRoot, cleaned));
  if (!permittedRoots.some((root) => inside(root, target))) throw new Error("HTML reply files and images must be inside this thread's project roots");
  return target;
}
async function boundedRead(target, limit) {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("HTML reply source must be a regular file");
    if (info.size > limit) throw new Error(`HTML reply file exceeds the ${Math.round(limit / 1024 / 1024)} MiB limit`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) throw new Error("HTML reply file grew beyond its size limit");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export async function embedHtmlReplyImages(html, { primaryRoot, roots }) {
  const references = localImageReferences(html);
  if (references.length > 128) throw new Error("An HTML reply can embed at most 128 local image references");
  const replacements = new Map();
  let embeddedBytes = 0;
  for (const reference of references) {
    if (replacements.has(reference.path)) continue;
    let target;
    try { target = await permittedFile(reference.path, primaryRoot, roots); }
    catch (error) { throw new Error(`Cannot embed image ${reference.path}: ${error.message}`); }
    const bytes = await boundedRead(target, MAX_HTML_IMAGE_BYTES);
    const mime = imageMime(bytes);
    if (!mime) throw new Error(`Cannot embed ${reference.path}: only raster image files are supported`);
    const replacement = `data:${mime};base64,${bytes.toString("base64")}`;
    embeddedBytes += Buffer.byteLength(replacement);
    if (embeddedBytes + Buffer.byteLength(html) > MAX_HTML_REPLY_BYTES) throw new Error("The HTML reply with embedded images exceeds 25 MiB");
    replacements.set(reference.path, replacement);
  }
  let cursor = 0;
  const parts = [];
  let totalBytes = Buffer.byteLength(html);
  for (const reference of references) {
    const replacement = replacements.get(reference.path);
    totalBytes += Buffer.byteLength(replacement) - Buffer.byteLength(html.slice(reference.start, reference.end));
    if (totalBytes > MAX_HTML_REPLY_BYTES) throw new Error("The HTML reply with embedded images exceeds 25 MiB");
    parts.push(html.slice(cursor, reference.start), replacement);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}
function publicReply(reply) {
  const { id, threadId, title, height, createdAt } = reply;
  const copiedFromThreadIds = Array.isArray(reply.copiedFromThreadIds) ? [...new Set(reply.copiedFromThreadIds.filter((value) => typeof value === "string" && value.length > 0 && value.length <= 500))].slice(0, 32) : [];
  return { id, threadId, title, height, createdAt, ...(copiedFromThreadIds.length ? { copiedFromThreadIds } : {}), reference: `pixice-html://${encodeURIComponent(threadId)}/${id}` };
}
export class HtmlReplies {
  constructor({ storagePath, userDataPath } = {}) {
    this.storagePath = storagePath ?? path.join(userDataPath, "html-replies");
    this.pending = new Map();
  }
  #threadDirectory(threadId) {
    identifier.parse(threadId);
    return path.join(this.storagePath, createHash("sha256").update(threadId).digest("hex"));
  }
  async #serial(threadId, operation) {
    const previous = this.pending.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(threadId, next);
    try { return await next; } finally { if (this.pending.get(threadId) === next) this.pending.delete(threadId); }
  }
  async publish(input) {
    const { projectId, threadId, primaryRoot, roots } = input;
    identifier.parse(projectId); identifier.parse(threadId);
    const parsed = htmlReplyToolSchemas.publish.parse({ ...(input.html === undefined ? {} : { html: input.html }), ...(input.path === undefined ? {} : { path: input.path }), title: input.title, ...(input.height === undefined ? {} : { height: input.height }) });
    const sourcePath = parsed.path ? await permittedFile(parsed.path, primaryRoot, roots) : null;
    const source = parsed.html ?? (await boundedRead(sourcePath, MAX_HTML_SOURCE_BYTES)).toString("utf8");
    if (Buffer.byteLength(source) > MAX_HTML_SOURCE_BYTES) throw new Error("HTML source exceeds 1 MiB; use smaller embedded data or local raster image references");
    if (source.includes("\0")) throw new Error("HTML reply source contains binary data");
    const html = await embedHtmlReplyImages(source, { primaryRoot: sourcePath ? path.dirname(sourcePath) : primaryRoot, roots: roots?.length ? roots : [primaryRoot] });
    const title = parsed.title.trim();
    const height = parsed.height ?? 1200;
    const id = createHash("sha256").update(JSON.stringify({ html, title, height })).digest("hex");
    return this.#serial(threadId, async () => {
      const directory = this.#threadDirectory(threadId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await this.read({ projectId, threadId, id }).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
      if (existing) return publicReply(existing);
      const files = (await readdir(directory)).filter((name) => /^[a-f\d]{64}\.json$/.test(name));
      if (files.length >= MAX_THREAD_PAGES) throw new Error("This thread has reached its 96 HTML reply limit");
      const totalBytes = (await Promise.all(files.map(async (name) => (await stat(path.join(directory, name))).size))).reduce((sum, size) => sum + size, 0);
      const document = { version: 1, projectId, threadId, id, title, height, html, createdAt: new Date().toISOString() };
      const serialized = JSON.stringify(document);
      if (totalBytes + Buffer.byteLength(serialized) > MAX_THREAD_BYTES) throw new Error("This thread's HTML replies exceed 128 MiB");
      const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
      try { await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" }); await rename(temporary, path.join(directory, `${id}.json`)); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return publicReply(document);
    });
  }
  async read(input) {
    const { projectId, threadId, id } = htmlReplyReadSchema.parse(input);
    const bytes = await boundedRead(path.join(this.#threadDirectory(threadId), `${id}.json`), MAX_HTML_REPLY_BYTES + MAX_HTML_SOURCE_BYTES * 6);
    const document = JSON.parse(bytes.toString("utf8"));
    if (document.version !== 1 || document.projectId !== projectId || document.threadId !== threadId || document.id !== id || typeof document.html !== "string") throw new Error("This HTML reply does not belong to the selected project and thread");
    const digest = createHash("sha256").update(JSON.stringify({ html: document.html, title: document.title, height: document.height })).digest("hex");
    if (digest !== id) throw new Error("The HTML reply attachment is damaged");
    return { ...publicReply(document), html: document.html };
  }
  async list({ projectId, threadId }) {
    identifier.parse(projectId); identifier.parse(threadId);
    const directory = this.#threadDirectory(threadId);
    const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const replies = await Promise.all(files.filter((name) => /^[a-f\d]{64}\.json$/.test(name)).map((name) => this.read({ projectId, threadId, id: name.slice(0, -5) })));
    return replies.map(publicReply).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  async copyThread({ projectId, sourceThreadId, threadId }) {
    identifier.parse(projectId); identifier.parse(sourceThreadId); identifier.parse(threadId);
    if (sourceThreadId === threadId) return this.list({ projectId, threadId });
    const references = await this.list({ projectId, threadId: sourceThreadId });
    const sourceReplies = await Promise.all(references.map((reference) => this.read({ projectId, threadId: sourceThreadId, id: reference.id })));
    return this.#serial(threadId, async () => {
      const directory = this.#threadDirectory(threadId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await this.list({ projectId, threadId });
      const existingIds = new Set(existing.map((reply) => reply.id));
      const documents = sourceReplies.filter((reply) => !existingIds.has(reply.id)).map((reply) => ({ version: 1, projectId, threadId, id: reply.id, title: reply.title, height: reply.height, html: reply.html, createdAt: reply.createdAt, copiedFromThreadIds: [...new Set([sourceThreadId, ...(reply.copiedFromThreadIds ?? [])])].slice(0, 32) }));
      if (existing.length + documents.length > MAX_THREAD_PAGES) throw new Error("The copied thread would exceed its HTML reply limit");
      const existingBytes = (await Promise.all(existing.map(async (reply) => (await stat(path.join(directory, `${reply.id}.json`))).size))).reduce((sum, size) => sum + size, 0);
      const serialized = documents.map((document) => ({ document, content: JSON.stringify(document) }));
      if (existingBytes + serialized.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0) > MAX_THREAD_BYTES) throw new Error("The copied thread's HTML replies would exceed 128 MiB");
      for (const entry of serialized) {
        const temporary = path.join(directory, `${entry.document.id}.${randomUUID()}.tmp`);
        try { await writeFile(temporary, entry.content, { mode: 0o600, flag: "wx" }); await rename(temporary, path.join(directory, `${entry.document.id}.json`)); }
        finally { await rm(temporary, { force: true }).catch(() => {}); }
      }
      return sourceReplies.map((reply) => publicReply({ ...reply, threadId, copiedFromThreadIds: [...new Set([sourceThreadId, ...(reply.copiedFromThreadIds ?? [])])].slice(0, 32) }));
    });
  }
  async deleteThread(threadId) { return this.#serial(threadId, () => rm(this.#threadDirectory(threadId), { recursive: true, force: true })); }
  async invokeTool({ projectId, threadId, tool, arguments: args = {}, primaryRoot, roots }) {
    if (!htmlReplyToolSchemas[tool]) throw new Error(`Unknown HTML reply tool: ${tool}`);
    const input = htmlReplyToolSchemas[tool].parse(args);
    const value = tool === "list" ? await this.list({ projectId, threadId }) : await this.publish({ projectId, threadId, ...input, primaryRoot, roots });
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(tool === "publish" ? { ...value, replyMarkdown: `\`\`\`pixice-html\n${JSON.stringify(value)}\n\`\`\``, instruction: "Include replyMarkdown once in your final answer to display this interactive page." } : { replies: value }) }] };
  }
}
