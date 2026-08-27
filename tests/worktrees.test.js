import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectRepository, readDiff, readDiffManifest, readFileDiff } from "../electron/git/worktrees.mjs";

const run = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Git review scoping", () => {
  it("excludes parent-repository changes outside a nested project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-git-"));
    temporaryDirectories.push(root);
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "outside.txt"), "outside before\n");
    await writeFile(path.join(nested, "inside.txt"), "inside before\n");
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "pixice@example.test"], { cwd: root });
    await run("git", ["config", "user.name", "Pixice Tests"], { cwd: root });
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });

    await writeFile(path.join(root, "outside.txt"), "outside after\n");
    await writeFile(path.join(root, "outside-new.txt"), "outside new\n");
    await writeFile(path.join(nested, "inside.txt"), "inside after\n");
    await writeFile(path.join(nested, "inside-new.txt"), "inside new\n");

    const repository = await inspectRepository(nested);
    const diff = await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: nested });
    const manifest = await readDiffManifest({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: nested });
    const selectedDiff = await readFileDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: nested, filePath: "inside.txt" });
    expect(diff).toContain("packages/app/inside.txt");
    expect(diff).toContain("packages/app/inside-new.txt");
    expect(diff).not.toContain("outside.txt");
    expect(diff).not.toContain("outside-new.txt");
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "inside.txt", plus: 1, minus: 1 }),
      expect.objectContaining({ path: "inside-new.txt", plus: 1, minus: 0 })
    ]));
    expect(manifest.some((file) => file.path.includes("outside"))).toBe(false);
    expect(selectedDiff).toContain("diff --git a/inside.txt b/inside.txt");
    expect(selectedDiff).not.toContain("outside");
  });

  it("reads untracked LFS files when the optional Git LFS filter is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-git-lfs-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "pixice@example.test"], { cwd: root });
    await run("git", ["config", "user.name", "Pixice Tests"], { cwd: root });
    await run("git", ["add", ".gitattributes"], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });
    await run("git", ["config", "filter.lfs.process", "pixice-missing-git-lfs filter-process"], { cwd: root });
    await run("git", ["config", "filter.lfs.required", "true"], { cwd: root });
    await writeFile(path.join(root, "runtime.bin"), Buffer.from([0, 1, 2, 3, 4]));

    const repository = await inspectRepository(root);
    const diff = await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit });

    expect(diff).toContain("runtime.bin");
    expect(diff).toContain("Binary files");
  });
});
