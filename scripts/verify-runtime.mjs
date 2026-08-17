import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("../resources/runtime/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const errors = [];

for (const [platform, entry] of Object.entries(manifest.platforms)) {
  if (!entry.sha256 || entry.sha256 === "REQUIRED_AT_RELEASE") {
    errors.push(`${platform}: sha256 is not pinned`);
    continue;
  }
  try {
    const bytes = await readFile(new URL(entry.path, root));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) errors.push(`${platform}: checksum mismatch`);
  } catch {
    errors.push(`${platform}: runtime binary is missing at ${path.normalize(entry.path)}`);
  }
}

if (errors.length) {
  console.error(["Codex runtime verification failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}
console.log(`Verified Codex ${manifest.codexVersion} for ${Object.keys(manifest.platforms).length} platforms.`);
