import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridge } from '../electron/backend/native-bridge.mjs';
import { validateVoiceProtocol } from '../electron/runtime/voice-protocol.mjs';
import { isDesktopCaller, isDesktopUrl, installDesktopMediaPermissions } from '../electron/native/desktop-permissions.mjs';
import { APPLICATION_OPERATIONS, APPLICATION_READ_OPERATIONS } from '../electron/connect/application-protocol.mjs';
import { OPERATIONS } from '../electron/connect/protocol.mjs';
import { createVoiceClient } from '../src/voice/client.js';

const cleanup = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
function nativeFixture() {
  const desktopAuthority = randomBytes(32).toString('base64url');
  const native = new NativeBridge({ desktopAuthority, leaseTimeoutMs: 10000 }); cleanup.push(() => native.close());
  const lease = { ...native.register({ clientId: randomUUID(), capabilities: [], desktopAuthority }), desktopAuthority };
  const handle = native.attachVoice(lease);
  const owner = native.authorizeVoice({ ...lease, ...handle });
  return { native, lease, handle, owner };
}
describe('native voice ownership and version contract', () => {
  it('requires the accepted version and all exact realtime schemas, with no model guess or catalog substitution', () => {
    const evidence = JSON.parse(readFileSync('work/voice-implementation/protocol-0.159.0.json', 'utf8'));
    const descriptors = { requests: evidence['ClientRequest.json'], notifications: evidence['ServerNotification.json'] };
    expect(validateVoiceProtocol(evidence.codexVersion, evidence.schemas, descriptors).experimentalApi).toBe(true);
    for (const version of ['0.158.0', '0.160.0', undefined]) expect(() => validateVoiceProtocol(version, evidence.schemas, descriptors)).toThrow(/unsupported/);
    const changed = structuredClone(evidence.schemas); changed['ThreadRealtimeStartParams.json'].properties.speed = { type: 'number' };
    expect(() => validateVoiceProtocol('0.159.0', changed, descriptors)).toThrow(/unsupported/);
    delete changed['ThreadRealtimeStartParams.json'];
    expect(() => validateVoiceProtocol('0.159.0', changed, descriptors)).toThrow(/unsupported/);
    expect(() => validateVoiceProtocol('0.159.0', evidence.schemas, { ...descriptors, requests: [] })).toThrow(/unsupported/);
  });
  it('rejects foreign helper and renderer tokens and never replays events to replacement owners', async () => {
    const f = nativeFixture(); const gone = vi.fn(); f.native.on('voice-owner-disconnected', gone);
    expect(() => f.native.authorizeVoice({ ...f.lease, ownerHandle: randomUUID() })).toThrow(/expired/);
    expect(() => f.native.authorizeVoice({ ...f.handle, leaseId: randomUUID() })).toThrow(/lease expired/);
    expect(f.native.publishVoice(f.owner, { type: 'sdp', sdp: 'old-private-answer' })).toBe(true);
    f.native.detachVoice(); expect(gone).toHaveBeenCalledWith(f.owner);
    const next = f.native.attachVoice(f.lease); const nextOwner = f.native.authorizeVoice({ ...f.lease, ...next });
    expect(f.native.publishVoice(f.owner, { sdp: 'late-answer' })).toBe(false);
    expect(nextOwner.events).toEqual([]); expect(f.owner.events).toEqual([]);
    const polling = f.native.pollVoice({ ...f.lease, ...next });
    f.native.publishVoice(nextOwner, { type: 'state' }); expect(await polling).toEqual({ events: [{ type: 'state' }] });
  });
  it('expires renderer ownership even when the helper keeps its general lease alive', () => {
    vi.useFakeTimers(); const f = nativeFixture(); const gone = vi.fn(); f.native.on('voice-owner-disconnected', gone);
    vi.advanceTimersByTime(9000); f.native.authorize(f.lease); vi.advanceTimersByTime(6000);
    expect(gone).toHaveBeenCalledOnce(); expect(f.native.isVoiceOwner(f.owner)).toBe(false);
    expect(f.native.status().connected).toBe(true);
  });
  it('bounds the ephemeral mailbox and tears down the owner when delivery cannot keep up', () => {
    const f = nativeFixture(); const gone = vi.fn(); f.native.on('voice-owner-disconnected', gone);
    for (let i = 0; i < 200; i++) f.native.publishVoice(f.owner, { type: 'transcript_delta', delta: 'fixture' });
    expect(f.native.publishVoice(f.owner, { type: 'sdp', sdp: 'overflow' })).toBe(false);
    expect(gone).toHaveBeenCalledOnce(); expect(f.owner.events).toEqual([]);
  });
  it('does not advertise remote voice and bypasses durable command recovery for all local voice operations', () => {
    expect([...OPERATIONS.keys()].some((name) => name.startsWith('voice.') || name.startsWith('native.voice'))).toBe(false);
    for (const name of APPLICATION_OPERATIONS.keys()) if (name.startsWith('voice.') || name.startsWith('native.')) expect(APPLICATION_READ_OPERATIONS.has(name)).toBe(true);
  });
});

