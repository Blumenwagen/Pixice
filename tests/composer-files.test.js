// @vitest-environment node
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listComposerFiles } from "../electron/runtime/composer-files.mjs";

const cleanup = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Composer project files", () => {
  it("lists ordinary project files and omits symlinks, dependencies and build output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-composer-files-")); cleanup.push(root);
    await Promise.all(["src", ".git", "node_modules", "dist"].map(name => mkdir(path.join(root, name))));
    await Promise.all(["src/index.js", "README.md", ".git/config", "node_modules/package.js", "dist/index.html"].map(name => writeFile(path.join(root, name), name)));
    await symlink(path.join(root, "src"), path.join(root, "linked"));
    const result = await listComposerFiles({ primaryRoot: root, query: "", limit: 20 });
    expect(result.files.map(file => file.relativePath).sort()).toEqual(["README.md", "src/index.js"]);
    const canonicalRoot = await realpath(root);
    expect(result.files.every(file => file.path.startsWith(canonicalRoot) && file.folderPath === canonicalRoot)).toBe(true);
    expect(result.truncated).toBe(false);
  });
  it("bounds traversal and handles one removed root without disabling another", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-composer-files-")); cleanup.push(root);
    await Promise.all(["one.js", "two.js", "three.js"].map(name => writeFile(path.join(root, name), name)));
    const limited = await listComposerFiles({ primaryRoot: `${root}/missing`, roots: [root], query: ".js", limit: 1 });
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    const search = await listComposerFiles({ primaryRoot: root, query: "TWO", limit: 30 });
    expect(search.files.map(file => file.name)).toEqual(["two.js"]);
  });
});
