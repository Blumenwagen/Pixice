#!/usr/bin/env node

import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const [arm64Path, x64Path, outputPath] = process.argv.slice(2).map((value) => value && path.resolve(value));
if (!arm64Path || !x64Path || !outputPath) {
  throw new Error("Usage: merge-mac-update-metadata.mjs <arm64.yml> <x64.yml> <output.yml>");
}

function scalar(value) {
  const trimmed = value.trim();
  if (/^['\"].*['\"]$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseBuilderMetadata(contents, source) {
  const result = { files: [] };
  let currentFile = null;
  let inFiles = false;
  for (const line of contents.split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (topLevel) {
      inFiles = false;
      result[topLevel[1]] = scalar(topLevel[2]);
      continue;
    }
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const first = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (first) {
      currentFile = { [first[1]]: scalar(first[2]) };
      result.files.push(currentFile);
      continue;
    }
    const property = line.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (property && currentFile) currentFile[property[1]] = scalar(property[2]);
  }
  if (!result.version || !result.files.length) throw new Error(`Could not parse electron-builder metadata: ${source}`);
  return result;
}

const arm64 = parseBuilderMetadata(await readFile(arm64Path, "utf8"), arm64Path);
const x64 = parseBuilderMetadata(await readFile(x64Path, "utf8"), x64Path);
if (arm64.version !== x64.version) throw new Error("macOS update metadata versions do not match");
const files = [...arm64.files, ...x64.files];
if (!files.some((file) => String(file.url).includes("arm64"))) throw new Error("arm64 macOS update file is missing");
if (!files.some((file) => String(file.url).includes("x64"))) throw new Error("x64 macOS update file is missing");

await writeFile(outputPath, `${JSON.stringify({
  version: arm64.version,
  files,
  path: arm64.path,
  sha512: arm64.sha512,
  releaseDate: arm64.releaseDate || x64.releaseDate
}, null, 2)}\n`);
await Promise.all([unlink(arm64Path), unlink(x64Path)]);
console.log(`Merged macOS update metadata for Pixice ${arm64.version}.`);
