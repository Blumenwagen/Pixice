import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../src/App.jsx';

const appRequest = (params = {}) => ({
  id: 'computer-access', requestGeneration: 12, provider: 'codex',
  method: 'mcpServer/elicitation/request',
  params: {
    serverName: 'computer', message: 'Allow ChatGPT to use Chrome?',
    _meta: { app_name: 'Chrome' },
    requestedSchema: {
      type: 'object', required: ['approval'], properties: {
        approval: { type: 'string', oneOf: [
          { const: 'once', title: 'Allow once' },
          { const: 'session', title: 'For this session' },
          { const: 'always', title: 'Remember' }
        ] }
      }
    },
    ...params
  }
});

describe('computer-use app approval actions', () => {
  it('exposes app-scoped permission choices directly, including Always allow', async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(<ApprovalCard request={appRequest()} onResolve={onResolve} />);
    expect(screen.getByText('Approval required')).toBeInTheDocument();
    expect(screen.getByText('Allow ChatGPT to use Chrome?')).toBeInTheDocument();
    expect(screen.queryByText('App access · Chrome')).not.toBeInTheDocument();
    expect(screen.getByText(/Codex remember access to Chrome across requests and chats/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(appRequest(), { decision: 'acceptAlways' }));
  });

  it.each([
    ['Allow once', 'accept'], ['Allow for session', 'acceptForSession'], ['Decline', 'decline']
  ])('submits %s through the confirmed response path', async (label, decision) => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(<ApprovalCard request={appRequest()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(appRequest(), { decision }));
  });

  it('does not promise persistence when the provider only advertises one-time access', () => {
    const request = appRequest({ requestedSchema: { type: 'object', required: ['approval'], properties: {
      approval: { type: 'string', enum: ['once'] }
    } } });
    render(<ApprovalCard request={request} onResolve={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow for session' })).not.toBeInTheDocument();
    expect(screen.queryByText(/across requests and chats/)).not.toBeInTheDocument();
  });

  it('does not invent Allow once when a required provider choice only supports persistent access', () => {
    const request = appRequest({ requestedSchema: { type: 'object', required: ['approval'], properties: {
      approval: { type: 'string', enum: ['always'] }
    } } });
    render(<ApprovalCard request={request} onResolve={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it('preserves Always allow and locks other choices while confirmation is uncertain', async () => {
    let reject;
    const sent = new Promise((_, no) => { reject = no; });
    const onResolve = vi.fn().mockReturnValueOnce(sent).mockResolvedValue(true);
    const request = appRequest();
    const view = render(<ApprovalCard request={request} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for provider confirmation');
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    view.rerender(<ApprovalCard request={{ ...request, responseState: 'uncertain' }} onResolve={onResolve} />);
    reject(Object.assign(new Error('Provider confirmation is missing'), { uncertain: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry response' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls.map(call => call[1])).toEqual([
      { decision: 'acceptAlways' }, { decision: 'acceptAlways' }
    ]);
  });

  it('preserves generic elicitation fields when an app also asks for ordinary input', async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    const request = appRequest({ requestedSchema: {
      type: 'object', required: ['label'], properties: {
        label: { type: 'string', title: 'Window label' }
      }
    } });
    render(<ApprovalCard request={request} onResolve={onResolve} />);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Window label' }), { target: { value: 'Draft window' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(request, { action: 'accept', content: { label: 'Draft window' } }));
  });

  it('preserves external URL elicitations even when metadata advertises persistence', async () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    const request = appRequest({ mode: 'url', url: 'https://example.test/connect',
      _meta: { app_name: 'Chrome', allowPersistentApproval: true }, requestedSchema: undefined });
    render(<ApprovalCard request={request} onResolve={onResolve} />);
    expect(screen.getByRole('link', { name: 'Open request' })).toHaveAttribute('href', request.params.url);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(request, { action: 'accept' }));
  });
});
