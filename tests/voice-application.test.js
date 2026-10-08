// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, link, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startService } from '../electron/backend/service.mjs';
import { ApplicationClient } from '../electron/connect/application-client.mjs';
import { BackendFixtureProvider } from './fixtures/backend-provider.mjs';
import { CODEX_0159_VOICE_CAPABILITIES } from '../electron/runtime/voice-session.mjs';
import { installVoiceApplication } from '../electron/runtime/voice-application.mjs';
import { ApplicationRegistry } from '../electron/backend/registry.mjs';
import { FocusSessionRenewal } from '../electron/runtime/focus-session-renewal.mjs';
import { NativeHelperClient } from '../electron/native/helper-client.mjs';
import { readDesktopAuthority } from '../electron/backend/desktop-authority.mjs';
import { executeBuiltInWorkflowNode } from '../electron/workflows/workflow-node-executors.mjs';
import { resolveWorkflowSkillAttachment } from '../electron/workflows/workflow-skill-node.mjs';
import { execFileSync } from 'node:child_process';
import { readDiff, readFileDiff } from '../electron/git/worktrees.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const catalog = { voices: { v1: ['dynamic-a'], v2: ['dynamic-b'], defaultV1: 'dynamic-a', defaultV2: 'dynamic-b' } };
async function fixture(providerId = 'codex', registerHelper = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'pixice-voice-integration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providers = { codex: new BackendFixtureProvider(), claude: new BackendFixtureProvider('claude') };
  const claudeRequest = providers.claude.request.bind(providers.claude);
  providers.claude.request = (method, params) => method === 'model/list' ? Promise.resolve({ data: [{ id: 'fixture-model', model: 'fixture-model' }] }) : claudeRequest(method, params);
  let database, native;
  const service = await startService({ dataDirectory: path.join(root, 'data'), resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test',
    providerFactories: {
      codex: (context) => {
        database = context.database; native = context.codexRuntime;
        Object.defineProperty(native, 'connected', { get: () => providers.codex.connected });
        Object.defineProperty(native, 'voiceCapabilities', { get: () => CODEX_0159_VOICE_CAPABILITIES });
        native.verifyVoiceSupport = vi.fn(async () => CODEX_0159_VOICE_CAPABILITIES);
        native.request = vi.fn(async (method) => method === 'account/read' ? { account: { type: 'chatgpt' } } : method === 'thread/realtime/listVoices' ? catalog : {});
        return providers.codex;
      }, claude: () => providers.claude
    } });
  cleanup.push(async () => { native.request.mockImplementation(async () => ({})); service.native.close(); await service.stop({ force: true }); });
  await service.ready;
  const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: 'service.status' });
  cleanup.push(() => client.close()); await client.connect();
  const folder = path.join(root, 'project'); await mkdir(folder);
  const project = await client.call('projects.create', { displayName: 'Voice fixture', icon: 'folder', color: 'gray', folders: [folder] });
  const focus = await client.call('focus.ensure', { projectId: project.id, model: `${providerId}:fixture-model` });
  const desktopAuthority = await readDesktopAuthority(service.paths.data, service.descriptor);
  const lease = registerHelper ? { ...await client.call('native.register', { clientId: randomUUID(), capabilities: [], desktopAuthority }), desktopAuthority } : undefined;
  const owner = registerHelper ? await client.call('native.voiceAttach', lease) : undefined;
  const scope = { projectId: project.id, threadId: focus.thread.id, generation: focus.session.generation };
  const call = (operation, payload = scope) => client.call('native.voiceCall', { ...lease, ...owner, operation: `voice.${operation}`, payload });
  const emit = (method, params = {}) => native.emit('voice-event', { payload: { method: `thread/realtime/${method}`, threadId: scope.threadId, ...params } });
  const prepare = async () => ({ ...scope, ...await call('prepare') });
  const begin = async () => {
    const input = await prepare();
    await call('start', { ...input, transport: { type: 'webrtc', sdp: 'ephemeral-offer' } });
    emit('started', { version: 'v3', realtimeSessionId: 'native-fixture-session' });
    return input;
  };
  const refresh = () => client.call('focus.refresh', { projectId: project.id, expectedGeneration: scope.generation });
  return { root, folder, desktopAuthority, service, client, providers, provider: providers[providerId], native, database, project, focus, lease, owner, scope, call, emit, prepare, begin, refresh };
}

