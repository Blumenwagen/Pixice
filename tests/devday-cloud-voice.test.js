import { describe, expect, it, vi } from 'vitest';
import { CodexCloud } from '../electron/providers/codex-cloud.mjs';
import { CodexVoice } from '../electron/voice/codex-voice.mjs';
import { CodexVoiceConnection } from '../src/lib/codex-voice.js';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
describe('Cloud commands', () => {
  function fixture() { const saved = {}; const runner = vi.fn(async () => ({ output: '{"tasks":[],"cursor":null}', warnings: '' })); const cloud = new CodexCloud({ executable: () => '/codex', getEnvironments: (id) => saved[id] ?? [], saveEnvironments: (id, value) => { saved[id] = value; }, runner }); return { cloud, runner }; }
  it('passes hostile-looking prompts as a literal positional argument and enforces attempts and identifiers', async () => {
    const { cloud, runner } = fixture(); await cloud.submit('project', { environmentId: 'env_123', prompt: '$(touch /tmp/no) `echo no` --help', attempts: 2, branch: 'work/test' }, '/project');
    expect(runner).toHaveBeenCalledWith('/codex', ['exec', '--env', 'env_123', '--attempts', '2', '--branch', 'work/test', '--', '$(touch /tmp/no) `echo no` --help'], { cwd: '/project' });
    await expect(cloud.submit('project', { environmentId: '--env=bad', prompt: 'task', attempts: 1 }, '/project')).rejects.toThrow();
    await expect(cloud.submit('project', { environmentId: 'env_123', prompt: 'task', attempts: 5 }, '/project')).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('does not submit or apply while checking capability, listing, or reviewing a diff', async () => {
    const { cloud, runner } = fixture(); await cloud.state('project'); await cloud.list({ limit: 1, cursor: 'next' }, '/project'); await cloud.inspect('diff', { taskId: 'task_123' }, '/project');
    expect(runner.mock.calls.map((call) => call[1][0])).toEqual(['--help', 'list', 'diff']);
    expect((await cloud.state('project')).environmentDiscovery).toBe('manual');
  });
  it('keeps saved environments project-scoped and prevents overlapping mutations', async () => {
    const { cloud, runner } = fixture(); cloud.saveEnvironment('a', { id: 'env_a', name: 'A' }); expect((await cloud.state('b')).environments).toEqual([]);
    const waiting = deferred(); runner.mockImplementation(() => waiting.promise);
    const first = cloud.submit('a', { environmentId: 'env_a', prompt: 'task' }, '/a');
    await expect(cloud.apply('a', { taskId: 'task_a', reviewId: '11111111-1111-4111-8111-111111111111', expectedDiffHash: 'a'.repeat(64) }, '/a')).rejects.toThrow('already running'); waiting.resolve({ output: '', warnings: '' }); await first;
  });
});
describe('Native thread Voice', () => {
  function fixture() { const runtime = { connected: true, request: vi.fn(async () => ({})) }; const prepareThread = vi.fn(async () => {}); const onEvent = vi.fn(); const voice = new CodexVoice({ runtime, prepareThread, onEvent }); return { voice, runtime, prepareThread, onEvent }; }
  it('prepares the actual thread before negotiation and leaves handoffs with Codex', async () => {
    const { voice, runtime, prepareThread } = fixture(); const context = { projectId: 'p', threadId: 't', sdp: 'offer' }; const session = await voice.start(context);
    expect(prepareThread).toHaveBeenCalledWith(context); expect(runtime.request).toHaveBeenCalledWith('thread/realtime/start', expect.objectContaining({ threadId: 't', version: 'v3', transport: { type: 'webrtc', sdp: 'offer' }, clientManagedHandoffs: false }));
    expect(session.threadId).toBe('t'); await expect(voice.start(context)).rejects.toThrow('End the current'); await voice.stop({ sessionId: session.id });
  });
  it('refuses SIWC Voice and filters remote SDP to the active session', async () => {
    const { voice, runtime, onEvent } = fixture(); voice.authSource = () => 'profile'; expect((await voice.state()).available).toBe(false); await expect(voice.start({})).rejects.toThrow('existing Codex'); expect(runtime.request).not.toHaveBeenCalled();
    voice.authSource = () => null; const session = await voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' });
    voice.handle({ method: 'thread/realtime/sdp', threadId: 'other', sdp: 'secret-other' }); expect(onEvent).not.toHaveBeenCalled();
    voice.handle({ method: 'thread/realtime/sdp', threadId: 't', sdp: 'answer' }); expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, sdp: 'answer' }));
    await expect(voice.stop({ sessionId: 'wrong' })).rejects.toThrow('changed'); await voice.stop({ sessionId: session.id });
  });
  it('cancels a pending start and stops the host after negotiation completes', async () => {
    const { voice, runtime } = fixture(); const pending = deferred(); runtime.request.mockImplementation((method) => method.endsWith('/start') ? pending.promise : Promise.resolve({}));
    const start = voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' }); await Promise.resolve(); await Promise.resolve();
    const stop = voice.stop({ sessionId: voice.session.id });
    await expect(voice.start({ projectId: 'p', threadId: 't', sdp: 'new offer' })).rejects.toThrow('End the current');
    pending.resolve({}); await expect(start).rejects.toThrow('ended before'); await stop;
    expect(voice.session).toBe(null); expect(runtime.request).toHaveBeenCalledWith('thread/realtime/stop', { threadId: 't' });
  });
  it('keeps untagged native errors advisory and blocks overlapping restarts until owned cleanup', async () => {
    const { voice, runtime } = fixture(); const session = await voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' });
    const pending = deferred(); runtime.request.mockImplementation((method) => method.endsWith('/stop') ? pending.promise : Promise.resolve({}));
    voice.handle({ method: 'thread/realtime/error', threadId: 't', message: 'connection failed' });
    await expect(voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' })).rejects.toThrow('End the current');
    expect(voice.session.id).toBe(session.id);
    const stop = voice.stop({ sessionId: session.id }); pending.resolve({}); await stop;
    expect(runtime.request.mock.calls.filter(([method]) => method === 'thread/realtime/stop')).toHaveLength(1);
    expect(voice.session).toBe(null);
  });
});
describe('Renderer media lifetime', () => {
  it('releases microphone tracks when capture returns after the view closed', async () => {
    const capture = deferred(); const stop = vi.fn(); const client = new CodexVoiceConnection({ api: {}, context: {}, capture: () => capture.promise }); const opening = client.open(); await client.close(); capture.resolve({ getTracks: () => [{ stop }] }); await opening; expect(stop).toHaveBeenCalled();
  });
  it('receives early SDP events and cleans both local media and the host on close', async () => {
    const stop = vi.fn(); const apiStop = vi.fn(); let listener;
    const peer = { iceGatheringState: 'complete', connectionState: 'new', localDescription: { sdp: 'offer' }, addTrack: vi.fn(), createDataChannel: () => ({ close: vi.fn() }), createOffer: async () => ({ type: 'offer', sdp: 'offer' }), setLocalDescription: async () => {}, setRemoteDescription: vi.fn(async () => {}), close: vi.fn() };
    const off = vi.fn(); const audio = { pause: vi.fn() };
    const api = { events: { subscribe: (handler) => { listener = handler; return off; } }, voice: { start: async () => { listener({ type: 'VoiceEvent', payload: { id: 'session', threadId: 't', projectId: 'p', method: 'thread/realtime/sdp', sdp: 'answer' } }); return { id: 'session' }; }, stop: apiStop } };
    const client = new CodexVoiceConnection({ api, context: { projectId: 'p', threadId: 't' }, capture: async () => ({ getTracks: () => [{ stop }] }), peerFactory: () => peer, audioFactory: () => audio });
    await client.open(); expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' }); await client.close(); expect(stop).toHaveBeenCalled(); expect(off).toHaveBeenCalled(); expect(peer.close).toHaveBeenCalled(); expect(apiStop).toHaveBeenCalledWith({ sessionId: 'session' });
  });
});
