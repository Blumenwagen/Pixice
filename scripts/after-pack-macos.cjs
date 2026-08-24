const { execFileSync } = require("node:child_process");
const path = require("node:path");

const unusedPrivacyDescriptions = [
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription"
];

module.exports = async function removeUnusedMacPrivacyDescriptions(context) {
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
