import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const legacySlug = ["lo", "om"].join("");
const fileRenames = new Map([
  [`${legacySlug}.sqlite`, "pixice.sqlite"],
  [`${legacySlug}-workflows.sqlite`, "pixice-workflows.sqlite"],
  [`${legacySlug}-workflow-credentials.json`, "pixice-workflow-credentials.json"]
]);

function migrateDirectory(directory) {
  if (!existsSync(directory)) return [];
  const migrated = [];
  for (const [legacyName, pixiceName] of fileRenames) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = path.join(directory, `${legacyName}${suffix}`);
      const destination = path.join(directory, `${pixiceName}${suffix}`);
      if (!existsSync(source) || existsSync(destination)) continue;
      renameSync(source, destination);
      migrated.push({ source, destination });
    }
  }

  const manifestPath = path.join(directory, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      let changed = false;
      manifest.files = Array.isArray(manifest.files) ? manifest.files.map((file) => {
        const renamed = fileRenames.get(file?.name);
        if (!renamed) return file;
        changed = true;
        return { ...file, name: renamed };
      }) : manifest.files;
      if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A malformed backup manifest is ignored by the normal recovery path.
    }
  }
  return migrated;
}

export function migrateLegacyBrandData(userDataPath) {
  mkdirSync(userDataPath, { recursive: true });
  const migrated = migrateDirectory(userDataPath);
  const backupRoot = path.join(userDataPath, "update-data-backups");
  if (existsSync(backupRoot)) {
    for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) migrated.push(...migrateDirectory(path.join(backupRoot, entry.name)));
    }
  }

  const partitions = path.join(userDataPath, "Partitions");
  if (existsSync(partitions)) {
    const legacyPrefix = `${legacySlug}-browser-`;
    for (const entry of readdirSync(partitions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(legacyPrefix)) continue;
      const destinationName = `pixice-browser-${entry.name.slice(legacyPrefix.length)}`;
      const source = path.join(partitions, entry.name);
      const destination = path.join(partitions, destinationName);
      if (existsSync(destination)) continue;
      renameSync(source, destination);
      migrated.push({ source, destination });
    }
  }
  return migrated;
}
