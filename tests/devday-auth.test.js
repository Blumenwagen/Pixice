import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { randomBytes, webcrypto } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGPTAuth, validateChatGPTIdentity } from '../electron/providers/chatgpt-auth.mjs';
import { createCredentialCrypto } from '../electron/backend/credential-crypto.mjs';
import { codexAppServerArgs } from '../electron/runtime/codex-runtime.mjs';
import { APPLICATION_OPERATIONS } from '../electron/connect/application-protocol.mjs';
import { OPERATIONS, REMOTE_EVENTS } from '../electron/connect/protocol.mjs';
const directories = []; const clients = [];
afterEach(async () => { clients.forEach((c) => c.cancel()); clients.length = 0; vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixice-chatgpt-')); directories.push(directory);
  const crypto = createCredentialCrypto({ directory, environment: { PIXICE_CREDENTIAL_KEY: randomBytes(32).toString('base64') } });
  const openExternal = vi.fn();
  const tokens = { access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: 'secret-id', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct offline_access' };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const verifyIdentity = vi.fn(async () => ({ sub: 'verified-user', email: 'person@example.com' }));
  const auth = new ChatGPTAuth({ directory, crypto, openExternal, fetcher, verifyIdentity }); clients.push(auth);
  return { auth, directory, openExternal, fetcher, verifyIdentity, tokens };
}
async function connect(f) {
  await f.auth.begin();
  const url = new URL(f.openExternal.mock.calls.at(-1)[0]);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'one-use-code'); callback.searchParams.set('client_id', 'oaiapp_test');
  const response = await fetch(callback); expect(response.status).toBe(200);
  return (await f.auth.state()).profiles[0];
}
describe('ChatGPT app-owned authentication', () => {
  it('uses fresh PKCE, state and nonce with stable host identity; rejects foreign state without exchanging a code', async () => {
    const f = await fixture(); await f.auth.begin();
    const first = new URL(f.openExternal.mock.calls[0][0]);
    expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(first.searchParams.get('agent_name_hint')).toBe('Pixice');
    expect(first.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    const invalid = new URL(first.searchParams.get('redirect_uri')); invalid.searchParams.set('state', 'foreign'); invalid.searchParams.set('code', 'code');
    expect((await fetch(invalid)).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
    f.auth.cancel(); await f.auth.begin();
    const second = new URL(f.openExternal.mock.calls[1][0]);
    for (const field of ['state', 'nonce', 'code_challenge']) expect(second.searchParams.get(field)).not.toBe(first.searchParams.get(field));
    expect(second.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'));
  });
  it('exchanges with the issued client ID and exact redirect; saves encrypted credentials without exposing them in state', async () => {
    const f = await fixture(); const profile = await connect(f);
    const fields = new URLSearchParams(f.fetcher.mock.calls[0][1].body);
    const authorize = new URL(f.openExternal.mock.calls[0][0]);
    expect(fields.get('client_id')).toBe('oaiapp_test'); expect(fields.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
    expect(fields.has('client_secret')).toBe(false);
    expect(f.verifyIdentity).toHaveBeenCalledWith('secret-id', expect.objectContaining({ clientId: 'oaiapp_test', nonce: authorize.searchParams.get('nonce') }));
    const file = path.join(f.directory, 'chatgpt/profiles.json');
    expect(await readFile(file, 'utf8')).not.toContain('secret-access');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await f.auth.state())).not.toContain('secret-');
    expect(profile.planEnabled).toBe(true);
  });
  it('reuses the selected registration and refuses another identity before replacing credentials', async () => {
    const f = await fixture(); const profile = await connect(f);
    await f.auth.begin({ profileId: profile.id });
    const authorize = new URL(f.openExternal.mock.calls.at(-1)[0]);
    expect(authorize.searchParams.get('client_id')).toBe('oaiapp_test'); expect(authorize.searchParams.has('agent_name_hint')).toBe(false); expect(authorize.searchParams.get('id_token_hint')).toBe('secret-id');
    f.verifyIdentity.mockRejectedValueOnce(new Error('wrong identity'));
    const callback = new URL(authorize.searchParams.get('redirect_uri')); callback.searchParams.set('state', authorize.searchParams.get('state')); callback.searchParams.set('code', 'code');
    expect((await fetch(callback)).status).toBe(400);
    expect((await f.auth.state()).profiles[0].id).toBe(profile.id);
    expect((await f.auth.access(profile.id)).accessToken).toBe('secret-access');
  });
  it('requires granted plan scope, and serializes rotating refreshes across concurrent consumers', async () => {
    const f = await fixture(); const profile = await connect(f);
    const store = await f.auth.read(); store.profiles[0].expires_at = 0; await f.auth.write(store);
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...f.tokens, access_token: 'rotated-access', refresh_token: 'rotated-refresh' })));
    const results = await Promise.all([f.auth.access(profile.id), f.auth.access(profile.id)]);
    expect(results.map((r) => r.accessToken)).toEqual(['rotated-access', 'rotated-access']);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const fields = new URLSearchParams(f.fetcher.mock.calls[1][1].body); expect(fields.get('grant_type')).toBe('refresh_token'); expect(fields.has('scope')).toBe(false);
    expect((await f.auth.read()).profiles[0].refresh_token).toBe('rotated-refresh');
    const reduced = await f.auth.read(); reduced.profiles[0].scopes = ['openid']; await f.auth.write(reduced);
    await expect(f.auth.access(profile.id)).rejects.toThrow('has not granted');
  });
  it('clears token material at sign-out but retains account registration for later login', async () => {
    const f = await fixture(); const profile = await connect(f); await f.auth.signOut(profile.id);
    const saved = (await f.auth.read()).profiles[0]; expect(saved.client_id).toBe('oaiapp_test'); expect(JSON.stringify(saved)).not.toContain('secret-');
    await expect(f.auth.access(profile.id)).rejects.toThrow('Sign in');
  });
  it('fails closed when credential encryption is unavailable', async () => {
    const f = await fixture(); f.auth.crypto = { ready: async () => {}, isEncryptionAvailable: () => false };
    await expect(f.auth.begin()).rejects.toThrow('Secure credential'); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('enforces signatures, issuer, audience, expiry, nonce, and returning subject with real signed JWTs', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Uint8Array', new TextEncoder().encode('').constructor);
    const { privateKey, publicKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'test';
    const keySet = createLocalJWKSet({ keys: [jwk] });
    const make = (values = {}) => new SignJWT({ nonce: 'nonce', ...values }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(values.iss ?? 'https://auth.openai.com').setAudience(values.aud ?? 'client').setSubject(values.sub ?? 'subject').setIssuedAt().setExpirationTime(values.exp ?? '1h').sign(privateKey);
    const options = { clientId: 'client', nonce: 'nonce', subject: 'subject', keySet };
    expect((await validateChatGPTIdentity(await make(), options)).sub).toBe('subject');
    for (const values of [{ iss: 'https://other.invalid' }, { aud: 'other-client' }, { sub: 'other-user' }, { nonce: 'wrong' }, { exp: 1 }]) await expect(validateChatGPTIdentity(await make(values), options)).rejects.toThrow();
    const { publicKey: other } = await generateKeyPair('RS256'); const otherJwk = await exportJWK(other); otherJwk.kid = 'test';
    await expect(validateChatGPTIdentity(await make(), { ...options, keySet: createLocalJWKSet({ keys: [otherJwk] }) })).rejects.toThrow();
  });
  it('uses a Responses provider with no token in process arguments and keeps all three integrations outside paired Connect capabilities', () => {
    const args = codexAppServerArgs('', true); expect(args.join(' ')).toContain('supports_websockets=false'); expect(args.join(' ')).toContain('env_key="ACCESS_TOKEN"');
    for (const operation of ['chatgpt.signIn', 'chatgpt.select', 'voice.start', 'cloud.submit', 'cloud.apply']) { expect(APPLICATION_OPERATIONS.has(operation)).toBe(true); expect(OPERATIONS.has(operation)).toBe(false); }
    expect(REMOTE_EVENTS.has('ChatGPTState')).toBe(false); expect(REMOTE_EVENTS.has('VoiceEvent')).toBe(false);
  });
});
