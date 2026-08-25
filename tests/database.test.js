import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PixiceDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("thread runtime persistence", () => {
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
      cwd: "/workspace"
    });
    database.saveProviderThreadSnapshot("thread-claude", { id: "thread-claude", turns: [] });

    expect(database.getThreadProviderBinding("thread-claude")).toMatchObject({
      provider: "claude",
      providerThreadId: "session-1",
      resumeCursor: "session-1",
      cwd: "/workspace"
    });
    expect(database.listThreadProviderBindings({ provider: "claude" })).toHaveLength(1);
    expect(database.getProviderThreadSnapshot("thread-claude")).toEqual({ id: "thread-claude", turns: [] });

    database.deleteThreadProviderBinding("thread-claude");
    expect(database.getThreadProviderBinding("thread-claude")).toBeNull();
    expect(database.getProviderThreadSnapshot("thread-claude")).toBeNull();
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
      checkCodexUpdates: false,
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
      checkCodexUpdates: false,
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
