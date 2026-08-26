const path = require("node:path");

const supportedRuntimeTargets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "linux-x64"
]);
const runtimeTarget = process.env.PIXICE_RUNTIME_TARGET || `${process.platform}-${process.arch}`;

if (!supportedRuntimeTargets.has(runtimeTarget)) {
  throw new Error(`Unsupported Pixice runtime target: ${runtimeTarget}`);
}

module.exports = {
  appId: "com.blumenwagen.pixice",
  productName: "Pixice",
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  icon: "build/icon.png",
  asar: true,
  npmRebuild: false,
  beforePack: "scripts/verify-desktop-renderer.cjs",
  afterPack: "scripts/after-pack-macos.cjs",
  directories: {
    output: "release"
  },
  publish: [
    {
      provider: "github",
      owner: "Blumenwagen",
      repo: "Pixice",
      releaseType: "release"
    }
  ],
  files: [
    "dist/client/**/*",
    "electron/**/*",
    "package.json"
  ],
  extraResources: [
    { from: "build/icon.png", to: "app-icon.png" },
    { from: "resources/app-update.yml", to: "app-update.yml" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "PRIVACY.md", to: "PRIVACY.md" },
    { from: "SUPPORT.md", to: "SUPPORT.md" },
    { from: "resources/runtime/manifest.json", to: "runtime/manifest.json" },
    {
      from: "resources/runtime/pixice-developer-instructions.md",
      to: "runtime/pixice-developer-instructions.md"
    },
    { from: "resources/runtime/agent-behaviors", to: "runtime/agent-behaviors" },
    {
      from: path.join("resources", "runtime", runtimeTarget),
      to: path.join("runtime", runtimeTarget)
    }
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true
  },
  win: {
    target: ["nsis"]
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Development"
  }
};
