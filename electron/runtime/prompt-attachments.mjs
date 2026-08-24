import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_PROMPT_ATTACHMENTS = 10;
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function safeSegment(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 24);
}

export function safeAttachmentName(name) {
  const base = path.basename(String(name ?? "").replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()\[\]-]+/gu, "_").slice(0, 180);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

export function attachmentProjectRoot(userDataPath, projectId) {
  return path.join(userDataPath, "prompt-attachments", safeSegment(projectId));
}

export function decodeAttachmentDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?;base64,([a-z0-9+/=]*)$/i.exec(String(dataUrl ?? ""));
  if (!match) throw new Error("Attachment must be a base64 data URL");
  return { mimeType: match[1]?.toLowerCase() || "application/octet-stream", buffer: Buffer.from(match[2], "base64") };
}

function normalizedMimeType(value) {
  const mimeType = String(value ?? "").toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

export function stagePromptAttachments({ attachments, userDataPath, projectId, threadId }) {
  const images = [];
  const files = [];
  if (!attachments?.length) return { images, files, root: attachmentProjectRoot(userDataPath, projectId) };

  const root = path.join(attachmentProjectRoot(userDataPath, projectId), safeSegment(threadId));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const attachment of attachments) {
    const decoded = decodeAttachmentDataUrl(attachment.dataUrl);
    if (decoded.buffer.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("Attachments must be 25 MB or smaller");
    const mimeType = normalizedMimeType(decoded.mimeType);
    if (NATIVE_IMAGE_TYPES.has(mimeType)) {
      images.push(attachment.dataUrl);
      continue;
    }
    const name = safeAttachmentName(attachment.name);
    const storedPath = path.join(root, `${randomUUID()}-${name}`);
    writeFileSync(storedPath, decoded.buffer, { mode: 0o600 });
    files.push({ name, path: storedPath, mimeType, size: decoded.buffer.byteLength });
  }
  return { images, files, root };
}

export function appendAttachmentContext(text, files) {
  const prompt = String(text ?? "").trim();
  if (!files?.length) return prompt;
  const list = files.map((file) => `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${file.path}`).join("\n");
  const context = [
    "Attached files are available at these local paths:",
    list,
    "Use the paths above when reading or editing the attached files."
  ].join("\n");
  return prompt ? `${prompt}\n\n${context}` : context;
}
