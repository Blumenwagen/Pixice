import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceCompanionService, registerVoiceCompanionIpc } from '../electron/voice/companion-service.mjs';
import { CodexVoiceConnection } from '../src/lib/codex-voice.js';
const context = { projectId: 'f53f8280-c934-4b8f-b812-57ef3daa89a8', threadId: 'voice-thread', model: 'gpt-6.1-sol', permissionMode: 'workspace-write' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const presentation = { supported: true, open: vi.fn(async () => {}), destroy: vi.fn(), send: vi.fn(), detach: vi.fn(), attach: vi.fn() };
  const call = vi.fn(async (op) => op === 'voice.state' ? { available: true, session: null } : op === 'voice.start' ? { id: 'session', ...context } : { stopped: true });
  const returnToMain = vi.fn(async () => {}), notifyApproval = vi.fn();
  const service = new VoiceCompanionService({ presentation, call, returnToMain, notifyApproval });
  return { service, presentation, call, returnToMain, notifyApproval };
}
afterEach(() => vi.useRealTimers());
describe('single native companion ownership', () => {
  it('pins context, reserves before discovery, rejects competing thread and duplicate starts', async () => {
    const { service, presentation, call } = fixture();
    const pending = deferred(); call.mockImplementationOnce(() => pending.promise);
    const opening = service.open(context);
    await service.open(context);
    await expect(service.open({ ...context, threadId: 'other' })).rejects.toThrow('pinned');
    pending.resolve({ available: true }); await opening;
    await service.start({ sdp: 'offer' });
    await expect(service.start({ sdp: 'another' })).rejects.toThrow('already');
    expect(presentation.open).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter(([op]) => op === 'voice.start')).toHaveLength(1);
    expect(call).toHaveBeenCalledWith('voice.start', { ...context, sdp: 'offer' });
    await service.end();
  });
  it('detach, reattach and return change presentation without restarting transport', async () => {
    const { service, call, presentation } = fixture(); await service.open(context); await service.start({ sdp: 'offer' });
    service.detach(); expect(service.state().detached).toBe(true);
    await service.attach(); await service.returnToPixice();
    expect(service.state().detached).toBe(false); expect(presentation.destroy).not.toHaveBeenCalled();
    expect(call.mock.calls.filter(([op]) => op === 'voice.start')).toHaveLength(1); await service.end();
  });
  it('destroys media immediately during late start, stops returned session once, blocks retry until done', async () => {
    const { service, call, presentation } = fixture(); await service.open(context);
    const pending = deferred(); call.mockImplementationOnce(() => pending.promise);
    const start = service.start({ sdp: 'offer' }); const end = service.end();
    expect(presentation.destroy).toHaveBeenCalledTimes(1);
    await expect(service.open(context)).rejects.toThrow('still ending');
    pending.resolve({ id: 'late', ...context }); await start; await end;
    expect(call).toHaveBeenCalledWith('voice.stop', { sessionId: 'late' }); expect(service.state().phase).toBe('ended');
    await service.open(context); await service.end();
  });
  it('retains cleanup failure for explicit retry while capture stays destroyed', async () => {
    const { service, call, presentation } = fixture(); await service.open(context); await service.start({ sdp: 'offer' });
    call.mockRejectedValueOnce(new Error('offline')); await expect(service.end()).rejects.toThrow('offline');
    expect(presentation.destroy).toHaveBeenCalled(); expect(service.state().phase).toBe('cleanup-failed');
    await expect(service.open({ ...context, threadId: 'other' })).rejects.toThrow('Retry End');
    await service.open(context); expect(service.configuration().state.phase).toBe('cleanup-failed');
    expect(call.mock.calls.filter(([op]) => op === 'voice.start')).toHaveLength(1);
    await service.end(); expect(service.state().phase).toBe('ended'); expect(service.ownsMedia()).toBe(false);
  });
  it('resolves uncertain Start only by discovering and stopping the owned session', async () => {
    const { service, call } = fixture(); await service.open(context);
    call.mockRejectedValueOnce(new Error('response lost')); await expect(service.start({ sdp: 'offer' })).rejects.toThrow('lost');
    call.mockResolvedValueOnce({ session: { id: 'uncertain', ...context } }); await service.end();
    expect(call).toHaveBeenCalledWith('voice.stop', { sessionId: 'uncertain' });
  });
  it('does not load a window if End races support discovery', async () => {
    const { service, call, presentation } = fixture(); const pending = deferred(); call.mockImplementationOnce(() => pending.promise);
    const opening = service.open(context); await service.end(); pending.resolve({ available: true }); await opening;
    expect(presentation.open).not.toHaveBeenCalled();
  });
  it('reports an unsupported desktop before accessing microphone or backend', async () => {
    const { service, presentation, call } = fixture(); presentation.supported = false;
    await expect(service.open(context)).rejects.toThrow('unavailable'); expect(call).not.toHaveBeenCalled(); expect(presentation.open).not.toHaveBeenCalled();
  });
  it('routes approval notification/Return to actual main UI and never responds to approval', async () => {
    const { service, notifyApproval, returnToMain, call } = fixture(); await service.open(context);
    service.handle({ type: 'AttentionRequired', payload: { id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: context.threadId } } });
    expect(service.state().needsApproval).toBe(true); await service.returnToPixice();
    expect(returnToMain).toHaveBeenCalledWith({ projectId: context.projectId, threadId: context.threadId, needsApproval: true });
    expect(notifyApproval).toHaveBeenCalledTimes(1); expect(call.mock.calls.every(([op]) => op === 'voice.state')).toBe(true);
    service.handle({ type: 'AttentionResolved', payload: { requestId: 12 } }); expect(service.state().needsApproval).toBe(false); await service.end();
  });
  it('rejects foreign and subframe IPC senders, and transport accepts only SDP', async () => {
    const { service, presentation } = fixture(); const handlers = new Map(), contents = { mainFrame: {} };
    presentation.trusted = (event) => event.sender === contents && event.senderFrame === contents.mainFrame;
    registerVoiceCompanionIpc({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, service, mainWindow: { webContents: contents } });
    expect(() => handlers.get('voice-companion:start')({ sender: {} }, { sdp: 'x' })).toThrow('Untrusted');
    expect(() => handlers.get('voice:companion:open')({ sender: contents, senderFrame: {} }, context)).toThrow('Untrusted');
    await service.open(context); await expect(service.start({ sdp: 'x', projectId: 'foreign' })).rejects.toThrow(); await service.end();
  });
});
describe('owned WebRTC media', () => {
  function mediaFixture(options = {}) {
    const stop = vi.fn(), track = { enabled: true, stop }, media = { getTracks: () => [track], getAudioTracks: () => [track] };
    const capture = vi.fn(async () => media);
    const peer = { addTrack: vi.fn(), createDataChannel: () => ({ close: vi.fn() }), createOffer: async () => ({ sdp: 'offer' }), setLocalDescription: async () => {}, localDescription: { sdp: 'offer' }, iceGatheringState: 'complete', close: vi.fn(), setRemoteDescription: vi.fn(async () => {}) };
    const audio = { play: vi.fn(async () => {}), pause: vi.fn() }, start = vi.fn(async () => ({ id: 'session' })), hostStop = vi.fn(async () => {});
    const client = new CodexVoiceConnection({ api: { voice: { start, stop: hostStop }, events: { subscribe: () => () => {} } }, context, capture, peerFactory: () => peer, audioFactory: () => audio, audioContextFactory: () => { throw new Error('unavailable'); }, ...options });
    return { client, capture, media, stop, peer, audio, start, hostStop, track };
  }
  it('prevents duplicate capture, applies pre-capture mute and releases media/peer/playback exactly once', async () => {
    const f = mediaFixture(); f.client.mute(true); await f.client.open(); expect(f.track.enabled).toBe(false);
    await expect(f.client.open()).rejects.toThrow('already'); await f.client.close(); await f.client.close();
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.peer.close).toHaveBeenCalledTimes(1); expect(f.audio.pause).toHaveBeenCalledTimes(1); expect(f.audio.srcObject).toBe(null); expect(f.hostStop).toHaveBeenCalledTimes(1);
  });
  it('stops a microphone returned after cancellation without creating peer or starting host', async () => {
    const pending = deferred(); const f = mediaFixture({ capture: () => pending.promise }); const open = f.client.open(); await f.client.close(); pending.resolve(f.media); await open;
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.peer.addTrack).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });
  it('retains blocked playback through peer connected until explicit retry succeeds', async () => {
    const onState = vi.fn(); const f = mediaFixture({ onState });
    f.audio.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    await f.client.open(); f.peer.ontrack({ streams: [f.media] }); await Promise.resolve(); await Promise.resolve();
    expect(onState.mock.lastCall[0]).toBe('playback-blocked');
    f.peer.connectionState = 'connected'; f.peer.onconnectionstatechange();
    expect(onState.mock.lastCall[0]).toBe('playback-blocked');
    f.peer.ontrack({ streams: [f.media] }); expect(f.audio.play).toHaveBeenCalledTimes(1);
    f.audio.play.mockRejectedValueOnce(new Error('Still blocked')); await expect(f.client.play()).rejects.toThrow('Still blocked');
    expect(onState.mock.lastCall[0]).toBe('playback-blocked');
    await f.client.play(); expect(onState.mock.lastCall[0]).toBe('connected');
    const retry = deferred(); f.audio.play.mockImplementationOnce(() => retry.promise);
    const pending = f.client.play(); await f.client.close(); const reportsAtClose = onState.mock.calls.length;
    retry.resolve(); await pending; expect(onState).toHaveBeenCalledTimes(reportsAtClose);
  });
  it('uses separate real sample RMS for mic and speaker and closes analysis on End', async () => {
    vi.useFakeTimers(); const levels = vi.fn(); let index = 0;
    const analyzers = [0.1, 0.2].map((value) => ({ fftSize: 256, getFloatTimeDomainData: (samples) => samples.fill(value), disconnect: vi.fn() }));
    const audioContext = { resume: async () => {}, close: vi.fn(async () => {}), createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }), createAnalyser: () => analyzers[index++] };
    const f = mediaFixture({ audioContextFactory: () => audioContext, onLevels: levels }); await f.client.open(); f.peer.ontrack({ streams: [f.media] }); vi.advanceTimersByTime(100);
    expect(levels.mock.lastCall[0].micLevel).toBeCloseTo(0.3); expect(levels.mock.lastCall[0].speakerLevel).toBeCloseTo(0.6);
    f.client.mute(true); vi.advanceTimersByTime(100); expect(levels.mock.lastCall[0].micLevel).toBe(0); await f.client.close(); expect(audioContext.close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
