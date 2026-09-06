import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectRoot } from '../src/connect/ConnectRoot.jsx';
const original = Object.getOwnPropertyDescriptor(window, 'pixice');
afterEach(() => { cleanup(); localStorage.clear(); if (original) Object.defineProperty(window, 'pixice', original); else delete window.pixice; });
describe('desktop backend connection state', () => {
  it('preserves a mounted draft while offline and refreshes after a backend reset', async () => {
    localStorage.clear(); let receive; let mounts = 0;
    const service = { connection: vi.fn(async () => ({ state: 'connected' })), start: vi.fn(async () => { receive({ type: 'ServiceConnectionState', payload: { state: 'connected' } }); }) };
    Object.defineProperty(window, 'pixice', { configurable: true, value: { service, events: { subscribe: (listener) => { receive = listener; return () => {}; } } } });
    function Draft() { React.useEffect(() => { mounts++; }, []); return <input aria-label="Draft" defaultValue="" />; }
    render(<ConnectRoot><Draft /></ConnectRoot>);
    await waitFor(() => expect(screen.queryByText('Connecting to Pixice…')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Unsaved work' } });
    act(() => receive({ type: 'ServiceConnectionState', payload: { state: 'reconnecting' } }));
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft')).toHaveValue('Unsaved work');
    expect(mounts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start backend' }));
    await waitFor(() => expect(service.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('Backend unavailable')).not.toBeInTheDocument());
    const before = mounts;
    act(() => receive({ type: 'ServiceReset' }));
    await waitFor(() => expect(mounts).toBe(before + 1));
  });
});
