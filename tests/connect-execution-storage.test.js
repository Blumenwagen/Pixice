import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceStorage,
  executionWorkspaceId,
  loadRemoteThreadLinks,
  remoteThreadLinksKey,
  saveRemoteThreadLinks,
  threadReference,
  upsertRemoteThreadLink,
  workspaceStorageKey
} from '../src/connect/execution-storage.js';
import { createRemoteClientRegistry } from '../src/connect/client.js';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('connect execution storage', () => {
  it('keeps two host-scoped workspace stores independent while leaving connect metadata shared', () => {
    const hostA = createWorkspaceStorage('host-a');
    const hostB = createWorkspaceStorage('host-b');
    hostA.setItem('pixice.draft.project:thread', 'draft A');
    hostB.setItem('pixice.draft.project:thread', 'draft B');
    hostA.setItem('pixice.connect.instances', 'shared');

    expect(hostA.getItem('pixice.draft.project:thread')).toBe('draft A');
    expect(hostB.getItem('pixice.draft.project:thread')).toBe('draft B');
    expect(localStorage.getItem(workspaceStorageKey('host-a', 'pixice.draft.project:thread'))).toBe('draft A');
    expect(localStorage.getItem('pixice.connect.instances')).toBe('shared');
  });

  it('stores links with the execution identity and filters mismatched records', () => {
    const reference = threadReference({
      originHostId: 'local',
      originProjectId: 'project-a',
      executionHostId: 'host-b',
      executionProjectId: 'project-b',
      rawThreadId: 'same-thread',
      cachedExecutionHostLabel: 'Laptop'
    });
    saveRemoteThreadLinks('local', 'project-a', [reference]);
    localStorage.setItem(remoteThreadLinksKey('host-b', 'project-b'), JSON.stringify([{ ...reference, originHostId: 'host-b', originProjectId: 'project-b' }]));
    expect(localStorage.getItem(remoteThreadLinksKey('local', 'project-a'))).toContain('same-thread');
    expect(loadRemoteThreadLinks('local', 'project-a')).toEqual([reference]);
    expect(loadRemoteThreadLinks('host-b', 'project-b')).toEqual([{ ...reference, originHostId: 'host-b', originProjectId: 'project-b' }]);
    expect(executionWorkspaceId('host-b', 'same-thread')).not.toBe(executionWorkspaceId('host-a', 'same-thread'));
  });

  it('upserts one link per origin and execution identity without overwriting other origins', () => {
    const first = threadReference({ originHostId: 'local', originProjectId: 'project-a', executionHostId: 'host-a', executionProjectId: 'project-a', rawThreadId: 'thread-1' });
    const second = threadReference({ originHostId: 'local', originProjectId: 'project-a', executionHostId: 'host-b', executionProjectId: 'project-b', rawThreadId: 'thread-2' });
    const otherOrigin = threadReference({ originHostId: 'host-a', originProjectId: 'project-a', executionHostId: 'host-b', executionProjectId: 'project-b', rawThreadId: 'thread-3' });
    upsertRemoteThreadLink(first);
    upsertRemoteThreadLink(first);
    upsertRemoteThreadLink(second);
    upsertRemoteThreadLink(otherOrigin);
    expect(loadRemoteThreadLinks('local', 'project-a')).toEqual([first, second]);
    expect(loadRemoteThreadLinks('host-a', 'project-a')).toEqual([otherOrigin]);
  });

  it('does not collide encoded host ids and migrates legacy local workspace keys once', () => {
    expect(workspaceStorageKey('host/2F', 'pixice.draft')).not.toBe(workspaceStorageKey('host_2F', 'pixice.draft'));
    const dotted = createWorkspaceStorage('a.b');
    const plain = createWorkspaceStorage('a');
    dotted.setItem('pixice.draft.collision', 'dotted');
    plain.setItem('pixice.draft.collision', 'plain');
    plain.clear();
    expect(dotted.getItem('pixice.draft.collision')).toBe('dotted');
    localStorage.setItem('pixice.draft.legacy', 'saved locally');
    const local = createWorkspaceStorage('local');
    expect(local.getItem('pixice.draft.legacy')).toBe('saved locally');
    expect(localStorage.getItem(workspaceStorageKey('local', 'pixice.draft.legacy'))).toBe('saved locally');
  });

  it('assigns unscoped legacy drafts to the previously active host and never reimports a deleted copy', () => {
    localStorage.setItem('pixice.connect.active', 'host-b');
    localStorage.setItem('pixice.draft.legacy', 'host B draft');
    const hostA = createWorkspaceStorage('host-a');
    expect(hostA.getItem('pixice.draft.legacy')).toBeNull();
    const hostB = createWorkspaceStorage('host-b');
    expect(hostB.getItem('pixice.draft.legacy')).toBe('host B draft');
    hostB.removeItem('pixice.draft.legacy');
    const reloadedHostB = createWorkspaceStorage('host-b');
    expect(reloadedHostB.getItem('pixice.draft.legacy')).toBeNull();
    expect(localStorage.getItem('pixice.draft.legacy')).toBe('host B draft');
  });

  it('enumerates shared link keys through recreated host adapters without losing links', () => {
    const firstAdapter = createWorkspaceStorage('origin');
    const first = threadReference({ originHostId: 'origin', originProjectId: 'project', executionHostId: 'host-a', executionProjectId: 'a', rawThreadId: 'thread-a', cachedThreadTitle: 'First task' });
    const second = threadReference({ originHostId: 'origin', originProjectId: 'project', executionHostId: 'host-b', executionProjectId: 'b', rawThreadId: 'thread-b', cachedThreadTitle: 'Second task' });
    upsertRemoteThreadLink(first, firstAdapter);
    upsertRemoteThreadLink(second, firstAdapter);
    const reloadedAdapter = createWorkspaceStorage('origin');
    expect(loadRemoteThreadLinks('origin', 'project', reloadedAdapter)).toEqual([first, second]);
    upsertRemoteThreadLink({ ...first, cachedThreadTitle: 'Renamed first task' }, reloadedAdapter);
    expect(loadRemoteThreadLinks('origin', 'project', createWorkspaceStorage('origin'))).toEqual([
      { ...first, cachedThreadTitle: 'Renamed first task', rawTaskName: 'Renamed first task' },
      second
    ]);
  });

  it('keeps one client per host and closes only the forgotten host', async () => {
    const fetch = async (url) => {
      if (url.endsWith('/info')) return { ok: true, status: 200, json: async () => ({ protocol: 1, hostId: url.includes('a.example') ? 'host-a' : 'host-b', instanceId: 'instance' }) };
      if (url.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ capabilities: [] }) };
      return { ok: true, status: 200, json: async () => ({ result: { state: 'ready', connected: true } }) };
    };
    vi.stubGlobal('fetch', fetch);
    const registry = createRemoteClientRegistry({ getInstance: (id) => ({ id, endpoint: `https://${id === 'host-a' ? 'a.example' : 'b.example'}`, token: 'token' }) });
    const first = registry.ensure('host-a');
    const second = registry.ensure('host-a');
    const other = registry.ensure('host-b');
    await Promise.all([first.connecting, other.connecting]);
    expect(second.client).toBe(first.client);
    registry.forget('host-a');
    expect(first.client.closed).toBe(true);
    expect(other.client.closed).toBe(false);
    registry.close();
  });
});
