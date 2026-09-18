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
    "package.json",
    "!node_modules/@anthropic-ai/claude-agent-sdk-*/**/*"
  ],
  // The speech addon resolves its sibling dylibs through an @loader_path
  // rpath, so the .node file and the libraries beside it must stay together
  // on a real filesystem rather than inside the asar.
  asarUnpack: [
    "**/node_modules/sherpa-onnx-node/**",
    "**/node_modules/sherpa-onnx-{darwin,linux,win}-*/**"
  ],
  extraResources: [
    { from: "build/icon.png", to: "app-icon.png" },
    { from: "resources/app-update.yml", to: "app-update.yml" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "PRIVACY.md", to: "PRIVACY.md" },
    { from: "SUPPORT.md", to: "SUPPORT.md" },
    {
      from: "resources/runtime/pixice-developer-instructions.md",
      to: "runtime/pixice-developer-instructions.md"
    },
    { from: "resources/runtime/agent-behaviors", to: "runtime/agent-behaviors" }
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    extendInfo: {
      NSMicrophoneUsageDescription: "Pixice records audio only while you are dictating a message, and transcribes it on this Mac."
    },
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
