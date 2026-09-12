import { CONNECT_ERROR_CODES, CONNECT_LIMITS, CONNECT_RECOVERY_EVENTS, CONNECT_RECOVERY_LIMITS, PROTOCOL_VERSION, READ_OPERATIONS, normalizeEndpoint } from './protocol.mjs';

const encodedBytes = (value) => new TextEncoder().encode(value).byteLength;
const boundedIdentifier = (value) => {
  if (typeof value !== 'string') return undefined;
  const identifier = value.trim().slice(0, CONNECT_RECOVERY_LIMITS.maxIdentifierLength);
  return identifier || undefined;
};
const isMutation = (operation) => !READ_OPERATIONS.has(operation);
const recoveryDescriptor = (descriptor, payload, uncertain = true) => ({
  operation: descriptor.operation,
  commandId: descriptor.id,
  issuedAt: descriptor.issuedAt,
  backendInstanceId: descriptor.instanceId || null,
  ...(boundedIdentifier(payload?.projectId) ? { projectId: boundedIdentifier(payload.projectId) } : {}),
  ...(boundedIdentifier(payload?.threadId) ? { threadId: boundedIdentifier(payload.threadId) } : {}),
  uncertain
});

function abortableFetch(url, options) {
  const signal = options?.signal;
  if (!signal) return fetch(url, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(fetch(url, options)).then(
      (response) => finish(resolve, response),
      (error) => finish(reject, error)
    );
  });
}

