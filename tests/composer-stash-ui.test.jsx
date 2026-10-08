import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStash } from '../src/composer/DraftStash.jsx';
import { createDraftMemory } from '../src/composer/draft-memory.js';

afterEach(cleanup);
function storageAdapter() { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }; }

describe('saved prompt menu', () => {
  it('restores context and displays missing-attachment repair status, keeping reusable entries', async () => {
    const memory = createDraftMemory({ storage: storageAdapter() });
    await memory.stash({ text: 'Review this screenshot', records: [{ id: 'quote', kind: 'citation' }], attachments: [{ id: 'missing', name: 'old.png', type: 'image/png', size: 10 }] });
    const onRestore = vi.fn(), onNotice = vi.fn();
    render(<DraftStash memory={memory} onRestore={onRestore} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saved prompts (1)' }));
    expect(screen.getByText('1 file needs reselecting')).toBeInTheDocument();
    expect(screen.getByText('1 attachment · 1 context reference')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restore Review this screenshot' })));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ text: 'Review this screenshot', contextRecords: [{ id: 'quote', kind: 'citation' }] }), expect.objectContaining({ ok: true }));
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Reselect old.png'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(memory.listStashes()).toHaveLength(1);
  });
  it('supports controlled keyboard opening, Escape focus return and deleting only the chosen prompt', async () => {
    const memory = createDraftMemory({ storage: storageAdapter() });
    await memory.stash({ text: 'First' });
    await memory.stash({ text: 'Second' });
    const onOpenChange = vi.fn();
    const { rerender } = render(<DraftStash memory={memory} open onOpenChange={onOpenChange} />);
    const first = screen.getByRole('button', { name: 'Restore Second' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete saved prompt Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved prompt Second' }));
    expect(memory.listStashes().map(entry => entry.text)).toEqual(['First']);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<DraftStash memory={memory} open={false} onOpenChange={onOpenChange} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Saved prompts (1)' }));
  });
});
