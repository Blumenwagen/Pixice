import { describe, expect, it, vi } from 'vitest';
import { acceptedPromptHistoryAnchor, buildPromptHistoryEntries, createDraftMemory, DRAFT_STASH_STORAGE_KEY, LARGE_PASTE_BYTES, nextPastedTextFileName, pasteToAttachment, recallablePrompt, reconcileAcceptedPromptHistory, stepPromptHistory, stripGeneratedAttachmentContext } from '../src/composer/draft-memory.js';
import { appendAttachmentContext } from '../electron/runtime/prompt-attachments.mjs';

function storageAdapter() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function readFile(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(file); });
}

describe('durable reusable prompt stash', () => {
  it('restores typed text, context records and file bytes after a reload without consuming the prompt', async () => {
    const storage = storageAdapter();
    const scope = { hostId: 'host', projectId: 'project' };
    const memory = createDraftMemory({ storage, scope, now: () => 1000 });
    const context = { version: 1, id: 'citation', kind: 'citation', text: 'Quoted content', comment: 'Adjust this', source: { threadId: 'previous' } };
    const file = new File(['image bytes'], 'image.png', { type: 'image/png' });
    const result = await memory.stash({ text: 'Compare [quoted](pixice-context://v1/citation/citation)', records: [context], attachments: [{ id: 'image', name: file.name, type: file.type, size: file.size, file, transferId: 'expired', transferState: 'ready', uploadOffset: file.size }] });
    expect(result).toMatchObject({ ok: true, durable: true, unavailableAttachments: [] });
    const reloaded = createDraftMemory({ storage, scope });
    const restored = reloaded.restore(result.entry.id);
    expect(restored.draft.text).toBe(result.entry.text);
    expect(restored.draft.contextRecords).toEqual([context]);
    expect(restored.draft.attachments[0]).toMatchObject({ id: 'image', name: 'image.png', needsReselect: false, transferId: null, uploadOffset: 0 });
    expect(await readFile(restored.draft.attachments[0].file)).toBe('image bytes');
    expect(reloaded.listStashes()).toHaveLength(1);
    expect(reloaded.restore(result.entry.id).ok).toBe(true);
  });
  it('keeps unavailable and oversized file metadata with explicit repair feedback', async () => {
    const memory = createDraftMemory({ storage: storageAdapter(), scope: { projectId: 'p' }, maxAttachmentChars: 10 });
    const saved = await memory.stash({ text: 'Review these', attachments: [
      { id: 'large', name: 'large.png', type: 'image/png', size: 100, file: new File(['payload too large'], 'large.png', { type: 'image/png' }) },
      { id: 'lost', name: 'lost.txt', type: 'text/plain', size: 10 }
    ] });
    expect(saved.ok).toBe(true);
    expect(saved.unavailableAttachments.map(file => file.name)).toEqual(['large.png', 'lost.txt']);
    const restored = memory.restore(saved.entry.id);
    expect(restored.draft.attachments.every(file => file.needsReselect)).toBe(true);
    expect(restored.message).toContain('Reselect large.png, lost.txt');
  });
  it('rejects failed durable writes without exposing a phantom stash or evicting existing entries', async () => {
    const storage = storageAdapter();
    const memory = createDraftMemory({ storage, maxEntries: 1 });
    const old = await memory.stash({ text: 'Keep this' });
    storage.setItem = vi.fn(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    const failed = await memory.stash({ text: 'New draft' });
    expect(failed).toMatchObject({ ok: false, durable: false, entry: null });
    expect(memory.listStashes().map(entry => entry.id)).toEqual([old.entry.id]);
  });
  it('isolates stashes by host/project and bounds old entries without mutating the draft', async () => {
    const storage = storageAdapter();
    const first = createDraftMemory({ storage, scope: { hostId: 'one', projectId: 'p' }, maxEntries: 2 });
    const draft = { text: 'one', records: [], attachments: [] };
    await first.stash(draft);
    await first.stash({ text: 'two' });
    const third = await first.stash({ text: 'three' });
    expect(third.evicted.text).toBe('one');
    expect(draft).toEqual({ text: 'one', records: [], attachments: [] });
    expect(first.listStashes().map(entry => entry.text)).toEqual(['three', 'two']);
    expect(createDraftMemory({ storage, scope: { hostId: 'two', projectId: 'p' } }).listStashes()).toEqual([]);
    expect(createDraftMemory({ storage, scope: { hostId: 'one', projectId: 'other' } }).restore(third.entry.id).ok).toBe(false);
  });
  it('keeps a prompt in the composer when its whole serialized entry exceeds the bounded store', async () => {
    const memory = createDraftMemory({ storage: storageAdapter(), maxStorageChars: 100 });
    const result = await memory.stash({ text: 'A'.repeat(200) });
    expect(result).toMatchObject({ ok: false, durable: false, entry: null });
    expect(memory.listStashes()).toEqual([]);
  });
  it('tolerates damaged stored JSON', () => {
    const storage = storageAdapter();
    storage.setItem(DRAFT_STASH_STORAGE_KEY, '{bad');
    expect(createDraftMemory({ storage }).listStashes()).toEqual([]);
  });
});

describe('accepted prompt recall', () => {
  it('keeps only accepted user text and strips chips plus provider-expanded context', () => {
    const messages = [
      { id: 'assistant', role: 'assistant', text: 'Answer' },
      { id: 'local-user:pending', role: 'user', text: 'Still sending' },
      { id: 'failed', role: 'user', text: 'Rejected', accepted: false },
      { id: 'one', role: 'user', text: 'Review [source](pixice-context://v1/citation/ref)' },
      { id: 'two', role: 'user', text: 'Review\n<context-reference kind="citation" label="source">\nPrivate source excerpt\n</context-reference>' },
      { id: 'local-user:accepted', role: 'user', accepted: true, text: 'Continue' },
      { id: 'attachment', role: 'user', text: '' }
    ];
    expect(buildPromptHistoryEntries(messages)).toEqual([{ id: 'two', prompt: 'Review' }, { id: 'local-user:accepted', prompt: 'Continue' }]);
    expect(recallablePrompt({ type: 'userMessage', content: [{ type: 'text', text: 'From native runtime' }, { type: 'image', url: 'image' }] })).toBe('From native runtime');
    expect(recallablePrompt('Read [strange \\[name\\]](pixice-context://v1/file/id%3Aone) then answer')).toBe('Read then answer');
  });
  it('recalls and acknowledges original text without the runtime-generated upload paths', () => {
    const files = [
      { name: 'notes [final].txt', mimeType: 'text/plain', size: 42, path: '/Users/example/Library/Application Support/Pixice/prompt-attachments/id-notes [final].txt' },
      { name: 'data.csv', mimeType: 'text/csv', size: 0, path: 'C:\\Users\\example\\Pixice\\prompt-attachments\\id-data.csv' }
    ];
    const original = 'Review the attached files\n\nand explain the result.';
    const nativeText = appendAttachmentContext(`${original}\n<context-reference kind="file" label="notes [final].txt">\nSelected file information\n</context-reference>`, files);
    expect(recallablePrompt(nativeText)).toBe(original);
    expect(buildPromptHistoryEntries([{ id: 'native-file', type: 'userMessage', content: [{ type: 'text', text: nativeText }] }])).toEqual([{ id: 'native-file', prompt: original }]);
    expect(reconcileAcceptedPromptHistory([{ id: 'native-file', role: 'user', text: nativeText }], [{ id: 'sent-file', text: `${original} [notes](pixice-context://v1/file/upload)`, historyAnchorId: null }])).toEqual([]);
    // History cleanup must never alter the actual provider input generator.
    expect(nativeText).toContain(files[0].path);
  });
  it('excludes attachment-only native messages from prompt recall', () => {
    const nativeText = appendAttachmentContext('', [{ name: 'document.pdf', mimeType: 'application/pdf', size: 128, path: '/tmp/pixice/prompt-attachments/document.pdf' }]);
    expect(stripGeneratedAttachmentContext(nativeText, { attachmentOnlyNames: true })).toBe('document.pdf');
    expect(recallablePrompt(nativeText)).toBe('');
    expect(buildPromptHistoryEntries([{ id: 'attachment-only', role: 'user', text: nativeText }])).toEqual([]);
    expect(stepPromptHistory({ direction: 'backward', entries: buildPromptHistoryEntries([{ id: 'attachment-only', role: 'user', text: nativeText }]) })).toBeNull();
  });
  it('strips generated file context with MIME parameters from large pasted text', () => {
    const nativeText = appendAttachmentContext('Review this paste', [{ name: 'pasted-text.txt', mimeType: 'text/plain;charset=utf-8', size: LARGE_PASTE_BYTES, path: '/tmp/pixice/prompt-attachments/pasted-text.txt' }]);
    expect(recallablePrompt(nativeText)).toBe('Review this paste');
    expect(reconcileAcceptedPromptHistory([{ id: 'native-paste', role: 'user', text: nativeText }], [{ id: 'sent-paste', text: 'Review this paste [pasted-text.txt](pixice-context://v1/file/paste)', historyAnchorId: null }])).toEqual([]);
  });
  it('preserves user paths, similar prose and malformed or nonterminal attachment blocks', () => {
    const generated = appendAttachmentContext('Keep this', [{ name: 'notes.txt', mimeType: 'text/plain', size: 42, path: '/tmp/pixice/notes.txt' }]);
    const userText = 'Read /work/source/notes.txt and keep that path in the explanation.';
    expect(recallablePrompt(userText)).toBe(userText);
    for (const text of [
      `${generated}\nThen compare another file.`,
      generated.replace('"notes.txt"', 'notes.txt'),
      generated.replace('42 bytes', 'many bytes'),
      generated.replace('/tmp/pixice/notes.txt', 'a local file'),
      generated.replace('Use the paths above when reading or editing the attached files.', 'Use these paths for my example.'),
      generated.replace('\n\nAttached files', '\nAttached files')
    ]) expect(recallablePrompt(text)).toBe(text);
  });
  it('navigates at visual boundaries, remains stable across message IDs changing, and never overwrites a typed draft', () => {
    const entries = [{ id: 'old', prompt: 'First' }, { id: 'new', prompt: 'Last\nwrapped text' }];
    const last = stepPromptHistory({ direction: 'backward', entries, currentText: '' });
    expect(last.text).toBe('Last\nwrapped text');
    expect(stepPromptHistory({ direction: 'backward', entries, position: last.position, currentText: last.text, atVisualEdge: false })).toBeNull();
    const first = stepPromptHistory({ direction: 'backward', entries: [{ ...entries[0] }, { ...entries[1], id: 'acknowledged' }], position: last.position, currentText: last.text });
    expect(first.text).toBe('First');
    const forward = stepPromptHistory({ direction: 'forward', entries, position: first.position, currentText: first.text });
    expect(stepPromptHistory({ direction: 'forward', entries, position: forward.position, currentText: forward.text })).toMatchObject({ position: null, text: '' });
    expect(stepPromptHistory({ direction: 'backward', entries, position: last.position, currentText: 'User edited this' })).toBeNull();
    expect(stepPromptHistory({ direction: 'backward', entries, currentText: 'New draft' })).toBeNull();
  });
  it('does not pair recalled text with current attachments, context or modified arrow shortcuts', () => {
    const input = { direction: 'backward', entries: [{ id: 'one', prompt: 'Previous' }], currentText: '' };
    expect(stepPromptHistory({ ...input, attachments: [{ name: 'new.png' }] })).toBeNull();
    expect(stepPromptHistory({ ...input, records: [{ id: 'context' }] })).toBeNull();
    expect(stepPromptHistory({ ...input, event: { altKey: true } })).toBeNull();
    expect(stepPromptHistory({ ...input, event: { isComposing: true } })).toBeNull();
  });

  it('acknowledges accepted sends only after their native submission anchor, retaining an old A/B repeat', () => {
    const native = [
      { id: 'old-a', role: 'user', text: 'A' }, { id: 'old-b', role: 'user', text: 'B' },
      { id: 'last-old-a', role: 'user', text: 'A' }, { id: 'last-old-b', role: 'user', text: 'B' }
    ];
    const accepted = [{ id: 'new-a', text: 'A', accepted: true, historyAnchorId: 'last-old-b' }, { id: 'new-b', text: 'B', accepted: true, historyAnchorId: 'last-old-b' }];
    expect(reconcileAcceptedPromptHistory(native, accepted)).toEqual(accepted);
    const oneAcknowledged = [...native, { id: 'native-new-a', role: 'user', text: 'A' }];
    expect(reconcileAcceptedPromptHistory(oneAcknowledged, accepted)).toEqual([{ ...accepted[1], historyAcknowledgedThroughId: 'native-new-a' }]);
    expect(reconcileAcceptedPromptHistory([...oneAcknowledged, { id: 'native-new-b', role: 'user', text: 'B' }], accepted)).toEqual([]);
    expect(native).toHaveLength(4);
    expect(accepted).toHaveLength(2);
  });

  it('consumes identical native acknowledgements once while respecting accepted send order', () => {
    const accepted = [{ id: 'one', text: 'Again', historyAnchorId: null }, { id: 'two', text: 'Again', historyAnchorId: null }];
    const native = [{ id: 'native-one', role: 'user', text: 'Again' }];
    const remaining = reconcileAcceptedPromptHistory(native, accepted);
    expect(remaining).toEqual([{ ...accepted[1], historyAcknowledgedThroughId: 'native-one' }]);
    expect(reconcileAcceptedPromptHistory(native, remaining)).toEqual(remaining);
    expect(reconcileAcceptedPromptHistory([...native, { id: 'native-two', role: 'user', text: 'Again' }], accepted)).toEqual([]);
    const ordered = [{ id: 'one', text: 'First', historyAnchorId: null }, { id: 'two', text: 'Second', historyAnchorId: null }];
    expect(reconcileAcceptedPromptHistory([{ id: 'native-second', role: 'user', text: 'Second' }, { id: 'native-first', role: 'user', text: 'First' }], ordered)).toEqual([{ ...ordered[1], historyAcknowledgedThroughId: 'native-first' }]);
  });

  it('keeps unknown or missing anchors and ignores failed sends, assistant text and optimistic messages', () => {
    const native = [
      { id: 'assistant', role: 'assistant', text: 'Same text' },
      { id: 'local-user:optimistic', role: 'user', text: 'Same text' },
      { id: 'failed', role: 'user', accepted: false, text: 'Same text' },
      { id: 'pending', role: 'user', pending: true, text: 'Same text' },
      { id: 'anchor', role: 'user', text: 'Same text' }
    ];
    const accepted = [{ id: 'unknown', text: 'Same text', historyAnchorId: 'unloaded' }, { id: 'legacy', text: 'Same text' }, { id: 'after', text: 'Same text', historyAnchorId: 'anchor' }];
    expect(reconcileAcceptedPromptHistory(native, accepted)).toEqual(accepted);
    expect(reconcileAcceptedPromptHistory(native, [{ id: 'empty-history', text: 'Same text', historyAnchorId: null }])).toEqual([]);
  });

  it('compares the typed prompt across canonical chips and native expanded context', () => {
    const accepted = [{ id: 'sent', text: 'Review [source](pixice-context://v1/citation/selection)', historyAnchorId: null }];
    const native = [{ id: 'ack', type: 'userMessage', content: [{ type: 'text', text: 'Review\n<context-reference kind="citation" label="source">\nQuoted source content\n</context-reference>\n' }] }];
    expect(reconcileAcceptedPromptHistory(native, accepted)).toEqual([]);
  });

  it('anchors only stable authoritative user messages and ignores optimistic or unavailable IDs', () => {
    const messages = [
      { id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'Sent prompt' }] },
      { id: 'assistant', role: 'assistant', text: 'Reply' },
      { id: 'local-user:pending', role: 'user', text: 'Still sending' },
      { id: 'local-user:accepted', role: 'user', accepted: true, text: 'Acknowledged locally; awaiting native identity' },
      { id: 'failed', role: 'user', accepted: false, text: 'Failed' },
      { id: 'pending', role: 'user', pending: true, text: 'Pending' },
      { role: 'user', text: 'No stable identity' }
    ];
    expect(acceptedPromptHistoryAnchor(messages)).toBe('native-user');
    expect(acceptedPromptHistoryAnchor(messages.slice(1))).toBeNull();
    expect(acceptedPromptHistoryAnchor([])).toBeNull();
    expect(reconcileAcceptedPromptHistory([{ role: 'user', text: 'Unidentified' }], [{ id: 'local', text: 'Unidentified', historyAnchorId: null }])).toHaveLength(1);
  });
});

describe('large clipboard paste', () => {
  it('uses the UTF-8 threshold, retains exact bytes and avoids duplicate attachment names', async () => {
    expect(pasteToAttachment('x'.repeat(LARGE_PASTE_BYTES - 1))).toBeNull();
    const text = '🧑'.repeat(LARGE_PASTE_BYTES / 4);
    const result = pasteToAttachment(text, { names: ['pasted-text.txt', 'pasted-text-2.txt'] });
    expect(result.name).toBe('pasted-text-3.txt');
    expect(result.file.size).toBe(LARGE_PASTE_BYTES);
    expect(await readFile(result.file)).toBe(text);
    expect(nextPastedTextFileName(['pasted-text.txt', 'pasted-text-3.txt'])).toBe('pasted-text-2.txt');
  });
  it('allows shift-paste to keep large text editable and falls through when file capacity is unavailable', () => {
    const text = 'x'.repeat(LARGE_PASTE_BYTES);
    expect(pasteToAttachment(text, { shiftKey: true })).toBeNull();
    expect(pasteToAttachment(text, { bypassAutoAttachment: true })).toBeNull();
    expect(pasteToAttachment(text, { maxFileBytes: 10 })).toBeNull();
  });
});
