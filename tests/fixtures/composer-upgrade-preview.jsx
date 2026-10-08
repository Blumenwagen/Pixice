import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/App.jsx';
import { MessageQueuePanel } from '../../src/components/MessageQueue.jsx';
import { SelectionContextMenu } from '../../src/composer/SelectionContextMenu.jsx';
import { requestQueueEdit } from '../../src/composer/composer-runtime.js';
import { serializeContextForProvider } from '../../src/composer/context.js';
import '../../src/styles.css';

const projectId = 'composer-preview'; const threadId = 'composer-preview-thread';
const listeners = new Set();
let queue = { held: false, entries: [{ id: 'queued', text: 'Review the implementation before shipping.', source: 'user', state: 'queued', attachments: [] }] };
const publish = () => listeners.forEach(listener => listener({ type: 'MessageQueueUpdated', payload: { projectId, threadId, ...queue } }));
const api = {
  files: { list: async ({ query }) => ({ files: [{ path: '/project/src/App.jsx', relativePath: 'src/App.jsx', name: 'App.jsx', folderPath: '/project' }, { path: '/project/README.md', relativePath: 'README.md', name: 'README.md', folderPath: '/project' }].filter(file => file.path.toLowerCase().includes(query?.toLowerCase() ?? '')) }) },
  threads: { list: async () => ({ data: [{ id: 'reference-thread', name: 'Design decisions' }] }) },
  pullRequests: { list: async () => [{ number: 42, title: 'Composer upgrade', url: 'https://github.com/example/project/pull/42', state: 'open', baseBranch: 'main', headBranch: 'composer' }], read: async () => ({ number: 42, title: 'Composer upgrade', url: 'https://github.com/example/project/pull/42', state: 'open' }) },
  events: { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } },
  turns: { queueList: async () => queue, queueDraft: async ({ id }) => ({ ...queue.entries.find(entry => entry.id === id), contextRecords: [], attachments: [] }), queueEdit: async payload => { queue = { ...queue, entries: queue.entries.map(entry => entry.id === payload.id ? { ...entry, text: payload.text, contextRecords: payload.contextRecords, attachments: payload.attachments } : entry) }; publish(); return queue; }, queueRemove: async ({ id }) => { queue = { ...queue, entries: queue.entries.filter(entry => entry.id !== id) }; publish(); return queue; }, queueHold: async () => { queue.held = true; publish(); return queue; }, queueResume: async () => { queue.held = false; publish(); return queue; } }
};
const models = [{ model: 'preview-model', displayName: 'GPT Preview', provider: 'codex', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
function Preview() {
  const [plain, setPlain] = useState(false); const [running, setRunning] = useState(false); const [result, setResult] = useState(null);
  return <main style={{ '--conversation-width': '880px', width: 'min(880px, calc(100vw - 80px))', margin: '70px auto', color: 'var(--foreground)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 30 }}><strong>Pixice · Composer</strong><div style={{ display: 'flex', gap: 20 }}><label><input type="checkbox" checked={plain} onChange={event => setPlain(event.target.checked)} /> Plain text</label><label><input type="checkbox" checked={running} onChange={event => setRunning(event.target.checked)} /> Task running</label></div></div>
    <SelectionContextMenu projectId={projectId} threadId={threadId}><article className="message assistant-message" data-context-kind="citation" data-context-item="answer-preview" data-context-label="Assistant answer" style={{ marginBottom: 40, fontSize: 15, lineHeight: 1.65 }}><p>The composer keeps context next to the words that refer to it. Select this answer to quote it, add a comment to its chip, or type @ to attach a project file.</p></article></SelectionContextMenu>
    <MessageQueuePanel api={api} projectId={projectId} threadId={threadId} onEdit={entry => requestQueueEdit({ projectId, threadId, entry })} />
    <Composer draftKey={`${projectId}:${threadId}`} preserveDrafts sendShortcut="enter" autoFocusComposer showSlashCommands spellCheckComposer richTextEnabled={!plain} models={models} selectedModel="preview-model" effort="medium" permissionMode="workspace-write" running={running} queueEnabled activeTurnId="active-turn" onModelChange={() => {}} onEffortChange={() => {}} onFastModeChange={() => {}} onPermissionModeChange={() => {}} onInterrupt={() => setRunning(false)} attachmentContext={{ api, projectId, threadId, hostId: 'local' }} contextOptions={{ threads: [{ id: 'reference-thread', name: 'Design decisions' }], skills: [{ name: 'Review', path: '/project/.agents/skills/review/SKILL.md' }], preview: { active: { title: 'Local preview', url: 'http://localhost:5173' } } }} onSubmit={async (text, attachments, prepared, original, signal, lifecycle) => { setResult({ text, providerText: serializeContextForProvider(text, lifecycle.contextRecords), attachments: attachments.map(attachment => attachment.name), dispatchMode: lifecycle.dispatchMode }); return true; }} />
    {result && <details open style={{ marginTop: 32, fontSize: 12 }}><summary>Submitted request</summary><pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{JSON.stringify(result, null, 2)}</pre></details>}
  </main>;
}
createRoot(document.getElementById('root')).render(<Preview />);
