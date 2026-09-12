import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { RemoteClient, createRemoteClientRegistry, getPixiceApi, parsePairingLink, pairInstance, savedInstances } from '../src/connect/client.js';
import { ConnectRoot, useConnect } from '../src/connect/ConnectRoot.jsx';
import { App } from '../src/App.jsx';
import { listRemoteThreadLinks } from '../src/connect/execution-storage.js';
const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { delete window.pixice; delete window.pixiceRemote; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function ExecutionHarness() {
  const connect = useConnect();
  const [message, setMessage] = useState('');
  return <><button onClick={() => void connect.openExecution({ hostId: 'observer-host', projectId: 'target-project', initialPrompt: 'must remain a draft' }).catch((cause) => setMessage(cause.message))}>Try observer</button>{message && <p role="alert">{message}</p>}</>;
}

function RemoteActionHarness() {
  const connect = useConnect();
  const [error, setError] = useState('');
  const run = async (operation) => {
    try {
      const api = connect.getApi('host-b');
      if (operation === 'read') await api.threads.read({ projectId: 'target-project', threadId: 'thread-b' });
      else await api.turns.start({ projectId: 'target-project', threadId: 'thread-b', text: 'one start' });
    } catch (cause) { setError(cause.message); }
  };
  return <><button onClick={() => void run('read')}>Read target</button><button onClick={() => void run('start')}>Start target</button>{error && <p role="alert">{error}</p>}</>;
}

describe('remote client behavior', () => {
  it('keeps native Electron APIs intact while selecting a remote instance', () => {
    window.pixice = { local: true }; window.pixiceRemote = { remote: true };
    expect(getPixiceApi()).toEqual({ remote: true });
    delete window.pixiceRemote;
    expect(getPixiceApi()).toEqual({ local: true });
  });
  it('rejects insecure links and pairs only compatible hosts', async () => {
    expect(() => parsePairingLink(`http://192.168.1.1/#pair=${'a'.repeat(43)}`)).toThrow('HTTPS');
    const fetch = vi.fn(async () => json({ protocol: 999 })); vi.stubGlobal('fetch', fetch);
    await expect(pairInstance(`https://pixice.example/#pair=${'a'.repeat(43)}`, 'Phone')).rejects.toThrow('incompatible');
    expect(fetch).toHaveBeenCalledOnce();
    expect(savedInstances()).toEqual([]);
  });
  it('pins host identity and sends each command once, with the current approval generation', async () => {
    const fetch = vi.fn(async () => { throw new Error('Network failed'); }); vi.stubGlobal('fetch', fetch);
    const client = new RemoteClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'instance'; client.online = true; client.requests.set('request', 7);
    await expect(client.api.approvals.resolve({ requestId: 'request', decision: 'accept' })).rejects.toThrow('may have reached the host');
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ operation: 'approvals.resolve', instanceId: 'instance', payload: { requestGeneration: 7 } });
    client.online = false;
    await expect(client.api.turns.start({ text: 'Do work' })).rejects.toThrow('not sent');
    expect(fetch).toHaveBeenCalledOnce();
    client.close();
  });
  it('keeps an explicit generation when a normalized provider request arrives before transport attention state', async () => {
    const fetch = vi.fn(async () => { throw new Error('Network failed'); });
    vi.stubGlobal('fetch', fetch);
    const client = new RemoteClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    client.instanceId = 'instance'; client.online = true;
    await expect(client.api.questions.respond({ requestId: 'request', requestGeneration: 12, action: 'cancel', answers: {} })).rejects.toThrow('may have reached the host');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.payload).toMatchObject({ requestId: 'request', requestGeneration: 12 });
    client.close();
  });
  it('replaces a failed or repaired registry entry without poisoning other hosts', async () => {
    let attempts = 0;
    const instances = {
      'host-a': { id: 'host-a', endpoint: 'https://a.example', token: 'old' },
      'host-b': { id: 'host-b', endpoint: 'https://b.example', token: 'stable' }
    };
    const fetch = vi.fn(async (url) => {
      if (url.endsWith('/info')) {
        if (url.includes('a.example') && attempts++ === 0) throw new Error('offline');
        return json({ protocol: 1, hostId: url.includes('a.example') ? 'host-a' : 'host-b', instanceId: 'instance' });
      }
      if (url.endsWith('/session')) return json({ capabilities: [] });
      return json({ result: { state: 'ready', connected: true } });
    });
    vi.stubGlobal('fetch', fetch);
    const registry = createRemoteClientRegistry({ getInstance: (id) => instances[id] });
    const failed = registry.ensure('host-a');
    await expect(failed.connecting).rejects.toThrow('connection');
    const repaired = registry.ensure('host-a');
    expect(repaired.client).not.toBe(failed.client);
    const stable = registry.ensure('host-b');
    stable.connecting.catch(() => {});
    instances['host-b'].token = 'rotated';
    const replaced = registry.ensure('host-b');
    expect(replaced.client).not.toBe(stable.client);
    await Promise.all([repaired.connecting, replaced.connecting]);
    expect(failed.client.closed).toBe(true);
    expect(stable.client.closed).toBe(true);
    registry.close();
  });

  it('subscribes recovery events once and replaces a closed client', async () => {
    const instance = { id: 'host-a', endpoint: 'https://a.example', token: 'token', deviceId: 'device-a' };
    const issued = vi.fn();
    const settled = vi.fn();
    const fetch = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/info')) return json({ protocol: 1, hostId: 'host-a', instanceId: 'backend-a' });
      if (url.endsWith('/session')) return json({ capabilities: [] });
      if (url.includes('/poll?')) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' }))));
      return json({ result: { turn: { id: 'turn-a' } } });
    });
    vi.stubGlobal('fetch', fetch);
    const registry = createRemoteClientRegistry({
      getInstance: () => instance,
      getOrigin: () => ({ hostId: 'origin', projectId: 'origin-project' }),
      onCommandIssued: issued,
      onCommandSettled: settled
    });
    const first = registry.ensure('host-a');
    await first.connecting;
    await first.client.api.turns.start({ projectId: 'target-project', threadId: 'thread-a' });
    expect(issued).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
    expect(issued.mock.calls[0][1]).toMatchObject({ hostId: 'host-a', deviceId: 'device-a', originHostId: 'origin', originProjectId: 'origin-project', projectId: 'target-project' });
    first.client.close();
    const replacement = registry.ensure('host-a');
    expect(replacement.client).not.toBe(first.client);
    await replacement.connecting;
    registry.close();
  });

  it('rejects initial submissions to a freshly identified observer host', async () => {
    window.pixice = {};
    localStorage.setItem('pixice.connect.instances', JSON.stringify([{ id: 'observer-host', endpoint: 'https://observer.example', token: 'token', name: 'Read-only host', deviceId: 'device-observer' }]));
    sessionStorage.setItem('pixice.connect.active', '__pixice_local__');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.endsWith('/info')) return json({ protocol: 1, hostId: 'observer-host', instanceId: 'observer-backend' });
      if (url.endsWith('/session')) return json({ role: 'observer', projectIds: ['target-project'], operations: ['threads.read'] });
      if (url.includes('/poll?')) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' }))));
      if (!options.body) return json({ result: { state: 'ready', connected: true } });
      const body = JSON.parse(options.body);
      calls.push(body);
      return json({ result: { state: 'ready', connected: true } });
    }));
    render(<ConnectRoot><ExecutionHarness /></ConnectRoot>);
    fireEvent.click(await screen.findByRole('button', { name: 'Try observer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('view-only');
    expect(calls.some((call) => ['threads.create', 'turns.start'].includes(call.operation))).toBe(false);
  });

  it('keeps an initially active remote usable after StrictMode registry replay', async () => {
    localStorage.setItem('pixice.connect.instances', JSON.stringify([{ id: 'host-b', endpoint: 'https://b.example', token: 'token-b', name: 'Laptop B', deviceId: 'device-b' }]));
    sessionStorage.setItem('pixice.connect.active', 'host-b');
    const remoteCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.endsWith('/info')) return json({ protocol: 1, hostId: 'host-b', instanceId: 'backend-b' });
      if (url.endsWith('/session')) return json({ role: 'operator', projectIds: ['target-project'] });
      if (url.includes('/poll?')) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' }))));
      if (!options.body) return json({ result: { state: 'ready', connected: true } });
      const body = JSON.parse(options.body);
      remoteCalls.push(body);
      if (body.operation === 'threads.read') return json({ result: { thread: { id: 'thread-b', turns: [] } } });
      return json({ result: { turn: { id: 'turn-b' } } });
    }));
    const { unmount } = render(<StrictMode><ConnectRoot><RemoteActionHarness /></ConnectRoot></StrictMode>);
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Read target' }));
      await waitFor(() => expect(remoteCalls.some((call) => call.operation === 'threads.read')).toBe(true));
      fireEvent.click(screen.getByRole('button', { name: 'Start target' }));
      await waitFor(() => expect(remoteCalls.filter((call) => call.operation === 'turns.start')).toHaveLength(1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally { unmount(); }
  });
  it('rejects a changed host before transmitting its saved credential', async () => {
    const fetch = vi.fn(async () => json({ protocol: 1, hostId: 'someone-else' })); vi.stubGlobal('fetch', fetch);
    const client = new RemoteClient({ id: 'expected-host', endpoint: 'https://pixice.example', token: 'private-token' });
    await expect(client.connect()).rejects.toThrow('different Pixice host');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    client.close();
  });
  it('reloads the authoritative snapshot after a missing event sequence', async () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    const client = new RemoteClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' }, { onReset });
    const reset = (sequence) => ({ protocol: 1, type: 'ConnectReset', instanceId: 'process', sequence, payload: { attention: [] } });
    const fetch = vi.fn().mockResolvedValueOnce(json({ events: [reset(0)] }))
      .mockResolvedValueOnce(json({ events: [{ protocol: 1, type: 'TaskUpdated', sequence: 2, payload: {} }] }))
      .mockResolvedValueOnce(json({ events: [reset(2)] }))
      .mockImplementation(() => { client.close(); return Promise.resolve(json({ events: [] })); });
    vi.stubGlobal('fetch', fetch);
    try {
      const polling = client.poll();
      await vi.advanceTimersByTimeAsync(1500);
      await polling;
      expect(onReset).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[2][0]).toContain('instanceId=');
      expect(client.cursor).toBe(2);
    } finally { client.close(); vi.useRealTimers(); }
  });
  it('resumes local event replay after a transport failure without resetting the app', async () => {
    vi.useFakeTimers();
    const onReset = vi.fn(); const onState = vi.fn();
    const instance = { id: 'host', endpoint: 'http://127.0.0.1:43187', token: 'token' };
    const client = new RemoteClient(instance, { onReset, onState });
    client.resolveInstance = vi.fn(async () => instance);
    const reset = { protocol: 1, type: 'ConnectReset', instanceId: 'process', sequence: 12, payload: { attention: [] } };
    const receive = vi.fn(); client.subscribe(receive);
    const fetch = vi.fn().mockResolvedValueOnce(json({ events: [reset] }))
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(json({ protocol: 1, hostId: 'host', instanceId: 'process' }))
      .mockResolvedValueOnce(json({ events: [{ protocol: 1, type: 'TaskUpdated', sequence: 13, payload: {} }] }))
      .mockImplementation(() => { client.close(); return Promise.resolve(json({ events: [] })); });
    vi.stubGlobal('fetch', fetch);
    try {
      const polling = client.poll(); await vi.advanceTimersByTimeAsync(1500); await polling;
      expect(fetch.mock.calls[3][0]).toContain('cursor=12&instanceId=process&wait=0');
      expect(onReset).not.toHaveBeenCalled();
      expect(receive).toHaveBeenCalledWith(expect.objectContaining({ type: 'TaskUpdated' }));
      expect(client.cursor).toBe(13);
    } finally { client.close(); vi.useRealTimers(); }
  });
  it('makes snapshot refresh reads available after an actual backend restart', async () => {
    vi.useFakeTimers();
    const instance = { id: 'host', endpoint: 'http://127.0.0.1:43187', token: 'token' };
    const client = new RemoteClient(instance);
    client.resolveInstance = async () => instance;
    const reset = (id) => ({ protocol: 1, type: 'ConnectReset', instanceId: id, sequence: 0, payload: { attention: [] } });
    const fetch = vi.fn().mockResolvedValueOnce(json({ events: [reset('old')] }))
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(json({ protocol: 1, hostId: 'host', instanceId: 'new' }))
      .mockResolvedValueOnce(json({ events: [reset('new')] }))
      .mockResolvedValueOnce(json({ result: { projects: [] } }))
      .mockImplementation(() => { client.close(); return Promise.resolve(json({ events: [] })); });
    vi.stubGlobal('fetch', fetch);
    let refreshed;
    client.subscribe(event => { if (event.type === 'ApplicationResync') refreshed = client.call('app.bootstrap'); });
    try {
      const polling = client.poll(); await vi.advanceTimersByTimeAsync(1500); await polling;
      await expect(refreshed).resolves.toEqual({ projects: [] });
      expect(JSON.parse(fetch.mock.calls[4][1].body)).toMatchObject({ operation: 'app.bootstrap', instanceId: 'new' });
    } finally { client.close(); vi.useRealTimers(); }
  });
  it('does not treat a failed interface listener as a lost backend connection', async () => {
    const onState = vi.fn(); const client = new RemoteClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' }, { onState });
    client.subscribe(() => { throw new Error('view failed'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ events: [{ protocol: 1, type: 'ConnectReset', instanceId: 'process', sequence: 0, payload: { attention: [] } }] }))
      .mockImplementation(() => { client.close(); return Promise.resolve(json({ events: [] })); }));
    await client.poll();
    expect(onState).toHaveBeenCalledWith({ state: 'connected' });
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'reconnecting' }));
  });
  it('offers a usable pairing screen when no desktop bridge is present', async () => {
    render(<ConnectRoot><p>Application</p></ConnectRoot>);
    expect(screen.getByRole('heading', { name: 'Pixice Connect' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add instance' }));
    expect(screen.getByRole('dialog', { name: 'Pair instance' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Pairing link'), { target: { value: 'invalid' } });
    fireEvent.submit(screen.getByLabelText('Pairing link').closest('form'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('keeps host layout and account administration local while exposing browser controls', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const client = new RemoteClient({ id: 'host', endpoint: 'https://pixice.example', token: 'token' });
    expect(typeof client.api.browser.frame).toBe('function');
    expect(typeof client.api.browser.input).toBe('function');
    await client.api.browser.setViewport({ workspaceId: 'remote', visible: true });
    await expect(client.api.providers.login({ provider: 'codex' })).rejects.toThrow('host');
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  it('keeps the origin App mounted while a new turn runs on a qualified target host', async () => {
    const localProject = { id: 'origin-project', displayName: 'Origin A', canonicalPath: '/work/origin-a' };
    const remoteProject = { id: 'target-project', displayName: 'Remote B', canonicalPath: '/work/remote-b' };
    const remoteDecoy = { id: 'origin-project', displayName: 'Remote decoy', canonicalPath: '/work/remote-decoy' };
    const localThread = { id: 'thread-collision', name: 'Origin task', status: { type: 'idle' }, turns: [] };
    const remoteThread = { id: 'thread-collision', name: 'Remote task', status: { type: 'idle' }, turns: [] };
    const listeners = new Set();
    const localStart = vi.fn(async () => ({ turn: { id: 'local-turn', status: 'inProgress', items: [] } }));
    const localApi = {
      app: { bootstrap: vi.fn(async () => ({ projects: [localProject], models: [{ model: 'local-model', displayName: 'Local model', provider: 'codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], providers: [{ id: 'codex', connected: true, status: { state: 'ready' } }], runtime: { state: 'ready', connected: true }, settings: {} })), saveSettings: vi.fn(async () => ({})) },
      models: { list: vi.fn(async () => [{ model: 'local-model', displayName: 'Local model', provider: 'codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]) },
      providers: { list: vi.fn(async () => [{ id: 'codex', connected: true, status: { state: 'ready' } }]) },
      projects: { list: vi.fn(async () => [localProject]), touch: vi.fn(async () => localProject) },
      threads: { list: vi.fn(async () => ({ data: [localThread] })), read: vi.fn(async () => ({ thread: localThread, plan: [] })), archive: vi.fn() },
      turns: { start: localStart, steer: vi.fn(), interrupt: vi.fn() },
      review: { read: vi.fn(async () => ({ repository: null, files: [] })) },
      board: { list: vi.fn(async () => ({ data: [], phases: [] })) },
      tasks: { receipts: vi.fn(async () => []), receipt: vi.fn(async () => null), interventions: vi.fn(async () => ({ requests: [] })) },
      proactivity: { list: vi.fn(async () => ({ data: [] })) },
      instruments: { tools: vi.fn(async () => ({ data: [] })), list: vi.fn(async () => ({ data: [] })) },
      extensions: { list: vi.fn(async () => ({ skills: [], apps: [], mcp: [] })) },
      browser: { state: vi.fn(async () => ({ native: false, activeTabId: null, tabs: [] })) },
      updates: { status: vi.fn(async () => ({ state: 'up-to-date' })) },
      events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) }
    };
    window.pixice = localApi;
    localStorage.setItem('pixice.connect.instances', JSON.stringify([{ id: 'host-b', endpoint: 'https://b.example', token: 'token-b', name: 'Laptop B' }]));
    sessionStorage.setItem('pixice.connect.active', '__pixice_local__');
    const remoteCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.endsWith('/info')) return json({ protocol: 1, hostId: 'host-b', instanceId: 'b-process' });
      if (url.endsWith('/session')) return json({ capabilities: [], operations: [] });
      if (url.includes('/poll?')) return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' }))));
      const body = JSON.parse(options.body);
      remoteCalls.push(body);
      const resultByOperation = {
        'runtime.status': { state: 'ready', connected: true },
        'app.bootstrap': { projects: [remoteProject, remoteDecoy], models: [{ model: 'remote-model', displayName: 'Remote model', provider: 'codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], providers: [{ id: 'codex', connected: true, status: { state: 'ready' } }], runtime: { state: 'ready', connected: true }, settings: {} },
        'projects.list': [remoteProject, remoteDecoy],
        'models.list': [{ model: 'remote-model', displayName: 'Remote model', provider: 'codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
        'threads.list': { data: [remoteThread] },
        'threads.read': { thread: remoteThread, plan: [] },
        'threads.create': { thread: remoteThread },
        'turns.start': { turn: { id: 'remote-turn', status: 'inProgress', items: [] } },
        'tasks.interventions': { requests: [] },
        'tasks.receipt': null,
        'browser.state': { native: false, activeTabId: null, tabs: [] },
        'instruments.list': { data: [] },
        'board.list': { data: [], phases: [] },
        'review.read': { repository: null, files: [] }
      };
      return json({ result: resultByOperation[body.operation] ?? {} });
    }));
    const { unmount } = render(<ConnectRoot><App /></ConnectRoot>);
    try {
      await waitFor(() => expect(screen.getAllByText('Origin A').length).toBeGreaterThan(0));
      fireEvent.click(screen.getByRole('button', { name: 'New task' }));
      const targetPicker = screen.getByRole('combobox', { name: 'Run on' });
      fireEvent.change(targetPicker, { target: { value: 'host-b' } });
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Target project' })).toBeInTheDocument());
      fireEvent.change(screen.getByRole('combobox', { name: 'Target project' }), { target: { value: remoteProject.id } });
      const prompt = screen.getByRole('textbox', { name: 'Task prompt' });
      await waitFor(() => expect(prompt).toBeEnabled());
      fireEvent.change(prompt, { target: { value: 'Run on B only' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(remoteCalls.some((call) => call.operation === 'turns.start' && call.payload.projectId === remoteProject.id && call.payload.text === 'Run on B only')).toBe(true), { timeout: 2000 });
      expect(localStart).not.toHaveBeenCalled();
      expect(remoteCalls.filter((call) => ['threads.create', 'threads.read', 'turns.start'].includes(call.operation)).every((call) => call.payload.projectId === remoteProject.id)).toBe(true);
      expect(remoteCalls.filter((call) => ['threads.create', 'threads.read', 'turns.start'].includes(call.operation)).some((call) => call.payload.projectId === remoteDecoy.id)).toBe(false);
      await waitFor(() => expect(listRemoteThreadLinks(localStorage)).toEqual(expect.arrayContaining([expect.objectContaining({ originHostId: 'local', originProjectId: localProject.id, executionHostId: 'host-b', executionProjectId: remoteProject.id })])));
      expect(screen.getByRole('status', { name: 'Connected to Laptop B' })).toBeInTheDocument();
      expect(screen.queryByText('Running on Laptop B')).not.toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toBeInTheDocument();
    } finally { unmount(); }
  });
});
