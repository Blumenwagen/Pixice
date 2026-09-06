import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
// Persist navigation metadata only. Page contents and images never enter this file.
export class BrowserSessions {
  constructor(directory) {
    this.file = path.join(directory, 'service/browser-sessions.json'); this.sessions = new Map(); this.restored = new Set();
    try { const records = JSON.parse(readFileSync(this.file, 'utf8')); if (Array.isArray(records)) for (const record of records.slice(-200)) if (typeof record.workspaceId === 'string' && Array.isArray(record.tabs)) this.sessions.set(record.workspaceId, record); } catch { /* Browser metadata is recoverable; cookies stay in Electron's persistent partitions. */ }
  }
  update(state, browser) {
    if (!state?.workspaceId) return;
    const tabs = (state.tabs ?? []).slice(0, 100).filter((tab) => typeof tab.id === 'string').map(({ id, url }) => ({ id, url: /^https?:\/\//.test(url) ? url : null }));
    if (tabs.length) this.sessions.set(state.workspaceId, { workspaceId: state.workspaceId, activeTabId: state.activeTabId, partition: browser?.sessionPartition(state.workspaceId), tabs });
    else this.sessions.delete(state.workspaceId);
    while (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value);
    clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 300); this.timer.unref();
  }
  restore(browser, workspaceId) {
    if (!workspaceId || this.restored.has(workspaceId)) return;
    this.restored.add(workspaceId);
    const saved = this.sessions.get(workspaceId);
    if (!saved || browser.snapshot(workspaceId).tabs.length) return;
    browser.restoreSession(saved);
  }
  flush() {
    clearTimeout(this.timer);
    try { mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.sessions.values()]), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file); } catch (error) { console.error('Browser session metadata could not be saved:', error.message); }
  }
}
