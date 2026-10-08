// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationClient } from '../electron/connect/application-client.mjs';
const instance = { id: 'host', endpoint: 'http://127.0.0.1:43187', token: 'token' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded application transport recovery', () => {
  it('times out a stalled handshake so recovery controls are not waiting for two minutes', async () => {
    const client = new ApplicationClient(instance, { handshakeTimeoutMs: 100 });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    try { await expect(client.connect()).rejects.toMatchObject({ code: 'REQUEST_ABORTED' }); }
    finally { client.close(); }
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.online).toBe(false);
  });
  it('cancels a pending handshake when the client is closed', async () => {
    const client = new ApplicationClient(instance);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const result = expect(client.connect()).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    client.close();
    await result;
    expect(client.online).toBe(false);
  });
  it('ends a reconnect resolver immediately when its client is retired', async () => {
    const entered = vi.fn();
    const onState = vi.fn();
    const client = new ApplicationClient(instance, { onState, resolveInstance: () => { entered(); return new Promise(() => {}); } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed')));
    const polling = client.poll();
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    client.close(); await polling;
    expect(client.online).toBe(false);
    expect(onState).not.toHaveBeenCalledWith({ state: 'connected' });
  });
});
