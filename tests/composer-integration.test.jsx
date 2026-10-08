import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/App.jsx';
import { createContextRecord, requestComposerContext, serializeContextToken } from '../src/composer/context.js';
import { requestQueueEdit } from '../src/composer/composer-runtime.js';
import { DRAFT_STASH_STORAGE_KEY, LARGE_PASTE_BYTES } from '../src/composer/draft-memory.js';
import { changeEditable, editableValue, installPromptEditorGeometry, toHaveEditableValue } from './helpers/prompt-editor.js';

beforeAll(installPromptEditorGeometry);
expect.extend({ toHaveEditableValue });
function storageAdapter() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; }
function composerProps(overrides = {}) {
  return {
    disabled: false, busy: false, draftKey: 'project:thread', preserveDrafts: true, sendShortcut: 'enter', spellCheckComposer: true,
    autoFocusComposer: false, showSlashCommands: true, running: false, models: [{ model: 'model', displayName: 'Model', provider: 'codex', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
    selectedModel: 'model', onModelChange: vi.fn(), effort: 'high', onEffortChange: vi.fn(), fastMode: false, onFastModeChange: vi.fn(),
    permissionMode: 'workspace-write', onPermissionModeChange: vi.fn(), providers: [], onProviderLogin: vi.fn(), onProvidersRefresh: vi.fn(),
    onSubmit: vi.fn(async () => true), onInterrupt: vi.fn(), storage: storageAdapter(), attachmentContext: { hostId: 'local', projectId: 'project', deviceId: 'local', threadId: 'thread', api: {} }, ...overrides
  };
}

describe('T3-reference composer workflows', () => {
  it('keeps slash-command keyboard selection while completing into the rich editor', async () => {
    render(<Composer {...composerProps()} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: '/' } });
    expect(screen.getByRole('option', { name: /\/model/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(prompt, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /\/fast/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(prompt, { key: 'Enter' });
    await waitFor(() => expect(prompt).toHaveEditableValue('/fast '));
  });
  it('stashes text with its context, clears only after durable save, and restores from the empty composer', async () => {
    const props = composerProps();
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Revise this passage ' } });
    const quote = createContextRecord('citation', { id: 'quote', label: 'Previous answer', text: 'A selected passage', comment: 'Make this clearer', source: { projectId: 'project', threadId: 'earlier', messageId: 'answer' } });
    act(() => requestComposerContext({ projectId: 'project', threadId: 'thread', record: quote }));
    expect(await screen.findByRole('button', { name: 'citation: Previous answer' })).toBeInTheDocument();
    const original = editableValue(prompt);
    fireEvent.keyDown(prompt, { key: 's', metaKey: true });
    await waitFor(() => expect(prompt).toHaveEditableValue(''));
    expect(screen.queryByRole('button', { name: 'citation: Previous answer' })).toBeNull();
    const saved = JSON.parse(props.storage.getItem(DRAFT_STASH_STORAGE_KEY)).entries[0];
    expect(saved).toMatchObject({ text: original, records: [expect.objectContaining({ id: 'quote', text: 'A selected passage', comment: 'Make this clearer' })] });
    fireEvent.keyDown(prompt, { key: 's', ctrlKey: true });
    await waitFor(() => expect(prompt).toHaveEditableValue(original));
    expect(screen.getByRole('button', { name: 'citation: Previous answer' })).toBeInTheDocument();
    expect(JSON.parse(props.storage.getItem(DRAFT_STASH_STORAGE_KEY)).entries).toHaveLength(1);
  });

  it('selects an @ file at the caret and sends its canonical source record alongside the exact prompt', async () => {
    const api = { files: { list: vi.fn(async () => ({ files: [{ name: 'utils.js', relativePath: 'src/utils.js', path: '/work/project/src/utils.js' }] })) } };
    const props = composerProps({ attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Inspect @utils' } });
    const option = await screen.findByRole('option', { name: /src\/utils.js/ });
    fireEvent.click(option);
    expect(await screen.findByRole('button', { name: 'file: src/utils.js' })).toBeInTheDocument();
    const source = editableValue(prompt);
    expect(source).toMatch(/^Inspect \[src\/utils\.js\]\(pixice-context:\/\/v1\/file\//);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    expect(props.onSubmit.mock.calls[0][0]).toBe(source.trim());
    expect(props.onSubmit.mock.calls[0][5].contextRecords).toEqual([expect.objectContaining({ kind: 'file', source: expect.objectContaining({ projectId: 'project', path: '/work/project/src/utils.js' }) })]);
    await waitFor(() => expect(prompt).toHaveEditableValue(''));
  });

  it.each([
    ['list', '- Inspect @utils', 'listItem'],
    ['quote', '> Inspect @utils', 'blockquote']
  ])('completes @ context with Enter inside a rich %s without adding a block or submitting', async (_label, source, blockType) => {
    const api = { files: { list: vi.fn(async () => ({ files: [{ name: 'utils.js', relativePath: 'src/utils.js', path: '/work/project/src/utils.js' }] })) } };
    const props = composerProps({ attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: source } });
    expect(prompt.editor.isActive(blockType)).toBe(true);
    const option = await screen.findByRole('option', { name: /src\/utils.js/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(prompt).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(prompt.getAttribute('aria-controls'))).toBe(screen.getByRole('listbox', { name: 'Context results' }));
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(await screen.findByRole('button', { name: 'file: src/utils.js' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Context results' })).toBeNull();
    const completed = editableValue(prompt);
    expect(completed).toContain('[src/utils.js](pixice-context://v1/file/');
    expect(completed).not.toContain('@utils');
    expect(completed).not.toContain('\n');
    let blocks = 0;
    prompt.editor.state.doc.descendants(node => { if (node.type.name === blockType) blocks++; });
    expect(blocks).toBe(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('turns a 32 KiB paste into a native file attachment and sends exact bytes with its inline reference', async () => {
    const props = composerProps();
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    const contents = 'x'.repeat(LARGE_PASTE_BYTES);
    fireEvent.paste(prompt, { clipboardData: { files: [], items: [], getData: type => type === 'text/plain' ? contents : '' } });
    expect(await screen.findByRole('button', { name: 'file: pasted-text.txt' })).toBeInTheDocument();
    expect(editableValue(prompt).length).toBeLessThan(300);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    const prepared = props.onSubmit.mock.calls[0][2];
    expect(prepared.attachments).toHaveLength(1);
    expect(prepared.attachments[0]).toMatchObject({ name: 'pasted-text.txt', size: LARGE_PASTE_BYTES });
    expect(atob(prepared.attachments[0].dataUrl.split(',')[1])).toBe(contents);
    expect(props.onSubmit.mock.calls[0][5].contextRecords[0]).toMatchObject({ kind: 'file', label: 'pasted-text.txt' });
  });

  it('cancels composer-based queued editing back to the existing draft and context without changing the queue', async () => {
    const queuedQuote = createContextRecord('citation', { id: 'queued-quote', label: 'Queued source', text: 'Queued excerpt', source: { projectId: 'project' } });
    const api = { turns: { queueDraft: vi.fn(async () => ({ id: 'entry', text: 'Edit queued request', contextRecords: [queuedQuote], attachments: [] })), queueEdit: vi.fn() } };
    const props = composerProps({ running: true, queueEnabled: true, attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Keep my next request ' } });
    const originalQuote = createContextRecord('citation', { id: 'original-quote', label: 'My source', text: 'Unsent excerpt', source: { projectId: 'project' } });
    act(() => requestComposerContext({ projectId: 'project', threadId: 'thread', record: originalQuote }));
    await screen.findByRole('button', { name: 'citation: My source' });
    const original = editableValue(prompt);
    act(() => requestQueueEdit({ projectId: 'project', threadId: 'thread', entry: { id: 'entry', source: 'user', state: 'queued' } }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveEditableValue('Edit queued request'));
    expect(screen.getByText('Editing queued message')).toBeInTheDocument();
    changeEditable(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Changed queued draft' } });
    expect(props.storage.getItem('pixice.draft.project:thread')).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveEditableValue(original);
    expect(await screen.findByRole('button', { name: 'citation: My source' })).toBeInTheDocument();
    expect(api.turns.queueEdit).not.toHaveBeenCalled();
  });

  it('retains text and context after a failed send and recalls accepted text without restoring its old context', async () => {
    const props = composerProps({ onSubmit: vi.fn().mockRejectedValueOnce(new Error('Provider temporarily disconnected')).mockResolvedValue(true) });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Review this ' } });
    const quote = createContextRecord('citation', { id: 'retained', label: 'Source', text: 'Selected content', source: { projectId: 'project' } });
    act(() => requestComposerContext({ projectId: 'project', threadId: 'thread', record: quote }));
    await screen.findByRole('button', { name: 'citation: Source' });
    const original = editableValue(prompt);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Provider temporarily disconnected');
    expect(prompt).toHaveEditableValue(original);
    expect(screen.getByRole('button', { name: 'citation: Source' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(prompt).toHaveEditableValue(''));
    fireEvent.keyDown(prompt, { key: 'ArrowUp' });
    await waitFor(() => expect(prompt).toHaveEditableValue('Review this'));
    expect(screen.queryByRole('button', { name: 'citation: Source' })).toBeNull();
    act(() => prompt.editor.commands.setTextSelection(prompt.editor.state.doc.content.size - 1));
    fireEvent.keyDown(prompt, { key: 'ArrowDown' });
    await waitFor(() => expect(prompt).toHaveEditableValue(''));
  });

  it('edits queued text attachments with their original context identities and restores the unsent draft on save', async () => {
    const record = createContextRecord('file', { id: 'queued-file', label: 'pasted-text.txt', attachmentId: 'original-attachment', source: { projectId: 'project', name: 'pasted-text.txt', attachmentId: 'original-attachment' } });
    const text = `Read ${serializeContextToken(record)}`;
    const dataUrl = `data:text/plain;charset=utf-8;base64,${btoa('exact queued file content')}`;
    const api = { turns: { queueDraft: vi.fn(async () => ({ id: 'entry', text, contextRecords: [record], attachments: [{ name: 'pasted-text.txt', type: 'text/plain;charset=utf-8', size: 25, dataUrl }] })), queueEdit: vi.fn(async () => ({ entries: [], held: false })) } };
    const props = composerProps({ running: true, queueEnabled: true, attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    changeEditable(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'My next unsent request' } });
    act(() => requestQueueEdit({ projectId: 'project', threadId: 'thread', entry: { id: 'entry', source: 'user', state: 'queued' } }));
    await screen.findByText('Editing queued message');
    expect(await screen.findByRole('button', { name: 'file: pasted-text.txt' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save queued message' }));
    await waitFor(() => expect(api.turns.queueEdit).toHaveBeenCalledOnce());
    const payload = api.turns.queueEdit.mock.calls[0][0];
    expect(payload).toMatchObject({ projectId: 'project', threadId: 'thread', id: 'entry', text, replaceAttachments: true, contextRecords: [expect.objectContaining({ attachmentId: 'original-attachment' })] });
    expect(payload.attachments[0]).toMatchObject({ name: 'pasted-text.txt', dataUrl });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveEditableValue('My next unsent request'));
  });

  it('reconciles accepted prompt recall with native history without duplicating acknowledged sends', async () => {
    const props = composerProps();
    const { rerender } = render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    for (const value of ['First request', 'Second request']) {
      changeEditable(prompt, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(prompt).toHaveEditableValue(''));
    }
    rerender(<Composer {...props} promptHistory={[{ id: 'native-first', role: 'user', text: 'First request' }, { id: 'native-second', role: 'user', text: 'Second request' }]} />);
    const previous = async () => {
      act(() => { prompt.editor.view.focus(); prompt.editor.commands.setTextSelection(1); });
      await act(async () => fireEvent.keyDown(prompt, { key: 'ArrowUp' }));
    };
    await previous();
    expect(prompt).toHaveEditableValue('Second request');
    await previous();
    expect(prompt).toHaveEditableValue('First request');
    await previous();
    expect(prompt).toHaveEditableValue('First request');
  });

  it.each([
    ['resumes', null, false, { ctrlKey: true }],
    ['steers', 'active-turn', true, { metaKey: true }]
  ])('Command/Control-Shift-Enter %s the oldest queued entry and preserves the current unsent draft', async (_label, activeTurnId, running, modifier) => {
    const entries = [{ id: 'oldest', source: 'user', state: 'queued', text: 'Oldest request' }, { id: 'newer', source: 'user', state: 'queued', text: 'Later request' }];
    const api = { turns: { queueList: vi.fn(async () => ({ entries, held: true })), queueResume: vi.fn(async () => ({ entries, held: false })), queueSteer: vi.fn(async () => ({ entries: entries.slice(1), held: false })) } };
    const props = composerProps({ running, queueEnabled: true, activeTurnId, attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Keep my next unsent request ' } });
    const quote = createContextRecord('citation', { id: 'unsent', label: 'Unsent source', text: 'My source excerpt', source: { projectId: 'project' } });
    act(() => requestComposerContext({ projectId: 'project', threadId: 'thread', record: quote }));
    await screen.findByRole('button', { name: 'citation: Unsent source' });
    const original = editableValue(prompt);
    await act(async () => fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true, ...modifier }));
    if (activeTurnId) {
      expect(api.turns.queueSteer).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', threadId: 'thread', id: 'oldest', turnId: activeTurnId });
      expect(api.turns.queueResume).not.toHaveBeenCalled();
    } else {
      expect(api.turns.queueResume).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', threadId: 'thread' });
      expect(api.turns.queueSteer).not.toHaveBeenCalled();
    }
    expect(prompt).toHaveEditableValue(original);
    expect(screen.getByRole('button', { name: 'citation: Unsent source' })).toBeInTheDocument();
    expect(props.storage.getItem('pixice.draft.project:thread')).toBe(original);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it.each(['failed', 'uncertain'])('does not promote a later queued entry past a %s head', async state => {
    const api = { turns: { queueList: vi.fn(async () => ({ entries: [{ id: 'head', source: 'user', state, text: 'Needs review' }, { id: 'later', source: 'user', state: 'queued', text: 'Later' }], held: true })), queueResume: vi.fn(), queueSteer: vi.fn() } };
    const props = composerProps({ running: true, queueEnabled: true, activeTurnId: 'turn', attachmentContext: { api, projectId: 'project', threadId: 'thread', hostId: 'local' } });
    render(<Composer {...props} />);
    const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
    changeEditable(prompt, { target: { value: 'Retain this draft' } });
    await act(async () => fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true, shiftKey: true }));
    expect(api.turns.queueList).toHaveBeenCalledOnce();
    expect(api.turns.queueResume).not.toHaveBeenCalled();
    expect(api.turns.queueSteer).not.toHaveBeenCalled();
    expect(prompt).toHaveEditableValue('Retain this draft');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
