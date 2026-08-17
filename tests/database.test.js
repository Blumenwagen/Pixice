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
});
