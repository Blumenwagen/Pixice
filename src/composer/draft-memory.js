import { createComposerAttachment, encodeFileAsDataUrl } from '../connect/transfer-client.js';
import { parseContextTokens } from './context.js';

// Behavior reference: T3 Code v0.0.46-nightly.20261008.2813,
// promptStashStore.ts, composerPromptHistory.ts and client-runtime/text-paste.
// A deliberate stash is persisted synchronously before callers clear a draft.
export const DRAFT_STASH_STORAGE_KEY = 'pixice.composer-stash.v1';
export const MAX_STASH_ENTRIES = 20;
export const MAX_STASH_STORAGE_CHARS = 2_500_000;
export const MAX_STASH_ATTACHMENT_CHARS = 1_350_000;
export const LARGE_PASTE_BYTES = 32 * 1024;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function identity() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
function scopeIdentity(scope = {}) { return JSON.stringify([scope.hostId ?? 'local', scope.projectId ?? '']); }
function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function attachmentMetadata(attachment, scope) {
  const fields = ['id', 'name', 'type', 'mimeType', 'size', 'sizeBytes', 'sha256', 'transferId', 'transferState', 'uploadOffset', 'scope', 'scopeKey', 'path', 'source'];
  const metadata = { name: 'Attachment', type: 'application/octet-stream', size: 0, scope };
  for (const key of fields) if (attachment[key] !== undefined) metadata[key] = copy(attachment[key]);
  metadata.name = String(metadata.name).slice(0, 255);
  metadata.id ??= identity();
  return metadata;
}
function decodeAttachment(attachment) {
  const result = { ...attachment, file: null, url: '', needsReselect: true };
  const encoded = /^data:([^;,]*)(?:;[^,;]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(attachment.dataUrl ?? '');
  if (!encoded || typeof File === 'undefined') return result;
  try {
    const bytes = Uint8Array.from(atob(encoded[2]), char => char.charCodeAt(0));
    const file = new File([bytes], attachment.name, { type: attachment.type || encoded[1] || 'application/octet-stream' });
    // A reusable prompt outlives staged-upload leases. Restored bytes upload
    // afresh instead of trusting an expired ID from a previous send/device.
    const restored = createComposerAttachment(file, { ...attachment, transferId: null, transferState: null, uploadOffset: 0 });
    return { ...attachment, ...restored, scope: attachment.scope, dataUrl: attachment.dataUrl, needsReselect: false };
  } catch { return result; }
}

/** Reusable within one host/project. Different threads may share stashes; targets never do. */
export function createDraftMemory({ storage, scope = {}, now = () => Date.now(), maxEntries = MAX_STASH_ENTRIES, maxStorageChars = MAX_STASH_STORAGE_CHARS, maxAttachmentChars = MAX_STASH_ATTACHMENT_CHARS } = {}) {
  const targetStorage = resolveStorage(storage);
  const scopeKey = scopeIdentity(scope);
  const listeners = new Set();
  let ephemeralEntries = [];
  const read = () => {
    try {
      const raw = targetStorage?.getItem(DRAFT_STASH_STORAGE_KEY);
      if (!raw) return targetStorage ? [] : ephemeralEntries;
      if (raw.length > maxStorageChars) return [];
      const parsed = JSON.parse(raw);
      return parsed.version === 1 && Array.isArray(parsed.entries)
        ? parsed.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.scopeKey === 'string' && Array.isArray(entry.attachments)).slice(0, maxEntries)
        : [];
    } catch { return []; }
  };
  const write = entries => {
    try {
      const serialized = JSON.stringify({ version: 1, entries });
      if (serialized.length > maxStorageChars) return { ok: false, durable: false, message: 'The prompt stash is full. Delete a saved prompt or reduce its attachments.' };
      if (targetStorage) targetStorage.setItem(DRAFT_STASH_STORAGE_KEY, serialized);
      else ephemeralEntries = entries;
      listeners.forEach(listener => listener());
      return { ok: true, durable: Boolean(targetStorage) };
    } catch {
      return { ok: false, durable: false, message: 'The prompt could not be saved. Your current draft is still here. Free storage and try again.' };
    }
  };
  const listStashes = () => read().filter(entry => entry.scopeKey === scopeKey);
  return {
    listStashes,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async stash(draft) {
      const text = String(draft?.text ?? '');
      const records = copy(draft?.records ?? draft?.contextRecords ?? []);
      const sourceAttachments = draft?.attachments ?? [];
      if (!text.trim() && !records.length && !sourceAttachments.length) return { ok: false, durable: false, message: 'Write a prompt or attach a file before saving it.' };
      const attachments = [];
      const unavailableAttachments = [];
      let usedChars = 0;
      for (const source of sourceAttachments) {
        const metadata = attachmentMetadata(source, scope);
        let reason = source.file || source.dataUrl ? 'Attachment exceeds the saved-prompt size limit.' : 'The attachment bytes are unavailable. Reselect the file after restoring.';
        let dataUrl = typeof source.dataUrl === 'string' && source.dataUrl.startsWith('data:') ? source.dataUrl : '';
        // Check the base64 estimate before reading an oversized file into memory.
        if (!dataUrl && source.file && Math.ceil(source.file.size * 4 / 3) + usedChars < maxAttachmentChars) {
          try { dataUrl = await encodeFileAsDataUrl(source.file); }
          catch { reason = 'The attachment could not be read. Reselect the file after restoring.'; }
        }
        if (dataUrl && usedChars + dataUrl.length <= maxAttachmentChars) {
          metadata.dataUrl = dataUrl;
          usedChars += dataUrl.length;
        } else {
          metadata.unavailableReason = reason;
          unavailableAttachments.push({ id: metadata.id, name: metadata.name, reason });
        }
        attachments.push(metadata);
      }
      const entry = { id: identity(), createdAt: new Date(now()).toISOString(), scopeKey, scope: copy(scope), text, records, attachments, unavailableAttachments };
      const existing = read();
      const next = [entry, ...existing].slice(0, maxEntries);
      const result = write(next);
      return { ...result, entry: result.ok ? entry : null, unavailableAttachments, evicted: result.ok && existing.length >= maxEntries ? existing.at(-1) : null,
        message: result.message ?? (!result.durable ? 'Saved for this session only. Keep your current draft until durable storage is available.' : unavailableAttachments.length ? `Prompt saved. ${unavailableAttachments.length} attachment${unavailableAttachments.length === 1 ? '' : 's'} will need reselecting when restored.` : 'Prompt saved.') };
    },
    restore(id) {
      const entry = listStashes().find(candidate => candidate.id === id);
      if (!entry) return { ok: false, durable: Boolean(targetStorage), message: 'That saved prompt is no longer available for this project.' };
      const attachments = entry.attachments.map(decodeAttachment);
      const unavailableAttachments = attachments.filter(attachment => attachment.needsReselect).map(attachment => ({ id: attachment.id, name: attachment.name, reason: attachment.unavailableReason ?? 'Reselect the file before sending.' }));
      // Restore is non-destructive: a reusable prompt stays saved, even if its
      // attachment needs repair or the application closes immediately afterward.
      return { ok: true, durable: Boolean(targetStorage), entry, draft: { text: entry.text, records: copy(entry.records ?? entry.contextRecords ?? []), contextRecords: copy(entry.records ?? entry.contextRecords ?? []), attachments }, unavailableAttachments,
        message: unavailableAttachments.length ? `Restored. Reselect ${unavailableAttachments.map(attachment => attachment.name).join(', ')} before sending.` : 'Prompt restored.' };
    },
    remove(id) {
      const entries = read();
      if (!entries.some(entry => entry.id === id && entry.scopeKey === scopeKey)) return { ok: false, durable: Boolean(targetStorage) };
      return write(entries.filter(entry => entry.id !== id || entry.scopeKey !== scopeKey));
    }
  };
}

