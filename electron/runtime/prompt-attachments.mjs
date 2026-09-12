import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS, copyFileSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

export function stagePromptAttachments({ attachments, stagedFiles = [], userDataPath, projectId, threadId }) {
  const images = [];
  const files = [];
  if (!attachments?.length && !stagedFiles?.length) return { images, files, root: attachmentProjectRoot(userDataPath, projectId) };

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
  for (const staged of stagedFiles) {
    const mimeType = normalizedMimeType(staged.mimeType);
    if (NATIVE_IMAGE_TYPES.has(mimeType)) {
      const sourceInfo = lstatSync(staged.path);
      if (!sourceInfo.isFile() || sourceInfo.size !== staged.size || sourceInfo.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("The staged image is no longer a regular file");
      images.push(`data:${mimeType};base64,${readFileSync(staged.path).toString("base64")}`);
    } else {
      files.push(stageReadyFile({ source: staged.path, name: staged.name, mimeType, size: staged.size, root }));
    }
  }
  return { images, files, root };
}

async function privateRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

async function writePrivateFile(target, buffer) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, buffer, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function validatedSource(source, size, label) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.size !== size || sourceInfo.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(`The staged ${label} is no longer a regular file`);
  const canonical = await realpath(source);
  return { info: sourceInfo, path: canonical };
}

function sameStableFile(left, right) {
  return left?.isFile?.() === true && right?.isFile?.() === true
    && left.size === right.size && left.dev === right.dev && left.ino === right.ino;
}

async function stageReadyFileAsync({ source, name, mimeType, size, root }) {
  const { info: sourceInfo, path: sourcePath } = await validatedSource(source, size, "attachment");
  const safeName = safeAttachmentName(name);
  const storedPath = path.join(root, `${randomUUID()}-${safeName}`);
  try {
    await copyFile(sourcePath, storedPath);
    const copied = await stat(storedPath);
    const sourceAfter = await lstat(sourcePath);
    if (!copied.isFile() || copied.size !== sourceInfo.size || !sourceAfter.isFile() || sourceAfter.size !== sourceInfo.size || sourceAfter.dev !== sourceInfo.dev || sourceAfter.ino !== sourceInfo.ino) throw new Error("The staged attachment changed while it was being copied");
    await chmod(storedPath, 0o600);
    return { name: safeName, path: storedPath, mimeType: normalizedMimeType(mimeType), size: copied.size };
  } catch (error) {
    await rm(storedPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Remote turns use this asynchronous path so provider calls never wait on a
// synchronous copy or read from the shared backend event loop. Each staged
// file is read or copied independently, keeping the extra memory bounded to
// one file at a time.
export async function stagePromptAttachmentsAsync({ attachments, stagedFiles = [], userDataPath, projectId, threadId }) {
  const images = [];
  const files = [];
  const createdFiles = [];
  if (!attachments?.length && !stagedFiles?.length) return { images, files, root: attachmentProjectRoot(userDataPath, projectId) };

  const root = await privateRoot(path.join(attachmentProjectRoot(userDataPath, projectId), safeSegment(threadId)));
  try {
    for (const attachment of attachments ?? []) {
      const decoded = decodeAttachmentDataUrl(attachment.dataUrl);
      if (decoded.buffer.byteLength > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("Attachments must be 25 MB or smaller");
      const mimeType = normalizedMimeType(decoded.mimeType);
      if (NATIVE_IMAGE_TYPES.has(mimeType)) {
        images.push(attachment.dataUrl);
        continue;
      }
      const name = safeAttachmentName(attachment.name);
      const storedPath = path.join(root, `${randomUUID()}-${name}`);
      await writePrivateFile(storedPath, decoded.buffer);
      createdFiles.push(storedPath);
      files.push({ name, path: storedPath, mimeType, size: decoded.buffer.byteLength });
    }
    for (const staged of stagedFiles ?? []) {
      const mimeType = normalizedMimeType(staged.mimeType);
      if (NATIVE_IMAGE_TYPES.has(mimeType)) {
        const { info: sourceInfo, path: sourcePath } = await validatedSource(staged.path, staged.size, "image");
        const noFollow = FS_CONSTANTS.O_NOFOLLOW ?? 0;
        const handle = await open(sourcePath, FS_CONSTANTS.O_RDONLY | noFollow);
        try {
          const opened = await handle.stat();
          if (!sameStableFile(opened, sourceInfo) || opened.size !== staged.size) throw new Error("The staged image changed while it was being read");
          const buffer = await handle.readFile();
          const after = await handle.stat();
          if (!sameStableFile(after, opened) || buffer.byteLength !== staged.size) throw new Error("The staged image changed while it was being read");
          images.push(`data:${mimeType};base64,${buffer.toString("base64")}`);
        } finally {
          await handle.close().catch(() => {});
        }
      } else {
        const stagedFile = await stageReadyFileAsync({ source: staged.path, name: staged.name, mimeType, size: staged.size, root });
        createdFiles.push(stagedFile.path);
        files.push(stagedFile);
      }
    }
    return { images, files, root };
  } catch (error) {
    await Promise.allSettled(createdFiles.map((pathname) => rm(pathname, { force: true })));
    throw error;
  }
}

function stageReadyFile({ source, name, mimeType, size, root }) {
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isFile() || sourceInfo.size !== size || sourceInfo.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("The staged attachment is no longer a regular file");
  const safeName = safeAttachmentName(name);
  const storedPath = path.join(root, `${randomUUID()}-${safeName}`);
  copyFileSync(source, storedPath);
  const copied = statSync(storedPath);
  if (!copied.isFile() || copied.size !== sourceInfo.size) throw new Error("The staged attachment could not be copied safely");
  return { name: safeName, path: storedPath, mimeType: normalizedMimeType(mimeType), size: copied.size };
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
