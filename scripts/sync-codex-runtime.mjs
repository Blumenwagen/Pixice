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
const channel = process.argv.find((argument) => argument.startsWith("--channel="))?.slice(10) || "latest";
const channelUrl = `https://releases.openai.com/codex/channels/${channel}`;
const platformAssets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-musl"
};

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const response = await fetch(channelUrl);
if (!response.ok) throw new Error(`Could not load Codex channel ${channel}: HTTP ${response.status}`);
const release = await response.json();
const version = String(release.tag_name ?? "").replace(/^rust-v/, "");
if (!version) throw new Error(`Codex channel ${channel} did not include a version`);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pixice-codex-runtime-"));
const platforms = {};

try {
  for (const [platform, target] of Object.entries(platformAssets)) {
    const assetName = `codex-app-server-package-${target}.tar.gz`;
    const asset = release.assets?.find((candidate) => candidate.name === assetName);
    if (!asset?.browser_download_url || !asset.digest?.startsWith("sha256:")) {
      throw new Error(`Missing official asset metadata for ${assetName}`);
    }

    const archivePath = path.join(temporaryRoot, assetName);
    const extractedPath = path.join(temporaryRoot, platform);
    await download(asset.browser_download_url, archivePath);
    const archiveHash = await sha256(archivePath);
    if (archiveHash !== asset.digest.slice(7)) throw new Error(`Archive checksum mismatch for ${assetName}`);
    await mkdir(extractedPath, { recursive: true });
    await execFile("tar", ["-xzf", archivePath, "-C", extractedPath]);

    const packageMetadata = JSON.parse(await readFile(path.join(extractedPath, "codex-package.json"), "utf8"));
    if (packageMetadata.version !== version || packageMetadata.target !== target) {
      throw new Error(`Package metadata mismatch for ${assetName}`);
    }
    const entrypoint = path.join(extractedPath, packageMetadata.entrypoint);
    const codeModeHostName = platform === "win32-x64" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
    const codeModeHost = path.join(extractedPath, "bin", codeModeHostName);
    if (platform !== "win32-x64") {
      await chmod(entrypoint, 0o755);
      await chmod(codeModeHost, 0o755);
    }

    const destination = path.join(runtimeRoot, platform);
    await rm(destination, { recursive: true, force: true });
    await cp(extractedPath, destination, { recursive: true, preserveTimestamps: true });
    platforms[platform] = {
      path: `${platform}/${packageMetadata.entrypoint}`,
      sha256: await sha256(entrypoint),
      codeModeHostPath: `${platform}/bin/${codeModeHostName}`,
      codeModeHostSha256: await sha256(codeModeHost),
      sourceUrl: asset.browser_download_url,
      sourceSha256: archiveHash
    };
    console.log(`Synced Codex ${version} for ${platform}.`);
  }

  const manifest = {
    schemaVersion: 2,
    runtimeKind: "app-server-package",
    codexVersion: version,
    protocolVersion: `${version}-app-server`,
    channel,
    platforms
  };
  await writeFile(path.join(runtimeRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
