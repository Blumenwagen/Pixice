import { randomUUID } from "node:crypto";

export const IOS_SESSION_STATUSES = new Set([
  "preparing",
  "booting",
  "building",
  "installing",
  "launching",
  "streaming",
  "ready",
  "stopping",
  "stopped",
  "failed"
]);

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function publicSession(record) {
  if (!record) return null;
  const { abortController: _abortController, cleanups: _cleanups, ...session } = record;
  return structuredClone(session);
}

export class IosSessionRegistry {
  #sessions = new Map();
  #simulatorOwners = new Map();
  #stopping = new Map();
  #id;
  #now;

  constructor({ id = randomUUID, now = () => new Date().toISOString() } = {}) {
    this.#id = id;
    this.#now = now;
  }

  claim({ workspaceId, projectId, simulatorUdid, source = "user" }) {
    const ownerId = requiredString(workspaceId, "Preview workspace");
    const project = requiredString(projectId, "Project");
    const udid = requiredString(simulatorUdid, "Simulator UDID");
    if (this.#sessions.has(ownerId) || this.#stopping.has(ownerId)) {
      throw new Error("Preview workspace already owns an iOS session");
    }
    const existingOwner = this.#simulatorOwners.get(udid);
    if (existingOwner && existingOwner !== ownerId) {
      throw new Error(`Simulator ${udid} is already owned by Preview workspace ${existingOwner}`);
    }

    const timestamp = this.#now();
    const record = {
      id: this.#id(),
      workspaceId: ownerId,
      projectId: project,
      simulatorUdid: udid,
      source,
      status: "preparing",
      scheme: null,
      previewUrl: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      abortController: new AbortController(),
      cleanups: []
    };
    this.#sessions.set(ownerId, record);
    this.#simulatorOwners.set(udid, ownerId);
    return publicSession(record);
  }

  snapshot(workspaceId) {
    return publicSession(this.#sessions.get(workspaceId));
  }

  list() {
    return [...this.#sessions.values()].map(publicSession);
  }

  signal(workspaceId) {
    const record = this.#sessions.get(workspaceId);
    if (!record) throw new Error("iOS session not found");
    return record.abortController.signal;
  }

  update(workspaceId, patch = {}) {
    const record = this.#sessions.get(workspaceId);
    if (!record) throw new Error("iOS session not found");
    if (patch.workspaceId || patch.projectId || patch.simulatorUdid || patch.id) {
      throw new Error("iOS session identity cannot be changed");
    }
    if (patch.status && !IOS_SESSION_STATUSES.has(patch.status)) {
      throw new Error(`Unknown iOS session status: ${patch.status}`);
    }
    Object.assign(record, patch, { updatedAt: this.#now() });
    return publicSession(record);
  }

  addCleanup(workspaceId, cleanup) {
    const record = this.#sessions.get(workspaceId);
    if (!record) throw new Error("iOS session not found");
    if (typeof cleanup !== "function") throw new Error("iOS session cleanup must be a function");
    record.cleanups.push(cleanup);
  }

  adopt(fromWorkspaceId, toWorkspaceId) {
    const sourceId = requiredString(fromWorkspaceId, "Source Preview workspace");
    const targetId = requiredString(toWorkspaceId, "Target Preview workspace");
    if (sourceId === targetId) return this.snapshot(targetId);
    if (this.#stopping.has(sourceId)) throw new Error("Cannot adopt an iOS session while it is stopping");
    if (this.#sessions.has(targetId) || this.#stopping.has(targetId)) {
      throw new Error("Target Preview workspace already owns an iOS session");
    }
    const record = this.#sessions.get(sourceId);
    if (!record) return null;
    this.#sessions.delete(sourceId);
    record.workspaceId = targetId;
    record.updatedAt = this.#now();
    this.#sessions.set(targetId, record);
    this.#simulatorOwners.set(record.simulatorUdid, targetId);
    return publicSession(record);
  }

  stop(workspaceId, reason = "Session stopped") {
    if (this.#stopping.has(workspaceId)) return this.#stopping.get(workspaceId);
    const record = this.#sessions.get(workspaceId);
    if (!record) return Promise.resolve(null);

    const stopping = this.#stopRecord(record, reason)
      .finally(() => this.#stopping.delete(workspaceId));
    this.#stopping.set(workspaceId, stopping);
    return stopping;
  }

  async #stopRecord(record, reason) {
    record.status = "stopping";
    record.updatedAt = this.#now();
    record.abortController.abort(reason);
    const failures = [];
    for (const cleanup of [...record.cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(String(error?.message || error));
      }
    }

    this.#sessions.delete(record.workspaceId);
    if (this.#simulatorOwners.get(record.simulatorUdid) === record.workspaceId) {
      this.#simulatorOwners.delete(record.simulatorUdid);
    }
    record.status = failures.length ? "failed" : "stopped";
    record.error = failures.length ? failures.join("\n") : null;
    record.updatedAt = this.#now();
    return publicSession(record);
  }

  async destroy() {
    return Promise.all([...this.#sessions.keys()].map((workspaceId) => this.stop(workspaceId, "Pixice is shutting down")));
  }
}
