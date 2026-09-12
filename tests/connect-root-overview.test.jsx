import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ConnectRoot } from '../src/connect/ConnectRoot.jsx';

const instances = Array.from({ length: 6 }, (_, index) => ({
  id: `host-${index}`,
  name: `Host ${index}`,
  endpoint: `https://host-${index}.example`,
  token: `token-${index}`,
  deviceId: `device-${index}`,
  expiresAt: `expiry-${index}`
}));

function ParentHarness() {
  const [revision, setRevision] = useState(0);
  return <>
    <button type="button" onClick={() => setRevision((value) => value + 1)}>Parent update</button>
    <span>Parent revision {revision}</span>
    <ConnectRoot><p>Root content</p></ConnectRoot>
  </>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.pixice;
  delete window.pixiceRemote;
  localStorage.setItem('pixice.connect.instances', JSON.stringify(instances));
});

afterEach(() => {
  delete window.pixice;
  delete window.pixiceRemote;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConnectRoot overview', () => {
  it('summarizes cold saved hosts with bounded public reads and survives parent rerenders', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const parsed = new URL(url);
      const hostId = parsed.hostname.split('.')[0];
      if (parsed.pathname.endsWith('/info')) {
        return { ok: true, status: 200, json: async () => ({ hostId, protocol: 1, instanceId: `runtime-${hostId}` }) };
      }
      expect(parsed.pathname).toMatch(/\/call$/);
      expect(options.headers.Authorization).toBe(`Bearer token-${hostId.slice(5)}`);
      const body = JSON.parse(options.body);
      expect(body.operation).toBe('app.overview');
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: {
          projects: [{ id: `project-${hostId}`, displayName: `Project ${hostId}` }],
          tasks: [{ threadId: `thread-${hostId}`, projectId: `project-${hostId}`, title: `Task ${hostId}`, status: 'waiting' }]
        } })
      };
    });
    vi.stubGlobal('fetch', fetchImpl);

    render(<ParentHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Environment: Host 0' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Overview' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Connect overview' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Task host-5').length).toBeGreaterThan(0));

    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchImpl).toHaveBeenCalledTimes(instances.length * 2);
    expect(fetchImpl.mock.calls.some(([url]) => /\/(?:session|poll)(?:\?|$)/.test(url))).toBe(false);
    expect(screen.getByText(/Host 3 · Project host-3 · waiting/)).toBeInTheDocument();
    expect(screen.getByLabelText('Overview counts')).toHaveTextContent('6');

    const callsAfterOverview = fetchImpl.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Parent update' }));
    await waitFor(() => expect(screen.getByText('Parent revision 1')).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterOverview);
  });
});
