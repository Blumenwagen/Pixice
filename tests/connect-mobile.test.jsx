import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createConnectDeepLink, parseConnectDeepLink, routeConnectDeepLink } from '../src/connect/pairing-links.js';
import { createPairingQrDataUrl, pairingExpired } from '../src/connect/pairing-qr.js';
import { clearConnectOverviewCache, createRemoteOverviewApi, loadConnectOverview, useConnectOverview } from '../src/connect/ConnectOverview.jsx';

afterEach(() => clearConnectOverviewCache());

describe('Connect pairing and deep links', () => {
  it('generates a QR data image from the one-time pairing URL and expires it', async () => {
    const toDataURL = vi.fn(async (value, options) => `data:image/png;base64,${value}:${options.width}`);
    const pair = { url: 'https://host.example/#pair=opaque-token', expiresAt: Date.now() + 1000 };
    await expect(createPairingQrDataUrl(pair, { toDataURL })).resolves.toContain('https://host.example/#pair=opaque-token');
    expect(toDataURL).toHaveBeenCalledWith(pair.url, expect.objectContaining({ errorCorrectionLevel: 'M' }));
    expect(pairingExpired(pair, Date.now() + 1001)).toBe(true);
  });

  it('accepts only same-origin bounded opaque Connect targets and never pairing tokens', () => {
    const value = createConnectDeepLink({ origin: 'https://app.example/path', hostId: 'host-1', projectId: 'project_2', threadId: 'thread:3' });
    expect(value).toBe('https://app.example/?connectHost=host-1&connectProject=project_2&connectThread=thread%3A3');
    expect(parseConnectDeepLink(value, { origin: 'https://app.example' })).toEqual({ hostId: 'host-1', projectId: 'project_2', threadId: 'thread:3' });
    expect(() => parseConnectDeepLink('https://app.example/?pair=secret', { origin: 'https://app.example' })).toThrow('unsupported parameter');
    expect(() => parseConnectDeepLink('https://evil.example/?connectHost=host-1', { origin: 'https://app.example' })).toThrow('receiving client');
    const onRoute = vi.fn();
    expect(routeConnectDeepLink({ location: new URL(value), onRoute })).toEqual({ hostId: 'host-1', projectId: 'project_2', threadId: 'thread:3' });
    expect(onRoute).toHaveBeenCalledOnce();
  });
});

