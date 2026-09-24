import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_FOCUS_VISUALS = 8;
export const MAX_FOCUS_VISUAL_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const types = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
function hasPngChunks(bytes) {
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") imageData = true;
    if (kind === "IEND") return imageData && length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}
const imageType = (bytes) => {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR"
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && hasPngChunks(bytes)) return "png";
  if (bytes.length >= 20 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
    && bytes.includes(Buffer.from([255, 218])) && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].some((marker) => bytes.includes(Buffer.from([255, marker])))) return "jpeg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length
    && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "webp";
  if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 59) return "gif";
  throw new Error("Visual is not a valid PNG, JPEG, WebP, or GIF image.");
};
const safeLabel = (value) => String(value ?? "").trim().slice(0, 120);
const dataBytes = (url) => {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url ?? "");
  if (!match) throw new Error("Selected conversation image has no supported data URL; attach a local image file instead.");
  if (match[2].length > Math.ceil(MAX_FOCUS_VISUAL_BYTES / 3) * 4) throw new Error("Selected conversation image exceeds the size limit.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2] || types[imageType(bytes)] !== `image/${match[1]}`) throw new Error("Selected conversation image data is invalid.");
  return bytes;
};

export class FocusVisuals {
  constructor({ userDataPath, readThread }) {
    this.root = path.join(userDataPath, "focus-visuals");
    this.readThread = readThread;
  }

  async stage(projectId, coordinatorThreadId, selections = []) {
    if (!selections.length) return [];
    if (selections.length > MAX_FOCUS_VISUALS) throw new Error(`Attach at most ${MAX_FOCUS_VISUALS} visuals.`);
    const needsConversation = selections.some((item) => item.source === "conversation");
    const live = needsConversation ? await this.readThread?.({ projectId, threadId: coordinatorThreadId }) : null;
    if (needsConversation && (live?.projectId !== projectId || live?.thread?.id !== coordinatorThreadId || !Array.isArray(live.thread.turns))) {
      throw new Error("Cannot read this project's live coordinator conversation; retry after the thread is available.");
    }
    const messages = (live?.thread?.turns ?? []).flatMap((turn) => turn.items ?? []).filter((item) => item.type === "userMessage");
    // A current Codex tool call may precede the provider's full thread snapshot.
    // The application captures only the input submitted to this active coordinator turn.
    const captured = live?.currentUserInput;
    const latest = captured ? { id: captured.messageId ?? `turn ${captured.turnId}`, content: captured.images.map((url) => ({ type: "image", url })) } : messages.at(-1);
    const staged = [];
    let total = 0;
    for (const selection of selections) {
      let bytes;
      let source;
      if (selection.source === "conversation") {
        const message = selection.messageId
          ? (captured?.messageId === selection.messageId ? latest : messages.find((item) => item.id === selection.messageId))
          : latest;
        if (!message) throw new Error(`User message ${selection.messageId ?? "latest"} was not found in this coordinator conversation.`);
        const images = (message.content ?? []).filter((part) => part.type === "image");
        if (!images[selection.index]) throw new Error(`Image index ${selection.index} was not found in user message ${message.id}.`);
        bytes = dataBytes(images[selection.index].url);
        source = `user message ${message.id}, image ${selection.index}`;
      } else if (selection.source === "file") {
        if (!path.isAbsolute(selection.path)) throw new Error("Visual file path must be absolute.");
        const filename = path.resolve(selection.path);
        if ((await lstat(filename).catch(() => null))?.isSymbolicLink()) throw new Error(`Cannot safely open visual symlink: ${filename}`);
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => { throw new Error(`Cannot safely open visual ${filename}: ${error.message}`); });
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error(`Visual must be a regular file: ${filename}`);
          if (stat.size > MAX_FOCUS_VISUAL_BYTES) throw new Error(`Visual exceeds ${MAX_FOCUS_VISUAL_BYTES} bytes: ${filename}`);
          bytes = await handle.readFile();
        } finally { await handle.close(); }
        source = `local file ${path.basename(filename)}`;
      } else throw new Error("Visual source must be conversation or file.");
      if (bytes.length > MAX_FOCUS_VISUAL_BYTES || (total += bytes.length) > MAX_TOTAL_BYTES) throw new Error("Visual attachments exceed the size limit.");
      const type = imageType(bytes);
      staged.push({ bytes, type, source, label: safeLabel(selection.label) });
    }
    const directory = path.join(this.root, projectId, coordinatorThreadId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result = [];
    for (const item of staged) {
      const name = `${randomUUID()}.${item.type}`;
      const filename = path.join(directory, name);
      const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(item.bytes); } finally { await handle.close(); }
      result.push({ path: filename, mimeType: types[item.type], bytes: item.bytes.length, source: item.source, label: item.label });
    }
    return result;
  }

  async load(projectId, coordinatorThreadId, visuals = []) {
    const directory = path.join(this.root, projectId, coordinatorThreadId);
    const root = await realpath(directory).catch(() => { throw new Error("Staged Focus visuals are missing; reattach them in a follow-up."); });
    const urls = [];
    for (const visual of visuals) {
      if (path.dirname(visual.path) !== directory || path.dirname(await realpath(visual.path).catch(() => "")) !== root) throw new Error("Staged Focus visual path is invalid; reattach the image.");
      const handle = await open(visual.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new Error("Staged Focus visual is missing; reattach the image."); });
      let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== visual.bytes || stat.size > MAX_FOCUS_VISUAL_BYTES) throw new Error("Staged Focus visual changed; reattach the image.");
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      if (types[imageType(bytes)] !== visual.mimeType) throw new Error("Staged Focus visual format changed; reattach the image.");
      urls.push(`data:${visual.mimeType};base64,${bytes.toString("base64")}`);
    }
    return urls;
  }
}
