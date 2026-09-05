import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("thread runtime persistence", () => {
  it("treats missing project ids as absent instead of binding invalid SQLite values", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    expect(database.getProject()).toBeNull();
    expect(database.getProject(null)).toBeNull();
    expect(database.getProject("  ")).toBeNull();
    expect(database.getProject({ id: "project-1" })).toBeNull();
    database.db.close();
  });

  it("round-trips project appearance and multiple folders", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = new Date().toISOString();

    const created = database.createProject({
      id: "project-studio",
      canonicalPath: "/workspace/studio",
      displayName: "Studio",
      icon: "code",
      color: "purple",
      folders: ["/workspace/studio", "/workspace/shared"],
      createdAt: now,
      updatedAt: now
    });

    expect(created).toMatchObject({
      id: "project-studio",
      canonicalPath: "/workspace/studio",
      displayName: "Studio",
      icon: "code",
      color: "purple",
      folders: ["/workspace/studio", "/workspace/shared"]
    });
    database.db.close();

    const reopened = new PixiceDatabase(directory);
    expect(reopened.listProjects()).toEqual([expect.objectContaining({
      id: "project-studio",
      canonicalPath: "/workspace/studio",
      displayName: "Studio",
      icon: "code",
      color: "purple",
      folders: ["/workspace/studio", "/workspace/shared"]
    })]);
    reopened.db.close();
  });

  it("orders projects by persisted recency after selection", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const olderAt = "2026-08-20T10:00:00.000Z";
    const recentAt = "2026-08-21T10:00:00.000Z";
    const selectedAt = "2026-08-22T10:00:00.000Z";

    database.createProject({
      id: "project-older",
      canonicalPath: "/workspace/older",
      displayName: "Older",
      icon: "folder",
      color: "blue",
      folders: ["/workspace/older"],
      lastUsedAt: olderAt,
      createdAt: olderAt,
      updatedAt: olderAt
    });
    database.createProject({
      id: "project-recent",
      canonicalPath: "/workspace/recent",
      displayName: "Recent",
      icon: "code",
      color: "green",
      folders: ["/workspace/recent"],
      lastUsedAt: recentAt,
      createdAt: recentAt,
      updatedAt: recentAt
    });

    expect(database.listProjects().map((project) => project.id)).toEqual(["project-recent", "project-older"]);
    expect(database.touchProject("project-older", selectedAt)).toMatchObject({
      id: "project-older",
      lastUsedAt: selectedAt
    });
    expect(database.listProjects().map((project) => project.id)).toEqual(["project-older", "project-recent"]);
    database.db.close();
  });

  it("deletes a project and its Pixice metadata without affecting other projects", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = new Date().toISOString();
    database.createProject({
      id: "project-delete",
      canonicalPath: "/workspace/delete",
      displayName: "Delete me",
      folders: ["/workspace/delete", "/workspace/shared"],
      createdAt: now,
      updatedAt: now
    });
    database.createProject({
      id: "project-keep",
      canonicalPath: "/workspace/keep",
      displayName: "Keep me",
      folders: ["/workspace/keep"],
      createdAt: now,
      updatedAt: now
    });
    database.createBoardTask({ id: "task-delete", projectId: "project-delete", title: "Project task", column: "backlog" });

    expect(database.deleteProject("project-delete")).toMatchObject({ id: "project-delete", folders: ["/workspace/delete", "/workspace/shared"] });
    expect(database.getProject("project-delete")).toBeNull();
    expect(database.listBoardTasks("project-delete")).toEqual([]);
    expect(database.listProjects().map((candidate) => candidate.id)).toEqual(["project-keep"]);
    database.db.close();
  });

  it("persists confirmed phases and exposes membership on Board tasks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = "2026-08-27T08:00:00.000Z";
    database.createProject({
      id: "project-phases",
      canonicalPath: "/workspace/phases",
      displayName: "Phases",
      folders: ["/workspace/phases"],
      createdAt: now,
      updatedAt: now
    });
    database.createBoardTask({
      id: "task-discovery",
      projectId: "project-phases",
      title: "Provider discovery",
      column: "done",
      schedule: { plannedStart: "2026-08-27T08:00:00.000Z", plannedEnd: "2026-08-27T10:00:00.000Z", timezone: "Europe/Zurich" }
    });
    database.createBoardTask({
      id: "task-build",
      projectId: "project-phases",
      title: "Provider implementation",
      column: "active",
      schedule: { plannedStart: "2026-08-28T07:00:00.000Z", plannedEnd: "2026-08-28T12:00:00.000Z", timezone: "Europe/Zurich" }
    });

    expect(database.createBoardPhase({
      id: "phase-provider",
      projectId: "project-phases",
      title: "Provider rollout",
      taskIds: ["task-discovery", "task-build"]
    })).toMatchObject({
      id: "phase-provider",
      title: "Provider rollout",
      taskIds: ["task-discovery", "task-build"],
      plannedStart: "2026-08-27T08:00:00.000Z",
      plannedEnd: "2026-08-28T12:00:00.000Z",
      completedCount: 1
    });
    expect(database.listBoardTasks("project-phases")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "task-discovery", phaseId: "phase-provider" }),
      expect.objectContaining({ id: "task-build", phaseId: "phase-provider" })
    ]));
    database.db.close();

    const reopened = new PixiceDatabase(directory);
    expect(reopened.listBoardPhases("project-phases")).toEqual([
      expect.objectContaining({ id: "phase-provider", title: "Provider rollout", taskIds: ["task-discovery", "task-build"] })
    ]);
    expect(() => reopened.createBoardPhase({ id: "phase-duplicate", projectId: "project-phases", title: "Duplicate", taskIds: ["task-discovery", "task-build"] })).toThrow("already belong to a phase");
    reopened.db.close();
  });

  it("migrates legacy projects to the structured project DTO", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const sqlite = new DatabaseSync(path.join(directory, "pixice.sqlite"));
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    sqlite.prepare(`
      INSERT INTO projects (id, canonical_path, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("legacy-project", "/workspace/legacy", "Legacy", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    sqlite.close();

    const database = new PixiceDatabase(directory);
    expect(database.getProject("legacy-project")).toMatchObject({
      id: "legacy-project",
      canonicalPath: "/workspace/legacy",
      displayName: "Legacy",
      icon: "folder",
      color: "blue",
      folders: ["/workspace/legacy"],
      lastUsedAt: "2026-01-01T00:00:00.000Z"
    });
    database.db.close();
  });

  it("restores and removes structured plan progress", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const plan = [{ step: "Audit runtime", status: "inProgress" }];

    database.saveThreadPlan("thread-1", plan);
    expect(database.getThreadPlan("thread-1")).toEqual(plan);

    database.deleteThreadRuntimeState("thread-1");
    expect(database.getThreadPlan("thread-1")).toBeNull();
    database.db.close();
  });

  it("persists turn timing across runtime snapshots", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    database.saveThreadTurnTiming({ threadId: "thread-1", turnId: "turn-1", startedAt: "2026-08-24T09:00:00.000Z" });
    database.saveThreadTurnTiming({ threadId: "thread-1", turnId: "turn-1", startedAt: "2026-08-24T09:00:01.000Z", completedAt: "2026-08-24T10:48:00.000Z" });
    expect(database.getThreadTurnTiming("thread-1", "turn-1")).toMatchObject({
      startedAt: "2026-08-24T09:00:00.000Z",
      completedAt: "2026-08-24T10:48:00.000Z"
    });

    database.deleteThreadTurnTimings("thread-1");
    expect(database.listThreadTurnTimings("thread-1")).toEqual([]);
    database.db.close();
  });

  it("persists generated thread names independently from Codex list metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    database.saveThreadName("thread-1", "Authentication session repair");
    expect(database.getThreadName("thread-1")).toBe("Authentication session repair");

    database.deleteThreadName("thread-1");
    expect(database.getThreadName("thread-1")).toBeNull();
    database.db.close();
  });

  it("persists, orders, and detaches project board tasks across app restarts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const now = new Date().toISOString();
    database.upsertProject({
      id: "project-1",
      canonicalPath: "/workspace",
      displayName: "Workspace",
      createdAt: now,
      updatedAt: now
    });

    database.createBoardTask({ id: "task-1", projectId: "project-1", title: "First", column: "backlog", threadId: "thread-1" });
    database.createBoardTask({ id: "task-2", projectId: "project-1", title: "Second", column: "backlog" });
    database.moveBoardTask("task-2", "backlog", "task-1");
    expect(database.listBoardTasks("project-1").map((task) => task.id)).toEqual(["task-2", "task-1"]);
    database.db.close();

    const reopened = new PixiceDatabase(directory);
    expect(reopened.getBoardTask("task-1")).toMatchObject({ title: "First", threadId: "thread-1", column: "backlog" });
    reopened.detachBoardTasksForThread("thread-1");
    expect(reopened.getBoardTask("task-1").threadId).toBeNull();
    reopened.deleteBoardTask("task-2");
    expect(reopened.listBoardTasks("project-1").map((task) => task.id)).toEqual(["task-1"]);
    reopened.db.close();
  });

  it("persists provider ownership, resume cursors, and canonical snapshots", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    database.saveThreadProviderBinding({
      threadId: "thread-claude",
      provider: "claude",
      providerThreadId: "session-1",
      resumeCursor: "session-1",
      cwd: "/workspace",
      forkedFromId: "thread-parent"
    });
    database.saveProviderThreadSnapshot("thread-claude", {
      id: "thread-claude",
      cwd: "/workspace",
      name: "Claude task",
      parentThreadId: null,
      forkedFromId: "thread-parent",
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-1", status: "inProgress", items: [{ id: "user", type: "userMessage" }] }]
    });

    expect(database.getThreadProviderBinding("thread-claude")).toMatchObject({
      provider: "claude",
      providerThreadId: "session-1",
      resumeCursor: "session-1",
      cwd: "/workspace",
      forkedFromId: "thread-parent"
    });
    expect(database.listThreadProviderBindings({ provider: "claude" })).toHaveLength(1);
    expect(database.listProviderThreadSummaries({ provider: "claude", cwd: "/workspace" })).toEqual([
      expect.objectContaining({ id: "thread-claude", name: "Claude task", parentThreadId: null, forkedFromId: "thread-parent", status: { type: "active", activeFlags: [] } })
    ]);
    expect(database.listProviderThreadSummaries({ provider: "claude" })[0]).not.toHaveProperty("turns");

    database.saveProviderActiveTurn("thread-claude", {
      id: "turn-1",
      status: "inProgress",
      items: [{ id: "user", type: "userMessage" }, { id: "answer", type: "agentMessage", text: "Recovered output" }]
    });
    expect(database.getProviderThreadSnapshot("thread-claude")).toMatchObject({ parentThreadId: null, forkedFromId: "thread-parent" });
    expect(database.getProviderThreadSnapshot("thread-claude").turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "answer", text: "Recovered output" })
    ]));

    database.saveProviderThreadSnapshot("thread-claude", {
      id: "thread-claude",
      cwd: "/workspace",
      name: "Claude task",
      status: { type: "idle" },
      turns: [{ id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Final output" }] }]
    });
    expect(database.getProviderThreadSnapshot("thread-claude").turns[0]).toMatchObject({ status: "completed" });
    expect(database.getProviderThreadSummary("thread-claude")).toMatchObject({ completionRevision: "turn:turn-1" });

    database.deleteThreadProviderBinding("thread-claude");
    expect(database.getThreadProviderBinding("thread-claude")).toBeNull();
    expect(database.getProviderThreadSnapshot("thread-claude")).toBeNull();
    database.db.close();
  });

  it("orders active snapshots and checkpoints even when the system clock does not advance", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-active-checkpoint-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    try {
      database.saveThreadProviderBinding({
        threadId: "thread-active",
        provider: "claude",
        providerThreadId: "session-active",
        cwd: "/workspace"
      });
      const activeSnapshot = {
        id: "thread-active",
        cwd: "/workspace",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-active", status: "inProgress", items: [{ id: "user", type: "userMessage" }] }]
      };
      database.saveProviderThreadSnapshot("thread-active", activeSnapshot);
      database.saveProviderActiveTurn("thread-active", {
        id: "turn-active",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage" }, { id: "answer", type: "agentMessage", text: "Checkpoint output" }]
      });
      expect(database.getProviderThreadSnapshot("thread-active")).toMatchObject({
        status: { type: "active" },
        turns: [{ id: "turn-active", items: expect.arrayContaining([expect.objectContaining({ id: "answer", text: "Checkpoint output" })]) }]
      });

      database.saveProviderThreadSnapshot("thread-active", {
        ...activeSnapshot,
        turns: [{
          id: "turn-active",
          status: "inProgress",
          items: [{ id: "user", type: "userMessage" }, { id: "answer", type: "agentMessage", text: "Newer snapshot output" }]
        }]
      });
      expect(database.getProviderThreadSnapshot("thread-active").turns[0].items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "answer", text: "Newer snapshot output" })
      ]));
      expect(database.getProviderThreadSnapshot("thread-active").turns[0].items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "answer", text: "Checkpoint output" })
      ]));

      database.saveProviderActiveTurn("thread-active", {
        id: "turn-active",
        status: "inProgress",
        items: [{ id: "user", type: "userMessage" }, { id: "answer", type: "agentMessage", text: "Newest checkpoint output" }]
      });
      expect(database.getProviderThreadSnapshot("thread-active").turns[0].items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "answer", text: "Newest checkpoint output" })
      ]));

      database.saveProviderThreadSnapshot("thread-active", {
        ...activeSnapshot,
        status: { type: "idle" },
        turns: [{ id: "turn-active", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Final output" }] }]
      });
      expect(database.getProviderThreadSnapshot("thread-active").turns[0]).toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
      database.db.close();
    }
  });

  it("adds durable fork ancestry to provider bindings created by older builds", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-fork-migration-"));
    temporaryDirectories.push(directory);
    const legacy = new DatabaseSync(path.join(directory, "pixice.sqlite"));
    legacy.exec(`
      CREATE TABLE thread_provider_bindings (
        thread_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_thread_id TEXT,
        resume_cursor TEXT, cwd TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE provider_thread_snapshots (
        thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
    `);
    const legacyAt = "2026-08-01T12:00:00.000Z";
    legacy.prepare(`
      INSERT INTO thread_provider_bindings
        (thread_id, provider, provider_thread_id, resume_cursor, cwd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-fork", "claude", "legacy-session", "legacy-session", "/workspace", legacyAt, legacyAt);
    legacy.prepare(`
      INSERT INTO provider_thread_snapshots (thread_id, snapshot, summary, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      "legacy-fork",
      JSON.stringify({ id: "legacy-fork", cwd: "/workspace", forkedFromId: "legacy-source", status: { type: "idle" }, turns: [] }),
      JSON.stringify({ id: "legacy-fork", name: "Legacy fork", status: { type: "idle" } }),
      legacyAt
    );
    legacy.close();

    const database = new PixiceDatabase(directory);
    expect(database.db.prepare("PRAGMA table_info(thread_provider_bindings)").all().map((column) => column.name))
      .toContain("forked_from_id");
    expect(database.getThreadProviderBinding("legacy-fork")).toMatchObject({ forkedFromId: "legacy-source" });
    expect(database.getProviderThreadSummary("legacy-fork")).toMatchObject({ forkedFromId: "legacy-source" });
    database.saveThreadProviderBinding({
      threadId: "forked-thread",
      provider: "codex",
      providerThreadId: "native-fork",
      cwd: "/workspace",
      forkedFromId: "source-thread"
    });
    expect(database.getThreadProviderBinding("forked-thread")).toMatchObject({
      forkedFromId: "source-thread"
    });
    database.db.close();
  });

  it("persists Pixice bridge ancestry and model choices", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    database.saveThreadLink({
      childThreadId: "claude-child",
      parentThreadId: "gpt-parent",
      model: "claude:claude-sonnet-4-6",
      effort: "high"
    });

    expect(database.getThreadLink("claude-child")).toMatchObject({
      parentThreadId: "gpt-parent",
      kind: "pixiceBridge",
      model: "claude:claude-sonnet-4-6",
      effort: "high"
    });
    expect(database.listThreadLinks("gpt-parent")).toHaveLength(1);

    database.deleteThreadLink("claude-child");
    expect(database.getThreadLink("claude-child")).toBeNull();
    database.db.close();
  });

  it("migrates bridge ancestry saved by the previous product name", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const legacyKind = `${["lo", "om"].join("")}Bridge`;
    database.saveThreadLink({
      childThreadId: "legacy-child",
      parentThreadId: "parent",
      kind: legacyKind
    });
    database.db.close();

    const reopened = new PixiceDatabase(directory);
    expect(reopened.getThreadLink("legacy-child")?.kind).toBe("pixiceBridge");
    reopened.db.close();
  });

  it("keeps task defaults in user data across database migrations and app updates", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);

    database.saveAppSettings({
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "xhigh",
      defaultPermissionMode: "workspace-write",
      workflowGenerationModel: "claude:claude-sonnet-5",
      keepSystemAwake: true,
      checkProviderUpdates: false,
      threadCompletionsSeen: { __baselineAt: 1_776_000_000_000, "thread-2": "turn:turn-2" },
      agentBehaviors: { structuredPlanning: true, parallelDelegation: false, verification: true }
    });
    database.db.close();

    const reopenedAfterUpdate = new PixiceDatabase(directory);
    expect(reopenedAfterUpdate.getAppSettings()).toEqual({
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "xhigh",
      defaultPermissionMode: "workspace-write",
      workflowGenerationModel: "claude:claude-sonnet-5",
      keepSystemAwake: true,
      checkProviderUpdates: false,
      threadCompletionsSeen: { __baselineAt: 1_776_000_000_000, "thread-2": "turn:turn-2" },
      agentBehaviors: { structuredPlanning: true, parallelDelegation: false, verification: true }
    });
    reopenedAfterUpdate.db.close();
  });

  it("deduplicates measured usage and aggregates cost and token history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-database-"));
    temporaryDirectories.push(directory);
    const database = new PixiceDatabase(directory);
    const recordedAt = new Date().toISOString();
    const usage = {
      id: "codex:response-1",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "codex",
      model: "gpt-5.6-sol",
      recordedAt,
      inputTokens: 1_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 100,
      outputTokens: 500,
      reasoningOutputTokens: 200,
      costUsd: 0.023625,
      costSource: "api-equivalent",
      pricingModel: "gpt-5.6-sol"
    };

    expect(database.recordUsageEvent(usage)).toBe(true);
    expect(database.recordUsageEvent(usage)).toBe(false);
    const summary = database.getUsageSummary({ days: 30 });

    expect(summary.selected).toMatchObject({
      inputTokens: 1_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 100,
      outputTokens: 500,
      reasoningOutputTokens: 200,
      totalTokens: 3_600,
      events: 1,
      unpricedEvents: 0
    });
    expect(summary.stats.todayCostUsd).toBeCloseTo(0.023625);
    expect(summary.stats.allTimeCostUsd).toBeCloseTo(0.023625);
    expect(summary.models[0]).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", events: 1 });
    expect(summary.daily).toHaveLength(30);
    expect(summary.heatmapDaily).toHaveLength(365);
    expect(summary.historyDailyModels).toHaveLength(1);
    expect(summary.historyDailyModels[0]).toMatchObject({ date: summary.calendarDate, provider: "codex", model: "gpt-5.6-sol", totalTokens: 3_600, events: 1 });
    expect(summary.recordingStartDate).toBe(summary.calendarDate);
    expect(summary.trackingDays).toBe(1);
    expect(summary.calendarTimeZone).toEqual(expect.any(String));
    expect(summary.heatmapDaily.at(-1)).toMatchObject({ costUsd: 0.023625, events: 1 });
    database.db.close();

    const reopenedAfterUpdate = new PixiceDatabase(directory);
    const persisted = reopenedAfterUpdate.getUsageSummary({ days: 30 });
    expect(persisted.stats.allTimeCostUsd).toBeCloseTo(0.023625);
    expect(persisted.stats.allTimeTokens).toBe(3_600);
    expect(persisted.selected.events).toBe(1);
    reopenedAfterUpdate.db.close();
  });
});
