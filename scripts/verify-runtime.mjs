import { createHash } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("../resources/runtime/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const errors = [];
const expectedPlatforms = {
  "darwin-arm64": "darwin-arm64/codex",
  "darwin-x64": "darwin-x64/codex",
  "win32-x64": "win32-x64/codex.exe",
  "linux-x64": "linux-x64/codex"
};

if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schemaVersion");
if (!manifest.codexVersion || manifest.codexVersion === "PIN_AT_RELEASE") errors.push("codexVersion is not pinned");
if (!manifest.protocolVersion || manifest.protocolVersion === "generated-with-bundled-runtime") errors.push("protocolVersion is not pinned");

for (const [platform, expectedPath] of Object.entries(expectedPlatforms)) {
  const entry = manifest.platforms?.[platform];
  if (!entry) {
    errors.push(`${platform}: manifest entry is missing`);
    continue;
  }
  if (entry.path !== expectedPath) {
    errors.push(`${platform}: path must be ${expectedPath}`);
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
    errors.push(`${platform}: sha256 is not pinned`);
    continue;
  }
  try {
    const binaryUrl = new URL(entry.path, root);
    const bytes = await readFile(binaryUrl);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) errors.push(`${platform}: checksum mismatch`);
    if (!entry.path.endsWith(".exe")) accessSync(binaryUrl, constants.X_OK);
  } catch (error) {
    errors.push(`${platform}: runtime is unusable at ${path.normalize(entry.path)} (${error.code ?? error.message})`);
  }
}

for (const platform of Object.keys(manifest.platforms ?? {})) {
  if (!expectedPlatforms[platform]) errors.push(`${platform}: unexpected platform entry`);
}

if (errors.length) {
  console.error(["Codex runtime verification failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}
console.log(`Verified Codex ${manifest.codexVersion} for ${Object.keys(expectedPlatforms).length} platforms.`);
