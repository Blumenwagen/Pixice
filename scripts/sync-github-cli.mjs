#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(repositoryRoot, "resources", "runtime");
const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))?.slice(9)
  ?? `${process.platform}-${process.arch}`;
const requestedVersion = process.argv.find((argument) => argument.startsWith("--version="))?.slice(10)
  ?? process.env.PIXICE_GITHUB_CLI_VERSION
  ?? "latest";
const platformAssets = {
  "darwin-arm64": (version) => `gh_${version}_macOS_arm64.zip`,
  "darwin-x64": (version) => `gh_${version}_macOS_amd64.zip`,
  "win32-x64": (version) => `gh_${version}_windows_amd64.zip`,
  "linux-x64": (version) => `gh_${version}_linux_amd64.tar.gz`
};

if (!platformAssets[requestedTarget]) throw new Error(`Unsupported GitHub CLI target: ${requestedTarget}`);

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function githubJson(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "Pixice-runtime-sync", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}: ${url}`);
  return response.json();
}

async function download(url, destination) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(url, { headers: { "user-agent": "Pixice-runtime-sync", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const releaseUrl = requestedVersion === "latest"
  ? "https://api.github.com/repos/cli/cli/releases/latest"
  : `https://api.github.com/repos/cli/cli/releases/tags/v${requestedVersion.replace(/^v/, "")}`;
const release = await githubJson(releaseUrl);
const version = String(release.tag_name ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitHub CLI release did not include a valid version");
const assetName = platformAssets[requestedTarget](version);
const asset = release.assets?.find((candidate) => candidate.name === assetName);
if (!asset?.browser_download_url) throw new Error(`GitHub CLI release v${version} does not include ${assetName}`);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pixice-github-cli-"));
try {
  const archivePath = path.join(temporaryRoot, assetName);
  const extractedPath = path.join(temporaryRoot, "extracted");
  await mkdir(extractedPath, { recursive: true });
  await download(asset.browser_download_url, archivePath);
  const archiveHash = await sha256(archivePath);
  if (asset.digest?.startsWith("sha256:") && asset.digest.slice(7) !== archiveHash) {
    throw new Error(`Checksum mismatch for ${assetName}`);
  }
  if (assetName.endsWith(".zip") && requestedTarget === "win32-x64") await execFile("tar", ["-xf", archivePath, "-C", extractedPath]);
  else if (assetName.endsWith(".zip")) await execFile("unzip", ["-q", archivePath, "-d", extractedPath]);
  else await execFile("tar", ["-xzf", archivePath, "-C", extractedPath]);

  const executable = requestedTarget === "win32-x64" ? "gh.exe" : "gh";
  const extractedBinary = path.join(extractedPath, assetName.replace(/\.(?:zip|tar\.gz)$/, ""), "bin", executable);
  const destinationDirectory = path.join(runtimeRoot, requestedTarget, "bin");
  const destinationBinary = path.join(destinationDirectory, executable);
  await mkdir(destinationDirectory, { recursive: true });
  await cp(extractedBinary, destinationBinary);
  if (requestedTarget !== "win32-x64") await chmod(destinationBinary, 0o755);
  await writeFile(path.join(runtimeRoot, requestedTarget, "github-cli.json"), `${JSON.stringify({
    version,
    path: `bin/${executable}`,
    sha256: await sha256(destinationBinary),
    sourceUrl: asset.browser_download_url,
    sourceSha256: archiveHash
  }, null, 2)}\n`);
  console.log(`Synced GitHub CLI ${version} for ${requestedTarget}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