export function stripGeneratedAttachmentContext(text, { attachmentOnlyNames = false } = {}) {
  // Match only appendAttachmentContext's terminal block, including its exact
  // list format. Ordinary user-written paths and attachment prose stay intact.
  const suffix = /(?:^|\n\n)Attached files are available at these local paths:\n((?:- [^\n]+\n)+)Use the paths above when reading or editing the attached files\.$/.exec(text.trimEnd());
  if (!suffix) return text;
  const files = suffix[1].trimEnd().split('\n');
  const names = [];
  const generatedFile = /^- ("(?:[^"\\\r\n]|\\.)*") \(([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[ \t]*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*), (0|[1-9]\d*) bytes\): (?:\/|[a-z]:[\\/]|\\\\)[^\r\n]+$/i;
  if (!files.every(line => {
    const file = generatedFile.exec(line);
    if (!file) return false;
    try {
      const name = JSON.parse(file[1]);
      if (JSON.stringify(name) !== file[1]) return false;
      names.push(name);
      return true;
    }
    catch { return false; }
  })) return text;
  const prompt = text.slice(0, suffix.index);
  return attachmentOnlyNames && !prompt.trim() ? names.join('\n') : prompt;
}

/** Strip application-appended context. Recall never reconstructs chips, files or stale IDs. */
export function recallablePrompt(message) {
  let text = String(typeof message === 'string' ? message : message?.promptText ?? message?.text ?? '');
  if (!text && Array.isArray(message?.content)) text = message.content.filter(part => part.type === 'text' || typeof part.text === 'string').map(part => part.text ?? '').join('\n');
  text = stripGeneratedAttachmentContext(text);
  text = text.replace(/\s*<(pixice-preview-context|pixice-composer-context|composer_context|context-reference|terminal_context|element_context|preview_annotation|review_comment)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  for (const token of parseContextTokens(text).toReversed()) {
    const end = text[token.end] === ' ' ? token.end + 1 : token.end;
    text = text.slice(0, token.start) + text.slice(end);
  }
  return text.replace(/^Ultrathink:\n/, '').trim();
}
export function buildPromptHistoryEntries(messages = []) {
  const result = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user' && message.type !== 'userMessage') continue;
    if (message.accepted === false || message.status === 'failed' || message.pending || (String(message.id).startsWith('local-user:') && message.accepted !== true)) continue;
    const prompt = recallablePrompt(message);
    if (!prompt || prompt === '[User attached one or more files without additional text. Respond using the conversation context and the attached files.]') continue;
    const entry = { id: String(message.id ?? index), prompt };
    if (result.at(-1)?.prompt === prompt) result[result.length - 1] = entry;
    else result.push(entry);
  }
  return result;
}

