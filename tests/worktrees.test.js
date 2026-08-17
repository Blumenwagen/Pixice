import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectRepository, readDiff } from "../electron/git/worktrees.mjs";

const run = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Git review scoping", () => {
  it("excludes parent-repository changes outside a nested project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "loom-git-"));
    temporaryDirectories.push(root);
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "outside.txt"), "outside before\n");
    await writeFile(path.join(nested, "inside.txt"), "inside before\n");
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "loom@example.test"], { cwd: root });
    await run("git", ["config", "user.name", "Loom Tests"], { cwd: root });
    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });

    await writeFile(path.join(root, "outside.txt"), "outside after\n");
    await writeFile(path.join(root, "outside-new.txt"), "outside new\n");
    await writeFile(path.join(nested, "inside.txt"), "inside after\n");
    await writeFile(path.join(nested, "inside-new.txt"), "inside new\n");

    const repository = await inspectRepository(nested);
    const diff = await readDiff({ workingPath: repository.root, baseCommit: repository.baseCommit, scopePath: nested });
    expect(diff).toContain("packages/app/inside.txt");
    expect(diff).toContain("packages/app/inside-new.txt");
    expect(diff).not.toContain("outside.txt");
    expect(diff).not.toContain("outside-new.txt");
  });
});
