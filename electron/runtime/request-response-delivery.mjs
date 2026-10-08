import { createHmac, randomBytes } from "node:crypto";

const requestKey = id => `${typeof id}:${id}`;
const ownerKey = request => `${request.provider ?? "codex"}\0${requestKey(request.id)}`;

// T3 V2 RuntimeRequestService/ProviderRuntimeRecoveryService are the reference:
// writing a response is distinct from the provider resolving its live callback.
// Persist identity and delivery state only; never persist user answers or secrets.
export class RequestResponseDelivery {
  constructor({ database, respond, onState = () => {}, onResolved = () => {}, timeoutMs = 8_000 }) {
    this.db = database.db;
    this.respond = respond;
    this.onState = onState;
    this.onResolved = onResolved;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.responseKey = randomBytes(32);
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_request_deliveries (
      generation INTEGER PRIMARY KEY, request_key TEXT NOT NULL, provider TEXT NOT NULL,
      thread_id TEXT, turn_id TEXT, state TEXT NOT NULL, response_hash TEXT,
      error TEXT, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS runtime_request_delivery_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO runtime_request_delivery_meta VALUES(1,0);`);
    this.db.prepare("UPDATE runtime_request_deliveries SET state='unavailable',error=?,updated_at=? WHERE state IN ('pending','responding','uncertain')")
      .run("The provider callback did not survive the backend restart.", new Date().toISOString());
    this.db.prepare("DELETE FROM runtime_request_deliveries WHERE generation NOT IN (SELECT generation FROM runtime_request_deliveries ORDER BY generation DESC LIMIT 1024)").run();
  }

  nextGeneration() {
    return Number(this.db.prepare("UPDATE runtime_request_delivery_meta SET generation=generation+1 WHERE id=1 RETURNING generation").get().generation);
  }

  register(pending) {
    const { request, generation } = pending;
    const key = ownerKey(request);
    const previous = this.pending.get(key);
    if (previous?.pending.generation === generation) return;
    if (previous) {
      clearTimeout(previous.timer);
      this.#update(previous, "unavailable", "The provider replaced this callback.");
      previous.response?.reject(new Error("The provider replaced this callback."));
    }
    this.db.prepare("INSERT INTO runtime_request_deliveries VALUES(?,?,?,?,?,'pending',NULL,NULL,?)")
      .run(generation, requestKey(request.id), request.provider ?? "codex", request.params?.threadId ?? null, request.params?.turnId ?? null, new Date().toISOString());
    this.pending.set(key, { pending, response: null, timer: null });
  }

  state(generation) {
    return this.db.prepare("SELECT * FROM runtime_request_deliveries WHERE generation=?").get(generation) ?? null;
  }

  #update(entry, state, error = null) {
    this.db.prepare("UPDATE runtime_request_deliveries SET state=?,error=?,updated_at=? WHERE generation=?")
      .run(state, error, new Date().toISOString(), entry.pending.generation);
    entry.pending.responseState = state;
    entry.pending.responseError = error;
    this.onState(entry.pending);
  }

  send(pending, result) {
    const key = ownerKey(pending.request);
    const entry = this.pending.get(key);
    if (!entry || entry.pending.generation !== pending.generation) return Promise.reject(new Error("This provider request is no longer current."));
    const hash = createHmac("sha256", this.responseKey).update(JSON.stringify(result)).digest("hex");
    const stored = this.state(pending.generation);
    if (stored.response_hash && stored.response_hash !== hash && ["responding", "uncertain"].includes(stored.state)) {
      return Promise.reject(new Error("The previous response is awaiting provider confirmation. Its answer cannot be changed yet."));
    }
    if (entry.response) return entry.response.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.response = { promise, resolve, reject };
    this.db.prepare("UPDATE runtime_request_deliveries SET response_hash=? WHERE generation=?").run(hash, pending.generation);
    this.#update(entry, "responding");
    entry.timer = setTimeout(() => {
      if (!entry.response) return;
      const response = entry.response;
      entry.response = null;
      entry.timer = null;
      const message = "The response was sent, but the provider has not confirmed it. The request remains visible; retry the same answer or refresh its state.";
      this.#update(entry, "uncertain", message);
      response.reject(Object.assign(new Error(message), { uncertain: true }));
    }, this.timeoutMs);
    Promise.resolve().then(() => this.respond(pending.request.id, result, {
      provider: pending.request.provider ?? "codex", requestGeneration: pending.generation,
      generation: pending.request.providerRequestGeneration
    })).then(ack => {
      // Claude owns a local SDK callback and can positively confirm it here.
      // Codex transport acknowledgement alone must await serverRequest/resolved.
      if (ack?.resolved === true && this.pending.get(key) === entry) {
        this.confirm(pending.request.id, { provider: pending.request.provider, generation: pending.generation });
      }
    }).catch(error => {
      if (this.pending.get(key) !== entry || !entry.response) return;
      clearTimeout(entry.timer);
      entry.timer = null;
      const response = entry.response;
      entry.response = null;
      const unavailable = error.requestClosed === true;
      this.#update(entry, unavailable ? "unavailable" : "uncertain", error.message);
      if (unavailable) {
        this.pending.delete(key);
        this.onResolved(entry.pending);
      }
      response.reject(Object.assign(error, { uncertain: true }));
    });
    return promise;
  }

  confirm(id, { provider, threadId, turnId, generation, providerRequestGeneration } = {}) {
    const matches = [...this.pending.entries()].filter(([, entry]) => requestKey(entry.pending.request.id) === requestKey(id) &&
      (!provider || (entry.pending.request.provider ?? "codex") === provider));
    if (matches.length !== 1) return false;
    const [key, entry] = matches[0];
    if (threadId && entry.pending.request.params?.threadId !== threadId ||
      turnId && entry.pending.request.params?.turnId !== turnId ||
      generation != null && entry.pending.generation !== generation ||
      providerRequestGeneration != null && entry.pending.request.providerRequestGeneration !== providerRequestGeneration) return false;
    clearTimeout(entry.timer);
    this.#update(entry, "resolved");
    this.pending.delete(key);
    entry.response?.resolve({ ok: true, resolved: true, requestGeneration: entry.pending.generation });
    this.onResolved(entry.pending);
    return true;
  }

  terminal(threadId, turnId) {
    for (const entry of [...this.pending.values()]) {
      const params = entry.pending.request.params ?? {};
      if (params.threadId !== threadId || !turnId || params.turnId !== turnId) continue;
      // Terminal proves that the callback closed, not that an answer crossing
      // the transport boundary was accepted. Never manufacture a success ACK.
      clearTimeout(entry.timer);
      const reason = "The exact requesting turn ended before provider confirmation; this callback is no longer available.";
      this.#update(entry, "unavailable", reason);
      this.pending.delete(ownerKey(entry.pending.request));
      entry.response?.reject(Object.assign(new Error(reason), { uncertain: true, requestClosed: true }));
      this.onResolved(entry.pending);
    }
  }

  unavailable(provider, reason = "The provider restarted before confirming the response.") {
    for (const [key, entry] of this.pending) {
      if (provider && (entry.pending.request.provider ?? "codex") !== provider) continue;
      clearTimeout(entry.timer);
      this.#update(entry, "unavailable", reason);
      entry.response?.reject(Object.assign(new Error(reason), { uncertain: true }));
      this.pending.delete(key);
    }
  }

  dispose() { this.unavailable(null, "The Pixice backend stopped before provider confirmation."); }
}
