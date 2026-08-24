import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUpdateDataBackup,
  ensureVersionUpdateDataBackup,
  markUpdateDataVersion,
  readUpdateDataVersion,
  recoverUpdateDataFromBackup
} from "../electron/persistence/update-data-backup.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-update-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createDatabase(directory, name, value) {
  const database = new DatabaseSync(path.join(directory, name));
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT NOT NULL)");
  database.prepare("INSERT INTO records (value) VALUES (?)").run(value);
  return database;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("update data backups", () => {
  it("creates verified snapshots from live WAL databases", async () => {
    const directory = temporaryDirectory();
    const main = createDatabase(directory, "loom.sqlite", "project-1");
    const workflows = createDatabase(directory, "loom-workflows.sqlite", "workflow-1");
    writeFileSync(path.join(directory, "loom-workflow-credentials.json"), JSON.stringify({ version: 1, credentials: [] }));

    const result = await createUpdateDataBackup({
      userDataPath: directory,
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      now: new Date("2026-08-24T12:00:00.000Z")
    });

    const restored = new DatabaseSync(path.join(result.path, "loom.sqlite"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM records").get()).toEqual({ value: "project-1" });
    expect(result.manifest).toMatchObject({
      formatVersion: 1,
      reason: "app-update",
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      files: expect.arrayContaining([
        expect.objectContaining({ name: "loom.sqlite", bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ name: "loom-workflows.sqlite" }),
        expect.objectContaining({ name: "loom-workflow-credentials.json" })
      ])
    });
    expect(JSON.parse(readFileSync(path.join(result.path, "manifest.json"), "utf8"))).toEqual(result.manifest);

    restored.close();
    main.close();
    workflows.close();
  });

  it("backs up once before a new app version migrates existing data", async () => {
    const directory = temporaryDirectory();
    const database = createDatabase(directory, "loom.sqlite", "project-1");
    database.close();
    markUpdateDataVersion(directory, "0.1.0");

    const first = await ensureVersionUpdateDataBackup({ userDataPath: directory, currentVersion: "0.2.0" });
    expect(first.manifest).toMatchObject({ reason: "pre-migration", currentVersion: "0.1.0", targetVersion: "0.2.0" });
    markUpdateDataVersion(directory, "0.2.0");
    expect(readUpdateDataVersion(directory)).toBe("0.2.0");
    await expect(ensureVersionUpdateDataBackup({ userDataPath: directory, currentVersion: "0.2.0" })).resolves.toBeNull();
  });

  it("rejects corrupt durable data instead of installing over it", async () => {
    const directory = temporaryDirectory();
    writeFileSync(path.join(directory, "loom.sqlite"), "not a sqlite database");

    await expect(createUpdateDataBackup({
      userDataPath: directory,
      currentVersion: "0.1.0",
      targetVersion: "0.2.0"
    })).rejects.toThrow("could not preserve app data");
  });

  it("recovers missing or corrupt data from the latest verified update backup", async () => {
    const directory = temporaryDirectory();
    const database = createDatabase(directory, "loom.sqlite", "project-1");
    database.close();
    writeFileSync(path.join(directory, "loom-workflow-credentials.json"), JSON.stringify({ version: 1, credentials: [] }));
    const backup = await createUpdateDataBackup({
      userDataPath: directory,
      currentVersion: "0.1.0",
      targetVersion: "0.2.0"
    });
    writeFileSync(path.join(directory, "loom.sqlite"), "corrupt");
    rmSync(path.join(directory, "loom-workflow-credentials.json"));

    expect(recoverUpdateDataFromBackup({ userDataPath: directory })).toEqual(expect.arrayContaining([
      { name: "loom.sqlite", backupPath: path.join(backup.path, "loom.sqlite") },
      { name: "loom-workflow-credentials.json", backupPath: path.join(backup.path, "loom-workflow-credentials.json") }
    ]));
    const restored = new DatabaseSync(path.join(directory, "loom.sqlite"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM records").get()).toEqual({ value: "project-1" });
    expect(JSON.parse(readFileSync(path.join(directory, "loom-workflow-credentials.json"), "utf8"))).toEqual({ version: 1, credentials: [] });
    restored.close();
  });
});
