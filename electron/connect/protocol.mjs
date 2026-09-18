// Explicit product capability registry. Local IPC additions are never exported automatically.
export const PROTOCOL_VERSION = 1;
export const CONNECT_LIMITS = Object.freeze({
  maxBodyBytes: 48 * 1024 * 1024,
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxAttachments: 10
});
export const CONNECT_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  HOST_RESTARTED: 'HOST_RESTARTED',
  OUTCOME_UNAVAILABLE: 'OUTCOME_UNAVAILABLE',
  COMMAND_ID_REUSED: 'COMMAND_ID_REUSED',
  ACTION_FAILED: 'ACTION_FAILED',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  OFFLINE: 'OFFLINE',
  REQUEST_ABORTED: 'REQUEST_ABORTED'
});
export const CONNECT_RECOVERY_LIMITS = Object.freeze({ maxUncertainCommands: 100, maxCommandDescriptors: 500, maxIdentifierLength: 256 });
export const CONNECT_RECOVERY_EVENTS = Object.freeze({ issued: 'CommandIssued', settled: 'CommandSettled', uncertain: 'CommandUncertain', resolved: 'CommandUncertainResolved' });
export const CAPABILITIES = {
  app: { bootstrap: 'app:bootstrap', overview: 'app:overview' },
  runtime: { status: 'runtime:status' },
  browser: { state: 'browser:state', create: 'browser:create', close: 'browser:close', activate: 'browser:activate', navigate: 'browser:navigate', history: 'browser:history', frame: 'browser:remote-frame', input: 'browser:remote-input', adopt: 'browser:remote-adopt', destroy: 'browser:remote-destroy' },
  git: { status: 'git:status' },
  providers: { list: 'providers:list' },
  usage: { summary: 'usage:summary', limits: 'usage:limits' },
  projects: { list: 'projects:list', touch: 'projects:touch', create: 'projects:create', delete: 'projects:delete' },
  threads: { list: 'threads:list', read: 'threads:read', children: 'threads:children', create: 'threads:create', fork: 'threads:fork', archive: 'threads:archive' },
  turns: { start: 'turns:start', steer: 'turns:steer', interrupt: 'turns:interrupt' },
  approvals: { resolve: 'approvals:resolve' },
  requests: { respond: 'requests:respond' },
  questions: { respond: 'questions:respond' },
  elicitations: { respond: 'elicitations:respond' },
  review: { read: 'review:read', file: 'review:file' },
  files: { read: 'files:read', preview: 'files:preview', write: 'files:write' },
  models: { list: 'models:list' },
  tasks: { receipts: 'tasks:receipts', receipt: 'tasks:receipt', replay: 'tasks:replay', interventions: 'tasks:interventions' },
  board: { list: 'board:list', read: 'board:read', create: 'board:create', update: 'board:update', move: 'board:move', delete: 'board:delete', attach: 'board:attach', createPhase: 'board:phase:create', activity: 'board:activity', readProposal: 'board:proposal:read', applyProposal: 'board:proposal:apply', discardProposal: 'board:proposal:discard', saveBinding: 'board:binding:save', deleteBinding: 'board:binding:delete' },
  proactivity: { list: 'proactivity:list', resolve: 'proactivity:resolve' },
  instruments: { list: 'instruments:list', tools: 'instruments:tools', read: 'instruments:read', open: 'instruments:open', refresh: 'instruments:refresh', event: 'instruments:event', invoke: 'instruments:invoke', pin: 'instruments:pin', events: 'instruments:events', receipts: 'instruments:receipts', launch: 'instruments:launch', rename: 'instruments:rename', grants: 'instruments:grants', duplicate: 'instruments:duplicate', revisions: 'instruments:revisions', restore: 'instruments:restore', deleteTool: 'instruments:delete-tool', delete: 'instruments:delete' },
  workflows: { list: 'workflows:list', read: 'workflows:read', taskRuns: 'workflows:task-runs', create: 'workflows:create', save: 'workflows:save', generate: 'workflows:generate', delete: 'workflows:delete', run: 'workflows:run', cancel: 'workflows:cancel', triggers: 'workflows:triggers', resolveMissedTrigger: 'workflows:resolve-missed-trigger' },
  // Paired clients capture microphone audio locally and transcribe it on the
  // host, so the model is downloaded once instead of once per device.
  transcription: { state: 'transcription:state', install: 'transcription:install', cancelInstall: 'transcription:install-cancel', remove: 'transcription:remove', select: 'transcription:select', configure: 'transcription:configure', start: 'transcription:start', chunk: 'transcription:chunk', finish: 'transcription:finish', abort: 'transcription:abort' }
};
export const OPERATIONS = new Map(Object.entries(CAPABILITIES).flatMap(([group, entries]) => Object.entries(entries).map(([name, channel]) => [`${group}.${name}`, channel])));
export const REMOTE_EVENTS = new Set(['BrowserState', 'BrowserOpenRequested', 'ActivityReceived', 'RuntimeEvent', 'RuntimeStatus', 'RuntimeError', 'TaskUpdated', 'AgentUpdated', 'AttentionRequired', 'AttentionResolved', 'AttentionReset', 'BoardUpdated', 'ProjectDeleted', 'ProactivityUpdated', 'TaskReceiptUpdated', 'UsageUpdated', 'CodexLimitsUpdated', 'InstrumentUpdated', 'InstrumentOpenRequested', 'InstrumentInteractionUpdated', 'TaskPreviewOpenRequested', 'FilePreviewOpenRequested', 'WorkflowUpdated', 'WorkflowRunUpdated', 'WorkflowOpenRequested', 'WorkflowTriggersUpdated', 'TranscriptionState', 'TranscriptionModelProgress']);
export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || url.pathname !== '/') throw new Error('Use the instance origin, such as https://pixice.example.com');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote instances require HTTPS. Use a secure tunnel or HTTPS reverse proxy.');
  return url.origin;
}

export const READ_OPERATIONS = new Set(['browser.state', 'browser.frame', 'app.bootstrap', 'app.overview', 'runtime.status', 'git.status', 'providers.list', 'usage.summary', 'usage.limits', 'projects.list', 'projects.directories', 'threads.list', 'threads.read', 'threads.children', 'review.read', 'review.file', 'files.read', 'files.preview', 'models.list', 'tasks.receipts', 'tasks.receipt', 'tasks.interventions', 'board.list', 'board.read', 'board.activity', 'board.readProposal', 'proactivity.list', 'instruments.list', 'instruments.tools', 'instruments.read', 'instruments.events', 'instruments.receipts', 'instruments.revisions', 'workflows.list', 'workflows.read', 'workflows.taskRuns', 'workflows.triggers', 'transcription.state']);
