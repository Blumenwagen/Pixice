import { createHash } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("../resources/runtime/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const errors = [];
const expectedPlatforms = {
  "darwin-arm64": { binary: "darwin-arm64/bin/codex-app-server", codeModeHost: "darwin-arm64/bin/codex-code-mode-host", packageTarget: "aarch64-apple-darwin" },
  "darwin-x64": { binary: "darwin-x64/bin/codex-app-server", codeModeHost: "darwin-x64/bin/codex-code-mode-host", packageTarget: "x86_64-apple-darwin" },
  "win32-x64": { binary: "win32-x64/bin/codex-app-server.exe", codeModeHost: "win32-x64/bin/codex-code-mode-host.exe", packageTarget: "x86_64-pc-windows-msvc" },
  "linux-x64": { binary: "linux-x64/bin/codex-app-server", codeModeHost: "linux-x64/bin/codex-code-mode-host", packageTarget: "x86_64-unknown-linux-musl" }
};
const requestedTarget = process.argv.includes("--current")
  ? `${process.platform}-${process.arch}`
  : process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length);
const requireGitHubCli = process.argv.includes("--require-github-cli");

if (requestedTarget && !expectedPlatforms[requestedTarget]) {
  errors.push(`unsupported runtime target ${requestedTarget}`);
}
const platformsToVerify = requestedTarget && expectedPlatforms[requestedTarget]
  ? { [requestedTarget]: expectedPlatforms[requestedTarget] }
  : expectedPlatforms;

if (manifest.schemaVersion !== 2) errors.push("unsupported manifest schemaVersion");
if (manifest.runtimeKind !== "app-server-package") errors.push("runtimeKind must be app-server-package");
if (!manifest.codexVersion || manifest.codexVersion === "PIN_AT_RELEASE") errors.push("codexVersion is not pinned");
if (!manifest.protocolVersion || manifest.protocolVersion === "generated-with-bundled-runtime") errors.push("protocolVersion is not pinned");

for (const [platform, expectedPaths] of Object.entries(platformsToVerify)) {
  const entry = manifest.platforms?.[platform];
  if (!entry) {
    errors.push(`${platform}: manifest entry is missing`);
    continue;
  }
  if (entry.path !== expectedPaths.binary) {
    errors.push(`${platform}: path must be ${expectedPaths.binary}`);
    continue;
  }
  if (entry.codeModeHostPath !== expectedPaths.codeModeHost) {
    errors.push(`${platform}: codeModeHostPath must be ${expectedPaths.codeModeHost}`);
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
    errors.push(`${platform}: sha256 is not pinned`);
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(entry.codeModeHostSha256 ?? "")) {
    errors.push(`${platform}: codeModeHostSha256 is not pinned`);
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? "")) {
    errors.push(`${platform}: source archive sha256 is not pinned`);
    continue;
  }
  if (!entry.sourceUrl?.startsWith("https://releases.openai.com/codex/releases/")) {
    errors.push(`${platform}: source URL is not an official OpenAI release`);
    continue;
  }
  try {
    const binaryUrl = new URL(entry.path, root);
    const bytes = await readFile(binaryUrl);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) errors.push(`${platform}: checksum mismatch`);
    if (!entry.path.endsWith(".exe")) accessSync(binaryUrl, constants.X_OK);

    const codeModeHostUrl = new URL(entry.codeModeHostPath, root);
    const codeModeHostBytes = await readFile(codeModeHostUrl);
    const actualCodeModeHost = createHash("sha256").update(codeModeHostBytes).digest("hex");
    if (actualCodeModeHost !== entry.codeModeHostSha256) errors.push(`${platform}: code-mode host checksum mismatch`);
    if (!entry.codeModeHostPath.endsWith(".exe")) accessSync(codeModeHostUrl, constants.X_OK);
    const packageMetadata = JSON.parse(await readFile(new URL(`${platform}/codex-package.json`, root), "utf8"));
    if (packageMetadata.version !== manifest.codexVersion) errors.push(`${platform}: package version mismatch`);
    if (packageMetadata.target !== expectedPaths.packageTarget) errors.push(`${platform}: package target mismatch`);
    if (packageMetadata.entrypoint !== expectedPaths.binary.slice(platform.length + 1)) errors.push(`${platform}: package entrypoint mismatch`);
    if (requireGitHubCli) {
      try {
        const githubMetadata = JSON.parse(await readFile(new URL(`${platform}/github-cli.json`, root), "utf8"));
        const expectedGitHubPath = `bin/${platform === "win32-x64" ? "gh.exe" : "gh"}`;
        if (githubMetadata.path !== expectedGitHubPath) errors.push(`${platform}: GitHub CLI path must be ${expectedGitHubPath}`);
        if (!/^\d+\.\d+\.\d+$/.test(githubMetadata.version ?? "")) errors.push(`${platform}: GitHub CLI version is invalid`);
        if (!/^[a-f0-9]{64}$/.test(githubMetadata.sha256 ?? "")) errors.push(`${platform}: GitHub CLI checksum is not pinned`);
        if (!/^[a-f0-9]{64}$/.test(githubMetadata.sourceSha256 ?? "")) errors.push(`${platform}: GitHub CLI source checksum is not pinned`);
        if (!githubMetadata.sourceUrl?.startsWith("https://github.com/cli/cli/releases/download/")) errors.push(`${platform}: GitHub CLI source URL is not official`);
        const githubBinaryUrl = new URL(`${platform}/${githubMetadata.path}`, root);
        const githubBytes = await readFile(githubBinaryUrl);
        const githubHash = createHash("sha256").update(githubBytes).digest("hex");
        if (githubHash !== githubMetadata.sha256) errors.push(`${platform}: GitHub CLI checksum mismatch`);
        if (!githubMetadata.path.endsWith(".exe")) accessSync(githubBinaryUrl, constants.X_OK);
      } catch (error) {
        errors.push(`${platform}: GitHub CLI is not ready; run pnpm github:sync (${error.code ?? error.message})`);
      }
    }
  } catch (error) {
    errors.push(`${platform}: runtime is unusable at ${path.normalize(entry.path)} (${error.code ?? error.message})`);
  }
}

if (!requestedTarget) {
  for (const platform of Object.keys(manifest.platforms ?? {})) {
    if (!expectedPlatforms[platform]) errors.push(`${platform}: unexpected platform entry`);
  }
}

if (errors.length) {
  console.error(["Codex runtime verification failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}
console.log(`Verified Codex ${manifest.codexVersion} for ${Object.keys(platformsToVerify).length} platform${Object.keys(platformsToVerify).length === 1 ? "" : "s"}.`);
