import { createComposerAttachment } from '../connect/transfer-client.js';

// Clipboard context may move between drafts in this renderer. Keep bounded
// native File handles, never blob URLs; each receiving draft owns its preview.
const files = new Map();
const MAX_FILES = 64;
const MAX_BYTES = 128 * 1024 * 1024;
export function rememberComposerAttachment(attachment, scope) {
  if (!attachment?.file || !attachment.id) return;
  files.delete(attachment.id);
  files.set(attachment.id, { file: attachment.file, metadata: { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size }, scope: { hostId: scope.hostId, projectId: scope.projectId } });
  let bytes = [...files.values()].reduce((sum, item) => sum + item.file.size, 0);
  while (files.size > MAX_FILES || bytes > MAX_BYTES) { const [key, item] = files.entries().next().value; files.delete(key); bytes -= item.file.size; }
}
export function recoverComposerAttachment(record, scope) {
  const id = record.attachmentId ?? record.imageId ?? record.source?.attachmentId;
  const item = id && files.get(id);
  if (!item || item.scope.hostId !== scope.hostId || item.scope.projectId !== scope.projectId) return null;
  return { ...createComposerAttachment(item.file, item.metadata), scope };
}
