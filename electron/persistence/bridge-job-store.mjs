import { createHash, randomUUID } from "node:crypto";

const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const stamp = () => new Date().toISOString();
export const bridgeStableId = (kind, value) => `${kind}:${createHash("sha256").update(value).digest("hex")}`;
const boundedLimit = (value) => Math.min(128, Math.max(1, Number(value) || 128));
const boundedPage = (rows, { limit = 128, afterId } = {}) => {
  const index = afterId ? rows.findIndex((row) => row.id === afterId) : -1;
  const page = rows.slice(index + 1, index + 1 + boundedLimit(limit));
  return page.length || !afterId ? page : rows.slice(0, boundedLimit(limit));
};

// Reference: T3 Orchestrator V2's command-derived task identity and durable
// completion mailbox. Provider calls are not SQL transactions: a dispatch cut
// without a response remains uncertain and is never automatically replayed.
class BridgeStoreMethods {
  accept(input) {
    const id = bridgeStableId("bridge-job", `${input.parentThreadId}\0${input.requestId}`);
    const fingerprint = bridgeStableId("bridge-input", JSON.stringify(input.identity));
    const existing = this.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("This bridge request id already belongs to a different task");
      return { job: existing, duplicate: true };
    }
    const now = stamp();
    const job = { ...input, id, fingerprint, status: "accepted", childThreadId: null, childTurnId: null,
      result: null, error: null, createdAt: now, updatedAt: now };
    this.writeJob(job);
    return { job, duplicate: false };
  }
  patch(id, patch) {
    const job = this.get(id);
    if (!job) throw new Error("Bridge task is unavailable");
    const next = { ...job, ...patch, updatedAt: stamp() };
    this.writeJob(next);
    return next;
  }
  complete(id, result) {
    return this.atomic(() => {
      const old = this.get(id);
      if (!old) throw new Error("Bridge task is unavailable");
      if (old.result) return old;
      const job = this.patch(id, { status: "completed", result, error: result.error ?? null });
      if (job.deliveryOwner !== "focus") {
        const deliveryId = bridgeStableId("bridge-delivery", id);
        this.writeDelivery({ id: deliveryId, jobId: id, state: "pending", targetTurnId: null,
          error: null, createdAt: stamp(), updatedAt: stamp() });
      }
      return job;
    });
  }
  setDelivery(id, patch) {
    const existing = this.getDelivery(id);
    if (!existing) throw new Error("Bridge completion delivery is unavailable");
    // A late callback must never regress explicit tool-result acknowledgement.
    if (existing.state === "acknowledged") return existing;
    const next = { ...existing, ...patch, updatedAt: stamp() };
    this.writeDelivery(next);
    return next;
  }
  claimDelivery(id) {
    return this.atomic(() => {
      const delivery = this.getDelivery(id);
      if (!delivery || delivery.state !== "pending") return null;
      return this.setDelivery(id, { state: "claimed", error: null });
    });
  }
  acknowledge(jobId) {
    const id = bridgeStableId("bridge-delivery", jobId);
    if (!this.getDelivery(id)) return false;
    this.setDelivery(id, { state: "acknowledged", error: null });
    return true;
  }
  getByChild(childThreadId) { return this.jobs().find((job) => job.childThreadId === childThreadId) ?? null; }
  listRecoverable(options) { return boundedPage(this.jobs().filter((job) => !["completed", "failed"].includes(job.status)), options); }
  listPendingCompletions(options) { return this.deliveries({ ...options, state: "pending" }); }
  listUncertainCompletions(options) { return this.deliveries({ ...options, state: "uncertain" }); }
  recoverClaims() {
    // Acceptance may have crossed the provider boundary before the process
    // died. Keep that ambiguity visible; do not start another paid parent turn.
    for (const delivery of this.deliveries({ state: "claimed", limit: 128 })) {
      this.setDelivery(delivery.id, { state: "uncertain", error: "Pixice restarted during completion delivery; provider acceptance is unknown." });
    }
  }
  newRequestId() { return randomUUID(); }
}