function permissionFixture() {
  const options = { isDev: true, indexPath: '/desktop/index.html' };
  const frame = { url: 'http://127.0.0.1:5173' };
  const contents = { mainFrame: frame, getURL: () => frame.url };
  const window = { isDestroyed: () => false, webContents: contents };
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
  const systemPreferences = { getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) };
  installDesktopMediaPermissions({ session, getWindow: () => window, options, systemPreferences, platform: 'darwin' });
  return { options, frame, contents, window, systemPreferences, check: session.setPermissionCheckHandler.mock.calls[0][0], request: session.setPermissionRequestHandler.mock.calls[0][0] };
}
describe('desktop origin and microphone permissions without media capture', () => {
  it('checks speaker selection against the actual main window, top frame and origin in both callbacks', () => {
    const f = permissionFixture();
    const details = { requestingUrl: f.frame.url, isMainFrame: true };
    expect(f.check(f.contents, 'speaker-selection', f.frame.url, details)).toBe(true);
    const callback = vi.fn(); f.request(f.contents, 'speaker-selection', callback, details);
    expect(callback).toHaveBeenLastCalledWith(true);
    for (const [contents, origin, changed] of [[{}, f.frame.url, details], [null, f.frame.url, details], [f.contents, 'https://foreign.invalid', details], [f.contents, f.frame.url, { ...details, isMainFrame: false }], [f.contents, f.frame.url, { ...details, requestingUrl: 'https://foreign.invalid' }]]) {
      expect(f.check(contents, 'speaker-selection', origin, changed)).toBe(false);
      if (origin !== 'https://foreign.invalid') { f.request(contents, 'speaker-selection', callback, changed); expect(callback).toHaveBeenLastCalledWith(false); }
    }
    f.frame.url = 'https://foreign.invalid';
    expect(f.check(f.contents, 'speaker-selection', details.requestingUrl, details)).toBe(false);
    f.request(f.contents, 'speaker-selection', callback, details); expect(callback).toHaveBeenLastCalledWith(false);
    expect(f.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
  });
  it('accepts packaged speaker origin only with the exact trusted file frame', () => {
    const f = permissionFixture(); f.frame.url = 'file:///desktop/index.html';
    const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
    installDesktopMediaPermissions({ session, getWindow: () => f.window, options: { ...f.options, isDev: false }, systemPreferences: f.systemPreferences });
    const check = session.setPermissionCheckHandler.mock.calls[0][0];
    const details = { isMainFrame: true, requestingUrl: f.frame.url };
    expect(check(f.contents, 'speaker-selection', 'file:///', details)).toBe(true);
    expect(check(f.contents, 'speaker-selection', 'https://foreign.invalid', details)).toBe(false);
    f.frame.url = 'file:///desktop/other.html';
    expect(check(f.contents, 'speaker-selection', 'file:///', details)).toBe(false);
  });
  it('accepts only the main desktop sender and exact production file or development origin', () => {
    const f = permissionFixture(); const event = { sender: f.contents, senderFrame: f.frame };
    expect(isDesktopCaller(event, f.window, f.options)).toBe(true);
    expect(isDesktopCaller({ ...event, senderFrame: { url: f.frame.url } }, f.window, f.options)).toBe(false);
    expect(isDesktopCaller({ ...event, sender: {} }, f.window, f.options)).toBe(false);
    for (const url of ['http://127.0.0.1:5174', 'http://localhost:5173', 'https://host.test', 'about:blank']) expect(isDesktopUrl(url, f.options)).toBe(false);
    expect(isDesktopUrl('file:///desktop/index.html', { ...f.options, isDev: false })).toBe(true);
    expect(isDesktopUrl('file:///desktop/other.html', { ...f.options, isDev: false })).toBe(false);
    expect(f.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
  });
  it('denies remote, subframe, video, mixed-media and unknown microphone requests before OS permission', () => {
    const f = permissionFixture();
    const details = { requestingUrl: f.frame.url, isMainFrame: true, mediaType: 'audio', mediaTypes: ['audio'] };
    expect(f.check(f.contents, 'media', f.frame.url, details)).toBe(true);
    for (const change of [{ requestingUrl: 'https://host.test' }, { isMainFrame: false }, { mediaType: 'video' }, { mediaType: 'unknown' }]) expect(f.check(f.contents, 'media', f.frame.url, { ...details, ...change })).toBe(false);
    for (const change of [{ requestingUrl: 'https://host.test' }, { isMainFrame: false }, { mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: undefined }]) {
      const callback = vi.fn(); f.request(f.contents, 'media', callback, { ...details, ...change }); expect(callback).toHaveBeenCalledWith(false);
    }
    expect(f.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
  });
  it('uses OS permission only for a trusted audio request and surfaces denied permission', async () => {
    const f = permissionFixture(); const details = { requestingUrl: f.frame.url, isMainFrame: true, mediaTypes: ['audio'] }; const callback = vi.fn();
    f.systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
    f.systemPreferences.askForMediaAccess.mockResolvedValue(false);
    f.request(f.contents, 'media', callback, details); await Promise.resolve();
    expect(f.systemPreferences.askForMediaAccess).toHaveBeenCalledWith('microphone'); expect(callback).toHaveBeenCalledWith(false);
    f.systemPreferences.getMediaAccessStatus.mockReturnValue('denied'); callback.mockClear();
    f.request(f.contents, 'media', callback, details); expect(callback).toHaveBeenCalledWith(false); expect(f.systemPreferences.askForMediaAccess).toHaveBeenCalledOnce();
  });
  it('rechecks the owning window before completing a delayed OS permission decision', async () => {
    const f = permissionFixture(); let finish;
    f.systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
    f.systemPreferences.askForMediaAccess.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const callback = vi.fn();
    f.request(f.contents, 'media', callback, { requestingUrl: f.frame.url, isMainFrame: true, mediaTypes: ['audio'] });
    f.frame.url = 'https://foreign.test'; finish(true); await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(false);
  });
});

describe('preload and voice client contracts', () => {
  it('exposes frozen typed-method counterparts, forwarding only voice events through the existing adapter', async () => {
    let api; const invoke = vi.fn(async () => ({})); const listeners = new Set();
    vm.runInNewContext(readFileSync('electron/preload.cjs', 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } }, ipcRenderer: { invoke, on: (_name, listener) => listeners.add(listener), removeListener: (_name, listener) => listeners.delete(listener) } }) });
    expect(Object.isFrozen(api.voice)).toBe(true);
    for (const name of ["availability", "prepare", "start", "stop", "appendText", "appendSpeech", "appendAudio", "snapshot", "state", "context"]) { await api.voice[name]({ projectId: 'project', threadId: 'thread' }); expect(invoke).toHaveBeenLastCalledWith(`voice:${name}`, { projectId: 'project', threadId: 'thread' }); }
    const client = createVoiceClient({ invoke: (channel, payload) => api.voice[channel.slice(6)](payload), subscribe: api.events.subscribe });
    const event = vi.fn(); const unsubscribe = client.subscribe(event);
    for (const listener of listeners) { listener({}, { type: 'TaskUpdated', payload: { sdp: 'foreign' } }); listener({}, { type: 'VoiceSessionEvent', payload: { type: 'sdp', sdp: 'owner-answer' } }); }
    expect(event).toHaveBeenCalledOnce(); expect(event).toHaveBeenCalledWith({ type: 'sdp', sdp: 'owner-answer' }); unsubscribe(); expect(listeners.size).toBe(0);
  });
});
