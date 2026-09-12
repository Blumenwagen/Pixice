import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectPreview } from '../src/connect-preview.jsx';
import { ConnectRoot, useConnect } from '../src/connect/ConnectRoot.jsx';
import { remoteThreadLinksKey } from '../src/connect/execution-storage.js';

let fixture;
let mounted;

function ContextHarness({ connectRef, executionPropsRef }) {
  const connect = useConnect();
  connectRef.current = connect;
  if (executionPropsRef) executionPropsRef.current = connect.executionView?.props ?? null;
  return connect.executionView;
}

function gateThreadCreates() {
  const fixtureFetch = window.fetch;
  const gates = [];
  const requests = [];
  window.fetch = vi.fn((input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input?.url, window.location.href);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* The fixture will report malformed requests. */ }
    requests.push({ url, body });
    if (url.pathname !== '/api/connect/call' || body?.operation !== 'threads.create') return fixtureFetch(input, init);
    let resolveGate;
    let rejectGate;
    const gate = {
      release() {
        if (gate.released) return;
        gate.released = true;
        void fixtureFetch(input, init).then(resolveGate, rejectGate);
      },
      promise: new Promise((resolve, reject) => { resolveGate = resolve; rejectGate = reject; }),
      released: false
    };
    gates.push(gate);
    return gate.promise;
  });
  return { gates, requests };
}

async function renderRoot(active = 'local', executionPropsRef = null) {
  sessionStorage.setItem('pixice.connect.active', '__pixice_local__');
  const connectRef = { current: null };
  mounted = render(<ConnectRoot><ContextHarness connectRef={connectRef} executionPropsRef={executionPropsRef} /></ConnectRoot>);
  await waitFor(() => expect(connectRef.current).toBeTruthy());
  if (active !== 'local') {
    await act(async () => { connectRef.current.select(active); });
  }
  const expectedLabel = active === 'local' ? 'This device' : active === 'observer-c' ? 'Observer tablet' : active;
  await waitFor(() => expect(screen.getByRole('button', { name: `Environment: ${expectedLabel}` })).toBeInTheDocument());
  return connectRef;
}

beforeEach(() => {
  fixture = ConnectPreview.installFixture(window);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  fixture?.restore();
  fixture = null;
  delete window.pixiceRemote;
  vi.restoreAllMocks();
});

