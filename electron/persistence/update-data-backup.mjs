import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const UPDATE_DATA_BACKUP_DIRECTORY = "update-data-backups";
export const UPDATE_DATA_VERSION_FILE = "update-data-version.json";

const SQLITE_FILES = ["pixice.sqlite", "pixice-workflows.sqlite", "pixice-instruments.sqlite"];
const FILES = [...SQLITE_FILES, "pixice-workflow-credentials.json"];

function safeVersion(value) {
  return String(value || "unknown").replace(/[^0-9A-Za-z._-]/g, "_");
}

function digest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertHealthyDatabase(database, label) {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0].quick_check !== "ok") {
    const detail = rows.map((row) => row.quick_check).filter(Boolean).join("; ") || "unknown integrity error";
    throw new Error(`${label} failed SQLite integrity checking: ${detail}`);
  }
}

async function snapshotDatabase(sourcePath, destinationPath) {
  const source = new DatabaseSync(sourcePath, { open: true, readOnly: true });
  try {
    assertHealthyDatabase(source, path.basename(sourcePath));
    await backup(source, destinationPath);
  } finally {
    source.close();
  }

  const snapshot = new DatabaseSync(destinationPath, { open: true, readOnly: true });
  try {
    assertHealthyDatabase(snapshot, `${path.basename(sourcePath)} backup`);
  } finally {
    snapshot.close();
  }
}

function validateCredentialStore(filePath) {
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || !Array.isArray(value.credentials)) {
    throw new Error("Workflow credential data has an invalid format");
  }
}

function durableFileIsHealthy(filePath, fileName) {
  try {
    if (!SQLITE_FILES.includes(fileName)) {
      validateCredentialStore(filePath);
      return true;
    }
    const database = new DatabaseSync(filePath, { open: true, readOnly: true });
    try {
      assertHealthyDatabase(database, fileName);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function backupCandidates(userDataPath) {
  const backupRoot = path.join(userDataPath, UPDATE_DATA_BACKUP_DIRECTORY);
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.includes(".partial"))
    .map((entry) => {
      const directory = path.join(backupRoot, entry.name);
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
        if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files)) return null;
        return { directory, manifest };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.manifest.createdAt).localeCompare(String(left.manifest.createdAt)));
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

export function readUpdateDataVersion(userDataPath) {
  try {
    const value = JSON.parse(readFileSync(path.join(userDataPath, UPDATE_DATA_VERSION_FILE), "utf8"));
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

export function markUpdateDataVersion(userDataPath, version) {
  mkdirSync(userDataPath, { recursive: true });
  writeJsonAtomically(path.join(userDataPath, UPDATE_DATA_VERSION_FILE), {
    version: String(version),
    recordedAt: new Date().toISOString()
  });
}

export function hasDurableUpdateData(userDataPath) {
  return FILES.some((name) => existsSync(path.join(userDataPath, name)));
}

export function recoverUpdateDataFromBackup({ userDataPath }) {
  const candidates = backupCandidates(userDataPath);
  if (!candidates.length) return [];
  const recovered = [];

  for (const fileName of FILES) {
    const currentPath = path.join(userDataPath, fileName);
    if (existsSync(currentPath) && durableFileIsHealthy(currentPath, fileName)) continue;
    const candidate = candidates.find(({ directory, manifest }) => {
      try {
        const record = manifest.files.find((file) => file?.name === fileName);
        const candidatePath = path.join(directory, fileName);
        return record && existsSync(candidatePath) && digest(candidatePath) === record.sha256 && durableFileIsHealthy(candidatePath, fileName);
      } catch {
        return false;
      }
    });
    if (!candidate) continue;

    const sourcePath = path.join(candidate.directory, fileName);
    const temporaryPath = `${currentPath}.${randomUUID()}.restore`;
    copyFileSync(sourcePath, temporaryPath);
    if (!durableFileIsHealthy(temporaryPath, fileName)) {
      rmSync(temporaryPath, { force: true });
      continue;
    }

    const quarantined = [];
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const existingPath = `${currentPath}${suffix}`;
        if (!existsSync(existingPath)) continue;
        const quarantinePath = `${existingPath}.before-update-recovery-${Date.now()}`;
        renameSync(existingPath, quarantinePath);
        quarantined.push({ existingPath, quarantinePath });
      }
      renameSync(temporaryPath, currentPath);
      recovered.push({ name: fileName, backupPath: sourcePath });
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      for (const { existingPath, quarantinePath } of quarantined.reverse()) {
        if (!existsSync(existingPath) && existsSync(quarantinePath)) renameSync(quarantinePath, existingPath);
      }
      throw new Error(`Pixice could not recover ${fileName} before updating: ${error.message}`);
    }
  }
  return recovered;
}

export async function createUpdateDataBackup({
  userDataPath,
  currentVersion,
  targetVersion,
  reason = "app-update",
  now = new Date()
}) {
  if (!hasDurableUpdateData(userDataPath)) return null;

  const createdAt = now.toISOString();
  const backupRoot = path.join(userDataPath, UPDATE_DATA_BACKUP_DIRECTORY);
  const name = `${createdAt.replace(/[:.]/g, "-")}-${safeVersion(currentVersion)}-to-${safeVersion(targetVersion)}-${randomUUID().slice(0, 8)}`;
  const finalPath = path.join(backupRoot, name);
  const temporaryPath = `${finalPath}.${randomUUID()}.partial`;
  mkdirSync(temporaryPath, { recursive: true, mode: 0o700 });

  try {
    const files = [];
    for (const fileName of FILES) {
      const sourcePath = path.join(userDataPath, fileName);
      if (!existsSync(sourcePath)) continue;
      const destinationPath = path.join(temporaryPath, fileName);
      if (SQLITE_FILES.includes(fileName)) await snapshotDatabase(sourcePath, destinationPath);
      else {
        validateCredentialStore(sourcePath);
        copyFileSync(sourcePath, destinationPath);
      }
      files.push({
        name: fileName,
        bytes: statSync(destinationPath).size,
        sha256: digest(destinationPath)
      });
    }

    if (!files.length) {
      rmSync(temporaryPath, { recursive: true, force: true });
      return null;
    }
    const manifest = {
      formatVersion: 1,
      reason,
      createdAt,
      currentVersion: String(currentVersion),
      targetVersion: String(targetVersion),
      files
    };
    writeJsonAtomically(path.join(temporaryPath, "manifest.json"), manifest);
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    renameSync(temporaryPath, finalPath);
    return { path: finalPath, manifest };
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error(`Pixice could not preserve app data before updating: ${error.message}`);
  }
}

export async function ensureVersionUpdateDataBackup({ userDataPath, currentVersion }) {
  const previousVersion = readUpdateDataVersion(userDataPath);
  if (!hasDurableUpdateData(userDataPath) || previousVersion === currentVersion) return null;
  return createUpdateDataBackup({
    userDataPath,
    currentVersion: previousVersion ?? "unversioned",
    targetVersion: currentVersion,
    reason: "pre-migration"
  });
}
