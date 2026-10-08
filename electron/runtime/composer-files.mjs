import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

const OMIT_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".cache", "coverage", "target", ".turbo", "vendor"]);

// A bounded async walk, independent of either provider. Never follow symlinks.
// Workspace roots supplied by the caller are already project-authorized.
export async function listComposerFiles({ primaryRoot, roots = [], query = "", limit = 80, maxEntries = 12_000, maxMilliseconds = 1000 } = {}) {
  const countLimit = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 80));
  const entryLimit = Math.max(1, Math.min(20_000, maxEntries));
  const needle = String(query ?? "").slice(0, 256).toLocaleLowerCase();
  const rootPaths = [...new Set([primaryRoot, ...roots].filter(value => typeof value === "string" && value))];
  const seen = new Set();
  const queue = [];
  for (const root of rootPaths) {
    try { const resolved = await realpath(root); if (!seen.has(resolved)) { seen.add(resolved); queue.push({ directory: resolved, root: resolved, depth: 0 }); } } catch { /* Removed roots don't disable other folders. */ }
  }
  const files = [];
  const paths = new Set();
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + Math.max(25, Math.min(2000, maxMilliseconds));
  while (queue.length) {
    if (visited >= entryLimit || Date.now() > deadline || files.length >= countLimit) { truncated = true; break; }
    const { directory, root, depth } = queue.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > entryLimit || Date.now() > deadline) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!OMIT_DIRECTORIES.has(entry.name) && depth < 16) queue.push({ directory: absolute, root, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || paths.has(absolute)) continue;
      const relativePath = path.relative(root, absolute).split(path.sep).join("/");
      if (needle && !relativePath.toLocaleLowerCase().includes(needle)) continue;
      paths.add(absolute);
      files.push({ path: absolute, relativePath, name: entry.name, folderPath: root });
      if (files.length >= countLimit) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

export const listProjectFiles = listComposerFiles;