export class BridgeJobStore extends BridgeStoreMethods {
  constructor(database) {
    super();
    if (!database?.db?.prepare || !database?.db?.exec) throw new Error("BridgeJobStore requires a Pixice SQLite database");
    this.db = database.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS bridge_jobs (
      id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, child_thread_id TEXT,
      status TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bridge_jobs_child ON bridge_jobs(child_thread_id);
    CREATE TABLE IF NOT EXISTS bridge_completion_outbox (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, payload TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES bridge_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS bridge_completion_state ON bridge_completion_outbox(state);`);
  }
  atomic(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id) { const row = this.db.prepare("SELECT payload FROM bridge_jobs WHERE id = ?").get(id); return row ? JSON.parse(row.payload) : null; }
  jobs() { return this.db.prepare("SELECT payload FROM bridge_jobs ORDER BY rowid").all().map((row) => JSON.parse(row.payload)); }
  getByChild(childThreadId) { const row = this.db.prepare("SELECT payload FROM bridge_jobs WHERE child_thread_id = ?").get(childThreadId); return row ? JSON.parse(row.payload) : null; }
  #page(table, predicate, { limit = 128, afterId } = {}) {
    const cursor = afterId ? this.db.prepare(`SELECT rowid AS position FROM ${table} WHERE id = ?`).get(afterId)?.position ?? 0 : 0;
    const query = `SELECT payload FROM ${table} WHERE ${predicate} AND rowid > ? ORDER BY rowid LIMIT ?`;
    let rows = this.db.prepare(query).all(cursor, boundedLimit(limit));
    if (!rows.length && cursor) rows = this.db.prepare(query).all(0, boundedLimit(limit));
    return rows.map(row => JSON.parse(row.payload));
  }
  listRecoverable(options) { return this.#page("bridge_jobs", "status NOT IN ('completed','failed')", options); }
  writeJob(job) { this.db.prepare(`INSERT INTO bridge_jobs(id,parent_thread_id,child_thread_id,status,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET child_thread_id=excluded.child_thread_id,status=excluded.status,payload=excluded.payload`)
    .run(job.id, job.parentThreadId, job.childThreadId, job.status, JSON.stringify(job)); }
  getDelivery(id) { const row = this.db.prepare("SELECT payload FROM bridge_completion_outbox WHERE id = ?").get(id); return row ? JSON.parse(row.payload) : null; }
  deliveries({ state, ...options } = {}) {
    // State is an internal enum, never user input or an interpolated SQL value.
    const allowed = ["pending", "claimed", "delivered", "acknowledged", "uncertain"];
    if (state && !allowed.includes(state)) throw new Error("Unknown bridge delivery state");
    return this.#page("bridge_completion_outbox", state ? `state = '${state}'` : "1 = 1", options);
  }
  writeDelivery(delivery) { this.db.prepare(`INSERT INTO bridge_completion_outbox(id,job_id,state,payload) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload`)
    .run(delivery.id, delivery.jobId, delivery.state, JSON.stringify(delivery)); }
}

// Only explicit test injection may use memory; production never silently drops durability.
export class MemoryBridgeJobStore extends BridgeStoreMethods {
  constructor() { super(); this.jobRows = new Map(); this.deliveryRows = new Map(); }
  atomic(fn) { return fn(); }
  get(id) { return copy(this.jobRows.get(id) ?? null); }
  jobs() { return [...this.jobRows.values()].map(copy); }
  writeJob(job) { this.jobRows.set(job.id, copy(job)); }
  getDelivery(id) { return copy(this.deliveryRows.get(id) ?? null); }
  deliveries({ state, ...options } = {}) { return boundedPage([...this.deliveryRows.values()].filter(row => !state || row.state === state).map(copy), options); }
  writeDelivery(delivery) { this.deliveryRows.set(delivery.id, copy(delivery)); }
}
