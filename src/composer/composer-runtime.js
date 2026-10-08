import { createComposerAttachment } from '../connect/transfer-client.js';

export const COMPOSER_QUEUE_EDIT_EVENT = 'pixice:composer-queue-edit';
export function requestQueueEdit({ projectId, threadId, entry }) {
  if (!projectId || !threadId || !entry) return;
  window.dispatchEvent(new CustomEvent(COMPOSER_QUEUE_EDIT_EVENT, { detail: { projectId, threadId, entry } }));
}
export function attachmentFromDraft(value, scope, imageRecord = null) {
  const metadata = { ...value, id: value.id ?? imageRecord?.imageId ?? imageRecord?.attachmentId ?? imageRecord?.source?.attachmentId, scope };
  const match = /^data:([^;,]*)(?:;[^,;]+)*;base64,([a-z0-9+/=]*)$/i.exec(value.dataUrl ?? '');
  if (!match) return { ...createComposerAttachment(null, metadata), scope, needsReselect: true };
  try {
    const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
    const file = new File([bytes], value.name ?? 'Attachment', { type: value.type || match[1] });
    return { ...createComposerAttachment(file, metadata), scope, dataUrl: value.dataUrl };
  } catch { return { ...createComposerAttachment(null, metadata), scope, needsReselect: true }; }
}
