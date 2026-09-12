import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../src/connect/ConnectRoot.jsx', () => ({ InstanceList: () => null, useConnect: () => null }));
import { BrowserPushSettings, ConnectionsSettings } from '../src/connect/ConnectionsSettings.jsx';

afterEach(() => { delete window.pixice; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const publicKey = Buffer.from(Uint8Array.from([4, ...new Array(64).fill(1)])).toString('base64url');
const pushEndpoint = 'https://fcm.googleapis.com/fcm/send/settings-test';
const subscriptionKeys = { p256dh: publicKey, auth: Buffer.from('1234567890123456').toString('base64url') };
function makeSubscription(applicationServerKey = publicKey) {
  return {
    endpoint: pushEndpoint,
    expirationTime: null,
    keys: subscriptionKeys,
    options: { applicationServerKey: Uint8Array.from(Buffer.from(applicationServerKey, 'base64url')) },
    toJSON: () => ({ endpoint: pushEndpoint, expirationTime: null, keys: subscriptionKeys }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function setupPush({ local = null, offline = false } = {}) {
  let currentSubscription = local;
  if (currentSubscription) currentSubscription.unsubscribe = vi.fn(async () => { currentSubscription = null; return true; });
  const registration = {
    scope: new URL('/connect-push/host-1/', window.location.origin).href,
    active: { state: 'activated' },
    pushManager: {
      getSubscription: vi.fn(async () => currentSubscription),
      subscribe: vi.fn(async ({ applicationServerKey }) => { currentSubscription = makeSubscription(Buffer.from(applicationServerKey).toString('base64url')); currentSubscription.unsubscribe = vi.fn(async () => { currentSubscription = null; return true; }); return currentSubscription; }),
    },
    unregister: vi.fn(async () => true),
  };
  const serviceWorker = { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => currentSubscription ? registration : null) };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  const notification = { permission: 'default', requestPermission: vi.fn(async () => 'granted') };
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('PushManager', class PushManager {});
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (offline) throw new Error('offline');
    const pathname = new URL(url).pathname;
    if (pathname === '/api/connect/info') return { ok: true, status: 200, json: async () => ({ hostId: 'host-1', protocol: 1 }) };
    if (pathname.endsWith('/subscribe')) return { ok: true, status: 200, json: async () => ({ state: 'enabled', publicKey, registered: true }) };
    if (pathname.endsWith('/unsubscribe')) return { ok: true, status: 200, json: async () => ({ state: 'disabled', registered: false }) };
    return { ok: true, status: 200, json: async () => ({ state: 'ready', readiness: 'ready', publicKey, registered: false }) };
  }));
  return { notification, registration, serviceWorker };
}

describe('Connect settings pairing controls', () => {
  it('shows feature-gated role/project controls, sends explicit options, and probes host identity', async () => {
    const pair = vi.fn(async (options) => ({ id: 'offer-1', url: 'https://host.example/#pair=token', endpoint: 'https://host.example', expiresAt: Date.now() + 300_000 }));
    const info = { hostId: 'host-1', protocol: 1 };
    const status = { hostId: 'host-1', name: 'Host', enabled: true, running: true, port: 43187, host: '127.0.0.1', publicUrl: 'https://host.example', origins: [], devices: [{ id: 'device-1', name: 'Phone', lastSeen: Date.now(), expiresAt: Date.now() + 2 * 86_400_000 }], offers: [], audit: [], pairing: { roles: true, renew: true } };
    const connect = { status: vi.fn(async () => status), pair, revoke: vi.fn(async () => status), renew: vi.fn(async () => status), configure: vi.fn(async () => status), startTunnel: vi.fn(), stopTunnel: vi.fn() };
    Object.defineProperty(window, 'pixice', { configurable: true, value: { connect, app: { bootstrap: vi.fn(async () => ({ projects: [{ id: 'project-1', displayName: 'Project One' }] })) }, events: { subscribe: vi.fn(() => () => {}) } } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => info })));
    render(<ConnectionsSettings />);
    await waitFor(() => expect(screen.getByLabelText('Pairing role')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Pairing role'), { target: { value: 'observer' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Project One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing link' }));
    await waitFor(() => expect(pair).toHaveBeenCalledWith({ role: 'observer', projectIds: ['project-1'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Probe endpoint' }));
    await waitFor(() => expect(screen.getByText(/Verified https:\/\/host\.example/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Renew 30 days' })).toBeInTheDocument();
  });

  it('does not publish a probe result for an edited address or an older overlapping request', async () => {
    const status = { hostId: 'host-1', name: 'Host', enabled: true, running: true, port: 43187, host: '127.0.0.1', publicUrl: 'https://old.example', origins: [], devices: [], offers: [], audit: [], pairing: { roles: true, renew: true } };
    const connect = { status: vi.fn(async () => status), configure: vi.fn(async () => status), pair: vi.fn(), revoke: vi.fn(), renew: vi.fn(), startTunnel: vi.fn(), stopTunnel: vi.fn() };
    Object.defineProperty(window, 'pixice', { configurable: true, value: { connect, events: { subscribe: vi.fn(() => () => {}) } } });
    const first = deferred();
    const second = deferred();
    const requests = [];
    vi.stubGlobal('fetch', vi.fn((url) => {
      const pending = requests.length === 0 ? first : second;
      requests.push({ url, pending });
      return pending.promise;
    }));
    render(<ConnectionsSettings />);
    await waitFor(() => expect(screen.getByLabelText('HTTPS endpoint')).toHaveValue('https://old.example'));

    fireEvent.click(screen.getByRole('button', { name: 'Probe endpoint' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled());
    fireEvent.change(screen.getByLabelText('HTTPS endpoint'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe endpoint' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    second.resolve({ ok: true, status: 200, json: async () => ({ hostId: 'host-1' }) });
    await waitFor(() => expect(screen.getByText('Verified https://new.example belongs to host host-1.')).toBeInTheDocument());
    first.resolve({ ok: true, status: 200, json: async () => ({ hostId: 'host-1' }) });
    await Promise.resolve();
    expect(screen.getByText('Verified https://new.example belongs to host host-1.')).toBeInTheDocument();
    expect(screen.queryByText('Verified https://old.example belongs to host host-1.')).not.toBeInTheDocument();
  });

  it('invalidates a probe when refresh restores the saved endpoint', async () => {
    const status = { hostId: 'host-1', name: 'Host', enabled: true, running: true, port: 43187, host: '127.0.0.1', publicUrl: 'https://saved.example', origins: [], devices: [], offers: [], audit: [], pairing: { roles: true, renew: true } };
    const connect = { status: vi.fn(async () => status), configure: vi.fn(async () => status), pair: vi.fn(), revoke: vi.fn(), renew: vi.fn(), startTunnel: vi.fn(), stopTunnel: vi.fn(), events: { subscribe: vi.fn(() => () => {}) } };
    Object.defineProperty(window, 'pixice', { configurable: true, value: { connect, events: connect.events } });
    const oldProbe = deferred();
    vi.stubGlobal('fetch', vi.fn(() => oldProbe.promise));
    render(<ConnectionsSettings />);
    await waitFor(() => expect(screen.getByLabelText('HTTPS endpoint')).toHaveValue('https://saved.example'));

    fireEvent.change(screen.getByLabelText('HTTPS endpoint'), { target: { value: 'https://edited.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe endpoint' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled());
    await waitFor(() => expect(connect.events.subscribe).toHaveBeenCalled());
    const refreshListener = connect.events.subscribe.mock.calls[0][0];
    await act(async () => { refreshListener({ type: 'ConnectStatus' }); });
    await waitFor(() => expect(connect.status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('HTTPS endpoint')).toHaveValue('https://saved.example'));

    oldProbe.resolve({ ok: true, status: 200, json: async () => ({ hostId: 'host-1' }) });
    await Promise.resolve();
    expect(screen.queryByText('Verified https://edited.example belongs to host host-1.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Probe endpoint' })).toBeInTheDocument();
  });

  it('uses the real push client through enable, enabled, and local turn-off states', async () => {
    const { notification, registration } = setupPush();
    render(<BrowserPushSettings instance={{ id: 'host-1', endpoint: 'https://host.example', token: 'device-token' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument());
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument());
    expect(registration.unregister).toHaveBeenCalledOnce();
  });

  it('offers local turn-off when the host is offline and cannot verify it', async () => {
    const local = makeSubscription();
    const { registration } = setupPush({ local, offline: true });
    render(<BrowserPushSettings instance={{ id: 'host-1', endpoint: 'https://host.example', token: 'device-token' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument());
    expect(local.unsubscribe).toHaveBeenCalledOnce();
    expect(registration.unregister).toHaveBeenCalledOnce();
    expect(screen.getByText(/host could not confirm cleanup/i)).toBeInTheDocument();
  });
});
