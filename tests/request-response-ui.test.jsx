import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard, Composer } from '../src/App.jsx';

const approval = { id: 'approval', requestGeneration: 4, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test' } };
const waitForResponse = () => {
  let reject;
  let resolve;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('provider response confirmation UI', () => {
  it('keeps an approval visible and prevents duplicate/changed decisions until confirmation', async () => {
    const first = waitForResponse();
    const onResolve = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const view = render(<ApprovalCard request={approval} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for provider confirmation');
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    view.rerender(<ApprovalCard request={{ ...approval, responseState: 'uncertain', responseError: 'Approval was sent; provider confirmation is missing.' }} onResolve={onResolve} />);
    first.reject(Object.assign(new Error('Missing confirmation'), { uncertain: true }));
    const retry = await screen.findByRole('button', { name: 'Retry response' });
    expect(screen.getByRole('alert')).toHaveTextContent('Approval was sent');
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls.map(call => call[1])).toEqual(['accept', 'accept']);
  });

  it('preserves structured elicitation values for an identical retry', async () => {
    const first = waitForResponse();
    const onResolve = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const request = { id: 'form', requestGeneration: 5, method: 'mcpServer/elicitation/request', params: { requestedSchema: {
      type: 'object', required: ['label'], properties: { label: { type: 'string', title: 'Release label' } }
    } } };
    const view = render(<ApprovalCard request={request} onResolve={onResolve} />);
    const input = screen.getByRole('textbox', { name: 'Release label' });
    fireEvent.change(input, { target: { value: 'Keep the review draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(input).toHaveValue('Keep the review draft');
    expect(input).toBeDisabled();
    view.rerender(<ApprovalCard request={{ ...request, responseState: 'uncertain' }} onResolve={onResolve} />);
    first.reject(Object.assign(new Error('Provider timeout'), { uncertain: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry response' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls[1][1]).toEqual({ action: 'accept', content: { label: 'Keep the review draft' } });
  });

  it('keeps the final composer question readable and its selected answer through uncertainty', async () => {
    const first = waitForResponse();
    const onResolve = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const request = { id: 'question', requestGeneration: 6, method: 'pixice/requestUserInput', params: { questions: [
      { id: 'scope', question: 'Which scope?', options: [{ label: 'Current project', description: 'Use this workspace' }] }
    ] } };
    const props = { disabled: false, busy: false, draftKey: 'draft', preserveDrafts: true, autoFocusComposer: false,
      models: [], questionRequest: request, onQuestionResolve: onResolve };
    const view = render(<Composer {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /Current project/ }));
    expect(screen.getByText('Which scope?')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting for provider confirmation');
    expect(screen.getByRole('radio', { name: /Current project/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Current project/ })).toBeDisabled();
    expect(screen.getByText('Which scope?').closest('.question-step')).toHaveAttribute('data-phase', 'idle');
    view.rerender(<Composer {...props} questionRequest={{ ...request, responseState: 'uncertain' }} />);
    first.reject(Object.assign(new Error('Response unconfirmed'), { uncertain: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry response' }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls[1][1]).toEqual({ action: 'answer', answers: { scope: 'Current project' } });
  });
});
