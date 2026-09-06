#!/usr/bin/env node

import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { discoverService, serviceCall, stopService } from '../electron/backend/manager.mjs';
import { createUpdateDataBackup } from '../electron/persistence/update-data-backup.mjs';
import { acquireServiceOwnership } from '../electron/backend/ownership.mjs';
import { defaultDataDirectory } from '../electron/backend/paths.mjs';
import { verifyMacAppSignature } from "./macos-signing.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const appId = "com.blumenwagen.pixice";
const relaunchDelayMs = 10_000;

function timestampTag(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function localInstallPaths({
  source = path.join(repositoryRoot, "release", "mac-arm64", "Pixice.app"),
  target = path.join(homedir(), "Applications", "Pixice.app"),
  date = new Date(),
  processId = process.pid
} = {}) {
  const tag = timestampTag(date);
  return {
    source: path.resolve(source),
    target: path.resolve(target),
    staging: `${path.resolve(target)}.staging-${processId}`,
    backup: `${path.resolve(target)}.backup-${tag}`,
    plan: path.join(tmpdir(), `pixice-local-install-${processId}-${tag}.json`),
    log: path.join(tmpdir(), `pixice-local-install-${processId}-${tag}.log`)
  };
}

export function detachWorker({ planPath, logPath, spawn = spawnProcess, nodePath = process.execPath }) {
  const log = openSync(logPath, "a");
  try {
    const child = spawn(nodePath, [scriptPath, "--finish-install", planPath], {
      detached: true,
      stdio: ["ignore", log, log]
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

async function assertAppBundle(appPath) {
  const executable = path.join(appPath, "Contents", "MacOS", "Pixice");
  const [bundleStats, executableStats] = await Promise.all([stat(appPath), stat(executable)]);
  if (!bundleStats.isDirectory() || !executableStats.isFile()) {
    throw new Error(`Not a Pixice app bundle: ${appPath}`);
  }
  await verifyMacAppSignature(appPath, { requireTeamIdentifier: false });
}

async function runningPixicePids(target) {
  const executable = path.join(target, "Contents", "MacOS", "Pixice");
  const { stdout } = await execFile("/bin/ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === executable ? [Number(match[1])] : [];
  });
}

export function processStateIsRunning(state) {
  const normalized = String(state ?? "").trim().toUpperCase();
  return Boolean(normalized) && !normalized.startsWith("Z");
}

async function processIsRunning(processId) {
  try {
    const { stdout } = await execFile("/bin/ps", ["-p", String(processId), "-o", "state="]);
    return processStateIsRunning(stdout);
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

async function waitForExit(processIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await Promise.all(processIds.map(processIsRunning));
    if (!running.some(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const running = await Promise.all(processIds.map(processIsRunning));
  return !running.some(Boolean);
}

async function quitRunningApp(processIds) {
  if (!processIds.length) return;
  await execFile("/usr/bin/osascript", ["-e", `tell application id \"${appId}\" to quit`]).catch(() => {});
  if (await waitForExit(processIds, 10_000)) return;

  for (const processId of processIds) {
    if (await processIsRunning(processId)) process.kill(processId, "SIGTERM");
  }
  if (await waitForExit(processIds, 3_000)) return;

  for (const processId of processIds) {
    if (await processIsRunning(processId)) process.kill(processId, "SIGKILL");
  }
  if (await waitForExit(processIds, 2_000)) return;

  throw new Error(`Pixice did not quit; refusing to replace a running app bundle (PID ${processIds.join(", ")})`);
}

async function finishInstall(planPath) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, relaunchDelayMs));
  // A live backend owns the databases even when the desktop has been closed.
  let backend;
  try { backend = await discoverService(defaultDataDirectory()); } catch (error) {
    if (error.code !== 'ENOENT' && existsSync(path.join(defaultDataDirectory(), 'service/instance.json'))) {
      // A stale descriptor is safe only when the OS confirms no backend owner.
      const probe = await acquireServiceOwnership(defaultDataDirectory()); await probe.release();
    }
  }
  if (backend) {
    if (backend.status.activeTurns || backend.status.startingTurns || backend.status.activeWorkflows) throw new Error('Active Pixice work is still running. Finish it before installing this update.');
    await serviceCall(backend.descriptor, 'service.backup', { currentVersion: backend.status.version, targetVersion: 'local-update' });
    await stopService(defaultDataDirectory(), { update: true });
  }
  await quitRunningApp(plan.runningPids);

  const installOwnership = await acquireServiceOwnership(defaultDataDirectory());
  let movedCurrentApp = false;
  try {
    if (!backend) await createUpdateDataBackup({ userDataPath: defaultDataDirectory(), currentVersion: "local-installed", targetVersion: "local-update", reason: "local-app-update" });
    if (existsSync(plan.target)) {
      await rename(plan.target, plan.backup);
      movedCurrentApp = true;
    }
    await rename(plan.staging, plan.target);
  } catch (error) {
    if (movedCurrentApp && !existsSync(plan.target) && existsSync(plan.backup)) {
      await rename(plan.backup, plan.target);
    }
    throw error;
  } finally {
    await installOwnership.release();
  }

  await assertAppBundle(plan.target);
  await execFile("/usr/bin/open", [plan.target]);
  await unlink(planPath).catch(() => {});
}

async function prepareInstall(options = {}) {
  const paths = localInstallPaths(options);
  await assertAppBundle(paths.source);
  await mkdir(path.dirname(paths.target), { recursive: true });
  await rm(paths.staging, { recursive: true, force: true });
  await execFile("/usr/bin/ditto", [paths.source, paths.staging]);
  await assertAppBundle(paths.staging);

  const plan = { ...paths, runningPids: await runningPixicePids(paths.target) };
  await writeFile(paths.plan, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  const workerPid = detachWorker({ planPath: paths.plan, logPath: paths.log });

  console.log(`Staged ${paths.source}`);
  console.log(`Pixice will relaunch once from detached worker PID ${workerPid}.`);
  console.log(`Backup: ${paths.backup}`);
  console.log(`Log: ${paths.log}`);
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Local Pixice installation is currently supported only on macOS");
  if (process.argv[2] === "--finish-install") {
    if (!process.argv[3]) throw new Error("Missing install plan path");
    await finishInstall(path.resolve(process.argv[3]));
    return;
  }

  const [source, target] = process.argv.slice(2);
  await prepareInstall({ ...(source ? { source } : {}), ...(target ? { target } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
