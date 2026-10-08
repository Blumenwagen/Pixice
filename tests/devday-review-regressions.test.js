import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTAuth } from '../electron/providers/chatgpt-auth.mjs';
import { createCredentialCrypto } from '../electron/backend/credential-crypto.mjs';
import { CodexVoice } from '../electron/voice/codex-voice.mjs';
import { CodexVoiceConnection } from '../src/lib/codex-voice.js';
import { CodexCloud, applyReviewedCloudPatch } from '../electron/providers/codex-cloud.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const dirs = [], clients = [];
afterEach(async () => { clients.forEach((c) => c.cancel()); clients.length = 0; vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function authFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pixice-auth-review-')); dirs.push(directory);
  const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', id_token: 'private-id', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens)));
  const openExternal = vi.fn();
  const verifyIdentity = vi.fn(async () => ({ sub: 'account' }));
  const auth = new ChatGPTAuth({ directory, crypto: createCredentialCrypto({ directory, environment: { PIXICE_CREDENTIAL_KEY: randomBytes(32).toString('base64') } }), fetcher, openExternal, verifyIdentity }); clients.push(auth);
  const callback = () => { const url = new URL(openExternal.mock.calls.at(-1)[0]); const target = new URL(url.searchParams.get('redirect_uri')); for (const [k, v] of Object.entries({ state: url.searchParams.get('state'), code: 'code', client_id: 'oaiapp_review' })) target.searchParams.set(k, v); return target; };
  return { auth, fetcher, openExternal, verifyIdentity, tokens, callback };
}
describe('Session revocation regression', () => {
  it.each([200, 503])('clears tokens after remote response %s and reports confirmation truthfully', async (status) => {
    const f = await authFixture(); await f.auth.begin(); expect((await fetch(f.callback())).status).toBe(200); const profile = (await f.auth.state()).profiles[0];
    const endpoint = 'https://auth.openai.com/discovered/revocation';
    f.fetcher.mockImplementation(async (url) => new Response(url.includes('openid-configuration') ? JSON.stringify({ issuer: 'https://auth.openai.com', revocation_endpoint: endpoint }) : '', { status: url.includes('openid-configuration') ? 200 : status }));
    const state = await f.auth.signOut(profile.id);
    const calls = f.fetcher.mock.calls.filter(([url]) => url === endpoint);
    expect(calls).toHaveLength(status === 200 ? 1 : 2);
    expect(Object.fromEntries(new URLSearchParams(calls[0][1].body))).toEqual({ token: 'private-refresh', token_type_hint: 'refresh_token', client_id: 'oaiapp_review' });
    expect(calls[0][1].redirect).toBe('error');
    expect(state.signOutResult.status).toBe(status === 200 ? 'confirmed' : 'unconfirmed');
    expect(JSON.stringify(await f.auth.read())).not.toContain('private-');
    expect(JSON.stringify(state)).not.toContain('private-');
    if (status !== 200) expect(state.signOutResult.message).toContain('Disconnect Pixice in ChatGPT Settings');
  });
  it('does not send tokens to a foreign discovery endpoint and still clears them', async () => {
    const f = await authFixture(); await f.auth.begin(); await fetch(f.callback()); const profile = (await f.auth.state()).profiles[0];
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://attacker.invalid/revoke' })));
    expect((await f.auth.signOut(profile.id)).signOutResult.status).toBe('unconfirmed');
    expect(f.fetcher.mock.calls.some(([url]) => url.includes('attacker'))).toBe(false);
    expect(JSON.stringify(await f.auth.read())).not.toContain('private-');
  });
});
describe('Sign-in attempt ownership regression', () => {
  it.each(['exchange', 'verification'])('does not cancel a newer attempt after stale %s fails or succeeds', async (stage) => {
    const f = await authFixture(); const pending = deferred();
    if (stage === 'exchange') f.fetcher.mockImplementationOnce(() => pending.promise);
    else f.verifyIdentity.mockImplementationOnce(() => pending.promise);
    await f.auth.begin(); const old = f.auth.pending;
    const response = fetch(f.callback());
    await vi.waitFor(() => expect(stage === 'exchange' ? f.fetcher : f.verifyIdentity).toHaveBeenCalled());
    f.auth.cancel(); await f.auth.begin(); const newer = f.auth.pending;
    f.auth.cancelAttempt(old, 'stale timeout'); expect(f.auth.pending).toBe(newer);
    if (stage === 'exchange') pending.resolve(new Response(JSON.stringify(f.tokens)));
    else pending.reject(new Error('stale verification failure'));
    expect((await response).status).toBe(400);
    expect(f.auth.pending).toBe(newer); expect(f.auth.error).toBe(null); expect((await f.auth.state()).pending).toBe(true);
  });
  it('scopes a late browser setup error to its cancelled attempt', async () => {
    const f = await authFixture(); const browser = deferred(); f.openExternal.mockImplementationOnce(() => browser.promise);
    const first = f.auth.begin(); await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledOnce());
    f.auth.cancel(); await f.auth.begin(); const newer = f.auth.pending;
    browser.reject(new Error('old browser failed')); expect(await first).toEqual({ opened: false });
    expect(f.auth.pending).toBe(newer); expect(f.auth.error).toBe(null);
  });
});
describe('Voice cleanup ownership regression', () => {
  it('holds the session through failed-start cleanup, including late terminal notifications', async () => {
    const stop = deferred(); const runtime = { request: vi.fn((method) => method.endsWith('/start') ? Promise.reject(new Error('negotiation failed')) : stop.promise) };
    const voice = new CodexVoice({ runtime, prepareThread: async () => {} });
    const starting = voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' }); const outcome = expect(starting).rejects.toThrow('negotiation failed');
    await vi.waitFor(() => expect(voice.session.phase).toBe('stopping'));
    const oldId = voice.session.id;
    voice.handle({ method: 'thread/realtime/closed', threadId: 't' }); voice.handle({ method: 'thread/realtime/error', threadId: 't', message: 'late error' });
    expect(voice.session.id).toBe(oldId); await expect(voice.start({})).rejects.toThrow('End the current');
    stop.resolve({}); await outcome; expect(voice.session).toBe(null);
    runtime.request.mockResolvedValue({}); const next = await voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' });
    voice.handle({ method: 'thread/realtime/closed', threadId: 't', realtimeSessionId: oldId }); voice.handle({ method: 'thread/realtime/error', threadId: 't', message: 'late untagged error' });
    expect(voice.session.id).toBe(next.id); await voice.stop({ sessionId: next.id });
  });
  it('retains the cleanup lock after Stop fails and lets its owner retry', async () => {
    const runtime = { request: vi.fn(async () => ({})) }; const voice = new CodexVoice({ runtime, prepareThread: async () => {} });
    const session = await voice.start({ projectId: 'p', threadId: 't', sdp: 'offer' }); runtime.request.mockRejectedValueOnce(new Error('stop failed'));
    await expect(voice.stop({ sessionId: session.id })).rejects.toThrow('stop failed'); expect(voice.session.phase).toBe('cleanup-failed');
    await expect(voice.start({})).rejects.toThrow('End the current'); await voice.stop({ sessionId: session.id }); expect(voice.session).toBe(null);
  });
  it('awaits a late Start response and the same Stop completion on repeated renderer closes', async () => {
    const start = deferred(), stop = deferred(); const track = { stop: vi.fn() };
    const peer = { iceGatheringState: 'complete', connectionState: 'new', localDescription: { sdp: 'offer' }, addTrack: vi.fn(), createDataChannel: () => ({ close() {} }), createOffer: async () => ({}), setLocalDescription: async () => {}, close: vi.fn() };
    const api = { events: { subscribe: () => () => {} }, voice: { start: vi.fn(() => start.promise), stop: vi.fn(() => stop.promise) } };
    const client = new CodexVoiceConnection({ api, context: { projectId: 'p', threadId: 't' }, capture: async () => ({ getTracks: () => [track] }), peerFactory: () => peer, audioFactory: () => ({ pause() {} }) });
    const opening = client.open(); await vi.waitFor(() => expect(api.voice.start).toHaveBeenCalledOnce());
    const closing = client.close(); expect(client.close()).toBe(closing); expect(track.stop).toHaveBeenCalledOnce();
    start.resolve({ id: 'session' }); await vi.waitFor(() => expect(api.voice.stop).toHaveBeenCalledWith({ sessionId: 'session' }));
    let finished = false; closing.then(() => { finished = true; }); await Promise.resolve(); expect(finished).toBe(false);
    stop.resolve({}); await closing; await opening; expect(api.voice.stop).toHaveBeenCalledOnce();
  });
});
describe('Reviewed Cloud snapshot regression', () => {
  it('applies the exact reviewed bytes despite later vendor changes, with project binding and single use', async () => {
    const applier = vi.fn(async () => ({ output: 'applied' })); const runner = vi.fn(async () => ({ output: 'reviewed patch\n', warnings: '' }));
    const cloud = new CodexCloud({ executable: () => '/codex', getEnvironments: () => [], saveEnvironments() {}, runner, patchApplier: applier });
    const review = await cloud.review('p', { taskId: 'task_1', attempt: 2 }, '/project');
    expect(runner).toHaveBeenCalledWith('/codex', ['diff', '--attempt', '2', '--', 'task_1'], { cwd: '/project' });
    runner.mockResolvedValue({ output: 'changed vendor patch\n' });
    const args = { taskId: 'task_1', reviewId: review.reviewId, expectedDiffHash: review.diffHash };
    await expect(cloud.apply('other', args, '/project')).rejects.toThrow('does not match');
    await cloud.apply('p', args, '/project'); expect(applier).toHaveBeenCalledWith('reviewed patch\n', { cwd: '/project' }); expect(runner).toHaveBeenCalledOnce();
    await expect(cloud.apply('p', args, '/project')).rejects.toThrow('expired');
  });
  it('uses real Git to apply reviewed bytes locally and rejects traversal and conflicting hunks without partial changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pixice-patch-review-')); dirs.push(root);
    await writeFile(path.join(root, 'file.txt'), 'before\n');
    const patch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+reviewed\n';
    await applyReviewedCloudPatch(patch, { cwd: root }); expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('reviewed\n');
    await expect(applyReviewedCloudPatch(patch, { cwd: root })).rejects.toThrow('could not be applied');
    const unsafe = 'diff --git a/../outside.txt b/../outside.txt\n--- /dev/null\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+unsafe\n';
    await expect(applyReviewedCloudPatch(unsafe, { cwd: root })).rejects.toThrow('could not be applied');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('reviewed\n');
  });
});
