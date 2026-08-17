import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release");
const entries = await readdir(releaseDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS.txt")
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (!files.length) throw new Error(`No release artifacts found in ${releaseDir}`);

const checksum = (file) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path.join(releaseDir, file));
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(`${hash.digest("hex")}  ${file}`));
});

const lines = await Promise.all(files.map(checksum));
await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Generated checksums for ${files.length} release artifact${files.length === 1 ? "" : "s"}.`);
