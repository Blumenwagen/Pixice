import { changeEditable, installPromptEditorGeometry, toHaveEditableValue } from "./helpers/prompt-editor.js";
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/App.jsx';
import { cloudTaskId } from '../src/components/ComposerWorkLocation.jsx';

beforeAll(installPromptEditorGeometry);
expect.extend({ toHaveEditableValue });

const model = { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', provider: 'codex', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
function fixture(overrides = {}) {
  const api = {
    voice: { state: vi.fn(async () => ({ available: true })), companion: { state: vi.fn(async () => ({ phase: 'idle' })), open: vi.fn(async () => ({ phase: 'connected' })) } },
    cloud: { state: vi.fn(async () => ({ available: true, environments: [{ id: 'env_1', name: 'Project environment' }, { id: 'env_2', name: 'Release' }] })),
      submit: vi.fn(async () => ({ output: 'Submitted task_real_1', warnings: '' })), status: vi.fn(async () => ({ output: 'Running task_real_1' })), diff: vi.fn(async () => ({ output: 'diff --git a/a b/a' })), open: vi.fn(async () => ({})) },
    events: { subscribe: () => () => {} }
  };
  const props = { disabled: false, busy: false, draftKey: 'p:t', preserveDrafts: true, sendShortcut: 'enter', spellCheckComposer: true, autoFocusComposer: false,
    showSlashCommands: false, running: false, models: [model], selectedModel: model.model, onModelChange: vi.fn(), effort: 'high', onEffortChange: vi.fn(),
    fastMode: false, onFastModeChange: vi.fn(), permissionMode: 'workspace-write', onPermissionModeChange: vi.fn(), providers: [], onSubmit: vi.fn(async () => true), onInterrupt: vi.fn(),
    storage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, dictationApi: api,
    voiceContext: { projectId: 'p', threadId: 't', model: model.model, effort: 'high', permissionMode: 'workspace-write', deviceId: 'selected-mic' },
    workLocation: { api, projectId: 'p', onSetup: vi.fn() }, ...overrides };
  return { api, props };
}
async function chooseCloud() {
  fireEvent.click(screen.getByRole('button', { name: 'Work in: This computer' }));
  const button = await screen.findByRole('button', { name: 'Cloud', exact: true });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Work location' }), { key: 'Escape' });
}

describe('composer Voice action and Cloud routing', () => {
  it('uses one primary action for explicit native Voice and typed Send, without capture on render or empty Enter', async () => {
    const { api, props } = fixture(); const { container } = render(<Composer {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversational Voice' })).toBeEnabled());
    expect(api.voice.companion.open).not.toHaveBeenCalled();
    const textarea = screen.getByRole('textbox', { name: 'Task prompt' });
    fireEvent.keyDown(textarea, { key: 'Enter' }); expect(api.voice.companion.open).not.toHaveBeenCalled(); expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conversational Voice' }));
    await waitFor(() => expect(api.voice.companion.open).toHaveBeenCalledWith(props.voiceContext));
    changeEditable(textarea, { target: { value: 'Fix the bug' } });
    expect(container.querySelectorAll('.composer-primary-action')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true }); expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' }); await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
  });
  it('resolves a new Voice thread only on click and cancels a stale launch after a provider switch', async () => {
    const { api, props } = fixture();
    let resolve;
    const resolveVoiceContext = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { rerender } = render(<Composer {...props} voiceContext={{ ...props.voiceContext, threadId: null }} resolveVoiceContext={resolveVoiceContext} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversational Voice' })).toBeEnabled());
    expect(resolveVoiceContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conversational Voice' }));
    expect(resolveVoiceContext).toHaveBeenCalledOnce();
    rerender(<Composer {...props} models={[{ ...model, provider: 'claude' }]} voiceContext={{ ...props.voiceContext, threadId: null }} resolveVoiceContext={resolveVoiceContext} />);
    await act(async () => resolve(props.voiceContext));
    expect(api.voice.companion.open).not.toHaveBeenCalled();
  });
  it('keeps Stop while a task is running and preserves draft steering', async () => {
    const { props } = fixture({ running: true }); render(<Composer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' })); expect(props.onInterrupt).toHaveBeenCalledOnce();
    changeEditable(screen.getByRole('textbox'), { target: { value: 'Use the other file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer task' })); await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
  });
  it('explains unsupported providers and missing native companion APIs', async () => {
    const { api, props } = fixture(); const { rerender } = render(<Composer {...props} dictationApi={{}} />);
    const expectSendFallback = () => {
      expect(screen.queryByRole('button', { name: 'Conversational Voice' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    };
    expectSendFallback(); expect(screen.getByRole('status')).toHaveTextContent('does not offer the native Voice companion');
    rerender(<Composer {...props} models={[{ ...model, provider: 'claude' }]} />);
    expectSendFallback(); expect(screen.getByRole('status')).toHaveTextContent('available for Codex tasks');
    changeEditable(screen.getByRole('textbox'), { target: { value: 'Ordinary Claude task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveEditableValue(''));
    rerender(<Composer {...props} workLocation={{ ...props.workLocation, remoteTarget: 'remote-device' }} />);
    expectSendFallback(); expect(screen.getByRole('status')).toHaveTextContent('local Pixice host');
    rerender(<Composer {...props} dictationApi={{ ...api, remote: true }} />);
    expectSendFallback(); expect(screen.getByRole('status')).toHaveTextContent('local Pixice host');
    api.voice.state.mockResolvedValue({ available: false, reason: 'Voice is unavailable for this account.' });
    rerender(<Composer {...props} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('unavailable for this account'));
    expectSendFallback(); expect(api.voice.companion.open).not.toHaveBeenCalled();
  });
  it('routes Cloud directly before any Focus/widget/local callback and shows the returned status and diff', async () => {
    const { api, props } = fixture({ disabled: true }); render(<Composer {...props} />); await chooseCloud();
    expect(screen.getByRole('textbox')).toBeEnabled();
    changeEditable(screen.getByRole('textbox'), { target: { value: 'Fix release bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Cloud' }));
    await waitFor(() => expect(api.cloud.submit).toHaveBeenCalledWith({ projectId: 'p', environmentId: 'env_1', prompt: 'Fix release bug', attempts: 1 }));
    expect(props.onSubmit).not.toHaveBeenCalled(); await screen.findByText('Submitted task_real_1');
    fireEvent.click(screen.getByRole('button', { name: 'Check status' })); await screen.findByText('Running task_real_1');
    expect(api.cloud.status).toHaveBeenCalledWith({ projectId: 'p', taskId: 'task_real_1' });
    fireEvent.click(screen.getByRole('button', { name: 'Review diff' })); await screen.findByText('diff --git a/a b/a');
    fireEvent.click(screen.getByRole('button', { name: 'Open Codex Cloud' })); expect(api.cloud.open).toHaveBeenCalledOnce();
  });
  it('keeps files and Preview context from being silently discarded by Cloud, including Enter', async () => {
    const { api, props } = fixture(); const { container, rerender } = render(<Composer {...props} />); await chooseCloud();
    changeEditable(screen.getByRole('textbox'), { target: { value: 'Review this file' } });
    changeEditable(container.querySelector('input[type="file"]'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Cloud' })).toBeDisabled());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(api.cloud.submit).not.toHaveBeenCalled(); expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Cloud cannot receive attachments/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Remove notes.txt/ }));
    rerender(<Composer {...props} workLocation={{ ...props.workLocation, previewContext: { open: true, active: { kind: 'file' } } }} />);
    expect(screen.getByRole('button', { name: 'Send to Cloud' })).toBeDisabled(); expect(screen.getByText(/Cloud cannot receive the open Preview context/)).toBeInTheDocument();
  });
  it('offers setup for missing environments and resets the destination on provider changes', async () => {
    const { api, props } = fixture(); api.cloud.state.mockResolvedValue({ available: true, environments: [] });
    const { rerender } = render(<Composer {...props} />); await chooseCloud();
    fireEvent.click(screen.getByRole('button', { name: 'Work in: Cloud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set up a Cloud environment' })); expect(props.workLocation.onSetup).toHaveBeenCalledOnce();
    rerender(<Composer {...props} models={[{ ...model, provider: 'claude' }]} />);
    expect(screen.getByRole('button', { name: 'Work in: This computer' })).toBeInTheDocument();
  });
  it('ignores old Cloud responses after switching projects, retains the draft, and prevents a deleted environment submission', async () => {
    const { api, props } = fixture(); let resolve;
    api.cloud.submit.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { rerender } = render(<Composer {...props} />); await chooseCloud();
    changeEditable(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Cloud' })); await waitFor(() => expect(api.cloud.submit).toHaveBeenCalledOnce());
    rerender(<Composer {...props} workLocation={{ ...props.workLocation, projectId: 'other-project' }} voiceContext={{ ...props.voiceContext, projectId: 'other-project' }} />);
    await act(async () => resolve({ output: 'Old task_old_result' }));
    expect(screen.queryByText('Old task_old_result')).not.toBeInTheDocument(); expect(screen.getByRole('textbox')).toHaveEditableValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Work in: This computer' })).toBeInTheDocument();
    await chooseCloud(); api.cloud.state.mockResolvedValue({ available: true, environments: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Cloud' })); await screen.findByText(/no longer saved/);
    expect(api.cloud.submit).toHaveBeenCalledOnce(); expect(screen.getByRole('textbox')).toHaveEditableValue('Keep this draft');
  });
  it('uses an attachment as Send and never invents a Cloud task ID', async () => {
    const { api, props } = fixture(); const { container } = render(<Composer {...props} />);
    changeEditable(container.querySelector('input[type="file"]'), { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
    expect(await screen.findByRole('button', { name: 'Send message' })).toBeEnabled(); expect(api.voice.companion.open).not.toHaveBeenCalled();
    expect(cloudTaskId({ output: 'Command finished.' })).toBeNull();
  });
});
