import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release scripts", () => {
  it("checksums only regular artifacts and ignores unpacked output directories", async () => {
    const release = await mkdtemp(path.join(os.tmpdir(), "loom-release-"));
    temporaryDirectories.push(release);
    await writeFile(path.join(release, "Loom.zip"), "artifact");
    await mkdir(path.join(release, "mac-arm64"));
    await writeFile(path.join(release, "mac-arm64", "Loom"), "unpacked");

    await run(process.execPath, [path.resolve("scripts/generate-checksums.mjs"), release]);
    const output = await readFile(path.join(release, "SHA256SUMS.txt"), "utf8");
    expect(output).toMatch(/^[a-f0-9]{64}  Loom\.zip\n$/);
    expect(output).not.toContain("mac-arm64");
  });
});
