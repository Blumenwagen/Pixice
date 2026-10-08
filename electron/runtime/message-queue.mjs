import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// T3 reference: orchestration-v2 queued-run edit/cancel and queue.resume.
// Persist the claim before dispatch. An interrupted claim is held for explicit
// review; a service restart must never silently repeat a user message.
export class MessageQueue {
  constructor({ storagePath, start, steer, isBusy, emit = () => {} }) {
    this.storagePath = storagePath; this.start = start; this.steer = steer;
    this.isBusy = isBusy; this.emit = emit; this.draining = new Map(); this.closed = false;
    try { this.state = JSON.parse(readFileSync(storagePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, threads: {}, delivered: [] }; }
    if (this.state.version !== 1 || !this.state.threads) throw new Error('Unsupported message queue data.');
    for (const queue of Object.values(this.state.threads)) {
      queue.held = true;
      for (const entry of queue.entries) if (entry.state === 'dispatching') {
        entry.state = 'uncertain'; entry.error = 'Dispatch was interrupted. Check the conversation before retrying.';
      }
    }
    this.persist();
  }
  persist() {
    mkdirSync(path.dirname(this.storagePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.storagePath);
  }
  queue(threadId, projectId) {
    let queue = this.state.threads[threadId];
    if (queue && queue.projectId !== projectId) throw new Error('Queue belongs to another project.');
    if (!queue) queue = this.state.threads[threadId] = { projectId, held: false, entries: [] };
    return queue;
  }
  list(projectId, threadId) {
    const queue = this.state.threads[threadId];
    if (queue && queue.projectId !== projectId) throw new Error('Queue belongs to another project.');
    return { held: queue?.held ?? false, entries: (queue?.entries ?? []).map(({ input, checkpointInput, ...entry }) => ({ ...entry })) };
  }
  changed(projectId, threadId) {
    this.persist(); this.emit({ projectId, threadId, ...this.list(projectId, threadId) });
  }
  enqueue({ projectId, threadId, text, input, checkpointInput, model, effort, serviceTier, permissionMode, source = 'user', dedupeKey = null, attachments = [], contextRecords = [] }) {
    if (!text?.trim() && !input?.length) throw new Error('A queued message cannot be empty.');
    if (dedupeKey && this.state.delivered.includes(dedupeKey)) return { duplicate: true };
    const queue = this.queue(threadId, projectId);
    if (dedupeKey && queue.entries.some(entry => entry.dedupeKey === dedupeKey)) return { duplicate: true };
    if (queue.entries.length >= 50 || Object.values(this.state.threads).reduce((sum, q) => sum + q.entries.length, 0) >= 1000) throw new Error('The message queue is full.');
    const entry = { id: randomUUID(), projectId, threadId, text: text ?? '', input, checkpointInput, model, effort, serviceTier, permissionMode, source, dedupeKey, attachments, contextRecords, state: 'queued', createdAt: new Date().toISOString() };
    queue.entries.push(entry); this.changed(projectId, threadId);
    void this.drain(threadId);
    return { queued: true, entry: this.list(projectId, threadId).entries.find(item => item.id === entry.id) };
  }
  find(projectId, threadId, id) {
    const queue = this.queue(threadId, projectId); const entry = queue.entries.find(item => item.id === id);
    if (!entry || entry.state === 'dispatching') throw new Error('That message is no longer editable in the queue.');
    return { queue, entry };
  }
  edit({ projectId, threadId, id, text, input, checkpointInput, attachments, contextRecords }) {
    if (!text?.trim() && !input?.length) throw new Error('A queued message cannot be empty.');
    const { entry } = this.find(projectId, threadId, id);
    if (entry.source !== 'user') throw new Error('Background notifications cannot be edited.');
    if (entry.state === 'uncertain') throw new Error('Review the conversation and explicitly retry the interrupted message before editing it.');
    // Retain staged image inputs and attachment context. Replace only the user's
    // text prefix; generated attachment/context suffixes are fixed at enqueue.
    const part = entry.input?.find(item => item.type === 'text');
    if (input) entry.input = input;
    else if (part) part.text = part.text.startsWith(entry.text) ? text + part.text.slice(entry.text.length) : text;
    else entry.input = [{ type: 'text', text, text_elements: [] }, ...(entry.input ?? [])];
    if (checkpointInput) entry.checkpointInput = checkpointInput;
    if (attachments) entry.attachments = attachments;
    if (contextRecords) entry.contextRecords = contextRecords;
    entry.text = text; entry.state = 'queued'; delete entry.error;
    if (entry.checkpointInput) entry.checkpointInput.text = text;
    this.changed(projectId, threadId); return this.list(projectId, threadId);
  }
  remove({ projectId, threadId, id }) {
    const { queue, entry } = this.find(projectId, threadId, id);
    queue.entries.splice(queue.entries.indexOf(entry), 1); this.changed(projectId, threadId);
    return this.list(projectId, threadId);
  }
  reorder({ projectId, threadId, ids }) {
    const queue = this.queue(threadId, projectId);
    if (queue.entries.some(entry => entry.state === 'dispatching')) throw new Error('A message is being dispatched. Retry after it starts.');
    if (ids.length !== queue.entries.length || new Set(ids).size !== ids.length || !ids.every(id => queue.entries.some(entry => entry.id === id))) throw new Error('Queue changed. Refresh before reordering.');
    queue.entries = ids.map(id => queue.entries.find(entry => entry.id === id));
    this.changed(projectId, threadId); return this.list(projectId, threadId);
  }
  hold(projectId, threadId) { const queue = this.queue(threadId, projectId); queue.held = true; this.changed(projectId, threadId); return this.list(projectId, threadId); }
  resume(projectId, threadId, retryUncertain = false) {
    const queue = this.queue(threadId, projectId);
    if (queue.entries.some(entry => entry.state === 'uncertain') && !retryUncertain) throw new Error('Review the conversation, then explicitly retry the interrupted message.');
    for (const entry of queue.entries) if (['failed', 'uncertain'].includes(entry.state)) { entry.state = 'queued'; delete entry.error; }
    queue.held = false; this.changed(projectId, threadId); void this.drain(threadId); return this.list(projectId, threadId);
  }
  async steerEntry({ projectId, threadId, id, turnId }) {
    const { queue, entry } = this.find(projectId, threadId, id);
    if (entry.state !== 'queued') throw new Error('Review the interrupted message before steering.');
    entry.state = 'dispatching'; this.changed(projectId, threadId);
    try {
      await this.steer({ ...entry, turnId });
      this.delivered(queue, entry); this.changed(projectId, threadId);
    } catch (error) {
      entry.state = 'uncertain'; entry.error = error.message; queue.held = true;
      this.changed(projectId, threadId); throw error;
    }
    return this.list(projectId, threadId);
  }
  delivered(queue, entry) {
    queue.entries = queue.entries.filter(item => item.id !== entry.id);
    if (entry.dedupeKey) this.state.delivered = [...this.state.delivered, entry.dedupeKey].slice(-500);
  }
  drain(threadId) {
    if (this.closed || this.draining.has(threadId)) return this.draining.get(threadId) ?? Promise.resolve();
    const run = this.dispatch(threadId).finally(() => {
      this.draining.delete(threadId);
      const queue = this.state.threads[threadId];
      if (!this.closed && queue && !queue.held && queue.entries[0]?.state === 'queued' && !this.isBusy(threadId)) queueMicrotask(() => void this.drain(threadId));
    });
    this.draining.set(threadId, run); return run;
  }
  async dispatch(threadId) {
    const queue = this.state.threads[threadId];
    if (!queue || queue.held || this.isBusy(threadId)) return;
    const entry = queue.entries[0]; if (!entry || entry.state !== 'queued') return;
    entry.state = 'dispatching'; this.changed(queue.projectId, threadId);
    try {
      await this.start(entry);
      this.delivered(queue, entry); this.changed(queue.projectId, threadId);
      // Start callbacks normally leave a running turn. Synchronous completions
      // can drain the next entry after this claim has been removed.
      if (!this.isBusy(threadId)) queueMicrotask(() => { if (!this.closed) void this.drain(threadId); });
    } catch (error) {
      entry.state = error.uncertain ? 'uncertain' : 'failed'; entry.error = error.message; queue.held = true;
      this.changed(queue.projectId, threadId);
    }
  }
  clear(projectId, threadId) { const queue = this.state.threads[threadId]; if (queue?.projectId !== projectId) return; if (queue.entries.some(entry => entry.state === 'dispatching')) throw new Error('Wait for message dispatch before archiving.'); delete this.state.threads[threadId]; this.changed(projectId, threadId); }
  cancelSource(projectId, threadId, source) { const queue = this.state.threads[threadId]; if (queue?.projectId !== projectId) return; queue.entries = queue.entries.filter(entry => entry.source !== source || entry.state === 'dispatching'); this.changed(projectId, threadId); }
  close() { this.closed = true; }
}