export async function requestJson(endpoint, route, { token, body, signal, mutation = body !== undefined, onDispatch } = {}) {
  let encodedBody;
  if (body !== undefined) {
    try { encodedBody = JSON.stringify(body); }
    catch (error) { throw Object.assign(new Error('The request body could not be encoded as JSON.'), { code: CONNECT_ERROR_CODES.INVALID_REQUEST, cause: error, uncertain: false }); }
    const bodyBytes = encodedBytes(encodedBody);
    if (bodyBytes > CONNECT_LIMITS.maxBodyBytes) {
      throw Object.assign(new Error(`The encoded request body is ${Math.ceil(bodyBytes / 1024 / 1024)} MiB, above the ${CONNECT_LIMITS.maxBodyBytes / 1024 / 1024} MiB maximum total.`), {
        code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE,
        bodyBytes,
        maxBodyBytes: CONNECT_LIMITS.maxBodyBytes,
        uncertain: false
      });
    }
  }
  let response;
  try {
    await onDispatch?.();
    response = await abortableFetch(`${endpoint}/api/connect/${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: encodedBody } : {}), signal: signal ?? AbortSignal.timeout(120_000)
    });
  } catch (error) {
    throw Object.assign(new Error('The connection could not be completed.'), {
      code: error?.name === 'AbortError' ? CONNECT_ERROR_CODES.REQUEST_ABORTED : CONNECT_ERROR_CODES.NETWORK_ERROR,
      cause: error,
      uncertain: Boolean(mutation)
    });
  }
  let result;
  try { result = await response.json(); } catch (error) {
    throw Object.assign(new Error('This address did not return a Pixice response. Check the endpoint and HTTPS proxy.'), {
      code: CONNECT_ERROR_CODES.INVALID_RESPONSE, status: response.status, cause: error, uncertain: Boolean(mutation)
    });
  }
  if (!response.ok) throw Object.assign(new Error(result?.error || `Connection failed (${response.status})`), {
    status: response.status,
    code: result?.code || `HTTP_${response.status}`,
    uncertain: Boolean(mutation) && (response.status >= 500 || result?.code === CONNECT_ERROR_CODES.OUTCOME_UNAVAILABLE)
  });
  return result;
}
export class ApplicationClient {
  constructor(instance, { onState = () => {}, onReset = () => {}, onCommandUncertain = () => {}, onCommandIssued = () => {}, onCommandSettled = () => {}, probe = 'runtime.status', resolveInstance } = {}) {
    this.instance = { ...instance, endpoint: normalizeEndpoint(instance.endpoint) };
    this.onState = onState; this.onReset = onReset; this.onCommandUncertain = onCommandUncertain; this.onCommandIssued = onCommandIssued; this.onCommandSettled = onCommandSettled; this.probe = probe; this.resolveInstance = resolveInstance;
    this.listeners = new Set(); this.requests = new Map(); this.attention = new Map(); this.commands = new Map(); this.uncertainCommands = new Map(); this.capabilities = null;
    this.closed = false; this.online = false; this.cursor = 0; this.eventInstance = ''; this.hasSnapshot = false;
    this.attentionRevision = 0; this.interventionReadSequence = 0;
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
    await this.getCapabilities();
    this.online = true;
    try { await this.call(this.probe); } catch (error) { this.online = false; throw error; }
    if (this.closed) return;
    this.onState({ state: 'connected' });
    void this.poll();
  }
  async call(operation, payload) {
    const mutation = isMutation(operation);
    if (!this.online || this.closed) throw Object.assign(new Error('The instance is offline. Your action was not sent.'), { code: CONNECT_ERROR_CODES.OFFLINE, uncertain: false });
    if (['approvals.resolve', 'requests.respond', 'questions.respond', 'elicitations.respond'].includes(operation)) {
      const requestId = String(payload?.requestId);
      const currentGeneration = this.requests.get(requestId);
      const explicitGeneration = payload?.requestGeneration;
      if (explicitGeneration !== undefined && currentGeneration !== undefined && explicitGeneration !== currentGeneration) {
        throw Object.assign(new Error('This response is no longer current. Refresh the task.'), { code: CONNECT_ERROR_CODES.INVALID_REQUEST, uncertain: false });
      }
      payload = { ...payload, ...(explicitGeneration !== undefined ? { requestGeneration: explicitGeneration } : currentGeneration !== undefined ? { requestGeneration: currentGeneration } : {}) };
    }
    const descriptor = { id: crypto.randomUUID(), operation, issuedAt: Date.now(), instanceId: this.instanceId };
    const interventionRead = operation === 'tasks.interventions'
      ? { revision: this.attentionRevision, sequence: ++this.interventionReadSequence, instanceId: this.instanceId }
      : null;
    if (mutation) {
      this.commands.set(descriptor.id, descriptor);
      while (this.commands.size > CONNECT_RECOVERY_LIMITS.maxCommandDescriptors) this.commands.delete(this.commands.keys().next().value);
    }
    let dispatched = false;
    try {
      const response = await requestJson(this.instance.endpoint, 'call', {
        token: this.instance.token,
        mutation,
        body: { ...descriptor, payload },
        onDispatch: mutation ? () => { dispatched = true; return this.issueCommand(descriptor, payload); } : undefined
      });
      if (!response || typeof response !== 'object' || !Object.prototype.hasOwnProperty.call(response, 'result')) {
        throw Object.assign(new Error('The host returned an incomplete command response.'), {
          code: CONNECT_ERROR_CODES.INVALID_RESPONSE, status: 200, uncertain: mutation
        });
      }
      if (mutation) this.settleCommand(descriptor, 'completed', payload);
      if (operation === 'tasks.interventions' && !this.closed && interventionRead.instanceId === this.instanceId && interventionRead.revision === this.attentionRevision && interventionRead.sequence === this.interventionReadSequence) {
        for (const request of response.result?.requests ?? []) this.requests.set(String(request.id), request.requestGeneration);
      }
      return response.result;
    } catch (error) {
      // Never retry commands: a lost response can mean the operation already ran.
      if (error.status === 401) { this.online = false; this.onState({ state: 'unauthorized', error: error.message, code: error.code }); }
      else if (error.status === 409 && error.code === CONNECT_ERROR_CODES.HOST_RESTARTED) { this.online = false; this.onState({ state: 'reconnecting', error: error.message, code: error.code, resync: true }); }
      const uncertain = mutation && error.uncertain === true;
      const safeDescriptor = recoveryDescriptor(descriptor, payload, error.uncertain !== false);
      if (uncertain) {
        this.rememberUncertain(safeDescriptor);
        const uncertainError = Object.assign(new Error('The connection was lost. This action may have reached the host; check its current state before sending again.'), {
          code: error.code || CONNECT_ERROR_CODES.NETWORK_ERROR,
          status: error.status,
          cause: error,
          commandId: descriptor.id,
          command: safeDescriptor,
          uncertain: true
        });
        if (!uncertainError.status || uncertainError.status >= 500) {
          this.online = false;
          this.onState({ state: 'reconnecting', error: uncertainError.message, code: uncertainError.code, commandId: descriptor.id });
        }
        throw uncertainError;
      } else if (mutation && error.uncertain === false) {
        if (!dispatched) this.commands.delete(descriptor.id);
        if (dispatched) this.settleCommand(descriptor, error.status === 401 ? 'not-sent' : 'failed', payload);
        Object.assign(error, { commandId: descriptor.id, command: safeDescriptor, uncertain: false });
      }
      throw error;
    }
  }
  rememberUncertain(descriptor) {
    this.uncertainCommands.set(descriptor.commandId, { ...descriptor });
    while (this.uncertainCommands.size > CONNECT_RECOVERY_LIMITS.maxUncertainCommands) this.uncertainCommands.delete(this.uncertainCommands.keys().next().value);
    const event = { type: CONNECT_RECOVERY_EVENTS.uncertain, payload: { ...descriptor } };
    this.emit(event);
    try { this.onCommandUncertain({ ...descriptor }); } catch (error) { console.error('Pixice uncertain-command listener failed:', error.message); }
    return descriptor;
  }
  settleCommand(descriptor, outcome, payload) {
    const value = { ...recoveryDescriptor(descriptor, payload, false) };
    delete value.uncertain;
    const event = { type: CONNECT_RECOVERY_EVENTS.settled, payload: { ...value, outcome } };
    this.emit(event);
    try { this.onCommandSettled({ ...value, outcome }); } catch (error) { console.error('Pixice settled-command listener failed:', error.message); }
    return event;
  }
  issueCommand(descriptor, payload) {
    const value = { ...recoveryDescriptor(descriptor, payload, false) };
    delete value.uncertain;
    const event = { type: CONNECT_RECOVERY_EVENTS.issued, payload: value };
    this.emit(event);
    try { this.onCommandIssued({ ...value }); } catch (error) { console.error('Pixice issued-command listener failed:', error.message); }
    return event;
  }
  listUncertainCommands() { return [...this.uncertainCommands.values()].map((descriptor) => ({ ...descriptor })); }
  resolveUncertainCommand(commandId) {
    const descriptor = this.uncertainCommands.get(String(commandId));
    if (!descriptor) return false;
    this.uncertainCommands.delete(String(commandId));
    this.emit({ type: CONNECT_RECOVERY_EVENTS.resolved, payload: { ...descriptor } });
    return true;
  }
  dismissUncertainCommand(commandId) { return this.resolveUncertainCommand(commandId); }
  async getCapabilities() {
    try {
      this.capabilities = await requestJson(this.instance.endpoint, 'session', { token: this.instance.token });
    } catch (error) {
      if (error.status === 404) { this.capabilities = null; return null; }
      throw error;
    }
    return this.capabilities;
  }
  async commandStatus(id, instanceId = this.instanceId) {
    const query = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return requestJson(this.instance.endpoint, `commands/${encodeURIComponent(id)}${query}`, { token: this.instance.token });
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
            this.attentionRevision += 1;
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
          if (event.type === 'AttentionRequired') { this.attentionRevision += 1; this.requests.set(String(event.payload.id), event.payload.requestGeneration); this.attention.set(String(event.payload.id), event.payload); }
          if (event.type === 'AttentionResolved') { this.attentionRevision += 1; this.requests.delete(String(event.payload.requestId)); this.attention.delete(String(event.payload.requestId)); }
          if (event.type === 'AttentionReset') { this.attentionRevision += 1; this.requests.clear(); this.attention.clear(); }
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
