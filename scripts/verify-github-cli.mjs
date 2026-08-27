#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(repositoryRoot, "resources", "runtime");
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
const requestedTarget = process.argv.includes("--current")
  ? `${process.platform}-${process.arch}`
  : process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length);
const targets = requestedTarget ? [requestedTarget] : [...supportedTargets];
const errors = [];

for (const target of targets) {
  if (!supportedTargets.has(target)) {
    errors.push(`${target}: unsupported GitHub CLI target`);
    continue;
  }
  try {
    const metadataPath = path.join(runtimeRoot, target, "github-cli.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const expectedPath = `bin/${target === "win32-x64" ? "gh.exe" : "gh"}`;
    if (metadata.path !== expectedPath) errors.push(`${target}: GitHub CLI path must be ${expectedPath}`);
    if (!/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) errors.push(`${target}: GitHub CLI version is invalid`);
    if (!/^[a-f0-9]{64}$/.test(metadata.sha256 ?? "")) errors.push(`${target}: GitHub CLI checksum is not pinned`);
    if (!/^[a-f0-9]{64}$/.test(metadata.sourceSha256 ?? "")) errors.push(`${target}: GitHub CLI source checksum is not pinned`);
    if (!metadata.sourceUrl?.startsWith("https://github.com/cli/cli/releases/download/")) {
      errors.push(`${target}: GitHub CLI source URL is not official`);
    }
    const binaryPath = path.join(runtimeRoot, target, expectedPath);
    const actualHash = createHash("sha256").update(await readFile(binaryPath)).digest("hex");
    if (actualHash !== metadata.sha256) errors.push(`${target}: GitHub CLI checksum mismatch`);
    if (!binaryPath.endsWith(".exe")) accessSync(binaryPath, constants.X_OK);
  } catch (error) {
    errors.push(`${target}: GitHub CLI is not ready; run pnpm github:sync (${error.code ?? error.message})`);
  }
}

if (errors.length) {
  console.error(["GitHub CLI verification failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log(`Verified GitHub CLI for ${targets.join(", ")}.`);
