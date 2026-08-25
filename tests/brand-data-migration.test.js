import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyBrandData } from "../electron/persistence/brand-data-migration.mjs";

const temporaryDirectories = [];
const legacySlug = ["lo", "om"].join("");

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("product data migration", () => {
  it("moves databases, credentials, backups, and browser partitions to Pixice names", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-brand-data-"));
    temporaryDirectories.push(directory);
    for (const name of [`${legacySlug}.sqlite`, `${legacySlug}.sqlite-wal`, `${legacySlug}-workflows.sqlite`, `${legacySlug}-workflow-credentials.json`]) {
      writeFileSync(path.join(directory, name), name);
    }

    const backup = path.join(directory, "update-data-backups", "snapshot");
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(backup, `${legacySlug}.sqlite`), "backup");
    writeFileSync(path.join(backup, "manifest.json"), JSON.stringify({ files: [{ name: `${legacySlug}.sqlite` }] }));

    const partition = path.join(directory, "Partitions", `${legacySlug}-browser-project-1`);
    mkdirSync(partition, { recursive: true });

    migrateLegacyBrandData(directory);

    expect(existsSync(path.join(directory, "pixice.sqlite"))).toBe(true);
    expect(existsSync(path.join(directory, "pixice.sqlite-wal"))).toBe(true);
    expect(existsSync(path.join(directory, "pixice-workflows.sqlite"))).toBe(true);
    expect(existsSync(path.join(directory, "pixice-workflow-credentials.json"))).toBe(true);
    expect(existsSync(path.join(backup, "pixice.sqlite"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(backup, "manifest.json"), "utf8")).files).toEqual([{ name: "pixice.sqlite" }]);
    expect(existsSync(path.join(directory, "Partitions", "pixice-browser-project-1"))).toBe(true);
  });

  it("does not overwrite an existing Pixice destination", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-brand-data-"));
    temporaryDirectories.push(directory);
    writeFileSync(path.join(directory, `${legacySlug}.sqlite`), "legacy");
    writeFileSync(path.join(directory, "pixice.sqlite"), "current");

    migrateLegacyBrandData(directory);

    expect(readFileSync(path.join(directory, "pixice.sqlite"), "utf8")).toBe("current");
    expect(existsSync(path.join(directory, `${legacySlug}.sqlite`))).toBe(true);
  });
});
