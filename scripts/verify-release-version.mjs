import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;

if (refType !== "tag") {
  console.log("No tag ref detected; release version check skipped for this manual build.");
  process.exit(0);
}

const expectedTag = `v${packageJson.version}`;
if (packageJson.version === "0.0.0") throw new Error("Refusing to publish placeholder package version 0.0.0");
if (refName !== expectedTag) throw new Error(`Release tag ${refName} does not match package version ${expectedTag}`);
console.log(`Release tag ${refName} matches package version ${packageJson.version}.`);