function eligibleNativePrompt(message) {
  if (message.role !== 'user' && message.type !== 'userMessage') return false;
  return message.id != null && String(message.id).length > 0 && message.accepted !== false && message.status !== 'failed' && !message.pending && !String(message.id).startsWith('local-user:');
}

/** Snapshot before submitting; optimistic IDs cannot anchor an acknowledgement. */
export function acceptedPromptHistoryAnchor(messages = []) {
  const message = messages.findLast(eligibleNativePrompt);
  return message ? String(message.id) : null;
}

/**
 * The accepted-send cache bridges the brief gap before native history arrives.
 * Reconcile against messages after the submission's native-history anchor;
 * matching older identical prompts would erase a new, unacknowledged send.
 * Native entries are consumed once and in accepted-send order. Keep uncertain
 * anchors until a future authoritative snapshot can establish their position.
 */
export function reconcileAcceptedPromptHistory(nativeMessages = [], acceptedPrompts = []) {
  const native = nativeMessages.filter(eligibleNativePrompt).map(message => ({ id: String(message.id), prompt: recallablePrompt(message) }));
  const remaining = [];
  let nextNativeIndex = 0;
  for (const accepted of acceptedPrompts) {
    const anchor = accepted.historyAnchorId;
    // Only an explicit null means the composer had no native history. Older
    // cache records lacking anchor metadata cannot safely acknowledge repeats.
    if (anchor === undefined) { remaining.push(accepted); continue; }
    const anchorIndex = anchor === null ? -1 : native.findIndex(message => message.id === String(anchor));
    if (anchor !== null && anchorIndex < 0) { remaining.push(accepted); continue; }
    const consumedIndex = accepted.historyAcknowledgedThroughId == null ? -1 : native.findIndex(message => message.id === String(accepted.historyAcknowledgedThroughId));
    if (accepted.historyAcknowledgedThroughId != null && consumedIndex < 0) { remaining.push(accepted); continue; }
    const prompt = recallablePrompt(accepted);
    const start = Math.max(anchorIndex + 1, consumedIndex + 1, nextNativeIndex);
    const match = native.findIndex((message, index) => index >= start && message.prompt === prompt);
    if (match < 0) {
      // Carry consumed history forward when callers prune acknowledged cache
      // entries. A later identical send must not consume the same native
      // acknowledgement again on the next render.
      remaining.push(nextNativeIndex > Math.max(anchorIndex + 1, consumedIndex + 1) ? { ...accepted, historyAcknowledgedThroughId: native[nextNativeIndex - 1].id } : accepted);
    }
    else nextNativeIndex = match + 1;
  }
  return remaining;
}