describe('production voice application integration with isolated native runtime', () => {
  it('keeps companion and authenticated Voice calls distinct, forwards companion events locally, and guards Focus renewal for both', async () => {
    const f = await fixture();
    const request = f.provider.request.bind(f.provider);
    f.provider.request = (method, params) => method === 'thread/settings/update' ? Promise.resolve({}) : request(method, params);
    const localEvents = vi.spyOn(f.service.local, 'publish');
    const remoteEvents = vi.spyOn(f.service.remote, 'publish');
    expect(await f.client.call('voice.state')).toMatchObject({ available: true, session: null });
    const companion = await f.client.call('voice.start', { projectId: f.project.id, threadId: f.scope.threadId, sdp: 'companion-offer' });
    f.emit('sdp', { realtimeSessionId: companion.id, sdp: 'companion-answer' });
    expect(localEvents).toHaveBeenCalledWith(expect.objectContaining({ type: 'VoiceEvent', payload: expect.objectContaining({ id: companion.id, sdp: 'companion-answer' }) }));
    expect(remoteEvents.mock.calls.some(([event]) => event.type === 'VoiceEvent')).toBe(false);
    await expect(f.refresh()).rejects.toThrow(/voice/);
    await expect(f.prepare()).rejects.toThrow(/Focus is busy/);
    await f.client.call('voice.stop', { sessionId: companion.id });
    const native = await f.begin();
    await expect(f.client.call('voice.start', { projectId: f.project.id, threadId: f.scope.threadId, sdp: 'companion-offer' })).rejects.toThrow(/native Voice/);
    await expect(f.refresh()).rejects.toThrow(/voice/);
    await f.call('stop', native);
    expect((await f.refresh()).session.generation).toBe(2);
  });
  it('serializes companion starts behind pending authenticated Voice preparation', async () => {
    const f = await fixture();
    const metadata = deferred();
    f.native.verifyVoiceSupport.mockImplementation(() => metadata.promise);
    const preparing = f.prepare();
    await vi.waitFor(() => expect(f.native.verifyVoiceSupport).toHaveBeenCalled());
    let settled = false;
    const companion = f.client.call('voice.start', { projectId: f.project.id, threadId: f.scope.threadId, sdp: 'companion-offer' });
    const rejected = expect(companion).rejects.toThrow(/native Voice/).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    metadata.resolve(CODEX_0159_VOICE_CAPABILITIES);
    const native = await preparing;
    await rejected;
    expect(f.native.request).not.toHaveBeenCalledWith('thread/realtime/start', expect.anything());
    await f.call('stop', native);
  });
  it('denies ordinary registration voice with no desktop helper, including public ID replay and recovery', async () => {
    const f = await fixture('codex', false); const clientId = randomUUID();
    const issued = []; f.client.onCommandIssued = (value) => issued.push(value);
    const first = await f.client.call('native.register', { clientId, capabilities: [] });
    const second = await f.client.call('native.register', { clientId: (await f.client.call('service.status')).native.clientId, capabilities: [] });
    expect(second).toEqual(first); // Existing nonvoice helper compatibility.
    await expect(f.client.call('native.voiceAttach', first)).rejects.toThrow(/private desktop bootstrap/);
    await expect(f.client.call('native.register', { clientId, capabilities: [], desktopAuthority: randomUUID() })).rejects.toThrow(/bootstrap authority expired/);
    expect(f.native.request).not.toHaveBeenCalled();
    expect([...f.service.local.operations.values()].some((value) => value.operation.startsWith('native.'))).toBe(false);
    const nativeCommand = issued.find((value) => value.operation === 'native.register');
    const recovered = await f.client.commandStatus(nativeCommand.commandId);
    expect(JSON.stringify(recovered)).not.toContain(first.leaseId);
  });
  it('uses actual helper bootstrap registration and defeats public ID impersonation even with a captured lease', async () => {
    const f = await fixture('codex', false);
    const helper = new NativeHelperClient({ directory: f.service.paths.data, desktopAuthority: (descriptor) => readDesktopAuthority(f.service.paths.data, descriptor), sessions: { flush() {} } });
    cleanup.push(() => helper.close()); helper.start();
    await vi.waitFor(() => expect(helper.registration?.leaseId).toBeTruthy());
    const status = await f.client.call('service.status');
    await expect(f.client.call('native.register', { clientId: status.native.clientId, capabilities: [] })).rejects.toThrow(/private bootstrap authority/);
    await expect(f.client.call('native.voiceAttach', { leaseId: helper.registration.leaseId })).rejects.toThrow(/bootstrap authority expired/);
    const events = []; const callback = (value) => events.push(value);
    const prepared = await helper.voiceCall('voice.prepare', f.scope, callback);
    await helper.voiceCall('voice.start', { ...prepared, transport: { type: 'webrtc', sdp: 'bootstrap-private-offer' } }, callback);
    f.emit('sdp', { sdp: 'bootstrap-private-answer' });
    await vi.waitFor(() => expect(events.some((value) => value.sdp === 'bootstrap-private-answer')).toBe(true));
    const captured = { leaseId: helper.registration.leaseId, ownerHandle: helper.voice.ownerHandle };
    for (const operation of ['native.voicePoll', 'native.voiceDisconnect']) await expect(f.client.call(operation, captured)).rejects.toThrow(/bootstrap authority expired/);
    await expect(f.client.call('native.voiceCall', { ...captured, operation: 'voice.snapshot', payload: prepared })).rejects.toThrow(/bootstrap authority expired/);
    const logs = JSON.stringify({ events: f.service.local.events, remote: f.service.remote.events, operations: [...f.service.local.operations.values()], audit: f.service.local.state.audit, descriptor: f.service.descriptor, commands: [...f.client.commands.values()] });
    for (const sensitive of [f.desktopAuthority, helper.registration.leaseId, captured.ownerHandle, 'bootstrap-private']) expect(logs).not.toContain(sensitive);
    await helper.voiceCall('voice.stop', prepared, callback);
  });
  it('blocks bootstrap file reads and writes through project, external preview and workflow aliases', async () => {
    const f = await fixture(); const secret = f.service.paths.desktopAuthority;
    expect((await stat(secret)).mode & 0o077).toBe(0);
    const alias = path.join(f.folder, 'credential.md'); const imageAlias = path.join(f.folder, 'credential.png');
    await link(secret, alias); await symlink(secret, imageAlias);
    for (const target of [secret, alias, imageAlias]) {
      await expect(f.client.call('files.preview', { projectId: f.project.id, path: target })).rejects.toThrow(/bootstrap credentials/);
      await expect(f.client.call('files.write', { projectId: f.project.id, path: target, content: 'replacement' })).rejects.toThrow(/bootstrap credentials/);
    }
    await expect(f.client.call('files.read', { projectId: f.project.id, path: alias })).rejects.toThrow(/bootstrap credentials/);
    await expect(executeBuiltInWorkflowNode({ node: { type: 'file', config: { operation: 'readText', path: 'credential.md' } }, projectRoot: f.folder, inputs: [], run: { input: {} }, workflow: { projectId: f.project.id }, nodeOutputs: new Map() })).rejects.toThrow(/bootstrap credentials/);
    await expect(resolveWorkflowSkillAttachment({ node: { type: 'useSkill', config: { source: 'markdown', path: 'credential.md' } }, projectRoot: f.folder })).rejects.toThrow(/bootstrap credentials/);
    execFileSync('git', ['init', '--quiet', f.folder]);
    await expect(readDiff({ workingPath: f.folder })).rejects.toThrow(/bootstrap credentials/);
    await expect(readFileDiff({ workingPath: f.folder, filePath: 'credential.md' })).rejects.toThrow(/bootstrap credentials/);
    expect(JSON.parse(await readFile(secret, 'utf8')).token).toBe(f.desktopAuthority);
  });
  it('rejects frozen starts and all input handlers while retaining snapshot, stop and explicit retry', async () => {
    const f = await fixture(); const prepared = await f.prepare(); f.native.request.mockClear();
    f.service.application.freeze(true);
    const inputs = { start: { transport: { type: 'webrtc', sdp: 'frozen-offer' } }, appendText: { text: 'frozen text' }, appendSpeech: { text: 'frozen speech' }, appendAudio: { audio: { data: 'opaque', sampleRate: 24000, numChannels: 1 } } };
    for (const [operation, input] of Object.entries(inputs)) await expect(f.call(operation, { ...prepared, ...input })).rejects.toMatchObject({ message: expect.stringMatching(/host is frozen/), code: 'voice_host_frozen' });
    expect(f.native.request).not.toHaveBeenCalled();
    expect((await f.call('snapshot', prepared)).state).toBe('preparing');
    await expect(f.refresh()).rejects.toThrow();
    await f.call('stop', prepared); expect(f.native.request).not.toHaveBeenCalled();
    f.service.application.freeze(false);
    const next = await f.begin(); await f.call('stop', next);
  });
  it('rejects stale helper and owner authority immediately and renews only with private bootstrap proof', async () => {
    const f = await fixture(); const clientId = f.service.native.status().clientId;
    f.service.native.voiceOwner.lastSeen = Date.now() - f.service.native.leaseTimeoutMs - 1;
    await expect(f.client.call('native.voicePoll', { ...f.lease, ...f.owner })).rejects.toThrow(/owner expired/);
    const secondOwner = await f.client.call('native.voiceAttach', f.lease);
    expect(secondOwner.ownerHandle).not.toBe(f.owner.ownerHandle);
    f.service.native.client.lastSeen = Date.now() - f.service.native.leaseTimeoutMs - 1;
    const untrusted = await f.client.call('native.register', { clientId, capabilities: [] });
    expect(untrusted.leaseId).not.toBe(f.lease.leaseId);
    await expect(f.client.call('native.voiceAttach', untrusted)).rejects.toThrow(/private desktop bootstrap/);
    await expect(f.client.call('native.voicePoll', { ...f.lease, ...secondOwner })).rejects.toThrow(/lease expired/);
    await f.client.call('native.disconnect', untrusted);
    const registered = await f.client.call('native.register', { clientId: randomUUID(), capabilities: [], desktopAuthority: f.desktopAuthority });
    const trusted = { ...registered, desktopAuthority: f.desktopAuthority };
    const next = await f.client.call('native.voiceAttach', trusted);
    expect(next.ownerHandle).not.toBe(secondOwner.ownerHandle);
    expect(f.service.native.voiceOwner.events).toEqual([]);
    expect(f.native.request).not.toHaveBeenCalled();
  });
  it('rechecks frozen admission after pending start metadata before any native start', async () => {
    const f = await fixture(); const prepared = await f.prepare(); const pending = deferred();
    const original = f.native.request.getMockImplementation(); f.native.request.mockClear();
    f.native.request.mockImplementation((name, params) => name === 'thread/realtime/listVoices' ? pending.promise : original(name, params));
    const starting = f.call('start', { ...prepared, transport: { type: 'webrtc', sdp: 'pending-frozen-offer' } });
    const rejected = expect(starting).rejects.toMatchObject({ code: 'voice_host_frozen' });
    await vi.waitFor(() => expect(f.native.request).toHaveBeenCalledWith('thread/realtime/listVoices', {}));
    f.service.application.freeze(true); pending.resolve(catalog); await rejected;
    expect(f.native.request.mock.calls.some(([name]) => name === 'thread/realtime/start' || name.startsWith('thread/realtime/append'))).toBe(false);
    f.service.application.freeze(false);
  });
  it('rotates private bootstrap on actual disposable service restart and rejects stale descriptors and proofs', async () => {
    const f = await fixture(); f.client.close(); f.service.native.close(); await f.service.stop({ force: true });
    await expect(readFile(f.service.paths.desktopAuthority)).rejects.toMatchObject({ code: 'ENOENT' });
    const service = await startService({ dataDirectory: f.service.paths.data, resourcesPath: path.resolve('resources'), clientDirectory: path.resolve('dist/client'), version: 'test', providerFactories: { codex: () => new BackendFixtureProvider(), claude: () => new BackendFixtureProvider('claude') } });
    cleanup.push(async () => { service.native.close(); await service.stop({ force: true }); }); await service.ready;
    const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: 'service.status' });
    cleanup.push(() => client.close()); await client.connect();
    await expect(readDesktopAuthority(service.paths.data, f.service.descriptor)).rejects.toThrow(/another service/);
    const proof = await readDesktopAuthority(service.paths.data, service.descriptor);
    expect(proof).not.toBe(f.desktopAuthority);
    await expect(client.call('native.register', { clientId: randomUUID(), capabilities: [], desktopAuthority: f.desktopAuthority })).rejects.toThrow(/authority expired/);
    const lease = { ...await client.call('native.register', { clientId: randomUUID(), capabilities: [], desktopAuthority: proof }), desktopAuthority: proof };
    await expect(client.call('native.voiceAttach', { ...f.lease, desktopAuthority: proof })).rejects.toThrow(/lease expired/);
    expect((await client.call('native.voiceAttach', lease)).ownerHandle).not.toBe(f.owner.ownerHandle);
    expect([...service.local.operations.values()].some((value) => value.operation.startsWith('native.'))).toBe(false);
  });
  it('uses the native instance and returns dynamic experimental catalogs without claiming live availability', async () => {
    const f = await fixture();
    expect(await f.call('availability')).toMatchObject({ catalog: catalog.voices, capabilities: { experimentalApi: true, schemaVersion: '0.159.0' }, sessionAvailability: 'unverified' });
    expect(f.native.verifyVoiceSupport).toHaveBeenCalledOnce();
    expect(f.native.request.mock.calls.map(([name]) => name)).toEqual(['account/read', 'thread/realtime/listVoices']);
    expect(f.provider.starts).toBe(0);
  });
  it('rejects ordinary local CLI, remote context, unauthenticated lease, and spoofed owner before native calls', async () => {
    const f = await fixture();
    await expect(f.client.call('voice.prepare', { ...f.scope, ownerId: f.owner.ownerHandle })).rejects.toThrow(/authenticated local/);
    await expect(f.service.application.handlers.invoke('voice:prepare', f.scope, { remote: true, local: true, voiceOwner: f.service.native.voiceOwner })).rejects.toThrow(/authenticated local/);
    await expect(f.client.call('native.voiceCall', { ...f.lease, ownerHandle: randomUUID(), operation: 'voice.prepare', payload: f.scope })).rejects.toThrow(/expired/);
    await expect(f.client.call('native.voiceCall', { leaseId: randomUUID(), ...f.owner, operation: 'voice.prepare', payload: f.scope })).rejects.toThrow(/lease expired/);
    expect(f.native.request).not.toHaveBeenCalled(); expect(f.native.verifyVoiceSupport).not.toHaveBeenCalled();
  });
  it('rejects Claude Focus, wrong project, unknown thread and wrong generation before native effects', async () => {
    const f = await fixture('claude');
    await expect(f.call('prepare')).rejects.toThrow(/Codex Focus/);
    await expect(f.call('availability', { ...f.scope, threadId: 'unknown' })).rejects.toThrow(/ownership/);
    await expect(f.call('prepare', { ...f.scope, generation: 42 })).rejects.toThrow(/Codex Focus|generation/);
    await expect(f.call('prepare', { ...f.scope, projectId: 'unknown-project' })).rejects.toThrow();
    expect(f.native.request).not.toHaveBeenCalled(); expect(f.native.verifyVoiceSupport).not.toHaveBeenCalled();
  });
  it('does not use providerForThread default as proof of unknown ownership', async () => {
    const f = await fixture();
    const getBinding = f.database.getThreadProviderBinding.bind(f.database);
    vi.spyOn(f.database, 'getThreadProviderBinding').mockImplementation((id) => id === f.scope.threadId ? null : getBinding(id));
    await expect(f.call('prepare')).rejects.toThrow(/ownership/);
    expect(f.native.verifyVoiceSupport).not.toHaveBeenCalled();
  });
  it('rejects cross-project borrowed handles and retired authority on every operation', async () => {
    const f = await fixture(); const handle = await f.begin();
    for (const name of ['start', 'stop', 'snapshot', 'appendText', 'appendSpeech', 'appendAudio']) {
      await expect(f.call(name, { ...handle, threadId: 'foreign', text: 'x', audio: {}, transport: { type: 'webrtc', sdp: 'x' } })).rejects.toThrow(/ownership/);
      await expect(f.call(name, { ...handle, generation: 999 })).rejects.toThrow(/generation/);
      await expect(f.call(name, { ...handle, sessionHandle: 'stale' })).rejects.toThrow(/handle/);
    }
    await f.call('stop', handle); await f.refresh();
    for (const name of ['availability', 'prepare', 'start', 'stop', 'snapshot', 'appendText', 'appendSpeech', 'appendAudio']) await expect(f.call(name, handle)).rejects.toThrow(/ownership/);
    expect(f.native.request.mock.calls.filter(([name]) => name === 'thread/realtime/start')).toHaveLength(1);
  });
  it('delivers early SDP only through the authenticated ephemeral owner mailbox, with an empty start response', async () => {
    const f = await fixture(); const handle = await f.prepare();
    const request = f.native.request.getMockImplementation();
    f.native.request.mockImplementation(async (name, params) => {
      if (name === 'thread/realtime/start') { f.emit('sdp', { sdp: 'private-answer' }); return {}; }
      return request(name, params);
    });
    const response = await f.call('start', { ...handle, transport: { type: 'webrtc', sdp: 'private-offer' } });
    expect(response.state).toBe('starting'); expect(response).not.toHaveProperty('sdp');
    f.emit('sdp', { threadId: 'foreign-thread', sdp: 'foreign-answer' });
    f.emit('sdp', { projectId: 'foreign-project', sdp: 'cross-project-answer' });
    f.emit('transcript/done', { role: 'user', text: 'ephemeral-transcript' });
    const batch = await f.client.call('native.voicePoll', { ...f.lease, ...f.owner });
    expect(batch.events.filter((e) => e.type === 'sdp')).toEqual([expect.objectContaining({ sdp: 'private-answer', sessionHandle: handle.sessionHandle, projectId: f.project.id })]);
    const saved = JSON.stringify({ local: f.service.local.events, remote: f.service.remote.events, commands: [...f.service.local.operations.values()], snapshot: f.database.getProviderThreadSnapshot(f.scope.threadId) });
    for (const sensitive of ['private-answer', 'private-offer', 'ephemeral-transcript', f.owner.ownerHandle]) expect(saved).not.toContain(sensitive);
    expect(f.service.local.operations.size).toBeGreaterThan(0);
    expect([...f.service.local.operations.values()].some((c) => c.operation.startsWith('voice.') || c.operation.startsWith('native.voice'))).toBe(false);
  });
  it('carries the real native helper voice client through owner registration, early SDP and explicit disconnect', async () => {
    const f = await fixture(); await f.client.call('native.voiceDisconnect', { ...f.lease, ...f.owner });
    const helper = new NativeHelperClient({ directory: 'unused', sessions: { flush() {} } });
    helper.registration = { descriptor: f.service.descriptor, ...f.lease };
    cleanup.push(() => helper.close());
    const events = []; const event = (payload) => events.push(payload);
    const prepared = await helper.voiceCall('voice.prepare', f.scope, event);
    const original = f.native.request.getMockImplementation();
    f.native.request.mockImplementation((name, params) => {
      if (name === 'thread/realtime/start') { f.emit('sdp', { sdp: 'helper-private-answer' }); return Promise.resolve({}); }
      return original(name, params);
    });
    await helper.voiceCall('voice.start', { ...f.scope, sessionHandle: prepared.sessionHandle, transport: { type: 'webrtc', sdp: 'helper-private-offer' } }, event);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'sdp' && e.sdp === 'helper-private-answer')).toBe(true));
    helper.closeVoice();
    expect(events.at(-1)).toEqual({ type: 'owner_disconnected' });
    await vi.waitFor(() => expect(f.native.request).toHaveBeenCalledWith('thread/realtime/stop', { threadId: f.scope.threadId }));
    expect((await f.refresh()).session.generation).toBe(2);
    expect(JSON.stringify(f.service.local.events)).not.toContain('helper-private');
  });
  it('cancels pending renderer attachment before preparation and never auto-attaches again', async () => {
    const f = await fixture(); await f.client.call('native.voiceDisconnect', { ...f.lease, ...f.owner });
    const helper = new NativeHelperClient({ directory: 'unused', sessions: { flush() {} } });
    helper.registration = { descriptor: f.service.descriptor, ...f.lease };
    cleanup.push(() => helper.close());
    const pending = helper.voiceCall('voice.prepare', f.scope, () => {});
    const rejected = expect(pending).rejects.toThrow(/disconnected/);
    helper.closeVoice(); await rejected;
    expect(helper.voice).toBeNull(); expect(helper.voiceTask).toBeNull();
    expect(f.service.native.voiceOwner).toBeNull(); expect(f.native.request).not.toHaveBeenCalled();
  });
  it('protects the actual automatic context-pressure renewal path until voice is explicitly stopped', async () => {
    const f = await fixture(); const handle = await f.prepare(); const count = f.provider.threads.size;
    const pressure = (id) => {
      f.provider.event({ method: 'thread/tokenUsage/updated', threadId: f.scope.threadId, turnId: id, tokenUsage: { last: { inputTokens: 80 }, modelContextWindow: 100 } });
      f.provider.event({ method: 'turn/completed', threadId: f.scope.threadId, turn: { id, status: 'completed', items: [] } });
    };
    pressure('fixture-pressure');
    await f.service.application.withFocusSessionAdmission(f.scope, () => {});
    expect(f.database.getProjectFocusSession(f.project.id).generation).toBe(1); expect(f.provider.threads.size).toBe(count);
    await f.call('stop', handle); pressure('fixture-next-boundary');
    await vi.waitFor(() => expect(f.database.getProjectFocusSession(f.project.id).generation).toBe(2));
    expect(f.provider.starts).toBe(0);
  });
  it('serializes prepare metadata against /new, then blocks renewal while the preparation is reserved', async () => {
    const f = await fixture(); const gate = deferred();
    f.native.verifyVoiceSupport.mockImplementation(() => gate.promise);
    const preparing = f.call('prepare');
    await vi.waitFor(() => expect(f.native.verifyVoiceSupport).toHaveBeenCalled());
    const refreshing = f.refresh(); const rejected = expect(refreshing).rejects.toThrow(/voice/);
    gate.resolve(CODEX_0159_VOICE_CAPABILITIES);
    const handle = { ...f.scope, ...await preparing }; await rejected;
    expect(f.database.getProjectFocusSession(f.project.id).generation).toBe(1);
    await expect(f.client.call('turns.start', { ...f.scope, text: 'Text remains separate', model: 'codex:fixture-model' })).rejects.toThrow(/Stop voice/);
    await f.call('stop', handle); expect((await f.refresh()).session.generation).toBe(2);
  });
  it('rejects preparation that waits behind a completed renewal without nesting admission', async () => {
    const f = await fixture(); const started = deferred(), gate = deferred();
    const request = f.provider.request.bind(f.provider);
    f.provider.request = async (name, params) => { if (name === 'thread/start') { started.resolve(); await gate.promise; } return request(name, params); };
    const refreshing = f.refresh(); await started.promise;
    const preparing = f.call('prepare'); const rejection = expect(preparing).rejects.toThrow(/Focus session changed|ownership/);
    gate.resolve(); await refreshing; await rejection;
    expect(f.native.request).not.toHaveBeenCalled();
  });
  it('rejects prepare during an active text turn and restores ordinary text after cleanup', async () => {
    const f = await fixture();
    const text = await f.client.call('turns.start', { ...f.scope, text: 'fixture text', model: 'codex:fixture-model' });
    await expect(f.call('prepare')).rejects.toThrow(/busy/);
    expect(f.native.request).not.toHaveBeenCalled();
    await f.client.call('turns.interrupt', { ...f.scope, turnId: text.turn.id });
    const handle = await f.prepare(); await f.call('stop', handle);
    await expect(f.client.call('turns.start', { ...f.scope, text: 'ordinary text', model: 'codex:fixture-model' })).resolves.toHaveProperty('turn');
  });
  it('keeps failed stop protected after owner disconnect and permits only explicit lifecycle cleanup', async () => {
    const f = await fixture(); await f.begin();
    const request = f.native.request.getMockImplementation();
    f.native.request.mockImplementation((name, params) => name === 'thread/realtime/stop' ? Promise.reject(new Error('private native stop failure')) : request(name, params));
    await f.client.call('native.voiceDisconnect', { ...f.lease, ...f.owner });
    await vi.waitFor(() => expect(f.native.request).toHaveBeenCalledWith('thread/realtime/stop', expect.anything()));
    await expect(f.refresh()).rejects.toThrow(/voice/);
    const nextOwner = await f.client.call('native.voiceAttach', f.lease);
    await expect(f.client.call('native.voiceCall', { ...f.lease, ...nextOwner, operation: 'voice.prepare', payload: f.scope })).rejects.toThrow(/another local renderer/);
    f.native.request.mockImplementation(request);
    await f.client.call('providers.logout', { provider: 'codex' }).catch(() => {});
    expect((await f.refresh()).session.generation).toBe(2);
  });
  it('stops before project deletion and does not persist or replay voice', async () => {
    const f = await fixture(); await f.begin();
    await f.client.call('projects.delete', { projectId: f.project.id });
    expect(f.native.request).toHaveBeenCalledWith('thread/realtime/stop', { threadId: f.scope.threadId });
    expect(f.database.getProject(f.project.id)).toBeNull();
    await expect(f.call('prepare')).rejects.toThrow();
    expect(f.service.native.voiceOwner.events.some((e) => e.type === 'sdp')).toBe(false);
    expect(f.service.native.voiceOwner.events.some((e) => e.type === 'closed' && e.reason === 'project_deleted')).toBe(true);
  });
  it('keeps failed deletion conservative and returns a safe error before removing project data', async () => {
    const f = await fixture(); await f.begin();
    const original = f.native.request.getMockImplementation();
    f.native.request.mockImplementation((name, params) => name === 'thread/realtime/stop' ? Promise.reject(new Error('private-offer bearer private-credential')) : original(name, params));
    await expect(f.client.call('projects.delete', { projectId: f.project.id })).rejects.toThrow(/Native voice could not stop/);
    expect(f.database.getProject(f.project.id)).not.toBeNull();
    expect(JSON.stringify([...f.service.local.operations.values()])).not.toContain('private-credential');
    await expect(f.refresh()).rejects.toThrow(/voice/);
    f.native.request.mockImplementation(original);
    await f.client.call('projects.delete', { projectId: f.project.id });
    expect(f.database.getProject(f.project.id)).toBeNull();
  });
  it('rejects a failed service shutdown visibly and keeps owner cleanup callable without a hidden retry', async () => {
    const f = await fixture(); const handle = await f.begin();
    const original = f.native.request.getMockImplementation();
    f.native.request.mockImplementation((name, params) => name === 'thread/realtime/stop' ? Promise.reject(new Error('private native failure')) : original(name, params));
    await expect(f.client.call('service.stop', { force: true })).rejects.toThrow(/Native voice could not stop/);
    expect(f.service.status().phase).toBe('ready'); expect(f.service.application.handlers.closed).toBe(false);
    await expect(f.refresh()).rejects.toThrow(/voice/);
    expect(f.native.request.mock.calls.filter(([name]) => name === 'thread/realtime/stop')).toHaveLength(1);
    f.native.request.mockImplementation(original);
    await f.call('stop', handle);
    expect((await f.refresh()).session.generation).toBe(2);
  });
  it('stops on account changes and host shutdown without starting another session', async () => {
    const f = await fixture(); await f.begin();
    f.native.emit('event', { payload: { method: 'account/updated', authMode: null } });
    await vi.waitFor(() => expect(f.native.request).toHaveBeenCalledWith('thread/realtime/stop', { threadId: f.scope.threadId }));
    await f.begin(); await f.service.stop({ force: true });
    expect(f.native.request.mock.calls.filter(([name]) => name === 'thread/realtime/start')).toHaveLength(2);
    expect(f.native.request.mock.calls.filter(([name]) => name === 'thread/realtime/stop')).toHaveLength(2);
  });
  it('fails version or account capability checks before exposing a usable preparation', async () => {
    const f = await fixture();
    f.native.verifyVoiceSupport.mockRejectedValue(Object.assign(new Error('Unverified executable'), { code: 'voice_protocol_unsupported' }));
    await expect(f.call('prepare')).rejects.toThrow(/Unverified/);
    expect(f.native.request).not.toHaveBeenCalled();
    f.native.verifyVoiceSupport.mockResolvedValue(CODEX_0159_VOICE_CAPABILITIES);
    f.native.request.mockResolvedValue({ account: { type: 'apiKey' } });
    await expect(f.call('prepare')).rejects.toThrow(/signed-in ChatGPT/);
    expect((await f.refresh()).session.generation).toBe(2);
  });
});

