import { access, readFile } from "node:fs/promises";

const repositoryRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", repositoryRoot), "utf8"));
const builderConfig = (await import(new URL("../electron-builder.config.cjs", import.meta.url))).default;
const errors = [];
const warnings = [];
const expectedIdentity = {
  name: "pixice",
  appId: "com.blumenwagen.pixice",
  productName: "Pixice",
  owner: "Blumenwagen",
  repo: "Pixice"
};
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
const target = process.env.PIXICE_RUNTIME_TARGET || `${process.platform}-${process.arch}`;

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

requireValue(packageJson.name === expectedIdentity.name, `package name must be ${expectedIdentity.name}`);
requireValue(packageJson.version !== "0.0.0", "package version must not be 0.0.0");
requireValue(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version), "package version must be valid semver");
requireValue(builderConfig.appId === expectedIdentity.appId, `appId must be ${expectedIdentity.appId}`);
requireValue(builderConfig.productName === expectedIdentity.productName, `productName must be ${expectedIdentity.productName}`);
requireValue(builderConfig.publish?.[0]?.owner === expectedIdentity.owner, `publish owner must be ${expectedIdentity.owner}`);
requireValue(builderConfig.publish?.[0]?.repo === expectedIdentity.repo, `publish repo must be ${expectedIdentity.repo}`);
requireValue(supportedTargets.has(target), `unsupported PIXICE_RUNTIME_TARGET ${target}`);

for (const relativePath of [
  "THIRD_PARTY_NOTICES.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "RELEASE.md",
  "resources/app-update.yml",
  "resources/runtime/manifest.json"
]) {
  try {
    await access(new URL(relativePath, repositoryRoot));
  } catch {
    errors.push(`${relativePath} is missing`);
  }
}

try {
  await access(new URL("LICENSE", repositoryRoot));
  errors.push("LICENSE must remain absent until Pixice's product license is chosen");
} catch {
  // The beta intentionally has no Pixice product license.
}

if (process.env.GITHUB_REF_TYPE === "tag") {
  requireValue(process.env.GITHUB_REF_NAME === `v${packageJson.version}`, `tag must be v${packageJson.version}`);
}

if (process.env.PIXICE_REQUIRE_SIGNING === "1") {
  if (target.startsWith("darwin-")) {
    requireValue(Boolean(process.env.CSC_LINK), "macOS signing requires CSC_LINK");
    requireValue(Boolean(process.env.CSC_KEY_PASSWORD), "macOS signing requires CSC_KEY_PASSWORD");
    const hasApiKey = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
    const hasAppleId = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
    requireValue(hasApiKey || hasAppleId, "macOS notarization requires Apple API key credentials or Apple ID credentials");
  } else if (target === "win32-x64") {
    requireValue(Boolean(process.env.WIN_CSC_LINK), "Windows signing requires WIN_CSC_LINK");
    requireValue(Boolean(process.env.WIN_CSC_KEY_PASSWORD), "Windows signing requires WIN_CSC_KEY_PASSWORD");
  }
} else {
  warnings.push("signing credential checks were skipped; set PIXICE_REQUIRE_SIGNING=1 for a publish build");
}

if (warnings.length) console.warn(warnings.map((warning) => `Warning: ${warning}`).join("\n"));
if (errors.length) {
  console.error(["Pixice release preflight failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log(`Pixice ${packageJson.version} is ready to package for ${target}.`);
