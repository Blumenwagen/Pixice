#!/usr/bin/env node
// Fills in the `sha256` values the transcription catalog is missing.
//
// GitHub only publishes a digest for release assets uploaded after it added
// the field, so the older sherpa-onnx archives arrive without one. Those
// entries ship as `sha256: null` and are verified by byte length alone. Run
// this once per catalog change to download each unpinned archive, hash it, and
// write the value back into electron/transcription/catalog.mjs.
//
//   node scripts/pin-transcription-models.mjs            # pin what is missing
//   node scripts/pin-transcription-models.mjs --verify   # re-check pinned ones
//   node scripts/pin-transcription-models.mjs --id whisper-tiny

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TRANSCRIPTION_MODELS } from "../electron/transcription/catalog.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repositoryRoot, "electron", "transcription", "catalog.mjs");
const verify = process.argv.includes("--verify");
const onlyId = process.argv.find((argument) => argument.startsWith("--id="))?.slice(5)
  ?? (process.argv.includes("--id") ? process.argv[process.argv.indexOf("--id") + 1] : null);

async function hashArchive({ url, bytes }) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash("sha256");
  let received = 0;
  let nextMark = 10;
  for await (const chunk of Readable.fromWeb(response.body)) {
    hash.update(chunk);
    received += chunk.length;
    const percent = Math.round((received / bytes) * 100);
    if (percent >= nextMark) { nextMark = percent + 10; process.stderr.write(`    ${percent}%\n`); }
  }
  if (received !== bytes) throw new Error(`Expected ${bytes} bytes but received ${received}. Update the catalog size first.`);
  return hash.digest("hex");
}

const targets = TRANSCRIPTION_MODELS
  .filter((model) => (onlyId ? model.id === onlyId : true))
  .filter((model) => (verify ? Boolean(model.archive.sha256) : !model.archive.sha256));

if (targets.length === 0) {
  console.log(verify ? "No pinned models to verify." : "Every catalog model already has a pinned digest.");
  process.exit(0);
}

let source = await readFile(catalogPath, "utf8");
let changed = 0;
let mismatched = 0;

for (const model of targets) {
  console.log(`${verify ? "Verifying" : "Pinning"} ${model.id} (${(model.archive.bytes / 1048576).toFixed(0)} MB)`);
  const digest = await hashArchive(model.archive);

  if (verify) {
    if (digest === model.archive.sha256) {
      console.log(`  ok ${digest}`);
    } else {
      mismatched += 1;
      console.error(`  MISMATCH\n    catalog:   ${model.archive.sha256}\n    downloaded: ${digest}`);
    }
    continue;
  }

  // Replace the null digest inside this model's archive block only, so two
  // entries that share a byte size cannot overwrite each other.
  const block = new RegExp(`(name: "${model.archive.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"[\\s\\S]{0,400}?sha256: )null`);
  if (!block.test(source)) {
    console.error(`  could not locate the sha256 line for ${model.id} in catalog.mjs`);
    continue;
  }
  source = source.replace(block, `$1"${digest}"`);
  changed += 1;
  console.log(`  ${digest}`);
}

if (verify) {
  if (mismatched > 0) { console.error(`\n${mismatched} archive(s) no longer match the catalog.`); process.exit(1); }
  console.log("\nAll pinned digests match.");
  process.exit(0);
}

if (changed > 0) {
  await writeFile(catalogPath, source);
  console.log(`\nPinned ${changed} model(s) in electron/transcription/catalog.mjs.`);
} else {
  console.log("\nNothing was written.");
}
