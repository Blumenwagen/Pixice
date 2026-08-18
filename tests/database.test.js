import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoomDatabase } from "../electron/persistence/database.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("thread runtime persistence", () => {
  it("restores and removes structured plan progress", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-database-"));
    temporaryDirectories.push(directory);
    const database = new LoomDatabase(directory);
    const plan = [{ step: "Audit runtime", status: "inProgress" }];

    database.saveThreadPlan("thread-1", plan);
    expect(database.getThreadPlan("thread-1")).toEqual(plan);

    database.deleteThreadRuntimeState("thread-1");
    expect(database.getThreadPlan("thread-1")).toBeNull();
    database.db.close();
  });

  it("persists generated thread names independently from Codex list metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-database-"));
    temporaryDirectories.push(directory);
    const database = new LoomDatabase(directory);

    database.saveThreadName("thread-1", "Authentication session repair");
    expect(database.getThreadName("thread-1")).toBe("Authentication session repair");

    database.deleteThreadName("thread-1");
    expect(database.getThreadName("thread-1")).toBeNull();
    database.db.close();
  });

  it("persists provider ownership, resume cursors, and canonical snapshots", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "loom-database-"));
    temporaryDirectories.push(directory);
    const database = new LoomDatabase(directory);

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
});
