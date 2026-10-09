import { changeEditable, installPromptEditorGeometry, toHaveEditableValue } from "./helpers/prompt-editor.js";
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App.jsx';
import { createTaskProgressPreviewApi } from '../src/task-progress-preview.js';

beforeAll(installPromptEditorGeometry);
expect.extend({ toHaveEditableValue });

let api;
let emit;
beforeEach(() => {
  localStorage.clear();
  api = createTaskProgressPreviewApi({ focusIdlePreview: true });
  api.focus.ensure = vi.fn(api.focus.ensure);
  api.threads.read = vi.fn(api.threads.read);
  api.turns.start = vi.fn(api.turns.start);
  const subscribe = api.events.subscribe;
  api.events.subscribe = (listener) => {
    emit = listener;
    return subscribe(listener);
  };
  window.pixice = api;
});

async function openFocus() {
  const app = render(<App />);
  await waitFor(() => expect(app.container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', 'preview-task'));
  fireEvent.click(await screen.findByRole('button', { name: 'Focus' }));
  const prompt = await screen.findByRole('textbox', { name: 'Project Focus prompt' });
  await waitFor(() => expect(app.container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', 'preview-focus'));
  return { ...app, prompt };
}

it('returns from the Focus dock to the same coordinator, draft, activity panel and Preview', async () => {
  const { container, prompt } = await openFocus();
  changeEditable(prompt, { target: { value: 'Keep this Focus draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open activity panel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open preview workspace' }));
  const activity = screen.getByRole('complementary', { name: 'Coordinator activity' });
  const focusLayout = container.querySelector('.focus-layout');
  const ensureCount = api.focus.ensure.mock.calls.length;
  const readCount = api.threads.read.mock.calls.length;
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Focus navigation' })).getByRole('button', { name: 'Settings' }));
  expect(await screen.findByRole('complementary', { name: 'Settings navigation' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Project Focus prompt' })).not.toBeInTheDocument();
  expect(container.querySelector('.pixice-app')).toHaveClass('view-settings');
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-surface-mode', 'workspace');
  expect(container.querySelector('.browser-panel')).toHaveAttribute('aria-hidden', 'true');
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', 'preview-focus');
  fireEvent.click(screen.getByRole('button', { name: /^Appearance/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to Focus' }));
  expect(screen.getByRole('textbox', { name: 'Project Focus prompt' })).toBe(prompt);
  expect(prompt).toHaveEditableValue('Keep this Focus draft');
  expect(screen.getByRole('complementary', { name: 'Coordinator activity' })).toBe(activity);
  expect(container.querySelector('.focus-layout')).toBe(focusLayout);
  expect(focusLayout).toHaveClass('preview-open');
  expect(container.querySelector('.browser-panel')).toHaveAttribute('aria-hidden', 'false');
  expect(api.focus.ensure).toHaveBeenCalledTimes(ensureCount);
  expect(api.threads.read).toHaveBeenCalledTimes(readCount);
});

it.each(['settings', 'usage'])('returns to Focus after /%s without sending a turn', async (command) => {
  const { prompt, container } = await openFocus();
  const ensureCount = api.focus.ensure.mock.calls.length;
  changeEditable(prompt, { target: { value: `/${command}` } });
  fireEvent.keyDown(prompt, { key: 'Enter' });
  expect(await screen.findByRole('complementary', { name: 'Settings navigation' })).toBeInTheDocument();
  if (command === 'usage') expect(await screen.findByRole('region', { name: 'Usage overview' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Focus' }));
  expect(screen.getByRole('textbox', { name: 'Project Focus prompt' })).toBe(prompt);
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', 'preview-focus');
  expect(api.focus.ensure).toHaveBeenCalledTimes(ensureCount);
  expect(api.turns.start).not.toHaveBeenCalled();
});

it('returns to the Workspace task and its Preview, then restores the previous Review view', async () => {
  const { container } = render(<App />);
  const prompt = await screen.findByRole('textbox', { name: 'Task prompt' });
  await waitFor(() => expect(container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', 'preview-task'));
  const threadId = container.querySelector('.pixice-app').dataset.activeThreadId;
  changeEditable(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Keep this task draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open preview workspace' }));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Back to task' }));
  expect(await screen.findByRole('textbox', { name: 'Task prompt' })).toHaveEditableValue('Keep this task draft');
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', threadId);
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-preview-open', 'true');
  fireEvent.click(screen.getAllByRole('button', { name: 'Close preview workspace' })[0]);
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Primary navigation' })).getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Back to Review' }));
  expect(container.querySelector('.pixice-app')).toHaveClass('view-review');
  expect(container.querySelector('.pixice-app')).toHaveAttribute('data-active-thread-id', threadId);
});

it('keeps the Focus origin across repeated tray Settings entries', async () => {
  const { prompt } = await openFocus();
  await act(async () => emit({ type: 'TrayNavigate', payload: { view: 'settings', settingsPage: 'general' } }));
  expect(await screen.findByRole('button', { name: 'Back to Focus' })).toBeInTheDocument();
  await act(async () => emit({ type: 'TrayNavigate', payload: { view: 'settings', settingsPage: 'usage' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to Focus' }));
  expect(screen.getByRole('textbox', { name: 'Project Focus prompt' })).toBe(prompt);
});

it('releases the hidden Preview save shortcut and restores it when Focus is shown', async () => {
  api.files.write = vi.fn(api.files.write);
  const { unmount } = await openFocus();
  await act(async () => emit({ type: 'FilePreviewOpenRequested', payload: {
    workspaceId: 'preview-focus',
    file: { path: '/work/pixice/notes.md', name: 'notes.md', kind: 'markdown',
      content: 'Original', editable: true, size: 8, mtimeMs: 1 }
  } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const editor = screen.getByRole('textbox', { name: 'Edit notes.md' });
  changeEditable(editor, { target: { value: 'Unsaved Focus notes' } });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Focus navigation' })).getByRole('button', { name: 'Settings' }));
  await screen.findByRole('button', { name: 'Back to Focus' });
  expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(true);
  expect(fireEvent.keyDown(window, { key: 's', metaKey: true })).toBe(true);
  expect(api.files.write).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Back to Focus' }));
  expect(screen.getByRole('textbox', { name: 'Edit notes.md' })).toBe(editor);
  expect(editor).toHaveEditableValue('Unsaved Focus notes');
  expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false);
  await waitFor(() => expect(api.files.write).toHaveBeenCalledTimes(1));
  expect(api.files.write).toHaveBeenLastCalledWith(expect.objectContaining({
    projectId: 'preview-project', path: '/work/pixice/notes.md', content: 'Unsaved Focus notes'
  }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  changeEditable(editor, { target: { value: 'More Focus notes' } });
  expect(fireEvent.keyDown(window, { key: 's', metaKey: true })).toBe(false);
  await waitFor(() => expect(api.files.write).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  unmount();
  expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(true);
  expect(api.files.write).toHaveBeenCalledTimes(2);
});
