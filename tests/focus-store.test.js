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
    expect(store.getPolicy("project-a")).toEqual({ coordinatorModel: null, workerModel: null, reviewModel: null, permissionMode: "full-access", executionHost: "current" });
    expect(store.updatePolicy("project-a", { workerModel: "gpt-5.6-luna" })).toMatchObject({ workerModel: "gpt-5.6-luna" });
    const created = store.createWork("project-a", { title: "Inspect persistence", prompt: "Keep the coordinator durable.", coordinatorThreadId: "focus-thread" });
    expect(created).toMatchObject({ projectId: "project-a", model: "gpt-5.6-luna", status: "queued", access: "write", revision: 1 });
    database.db.close();

    const reopenedDatabase = new PixiceDatabase(directory);
    const reopened = new FocusStore(reopenedDatabase);
    expect(reopened.getPolicy("project-a")).toMatchObject({ workerModel: "gpt-5.6-luna" });
    expect(reopened.getPolicy("project-a")).not.toHaveProperty("maxWorkers");
    expect(reopened.getWork("project-a", created.id)).toMatchObject({ title: "Inspect persistence", coordinatorThreadId: "focus-thread" });
    reopenedDatabase.db.close();
  });

  it("persists bounded visual metadata without image bytes", () => {
    const { database, store } = fixture();
    const visual = { path: "/private/frame.png", mimeType: "image/png", bytes: 68, source: "local file frame.png", label: "Frame at 00:02" };
    const work = store.createWork("project-a", { title: "Inspect frame", visuals: [visual] });
    expect(store.getWork("project-a", work.id).visuals).toEqual([visual]);
    expect(JSON.stringify(store.listWork("project-a"))).not.toContain("base64");
    expect(() => store.updateWork("project-a", work.id, { visuals: [{ ...visual, path: `data:image/png;base64,${"A".repeat(3000)}` }] })).toThrow(/visual path exceeds/);
    database.db.close();
  });

  it("preserves legacy worker counts without exposing them as policy", () => {
    const { directory, database, store } = fixture();
    store.updatePolicy("project-a", { workerModel: "gpt-5.6-luna" });
    database.db.prepare("UPDATE focus_policies SET max_workers = 1 WHERE project_id = ?").run("project-a");
    database.db.close();

    const reopenedDatabase = new PixiceDatabase(directory);
    const reopened = new FocusStore(reopenedDatabase);
    expect(reopened.getPolicy("project-a")).not.toHaveProperty("maxWorkers");
    expect(reopened.updatePolicy("project-a", { reviewModel: "review-model" })).not.toHaveProperty("maxWorkers");
    expect(reopenedDatabase.db.prepare("SELECT max_workers FROM focus_policies WHERE project_id = ?").get("project-a").max_workers).toBe(1);
    reopenedDatabase.db.close();
  });

  it("validates policy and work boundaries, including project-scoped dependencies", () => {
    const { database, store } = fixture();
    expect(() => store.updatePolicy("project-a", { maxWorkers: 1 })).toThrow(/Unknown policy field: maxWorkers/);
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

  it("normalizes legacy policies and nonterminal work on startup while preserving terminal audit records", () => {
    const { directory, database, store } = fixture();
    const active = store.createWork("project-a", { title: "Queued legacy worker" });
    const terminal = store.createWork("project-a", { title: "Completed legacy worker", status: "done" });
    database.db.prepare("INSERT INTO focus_policies (project_id, max_workers, permission_mode, execution_host, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project-a", 2, "read-only", "current", "2026-09-22T10:00:00.000Z");
    database.db.prepare("UPDATE focus_work SET permission_mode = ? WHERE id IN (?, ?)")
      .run("workspace-write", active.id, terminal.id);
    database.db.close();

    const reopenedDatabase = new PixiceDatabase(directory);
    const reopened = new FocusStore(reopenedDatabase);
    expect(reopened.getPolicy("project-a").permissionMode).toBe("full-access");
    expect(reopened.getWork("project-a", active.id)?.permissionMode).toBe("full-access");
    expect(reopened.getWork("project-a", terminal.id)?.permissionMode).toBe("workspace-write");
    reopenedDatabase.db.close();
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
