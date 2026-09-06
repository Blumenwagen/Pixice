import path from 'node:path';
import { homedir } from 'node:os';
import { readdir, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { previewFileTarget } from '../runtime/preview-files.mjs';
import { OPERATIONS, PROTOCOL_VERSION } from './protocol.mjs';
const RESPONSES = new Set(['approvals.resolve', 'requests.respond', 'questions.respond', 'elicitations.respond']);

export function createRemoteThreadValidator({ getProject, request, contains }) {
  return async (payload) => {
    const { projectId, threadId } = z.object({ projectId: z.string().min(1), threadId: z.string().min(1) }).parse(payload);
    const project = getProject(projectId);
    // Authorization needs the workspace, not turn history. Reading turns can fail
    // for newly created Codex threads and also triggers receipt hydration in IPC.
    const { thread } = await request('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId || !thread.cwd || !contains(project, thread.cwd)) throw new Error('Thread is outside the selected project');
  };
}

export function createRemoteInvoker({ handlers, pendingRequest, generation, activeTurnId, fileOptions, hostId, validateThread }) {
  return async (operation, payload) => {
    if (operation === 'projects.directories') {
      const value = z.object({ path: z.string().max(4096).optional() }).strict().parse(payload ?? {});
      const directory = await realpath(value.path || homedir());
      const entries = await readdir(directory, { withFileTypes: true });
      return { path: directory, parent: path.dirname(directory), directories: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).slice(0, 500).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    const channel = OPERATIONS.get(operation);
    const handler = channel && handlers.get(channel);
    if (!handler) throw new Error('This capability is not ready on this host');
    if (RESPONSES.has(operation)) {
      const pending = pendingRequest(payload?.requestId);
      if (!pending || payload?.requestGeneration !== pending.generation || pending.generation !== generation()) throw new Error('This request is no longer current. Refresh the task.');
    }
    if (operation.startsWith('files.')) {
      const value = z.object({ projectId: z.string().min(1), path: z.string().min(1) }).parse(payload);
      previewFileTarget({ ...fileOptions(value.projectId, value.path), allowExternal: false });
      if (operation === 'files.write' && !Number.isFinite(payload.expectedMtimeMs)) throw new Error('Read the current file before saving it.');
    }
    if (payload?.threadId && payload?.projectId && !['threads.read', 'threads.children', 'threads.create'].includes(operation)) {
      await validateThread({ projectId: payload.projectId, threadId: payload.threadId });
    }
    if (['turns.steer', 'turns.interrupt'].includes(operation) && activeTurnId(payload.threadId) !== payload.turnId) throw new Error('That turn is no longer active. Refresh the task.');
    const result = await handler(null, payload);
    if (operation === 'app.bootstrap') {
      const { providerExecutablePaths, ...settings } = result.settings ?? {};
      return { ...result, settings, remote: { protocol: PROTOCOL_VERSION, hostId: hostId() } };
    }
    if (operation === 'git.status') return { ...result, installSupported: false, executablePath: undefined };
    if (operation === 'providers.list') return result.map((provider) => ({
      id: provider.id, connected: provider.connected, installed: provider.installed, compatible: provider.compatible,
      status: { state: provider.status?.state }, authenticated: provider.authenticated, requiresAuth: provider.requiresAuth,
      account: provider.account ? { type: provider.account.type, email: provider.account.email, planType: provider.account.planType, subscriptionType: provider.account.subscriptionType } : null,
      sessionCount: provider.sessionCount, externallyManagedAuth: true,
      actions: { install: false, locate: false, repair: false, checkUpdate: false, update: false, login: false, logout: false }
    }));
    return result;
  };
}
