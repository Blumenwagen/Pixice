import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteClient, getPixiceApi, parsePairingLink, pairInstance, savedInstances } from '../src/connect/client.js';
import { ConnectRoot, switchInstanceStorage } from '../src/connect/ConnectRoot.jsx';
const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
beforeEach(() => { localStorage.clear(); });
afterEach(() => { delete window.pixice; delete window.pixiceRemote; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it('isolates drafts and project selections while retaining saved instance identities', () => {
    localStorage.setItem('pixice.activeProjectId', 'local-project');
    localStorage.setItem('pixice.drafts', 'local draft');
    localStorage.setItem('pixice.connect.instances', '[]');
    switchInstanceStorage(null, 'host-a');
    expect(localStorage.getItem('pixice.activeProjectId')).toBeNull();
    expect(localStorage.getItem('pixice.connect.instances')).toBe('[]');
    localStorage.setItem('pixice.activeProjectId', 'remote-project');
    localStorage.setItem('pixice.drafts', 'remote draft');
    switchInstanceStorage('host-a', null);
    expect(localStorage.getItem('pixice.drafts')).toBe('local draft');
    expect(localStorage.getItem('pixice.activeProjectId')).toBe('local-project');
    switchInstanceStorage(null, 'host-a');
    expect(localStorage.getItem('pixice.drafts')).toBe('remote draft');
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
});
