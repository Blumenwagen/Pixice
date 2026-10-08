// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageQueue } from '../electron/runtime/message-queue.mjs';
const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture(options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pixice-queue-')); directories.push(directory);
  const start = vi.fn(async () => {}); const steer = vi.fn(async () => {});
  const queue = new MessageQueue({ storagePath: path.join(directory, 'queue.json'), start, steer, isBusy: () => true, ...options });
  return { queue, start: queue.start, steer: queue.steer, storagePath: queue.storagePath };
}
function prompt(text, extra = {}) { return { projectId: 'p', threadId: 't', text, input: [{ type: 'text', text }], permissionMode: 'workspace-write', ...extra }; }
describe('durable ordinary-message queue', () => {
  it('edits/reorders/cancels before dispatch and starts exactly one message at a time', async () => {
    let busy = true;
    const { queue, start } = fixture({ isBusy: () => busy, start: vi.fn(async () => { busy = true; }) });
    const first = queue.enqueue(prompt('first')).entry;
    const second = queue.enqueue(prompt('second')).entry;
    queue.edit({ projectId: 'p', threadId: 't', id: first.id, text: 'edited' });
    queue.reorder({ projectId: 'p', threadId: 't', ids: [second.id, first.id] });
    await queue.drain('t'); busy = false; await queue.drain('t');
    expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0][0].text).toBe('second');
    queue.remove({ projectId: 'p', threadId: 't', id: first.id });
    expect(queue.list('p', 't').entries).toEqual([]);
  });
  it('keeps staged images and attachment context when editing the user prompt', () => {
    const { queue } = fixture(); const { entry } = queue.enqueue(prompt('hello', { input: [{ type: 'text', text: 'hello\nAttachment: /private/staged' }, { type: 'localImage', path: '/private/image.png' }] }));
    queue.edit({ projectId: 'p', threadId: 't', id: entry.id, text: 'updated' });
    expect(queue.state.threads.t.entries[0].input).toEqual([{ type: 'text', text: 'updated\nAttachment: /private/staged' }, { type: 'localImage', path: '/private/image.png' }]);
    expect(queue.list('p', 't').entries[0]).not.toHaveProperty('input');
  });
  it('holds restart recovery and never silently repeats a claimed send', async () => {
    let release; const started = new Promise(resolve => { release = resolve; });
    const { queue, storagePath } = fixture({ isBusy: () => false, start: () => started });
    queue.enqueue(prompt('claimed')); await Promise.resolve();
    const start = vi.fn(); const recovered = new MessageQueue({ storagePath, start, steer: vi.fn(), isBusy: () => false });
    expect(recovered.list('p', 't')).toMatchObject({ held: true, entries: [{ state: 'uncertain' }] });
    await recovered.drain('t'); expect(start).not.toHaveBeenCalled();
    expect(() => recovered.resume('p', 't')).toThrow('Review the conversation');
    queue.close(); recovered.close(); release(); await queue.draining.get('t');
  });
  it('pauses failed sends and retains actionable error without dropping prompt', async () => {
    const { queue } = fixture({ isBusy: () => false, start: async () => { throw new Error('Provider offline'); } });
    queue.enqueue(prompt('keep me')); await queue.drain('t');
    expect(queue.list('p', 't')).toMatchObject({ held: true, entries: [{ text: 'keep me', state: 'failed', error: 'Provider offline' }] });
  });
  it('requires explicit review when the provider may have accepted a lost dispatch', async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error('Response lost after dispatch'), { uncertain: true }); });
    const { queue } = fixture({ isBusy: () => false, start });
    queue.enqueue(prompt('possibly accepted')); await queue.drain('t');
    expect(queue.list('p', 't')).toMatchObject({ held: true, entries: [{ state: 'uncertain', text: 'possibly accepted' }] });
    expect(() => queue.resume('p', 't')).toThrow('Review the conversation');
    await queue.drain('t'); expect(start).toHaveBeenCalledOnce();
  });
  it('steers an explicit entry and deduplicates watcher notifications across restart', async () => {
    const { queue, steer, storagePath } = fixture(); const { entry } = queue.enqueue(prompt('checks failed', { source: 'watch', dedupeKey: 'watch:1' }));
    await queue.steerEntry({ projectId: 'p', threadId: 't', id: entry.id, turnId: 'active' });
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'active' }));
    const recovered = new MessageQueue({ storagePath, start: vi.fn(), steer: vi.fn(), isBusy: () => true });
    expect(recovered.enqueue(prompt('checks failed', { dedupeKey: 'watch:1' }))).toEqual({ duplicate: true });
    expect(() => recovered.list('other', 't')).toThrow('another project');
  });
});
