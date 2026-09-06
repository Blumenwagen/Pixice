import { PROTOCOL_VERSION, normalizeEndpoint } from './protocol.mjs';
export async function requestJson(endpoint, route, { token, body, signal } = {}) {
  const response = await fetch(`${endpoint}/api/connect/${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(120_000)
  });
  let result;
  try { result = await response.json(); } catch { throw Object.assign(new Error('This address did not return a Pixice response. Check the endpoint and HTTPS proxy.'), { code: 'INVALID_RESPONSE' }); }
  if (!response.ok) throw Object.assign(new Error(result.error || `Connection failed (${response.status})`), { status: response.status });
  return result;
}
export class ApplicationClient {
  constructor(instance, { onState = () => {}, onReset = () => {}, probe = 'runtime.status', resolveInstance } = {}) {
    this.instance = { ...instance, endpoint: normalizeEndpoint(instance.endpoint) };
    this.onState = onState; this.onReset = onReset; this.probe = probe; this.resolveInstance = resolveInstance;
    this.listeners = new Set(); this.requests = new Map(); this.attention = new Map();
    this.closed = false; this.online = false; this.cursor = 0; this.eventInstance = ''; this.hasSnapshot = false;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    queueMicrotask(() => { if (this.listeners.has(listener)) for (const payload of this.attention.values()) listener({ type: 'AttentionRequired', payload }); });
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (error) { console.error('Pixice event listener failed:', event.type, error.message); }
    }
  }
  async connect() {
    const info = await requestJson(this.instance.endpoint, 'info');
    if (info.hostId !== this.instance.id) throw new Error('This address belongs to a different Pixice host. Pair again to verify its identity.');
    if (info.protocol !== PROTOCOL_VERSION) throw new Error('Incompatible Pixice Connect version. Update the host and client.');
    this.instanceId = info.instanceId;
    this.online = true;
    try { await this.call(this.probe); } catch (error) { this.online = false; throw error; }
    if (this.closed) return;
    this.onState({ state: 'connected' });
    void this.poll();
  }
  async call(operation, payload) {
    if (!this.online || this.closed) throw new Error('The instance is offline. Your action was not sent.');
    if (['approvals.resolve', 'requests.respond', 'questions.respond', 'elicitations.respond'].includes(operation)) {
      payload = { ...payload, requestGeneration: this.requests.get(String(payload?.requestId)) };
    }
    try {
      const response = await requestJson(this.instance.endpoint, 'call', { token: this.instance.token, body: { operation, payload, id: crypto.randomUUID(), issuedAt: Date.now(), instanceId: this.instanceId } });
      if (operation === 'tasks.interventions') for (const request of response.result?.requests ?? []) this.requests.set(String(request.id), request.requestGeneration);
      return response.result;
    } catch (error) {
      // Never retry commands: a lost response can mean the operation already ran.
      if (error.status === 401 || error.status === 409) { this.online = false; this.onState({ state: 'unauthorized', error: error.message }); }
      if (!error.status) throw new Error('The connection was lost. This action may have reached the host; check its current state before sending again.');
      throw error;
    }
  }
  async poll() {
    let failures = 0;
    while (!this.closed) {
      this.abort = new AbortController();
      const timeout = setTimeout(() => this.abort?.abort(), 30_000);
      try {
        const batch = await requestJson(this.instance.endpoint, `poll?cursor=${this.cursor}&instanceId=${encodeURIComponent(this.eventInstance)}${failures ? "&wait=0" : ""}`, { token: this.instance.token, signal: this.abort.signal });
        clearTimeout(timeout);
        if (this.closed) return;
        this.online = true;
        let resynced = false;
        for (const event of batch.events) {
          if (event.protocol !== PROTOCOL_VERSION) throw new Error('The host protocol changed. Update Pixice.');
          if (event.type === 'ConnectReset') {
            const wasConnected = this.hasSnapshot;
            this.hasSnapshot = true;
            this.online = true;
            this.instanceId = event.instanceId;
            this.eventInstance = event.instanceId;
            this.cursor = event.sequence;
            this.attention.clear();
            this.requests.clear();
            for (const payload of event.payload.attention) { this.attention.set(String(payload.id), payload); this.requests.set(String(payload.id), payload.requestGeneration); }
            if (wasConnected) { resynced = true; this.onReset(); this.emit({ type: 'ApplicationResync', payload: { reason: event.payload.reason || 'snapshot' } }); }
            this.emit({ type: 'AttentionReset', payload: {} });
            for (const payload of this.attention.values()) this.emit({ type: 'AttentionRequired', payload });
            continue;
          }
          // A missing event needs a snapshot, not a network reconnect.
          if (event.sequence !== this.cursor + 1) { this.eventInstance = ''; break; }
          this.cursor = event.sequence;
          if (event.type === 'AttentionRequired') { this.requests.set(String(event.payload.id), event.payload.requestGeneration); this.attention.set(String(event.payload.id), event.payload); }
          if (event.type === 'AttentionResolved') { this.requests.delete(String(event.payload.requestId)); this.attention.delete(String(event.payload.requestId)); }
          if (event.type === 'AttentionReset') { this.requests.clear(); this.attention.clear(); }
          this.emit(event);
        }
        this.online = true;
        this.onState({ state: 'connected' });
        if (failures && !resynced && this.hasSnapshot && this.eventInstance) this.emit({ type: 'ApplicationResync', payload: { reason: 'reconnected' } });
        failures = 0;
      } catch (error) {
        clearTimeout(timeout);
        if (this.closed) return;
        this.online = false;
        this.onState({ state: error.status === 401 ? 'unauthorized' : 'reconnecting', error: error.status ? error.message : 'Connection lost. Reconnecting…',
          diagnostic: error.cause?.code || error.code || error.name, status: error.status });
        if (this.resolveInstance) {
          try {
            const next = await this.resolveInstance();
            const info = await requestJson(next.endpoint, 'info');
            if (info.hostId !== next.id || info.protocol !== PROTOCOL_VERSION) throw new Error('The local service identity or protocol changed.');
            this.instance = { ...next, endpoint: normalizeEndpoint(next.endpoint) };
            this.instanceId = info.instanceId;
            // A transport interruption does not invalidate the replay cursor.
            // The server decides whether a snapshot is needed after a real restart
            // or a gap in retained events.
            if (info.instanceId !== this.eventInstance) { this.eventInstance = ''; this.cursor = 0; }
          } catch { /* Keep reconnecting; never replay an application command. */ }
        } else if (error.status === 401) return;
        await new Promise((resolve) => { this.wake = resolve; this.retry = setTimeout(resolve, Math.min(15_000, 1000 * 2 ** failures++) + Math.random() * 250); });
      }
    }
  }
  close() { this.closed = true; this.online = false; this.abort?.abort(); clearTimeout(this.retry); this.wake?.(); this.listeners.clear(); }
}
