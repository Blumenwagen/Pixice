const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { listPackage } = require("@electron/asar");

const unusedPrivacyDescriptions = [
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription"
];

const forbiddenAsarPaths = [
  /(^|\/)electron\/updater\/codex-updater\.mjs$/i,
  /(^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-[^/]+\//i,
  /(^|\/)resources\/runtime\/(?:darwin|linux|win32)-[^/]+\//i
];
const forbiddenResourceNames = new Set([
  "claude",
  "claude.exe",
  "codex",
  "codex.exe",
  "codex-app-server",
  "codex-app-server.exe",
  "codex-code-mode-host",
  "codex-code-mode-host.exe"
]);

function resourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function packagedResourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...packagedResourceFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function verifyProviderFreePackage(context) {
  const resources = resourcesDirectory(context);
  const asarPath = path.join(resources, "app.asar");
  const asarEntries = listPackage(asarPath);
  const forbiddenEntries = asarEntries.filter((entry) => forbiddenAsarPaths.some((pattern) => pattern.test(entry)));
  const forbiddenResources = packagedResourceFiles(resources)
    .filter((filename) => filename !== asarPath && statSync(filename).isFile())
    .filter((filename) => forbiddenResourceNames.has(path.basename(filename).toLowerCase()));
  if (forbiddenEntries.length || forbiddenResources.length) {
    throw new Error([
      "Packaged Pixice contains a provider runtime:",
      ...forbiddenEntries.map((entry) => `app.asar:${entry}`),
      ...forbiddenResources.map((entry) => path.relative(resources, entry))
    ].join("\n"));
  }
  console.log(`Verified provider-free package: ${asarEntries.length} app.asar entries, ${packagedResourceFiles(resources).length} resource files`);
}

module.exports = async function removeUnusedMacPrivacyDescriptions(context) {
  verifyProviderFreePackage(context);
  if (context.electronPlatformName !== "darwin") return;
  const plistPath = path.join(context.appOutDir, "Pixice.app", "Contents", "Info.plist");
  for (const key of unusedPrivacyDescriptions) {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath], { stdio: "pipe" });
    } catch (error) {
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      if (!/Does Not Exist/i.test(output)) throw error;
    }
  }
};

module.exports.verifyProviderFreePackage = verifyProviderFreePackage;
