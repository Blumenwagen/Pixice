import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectRoot } from '../src/connect/ConnectRoot.jsx';
import { MobileAttentionPanel } from '../src/connect/mobile-attention.jsx';

afterEach(() => {
  delete window.pixice;
  delete window.pixiceRemote;
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.pixice;
});

describe('Connect finishing UI', () => {
  it('reports mobile attention truthfully for checking, partial, stale, and complete snapshots', () => {
    const view = render(<MobileAttentionPanel loading />);
    expect(view.getByText('Checking hosts…')).toBeInTheDocument();
    expect(view.queryByText('Nothing is waiting right now.')).not.toBeInTheDocument();

    view.rerender(<MobileAttentionPanel snapshot={{
      partial: true,
      hosts: [{ hostId: 'host-1', state: 'stale', stale: true }],
      tasks: [{ hostId: 'host-1', projectId: 'project-1', threadId: 'thread-1', title: 'Review', hostName: 'Laptop', projectName: 'Project', status: 'waiting' }]
    }} onOpen={vi.fn()} />);
    expect(view.getByText(/Showing available and last-known tasks/)).toBeInTheDocument();
    expect(view.getByText(/Last known$/)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Open unavailable' })).toBeDisabled();

    view.rerender(<MobileAttentionPanel snapshot={{ partial: false, hosts: [{ hostId: 'host-1', state: 'ready' }], tasks: [] }} />);
    expect(view.getByText('Nothing is waiting right now.')).toBeInTheDocument();
  });

  it('traps overview focus, closes with Escape, and restores its opener', async () => {
    render(<ConnectRoot><p>Workspace</p></ConnectRoot>);
    const bar = document.querySelector('.connect-environment-bar');
    const opener = screen.getByRole('button', { name: 'Environment: No configured environments' });
    expect(within(bar).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    opener.focus();
    fireEvent.keyDown(opener, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu', { name: 'Environment menu' });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Overview' })));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Overview' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect overview' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(close));

    const focusable = within(dialog).getAllByRole('button').concat(within(dialog).getAllByRole('combobox'));
    const last = focusable.at(-1);
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect overview' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps only the topmost nested Connect dialog in control of focus and Escape', async () => {
    localStorage.setItem('pixice.connect.recovery', JSON.stringify([{ hostId: 'host-1', deviceId: 'device-1', commandId: 'command-1', backendInstanceId: 'backend-1', operation: 'threads.create', issuedAt: Date.now() }]));
    render(<ConnectRoot><p>Workspace</p></ConnectRoot>);
    const overviewOpener = screen.getByRole('button', { name: 'Environment: No configured environments' });
    overviewOpener.focus();
    fireEvent.keyDown(overviewOpener, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Overview' }));
    const overview = await screen.findByRole('dialog', { name: 'Connect overview' });
    const overviewClose = within(overview).getByRole('button', { name: 'Close' });

    overviewClose.focus();
    fireEvent.click(overviewOpener);
    const menu = await screen.findByRole('menu', { name: 'Environment menu' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Recovery/ }));
    const recovery = await screen.findByRole('dialog', { name: 'Connect recovery' });
    const recoveryButtons = within(recovery).getAllByRole('button');
    const recoveryFirst = recoveryButtons[0];
    const recoveryMiddle = recoveryButtons[1];
    const recoveryLast = recoveryButtons.at(-1);
    await waitFor(() => expect(document.activeElement).toBe(recoveryFirst));

    recoveryMiddle.focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    recoveryLast.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(recoveryFirst);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(recoveryLast);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect recovery' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Connect overview' })).toBe(overview);
    expect(document.activeElement).toBe(overviewOpener);
  });

  it('keeps Recovery and Add instance available from saved usage', async () => {
    localStorage.setItem('pixice.connect.instances', JSON.stringify([{ id: 'host-1', name: 'Saved host', endpoint: 'https://host-1.example', token: 'token' }]));
    localStorage.setItem('pixice.connect.recovery', JSON.stringify([{ hostId: 'host-1', deviceId: 'device-1', commandId: 'command-1', backendInstanceId: 'backend-1', operation: 'threads.create', issuedAt: Date.now() }]));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }) })));
    render(<ConnectRoot><p>Workspace</p></ConnectRoot>);

    fireEvent.click(screen.getByRole('button', { name: 'View Unified Usage' }));
    await screen.findByRole('heading', { name: 'Usage' });
    const recoveryOpener = screen.getByRole('button', { name: 'Environment: Saved host' });
    fireEvent.click(recoveryOpener);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Recovery/ }));
    expect(await screen.findByRole('dialog', { name: 'Connect recovery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect recovery' })).not.toBeInTheDocument());

    fireEvent.click(recoveryOpener);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add or manage' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add instance' }));
    expect(await screen.findByRole('dialog', { name: 'Pair instance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair instance' })).toBeInTheDocument();
  });

  it('selects a saved host from the environment menu and dismisses an open menu outside', async () => {
    localStorage.setItem('pixice.connect.instances', JSON.stringify([
      { id: 'host-1', name: 'Saved host one', endpoint: 'https://host-1.example', token: 'token-1' },
      { id: 'host-2', name: 'Saved host two', endpoint: 'https://host-2.example', token: 'token-2' }
    ]));
    vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/info') ? { protocol: 1, hostId: 'host-2', instanceId: 'backend-2' } : { role: 'operator', projectIds: [] } })));
    render(<ConnectRoot><p>Workspace</p></ConnectRoot>);

    const trigger = screen.getByRole('button', { name: 'Environment: Saved host one' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Environment menu' });
    const host = within(menu).getByRole('menuitemradio', { name: /Saved host two/ });
    expect(host).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(host);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Environment: Saved host two' })).toBeInTheDocument());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu', { name: 'Environment menu' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