describe('Connect overview', () => {
  it('deduplicates hosts, caps concurrency, and preserves partial failures', async () => {
    let active = 0; let peak = 0;
    const apiForHost = (hostId) => ({ app: { overview: vi.fn(async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1; if (hostId === 'failed') throw new Error('offline'); return { projects: [{ id: `project-${hostId}`, displayName: `Project ${hostId}` }], tasks: [{ threadId: `thread-${hostId}`, projectId: `project-${hostId}`, title: 'Wait', status: 'waiting' }] }; }) } });
    const instances = [...Array.from({ length: 7 }, (_, index) => ({ id: `host-${index}`, name: `Host ${index}`, endpoint: `https://host-${index}.example` })), { id: 'failed', name: 'Failed', endpoint: 'https://failed.example' }, { id: 'host-1', name: 'Duplicate', endpoint: 'https://duplicate.example' }];
    const result = await loadConnectOverview({ instances, apiForHost, maxConcurrent: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.hosts.map((host) => host.hostId)).not.toContain('local');
    expect(result.hosts.filter((host) => host.hostId === 'host-1')).toHaveLength(1);
    expect(result.hosts.find((host) => host.hostId === 'failed')).toMatchObject({ state: 'error', message: 'offline' });
    expect(result.partial).toBe(true);
    expect(result.tasks.every((task) => task.projectName.startsWith('Project'))).toBe(true);
  });

  it('uses scope-safe last-known data on a later timeout and cancels aborted work', async () => {
    const api = { app: { overview: vi.fn(async () => ({ projects: [{ id: 'p', displayName: 'Project' }], tasks: [] })) } };
    const first = await loadConnectOverview({ instances: [{ id: 'host', name: 'Host', deviceId: 'device-1', expiresAt: 'one' }], apiForHost: () => api });
    expect(first.hosts[0].state).toBe('ready');
    api.app.overview.mockRejectedValueOnce(new Error('gone'));
    const stale = await loadConnectOverview({ instances: [{ id: 'host', name: 'Host', deviceId: 'device-1', expiresAt: 'one' }], apiForHost: () => api });
    expect(stale.hosts[0]).toMatchObject({ state: 'stale', stale: true, projects: [{ id: 'p' }] });
    const controller = new AbortController();
    const pending = loadConnectOverview({ instances: [{ id: 'host-2', name: 'Host 2' }], apiForHost: () => ({ app: { overview: () => new Promise(() => {}) } }), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks saved host identity before sending the bearer token and marks re-pair cache boundaries', async () => {
    const instance = { id: 'host-1', endpoint: 'https://host.example', token: 'secret-token' };
    const fetchImpl = vi.fn(async (url, options) => url.endsWith('/info')
      ? { ok: true, status: 200, json: async () => ({ hostId: 'host-1', protocol: 1, instanceId: 'runtime-1' }) }
      : { ok: true, status: 200, json: async () => ({ result: { projects: [{ id: 'p', displayName: 'Project' }], tasks: [] } }) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(createRemoteOverviewApi(instance).app.overview({ signal: new AbortController().signal })).resolves.toMatchObject({ projects: [{ id: 'p' }] });
      expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
      expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer secret-token');
      const mismatch = createRemoteOverviewApi({ ...instance, id: 'other-host' });
      await expect(mismatch.app.overview()).rejects.toThrow('different Pixice host');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally { globalThis.fetch = originalFetch; }

    const api = { app: { overview: vi.fn(async () => ({ projects: [{ id: 'p' }], tasks: [] })) } };
    await loadConnectOverview({ instances: [{ ...instance, deviceId: 'device-1', expiresAt: 'one' }], apiForHost: () => api });
    api.app.overview.mockRejectedValue(new Error('unauthorized'));
    const sameCredential = await loadConnectOverview({ instances: [{ ...instance, deviceId: 'device-1', expiresAt: 'one' }], apiForHost: () => api });
    expect(sameCredential.hosts[0]).toMatchObject({ state: 'stale', projects: [{ id: 'p' }] });
    const rePaired = await loadConnectOverview({ instances: [{ ...instance, deviceId: 'device-2', expiresAt: 'two' }], apiForHost: () => api });
    expect(rePaired.hosts[0].state).toBe('error');
    expect(rePaired.hosts[0].projects).toBeUndefined();
  });

  it('passes one abort signal into remote overview calls and clamps concurrency', async () => {
    let seenSignal;
    const controller = new AbortController();
    const pending = loadConnectOverview({ instances: [{ id: 'host', endpoint: 'https://host.example' }], maxConcurrent: 99, apiForHost: () => ({ app: { overview: ({ signal }) => { seenSignal = signal; return new Promise(() => {}); } } }), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(seenSignal).toBeDefined();
    expect(seenSignal.aborted).toBe(true);
  });

  it('does not refetch in a rerender loop when the default overview reader is used', async () => {
    const instances = [{ id: 'host', endpoint: 'https://host.example', token: 'token', deviceId: 'device-1', expiresAt: 'one' }];
    const fetchImpl = vi.fn(async (url) => url.endsWith('/info')
      ? { ok: true, status: 200, json: async () => ({ hostId: 'host', protocol: 1, instanceId: 'runtime' }) }
      : { ok: true, status: 200, json: async () => ({ result: { projects: [], tasks: [] } }) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    function Harness() {
      const { loading } = useConnectOverview({ instances });
      return <span>{String(loading)}</span>;
    }
    try {
      const view = render(<Harness />);
      await waitFor(() => expect(view.getByText('false')).toBeInTheDocument());
      const count = fetchImpl.mock.calls.length;
      view.rerender(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fetchImpl).toHaveBeenCalledTimes(count);
    } finally { globalThis.fetch = originalFetch; }
  });
});
