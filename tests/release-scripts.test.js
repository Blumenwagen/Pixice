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
    const release = await mkdtemp(path.join(os.tmpdir(), "pixice-release-"));
    temporaryDirectories.push(release);
    await writeFile(path.join(release, "Pixice.zip"), "artifact");
    await mkdir(path.join(release, "mac-arm64"));
    await writeFile(path.join(release, "mac-arm64", "Pixice"), "unpacked");

    await run(process.execPath, [path.resolve("scripts/generate-checksums.mjs"), release]);
    const output = await readFile(path.join(release, "SHA256SUMS.txt"), "utf8");
    expect(output).toMatch(/^[a-f0-9]{64}  Pixice\.zip\n$/);
    expect(output).not.toContain("mac-arm64");
  });

  it("merges architecture-specific macOS update metadata", async () => {
    const release = await mkdtemp(path.join(os.tmpdir(), "pixice-release-"));
    temporaryDirectories.push(release);
    const arm64 = path.join(release, "latest-mac-arm64.yml");
    const x64 = path.join(release, "latest-mac-x64.yml");
    const outputPath = path.join(release, "latest-mac.yml");
    await writeFile(arm64, [
      "version: 0.1.0-beta.1",
      "files:",
      "  - url: Pixice-0.1.0-beta.1-mac-arm64.zip",
      "    sha512: armhash",
      "    size: 123",
      "path: Pixice-0.1.0-beta.1-mac-arm64.zip",
      "sha512: armhash",
      "releaseDate: '2026-08-22T14:00:00.000Z'",
      ""
    ].join("\n"));
    await writeFile(x64, [
      "version: 0.1.0-beta.1",
      "files:",
      "  - url: Pixice-0.1.0-beta.1-mac-x64.zip",
      "    sha512: x64hash",
      "    size: 456",
      "path: Pixice-0.1.0-beta.1-mac-x64.zip",
      "sha512: x64hash",
      "releaseDate: '2026-08-22T14:00:01.000Z'",
      ""
    ].join("\n"));

    await run(process.execPath, [path.resolve("scripts/merge-mac-update-metadata.mjs"), arm64, x64, outputPath]);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    expect(output.files.map((file) => file.url)).toEqual([
      "Pixice-0.1.0-beta.1-mac-arm64.zip",
      "Pixice-0.1.0-beta.1-mac-x64.zip"
    ]);
  });
});