describe('reservation and shared automatic renewal gate', () => {
  it('expires reservations and allows renewal, with the production guard installed before handlers', async () => {
    const current = { projectId: 'project', threadId: 'thread', generation: 1, provider: 'codex' };
    const runtime = new EventEmitter(); runtime.connected = true; runtime.voiceCapabilities = CODEX_0159_VOICE_CAPABILITIES;
    runtime.verifyVoiceSupport = async () => runtime.voiceCapabilities;
    runtime.request = vi.fn(async (name) => name === 'account/read' ? { account: { type: 'chatgpt' } } : name === 'thread/realtime/listVoices' ? catalog : {});
    const renewal = new FocusSessionRenewal({ database: { getProjectFocusSession: () => current, replaceProjectFocusSession: (value) => ({ ...current, threadId: value.threadId, generation: 2 }) },
      createSession: vi.fn(async () => ({ thread: { id: 'fresh' } })), safeBoundary: () => true, handoff: () => 'fixture' });
    const handlers = new ApplicationRegistry(); const owner = {}; let installed = false;
    const handle = handlers.handle.bind(handlers); handlers.handle = (name, callback) => { expect(installed).toBe(true); handle(name, callback); };
    const voice = installVoiceApplication({ runtime, handlers, resolveScope: () => current, prepareTimeoutMs: 25,
      application: { setFocusVoiceGuard: (guard) => { installed = true; renewal.setVoiceGuard(guard); }, withFocusSessionAdmission: (scope, run) => renewal.withProject(scope.projectId, run) },
      authorizeOwner: () => owner, deliverEvent: () => {} });
    cleanup.push(() => voice.dispose());
    await handlers.invoke('voice:prepare', current, {});
    await expect(renewal.withProject('project', () => renewal.rotate('project', { expectedGeneration: 1, evidence: { reason: 'context-pressure' } }))).rejects.toThrow(/voice/);
    expect(renewal.createSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(voice.bridge.blocksRollover(current)).toBe(false));
    await expect(renewal.refresh('project', { expectedGeneration: 1 })).resolves.toHaveProperty('renewed', true);
  });
});