describe('ConnectRoot execution lifecycle', () => {
  it('aborts a pending target create before resolving close as false', async () => {
    const { gates } = gateThreadCreates();
    const connectRef = await renderRoot();
    const promise = connectRef.current.openExecution({ hostId: 'host-b', projectId: 'project-b', initialPrompt: 'Close this draft' });
    await waitFor(() => expect(gates).toHaveLength(1));

    await act(async () => {
      connectRef.current.closeExecution();
      gates[0].release();
      await Promise.resolve();
    });

    await expect(promise).resolves.toBe(false);
    await waitFor(() => expect(fixture.calls.some((call) => call.hostId === 'host-b' && call.operation === 'turns.start')).toBe(false));
  });

  it('settles only the superseded request and never starts from its late create reply', async () => {
    const { gates } = gateThreadCreates();
    const connectRef = await renderRoot();
    const first = connectRef.current.openExecution({ hostId: 'host-b', projectId: 'project-b', initialPrompt: 'Old draft' });
    await waitFor(() => expect(gates).toHaveLength(1));

    let secondSettled;
    const second = connectRef.current.openExecution({ hostId: 'host-b', projectId: 'project-b', initialPrompt: 'New draft' });
    void second.then((value) => { secondSettled = value; });
    await waitFor(() => expect(gates).toHaveLength(2));
    await expect(first).resolves.toBe(false);

    await act(async () => {
      gates[0].release();
      await Promise.resolve();
    });
    expect(secondSettled).toBeUndefined();
    expect(fixture.calls.some((call) => call.hostId === 'host-b' && call.operation === 'turns.start')).toBe(false);

    await act(async () => {
      connectRef.current.closeExecution();
      gates[1].release();
      await Promise.resolve();
    });
    await expect(second).resolves.toBe(false);
    expect(fixture.calls.some((call) => call.hostId === 'host-b' && call.operation === 'turns.start')).toBe(false);
  });

  it('does not connect or start for an already-aborted incoming submission', async () => {
    const { gates, requests } = gateThreadCreates();
    const connectRef = await renderRoot();
    const controller = new AbortController();
    controller.abort(new DOMException('Already cancelled', 'AbortError'));

    await expect(connectRef.current.openExecution({
      hostId: 'host-b',
      projectId: 'project-b',
      initialPrompt: 'Do not connect',
      submissionSignal: controller.signal
    })).resolves.toBe(false);

    expect(gates).toHaveLength(0);
    expect(requests.some(({ url }) => url.hostname === 'host-b.example')).toBe(false);
    expect(fixture.calls.some((call) => call.hostId === 'host-b' && ['threads.create', 'turns.start'].includes(call.operation))).toBe(false);
  });

  it('keeps the initial submission signal stable after success and an unrelated rerender', async () => {
    const { gates } = gateThreadCreates();
    const executionPropsRef = { current: null };
    const connectRef = await renderRoot('local', executionPropsRef);
    const promise = connectRef.current.openExecution({ hostId: 'host-b', projectId: 'project-b', initialPrompt: 'Keep this signal' });
    await waitFor(() => expect(gates).toHaveLength(1));
    await waitFor(() => expect(executionPropsRef.current?.submissionSignal).toBeInstanceOf(AbortSignal));
    const submissionSignal = executionPropsRef.current.submissionSignal;

    await act(async () => {
      gates[0].release();
      await Promise.resolve();
    });
    await expect(promise).resolves.toBe(true);
    expect(submissionSignal).not.toBeNull();
    expect(submissionSignal.aborted).toBe(false);
    expect(executionPropsRef.current.submissionSignal).toBe(submissionSignal);

    await act(async () => {
      mounted.rerender(<ConnectRoot><ContextHarness connectRef={connectRef} executionPropsRef={executionPropsRef} /></ConnectRoot>);
    });
    await waitFor(() => expect(executionPropsRef.current?.submissionSignal).toBe(submissionSignal));
    expect(executionPropsRef.current.submissionSignal).not.toBeNull();
    expect(executionPropsRef.current.submissionSignal.aborted).toBe(false);
  });

  it('shows an operator task beside the observer origin and closes back to that origin', async () => {
    const connectRef = await renderRoot();
    connectRef.current.registerOrigin({ hostId: 'local', projectId: 'project-a', hostLabel: 'This device' });
    await act(async () => { connectRef.current.select('observer-c'); });
    await screen.findByText('Read-only project view');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Observer project' })).toHaveValue('project-b'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Observer task' })).toHaveValue('thread-collision'));
    const observer = screen.getByRole('region', { name: 'Observer workspace for Observer tablet' });
    const fileList = screen.getByRole('listbox', { name: 'Project files' });
    const fileOptions = within(fileList).getAllByRole('option');
    expect(fileOptions.length).toBeGreaterThan(1);
    const selectedFile = fileOptions[1];
    fireEvent.click(selectedFile);
    await waitFor(() => expect(selectedFile).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('Observer access · Observer tablet')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Environment:/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Overview' }));
    const overview = await screen.findByRole('dialog', { name: 'Connect overview' });
    const operatorTask = within(overview).getAllByText(/^Beacon host · Beacon mobile · /)[0].closest('.connect-overview-task');
    expect(operatorTask).not.toBeNull();
    fireEvent.click(within(operatorTask).getByRole('button', { name: 'Open' }));
    const target = await screen.findByRole('region', { name: 'Task on Beacon host' });
    await within(target).findByText('Beacon mobile', { selector: 'small' });
    await within(target).findByText('Review remote mobile handoff', { selector: 'strong' });
    expect(target).toHaveTextContent('Beacon mobile');
    expect(target).toHaveTextContent('Review remote mobile handoff');
    expect(screen.getByRole('button', { name: 'Environment: Observer tablet' })).toBeInTheDocument();
    expect(window.localStorage.getItem(remoteThreadLinksKey('local', 'project-a'))).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem(remoteThreadLinksKey('observer-c', 'project-b'))).toContain('Observer tablet'));

    const observerOrigin = observer.closest('.connect-observer-origin');
    expect(observerOrigin).toHaveAttribute('aria-hidden', 'true');
    expect(observerOrigin).toHaveAttribute('inert');
    expect(observer).toHaveTextContent('cannot run tasks');
    expect(within(observer).queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    expect(target).toBeVisible();
    expect(within(target).getByRole('button', { name: 'Close remote task' })).toBeVisible();
    expect(screen.getAllByRole('region', { name: 'Task on Beacon host' })).toHaveLength(1);

    await act(async () => {
      target.querySelector('button[aria-label="Close remote task"]').click();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task on Beacon host' })).not.toBeInTheDocument());
    const restoredObserver = screen.getByRole('region', { name: 'Observer workspace for Observer tablet' });
    expect(restoredObserver).toBe(observer);
    expect(restoredObserver.closest('.connect-observer-origin')).not.toHaveAttribute('aria-hidden');
    expect(restoredObserver.closest('.connect-observer-origin')).not.toHaveAttribute('inert');
    expect(screen.getByRole('combobox', { name: 'Observer project' })).toHaveValue('project-b');
    expect(screen.getByRole('combobox', { name: 'Observer task' })).toHaveValue('thread-collision');
    expect(selectedFile).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Environment: Observer tablet' })).toBeInTheDocument();
    expect(screen.getByText('Observer access · Observer tablet')).toBeVisible();
  });
});
