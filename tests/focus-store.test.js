import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { FocusStore } from "../electron/persistence/focus-store.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-focus-store-"));
  temporaryDirectories.push(directory);
  const database = new PixiceDatabase(directory);
  const timestamp = "2026-09-22T10:00:00.000Z";
  database.createProject({ id: "project-a", canonicalPath: "/workspace/a", displayName: "A", folders: ["/workspace/a"], createdAt: timestamp, updatedAt: timestamp });
  database.createProject({ id: "project-b", canonicalPath: "/workspace/b", displayName: "B", folders: ["/workspace/b"], createdAt: timestamp, updatedAt: timestamp });
  return { directory, database, store: new FocusStore(database) };
}

describe("FocusStore", () => {
  it("persists policy and work across a reopened Pixice database", () => {
    const { directory, database, store } = fixture();
    expect(store.getPolicy("project-a")).toEqual({ coordinatorModel: null, workerModel: null, reviewModel: null, maxWorkers: 2, permissionMode: "workspace-write", executionHost: "current" });
    expect(store.updatePolicy("project-a", { workerModel: "gpt-5.6-luna", maxWorkers: 3 })).toMatchObject({ workerModel: "gpt-5.6-luna", maxWorkers: 3 });
    const created = store.createWork("project-a", { title: "Inspect persistence", prompt: "Keep the coordinator durable.", coordinatorThreadId: "focus-thread" });
    expect(created).toMatchObject({ projectId: "project-a", model: "gpt-5.6-luna", status: "queued", access: "write", revision: 1 });
    database.db.close();

    const reopenedDatabase = new PixiceDatabase(directory);
    const reopened = new FocusStore(reopenedDatabase);
    expect(reopened.getPolicy("project-a").maxWorkers).toBe(3);
    expect(reopened.getWork("project-a", created.id)).toMatchObject({ title: "Inspect persistence", coordinatorThreadId: "focus-thread" });
    reopenedDatabase.db.close();
  });

  it("validates policy and work boundaries, including project-scoped dependencies", () => {
    const { database, store } = fixture();
    expect(() => store.updatePolicy("project-a", { maxWorkers: 9 })).toThrow(/1 to 8/);
    expect(() => store.updatePolicy("project-a", { executionHost: "remote" })).toThrow(/current/);
    expect(() => store.createWork("project-a", { title: "Unsafe", permissionMode: "root" })).toThrow(/permissionMode/);
    expect(() => store.createWork("project-a", { title: "Unknown", owner: "agent" })).toThrow(/Unknown work field/);
    expect(() => store.createWork("project-a", { title: "Object resource", resources: [{ path: "src" }] })).toThrow(/resource must be a string/);
    const other = store.createWork("project-b", { title: "Other" });
    expect(() => store.createWork("project-a", { title: "Cross project", dependsOn: [other.id] })).toThrow(/outside this project/);
    const first = store.createWork("project-a", { title: "First" });
    const second = store.createWork("project-a", { title: "Second", dependsOn: [first.id] });
    expect(() => store.updateWork("project-a", first.id, { dependsOn: [second.id] })).toThrow(/cycle/);
    expect(store.getWork("project-a", first.id)).toMatchObject({ dependsOn: [], revision: 1 });
    expect(store.getWork("project-b", first.id)).toBeNull();
    database.db.close();
  });

  it("increments work revision atomically and recovers unfinished or unreported work", () => {
    const { database, store } = fixture();
    const work = store.createWork("project-a", { title: "Run worker", resources: ["src/app.jsx"] });
    const saved = store.updateWork("project-a", work.id, { status: "review", answer: "done", threadId: "worker-thread" });
    expect(saved).toMatchObject({ revision: 2, status: "review", resources: ["src/app.jsx"] });
    expect(store.getWorkByThread("worker-thread")?.id).toBe(work.id);
    expect(store.listRecoverableWork().map((item) => item.id)).toContain(work.id);
    store.updateWork("project-a", work.id, { status: "done", completionReported: true, artifacts: [{ kind: "diff", path: "src/app.jsx" }] });
    expect(store.listRecoverableWork().map((item) => item.id)).not.toContain(work.id);
    database.db.close();
  });

  it("orders events, tracks delivery and persists monotonic seen state", () => {
    const { database, store } = fixture();
    const work = store.createWork("project-a", { title: "Observe" });
    const first = store.appendEvent("project-a", { workId: work.id, kind: "started", message: "Worker started", sourceThreadId: "focus" });
    const second = store.appendEvent("project-a", { workId: work.id, kind: "completed", message: "Worker completed" });
    expect(store.listEvents("project-a", { after: first.sequence })).toEqual([expect.objectContaining({ id: second.id, sequence: second.sequence })]);
    expect(store.pendingEvents("project-a")).toHaveLength(2);
    expect(store.markEventsDelivered("project-a", [first.id])).toBe(1);
    expect(store.pendingEvents("project-a")).toEqual([expect.objectContaining({ id: second.id })]);
    expect(store.markSeen("project-a", second.sequence)).toBe(second.sequence);
    expect(store.markSeen("project-a", first.sequence)).toBe(second.sequence);
    expect(store.getSeen("project-a")).toBe(second.sequence);
    database.db.close();
  });

  it("keeps decisions scoped, revisioned and durable", () => {
    const { database, store } = fixture();
    const own = store.createWork("project-a", { title: "Own" });
    const foreign = store.createWork("project-b", { title: "Foreign" });
    expect(() => store.recordDecision("project-a", { text: "Never route remotely.", workIds: [foreign.id] })).toThrow(/another project/);
    const one = store.recordDecision("project-a", { text: "Use a current host.", workIds: [own.id], sourceThreadId: "focus-thread" });
    const two = store.recordDecision("project-a", { text: "Review workers before handoff." });
    expect([one.revision, two.revision]).toEqual([1, 2]);
    expect(store.listDecisions("project-a").map((item) => item.revision)).toEqual([2, 1]);
    expect(store.latestDecisionRevision("project-a")).toBe(2);
    database.db.close();
  });

  it("filters work decision history before limiting so older relevant directions remain available", () => {
    const { database, store } = fixture();
    const target = store.createWork("project-a", { title: "Target" });
    const unrelated = store.createWork("project-a", { title: "Unrelated" });
    const scoped = store.recordDecision("project-a", { text: "Use the approved migration.", workIds: [target.id] });
    const global = store.recordDecision("project-a", { text: "Keep the current host.", workIds: [] });
    for (let index = 0; index < 101; index += 1) {
      store.recordDecision("project-a", { text: `Unrelated direction ${index}`, workIds: [unrelated.id] });
    }

    const decisions = store.listDecisions("project-a", { workId: target.id, limit: 20 });
    expect(decisions.map((decision) => decision.id)).toEqual([global.id, scoped.id]);
    expect(decisions.map((decision) => decision.text)).not.toContain("Unrelated direction 100");
    database.db.close();
  });
});
