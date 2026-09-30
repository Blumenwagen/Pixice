import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicProfile = (p) => ({ id: p.id, email: p.email, name: p.name, subject: p.subject, clientId: p.client_id, signedIn: Boolean(p.access_token), planEnabled: Boolean(p.access_token && p.scopes.includes(DIRECT_SCOPE)), scopes: p.scopes, expiresAt: p.expires_at });

export async function validateChatGPTIdentity(token, { clientId, nonce = null, subject = null, keySet = jwks }) {
  const { payload } = await jwtVerify(token, keySet, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], clockTolerance: 30, requiredClaims: ['sub', 'exp', 'iat', ...(nonce ? ['nonce'] : [])] });
  if ((nonce && !equal(payload.nonce, nonce)) || typeof payload.sub !== 'string' || !payload.sub || (subject && payload.sub !== subject)) throw new Error('ChatGPT returned a different identity or invalid nonce. Start a new sign-in.');
  if ((Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp) || (payload.azp && payload.azp !== clientId)) throw new Error('ChatGPT returned an unexpected authorized party.');
  return payload;
}

// App-owned public-client OAuth. No credentials cross IPC or enter the app database.
export class ChatGPTAuth {
  constructor({ directory, crypto, openExternal, onChange = () => {}, fetcher = fetch, verifyIdentity = validateChatGPTIdentity }) {
    this.directory = path.join(directory, 'chatgpt');
    this.crypto = crypto;
    this.openExternal = openExternal;
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.verifyIdentity = verifyIdentity;
    this.queue = Promise.resolve();
    this.pending = null;
    this.error = null;
    this.closed = false;
    this.signOutResult = null;
  }
  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  async read() {
    let value;
    try { value = JSON.parse(await readFile(path.join(this.directory, 'profiles.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { profiles: [] }; throw new Error('ChatGPT credentials could not be read.'); }
    await this.crypto?.ready?.();
    if (!this.crypto?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable.');
    try { return JSON.parse(this.crypto.decryptString(Buffer.from(value.encrypted, 'base64'))); }
    catch { throw new Error('ChatGPT credentials could not be decrypted.'); }
  }
  async write(value) {
    await this.crypto?.ready?.();
    if (!this.crypto?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'profiles.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, encrypted: Buffer.from(this.crypto.encryptString(JSON.stringify(value))).toString('base64') }), { mode: 0o600 });
    await rename(temporary, file);
  }
  async hostId() {
    const file = path.join(this.directory, 'host.json');
    try {
      const { hostId } = JSON.parse(await readFile(file, 'utf8'));
      if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)) throw new Error('Invalid ChatGPT host identifier.');
      return hostId;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const hostId = `urn:uuid:${randomUUID()}`;
    await writeFile(file, JSON.stringify({ hostId }), { mode: 0o600, flag: 'wx' });
    return hostId;
  }
  async state() {
    const { profiles } = await this.read();
    return { profiles: profiles.map(publicProfile), pending: Boolean(this.pending), error: this.error, signOutResult: this.signOutResult };
  }
  notify() {
    if (this.closed) return;
    void this.state().then((state) => { if (!this.closed) this.onChange(state); }).catch(() => {});
  }
  async close() { this.closed = true; this.cancel(); await this.queue; }
  async begin({ profileId = null } = {}) {
    if (this.closed) throw new Error("ChatGPT sign-in service is stopping.");
    if (this.pending) throw new Error('A ChatGPT sign-in is already open. Cancel it before starting another.');
    // Reserve before asynchronous storage reads so concurrent sign-ins cannot open two listeners.
    const attempt = { state: random(), nonce: random(), verifier: random(), server: null, timeout: null, claimed: false };
    this.pending = attempt;
    this.error = null;
    try {
      await this.crypto?.ready?.();
      if (!this.crypto?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable.');
      const saved = (await this.read()).profiles.find((p) => p.id === profileId);
      if (profileId && !saved) throw new Error('ChatGPT account not found.');
      const hostId = await this.hostId();
      if (this.pending !== attempt) return { opened: false };
      const server = createServer((req, res) => { void this.callback(attempt, saved, hostId, req, res); });
      attempt.server = server;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (this.pending !== attempt) { this.cancelAttempt(attempt); return { opened: false }; }
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      const params = { client_id: saved?.client_id ?? 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPE, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') };
      if (!saved) params.agent_name_hint = 'Pixice';
      else { if (saved.id_token) params.id_token_hint = saved.id_token; if (saved.email) params.login_hint = saved.email; }
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      attempt.timeout = setTimeout(() => this.cancelAttempt(attempt, 'ChatGPT sign-in timed out. Try again.'), 5 * 60_000);
      attempt.timeout.unref?.();
      await this.openExternal(url.toString());
      this.notify();
      return { opened: true };
    } catch (error) {
      if (this.pending !== attempt) { this.cancelAttempt(attempt); return { opened: false }; }
      this.cancelAttempt(attempt, error.message); throw error;
    }
  }
  async callback(attempt, saved, hostId, req, res) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url, attempt.redirectUri);
    if (req.method !== 'GET' || req.headers.host !== new URL(attempt.redirectUri).host || url.pathname !== '/auth/callback' || !equal(url.searchParams.get('state'), attempt.state) || this.pending !== attempt || attempt.claimed) { res.writeHead(400).end('Invalid sign-in callback.'); return; }
    attempt.claimed = true;
    try {
      if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined. You can try again.');
      const clientId = url.searchParams.get('client_id') ?? saved?.client_id;
      if (!clientId || clientId === 'dynamic_agent_client' || (saved && clientId !== saved.client_id)) throw new Error('ChatGPT registration did not return the expected client ID.');
      const code = url.searchParams.get('code');
      if (!code) throw new Error('ChatGPT did not return an authorization code.');
      const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
      const identity = await this.verifyIdentity(tokens.id_token, { clientId, nonce: attempt.nonce, subject: saved?.subject });
      await this.serial(async () => {
        if (this.pending !== attempt) throw new Error('This sign-in was cancelled.');
        const store = await this.read();
        if (this.pending !== attempt) throw new Error('This sign-in was cancelled.');
        const profile = { id: saved?.id ?? randomUUID(), client_id: clientId, subject: identity.sub, issuer: ISSUER, email: typeof identity.email === 'string' ? identity.email : saved?.email ?? null, name: typeof identity.name === 'string' ? identity.name : saved?.name ?? null, ext_agent_host_id: hostId, ...this.tokenRecord(tokens) };
        store.profiles = [...store.profiles.filter((p) => p.id !== profile.id), profile];
        await this.write(store);
      });
      res.end('Connected to Pixice. You can close this tab and return to the app.');
      this.cancelAttempt(attempt);
    } catch { res.writeHead(400).end('Sign-in could not be completed. Return to Pixice and try again.'); this.cancelAttempt(attempt, 'ChatGPT sign-in could not be verified. Start a new sign-in.'); }
  }
  tokenRecord(tokens, previous = null) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || String(tokens.token_type).toLowerCase() !== 'bearer') throw new Error('ChatGPT returned an invalid token response.');
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? previous?.refresh_token ?? null, id_token: tokens.id_token ?? previous?.id_token ?? null, scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [], expires_at: Date.now() + tokens.expires_in * 1000 };
  }
  async exchange(fields) {
    let response;
    try { response = await this.fetcher(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(20_000), redirect: 'error' }); }
    catch { throw new Error('ChatGPT token exchange could not connect. Try again.'); }
    if (!response.ok) throw new Error('ChatGPT credentials need a new sign-in.');
    try { return await response.json(); } catch { throw new Error('ChatGPT returned an invalid token response.'); }
  }
  access(profileId) {
    return this.serial(async () => {
      const store = await this.read();
      let p = store.profiles.find((profile) => profile.id === profileId);
      if (!p?.access_token) throw new Error('Sign in to this ChatGPT account again, or use the existing Codex account.');
      if (!p.scopes.includes(DIRECT_SCOPE)) throw new Error('This ChatGPT account has not granted plan usage. Sign in again and authorize plan usage.');
      if (p.expires_at <= Date.now() + 5 * 60_000) {
        if (!p.refresh_token) throw new Error('ChatGPT credentials expired. Sign in again.');
        const tokens = await this.exchange({ grant_type: 'refresh_token', client_id: p.client_id, refresh_token: p.refresh_token, resource: RESOURCE });
        if (tokens.id_token) await this.verifyIdentity(tokens.id_token, { clientId: p.client_id, subject: p.subject });
        // Scope reduction takes effect immediately; rotated refresh credentials are persisted together.
        p = { ...p, ...this.tokenRecord(tokens, p) };
        store.profiles = store.profiles.map((profile) => profile.id === p.id ? p : profile);
        await this.write(store);
        this.notify();
        if (!p.scopes.includes(DIRECT_SCOPE)) throw new Error('ChatGPT plan usage permission was removed. Sign in again.');
      }
      return { profileId: p.id, accessToken: p.access_token, expiresAt: p.expires_at };
    });
  }
  signOut(profileId) {
    return this.serial(async () => {
      if (this.pending) this.cancel();
      const store = await this.read();
      const profile = store.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error('ChatGPT account not found.');
      // Keep the rotating refresh token available only during this serialized attempt.
      const confirmed = profile.refresh_token ? await this.revokeSession(profile).catch(() => false) : null;
      store.profiles = store.profiles.map((p) => p.id === profileId ? { id: p.id, client_id: p.client_id, subject: p.subject, issuer: p.issuer, email: p.email, name: p.name, ext_agent_host_id: p.ext_agent_host_id, scopes: [], expires_at: null } : p);
      await this.write(store);
      this.signOutResult = { profileId, status: confirmed === true ? 'confirmed' : 'unconfirmed', message: confirmed === true ? 'Signed out. ChatGPT confirmed that this renewable session was revoked.' : 'Signed out on this device. Remote session revocation was not confirmed. Disconnect Pixice in ChatGPT Settings to end its remote access.' };
      this.notify();
      return this.state();
    });
  }
  async revokeSession(profile) {
    // Discover, rather than guess, the public-client revocation endpoint.
    // Redirects and foreign endpoints cannot receive the refresh token.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const discovery = await this.fetcher(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
        if (!discovery.ok) { if (discovery.status < 500) return false; throw new Error('Discovery unavailable'); }
        const metadata = await discovery.json();
        if (metadata.issuer !== ISSUER || typeof metadata.revocation_endpoint !== 'string') return false;
        const endpoint = new URL(metadata.revocation_endpoint);
        if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) return false;
        const response = await this.fetcher(endpoint.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: profile.client_id }).toString(), signal: AbortSignal.timeout(5_000), redirect: 'error' });
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch { /* Retry network/5xx failure once while the token is still protected. */ }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }
  cancelAttempt(attempt, error = null) {
    if (attempt?.timeout) clearTimeout(attempt.timeout);
    attempt?.server?.close();
    if (!attempt || this.pending !== attempt) return { cancelled: false };
    this.pending = null;
    this.error = error;
    this.notify();
    return { cancelled: true };
  }
  cancel(error = null) { return this.cancelAttempt(this.pending, error); }
}
