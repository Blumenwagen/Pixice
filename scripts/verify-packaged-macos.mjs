#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacAppSignature } from "./macos-signing.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

async function findPixiceApps(directory, remainingDepth = 3) {
  if (remainingDepth < 0) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.name === "Pixice.app") matches.push(entryPath);
    else matches.push(...(await findPixiceApps(entryPath, remainingDepth - 1)));
  }
  return matches;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS package verification must run on macOS");
  const releaseDirectory = path.resolve(process.argv[2] || path.join(repositoryRoot, "release"));
  const matches = await findPixiceApps(releaseDirectory);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one packaged Pixice.app under ${releaseDirectory}; found ${matches.length}`);
  }
  const result = await verifyMacAppSignature(matches[0], { requireGatekeeper: process.argv.includes("--require-gatekeeper") });
  console.log(`Verified ${result.identifier}, team ${result.teamIdentifier}, at ${result.path}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