/** Called only at the editor's visual start/end; a typed draft is never overwritten by Up. */
export function stepPromptHistory({ direction, entries = [], position = null, currentText = '', attachments = [], records = [], atVisualEdge = true, event = null } = {}) {
  if (!atVisualEdge || attachments.length || records.length || event?.isComposing || event?.shiftKey || event?.altKey || event?.metaKey || event?.ctrlKey) return null;
  let activeIndex = -1;
  if (position?.recalled === currentText) {
    activeIndex = entries.findIndex(entry => entry.id === position.entryId);
    if (activeIndex < 0) activeIndex = entries.findLastIndex(entry => entry.prompt === position.recalled);
  }
  const backward = direction === 'backward' || direction === 'up';
  if (backward && activeIndex < 0 && currentText.length) return null;
  if (!backward && activeIndex < 0) return null;
  const entry = entries[backward ? activeIndex < 0 ? entries.length - 1 : activeIndex - 1 : activeIndex + 1];
  if (!entry) return !backward && activeIndex >= 0 ? { position: null, text: '', prompt: '' } : null;
  return { position: { entryId: entry.id, recalled: entry.prompt }, text: entry.prompt, prompt: entry.prompt };
}

export function nextPastedTextFileName(names = []) {
  const used = new Set(names);
  for (let index = 1; ; index++) {
    const name = index === 1 ? 'pasted-text.txt' : `pasted-text-${index}.txt`;
    if (!used.has(name)) return name;
  }
}
export function pasteToAttachment(text, { shiftKey = false, bypassAutoAttachment = false, names = [], name, maxFileBytes = 25 * 1024 * 1024 } = {}) {
  if (shiftKey || bypassAutoAttachment || typeof text !== 'string' || new TextEncoder().encode(text).byteLength < LARGE_PASTE_BYTES || typeof File === 'undefined') return null;
  const file = new File([text], name ?? nextPastedTextFileName(names), { type: 'text/plain;charset=utf-8' });
  if (file.size > maxFileBytes) return null;
  return { file, name: file.name, type: file.type, size: file.size, source: { type: 'pasted-text' }, message: `Large paste attached as ${file.name}. Use Shift-paste to keep it inline.` };
}
