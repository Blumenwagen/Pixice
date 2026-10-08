import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatGPTSettings } from '../src/components/ChatGPTSettings.jsx';
import { CodexCloudSettings } from '../src/components/CodexCloudSettings.jsx';
import { VoiceConversation } from '../src/components/VoiceConversation.jsx';
const events = { subscribe: () => () => {} };
describe('DevDay integration controls', () => {
  it('opens app-owned sign-in and uses an explicitly selected validated profile', async () => {
    const state = { profiles: [{ id: 'profile', email: 'person@example.com', clientId: 'oaiapp_profile', signedIn: true, planEnabled: true }], selectedProfileId: null, pending: false };
    const api = { events, chatgpt: { state: vi.fn(async () => state), signIn: vi.fn(async () => ({})), select: vi.fn(async () => ({})) } };
    render(<ChatGPTSettings api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use for Codex' }));
    await waitFor(() => expect(api.chatgpt.select).toHaveBeenCalledWith({ profileId: 'profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    await waitFor(() => expect(api.chatgpt.signIn).toHaveBeenCalledWith({}));
    expect(screen.queryByLabelText(/token|secret/i)).not.toBeInTheDocument();
  });
  it('requires concrete submission and patch reviews before either Cloud mutation', async () => {
    const state = { available: true, environments: [{ id: 'env_1', name: 'Release' }] };
    const api = { cloud: { state: vi.fn(async () => state), list: vi.fn(async () => ({ data: { tasks: [] } })), submit: vi.fn(async () => ({ output: 'Submitted task_1' })), diff: vi.fn(async () => ({ output: 'diff --git a/file b/file\n+fixed', diffHash: 'a'.repeat(64), reviewId: '11111111-1111-4111-8111-111111111111', attempt: 1 })), apply: vi.fn(async () => ({ output: 'Applied' })) } };
    render(<CodexCloudSettings api={api} projects={[{ id: 'p', displayName: 'Project', canonicalPath: '/project' }]} projectId="p" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    fireEvent.change(screen.getByLabelText('Cloud task prompt'), { target: { value: 'Fix the bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review submission' }));
    expect(api.cloud.submit).not.toHaveBeenCalled(); expect(screen.getByRole('region', { name: 'Confirm Cloud submission' })).toHaveTextContent('env_1');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Cloud task' }));
    await waitFor(() => expect(api.cloud.submit).toHaveBeenCalledWith({ projectId: 'p', environmentId: 'env_1', prompt: 'Fix the bug', attempts: 1 }));
    await screen.findByText('Submitted task_1');
    fireEvent.change(screen.getByLabelText('Cloud task ID'), { target: { value: 'task_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review diff' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply reviewed patch…' }));
    expect(api.cloud.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply patch to project' }));
    await waitFor(() => expect(api.cloud.apply).toHaveBeenCalledWith({ projectId: 'p', taskId: 'task_1', expectedDiffHash: 'a'.repeat(64), reviewId: '11111111-1111-4111-8111-111111111111' }));
  });
  it('launches the native companion only after an explicit supported Voice action', async () => {
    const open = vi.fn(async () => ({ phase: 'connecting' }));
    const api = { events, voice: { state: vi.fn(async () => ({ available: true })), companion: { open } } };
    const { container } = render(<VoiceConversation api={api} projectId="p" threadId="t" permissionMode="read-only">
      {(voice) => <button disabled={!voice.available} onClick={voice.open}>Conversational Voice</button>}
    </VoiceConversation>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversational Voice' })).toBeEnabled());
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conversational Voice' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', threadId: 't', permissionMode: 'read-only' })));
    expect(container.querySelector('[role="dialog"]')).toBe(null);
  });
});
