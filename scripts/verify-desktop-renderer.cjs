const { accessSync, readFileSync } = require("node:fs");
const path = require("node:path");

function verifyDesktopRenderer(appDirectory = path.resolve(__dirname, "..")) {
  const indexPath = path.join(appDirectory, "dist", "client", "index.html");
  const html = readFileSync(indexPath, "utf8");
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const assets = references.filter((reference) => reference.includes("assets/"));

  if (assets.length === 0) {
    throw new Error(`Desktop renderer verification failed: ${indexPath} contains no asset references`);
  }

  const invalid = assets.filter((reference) => !reference.startsWith("./assets/"));
  if (invalid.length > 0) {
    throw new Error(
      `Desktop renderer verification failed: Electron file URLs require ./assets/ references; found ${invalid.join(", ")}`,
    );
  }

  for (const reference of assets) {
    const assetPath = path.resolve(path.dirname(indexPath), reference);
    accessSync(assetPath);
  }

  return { indexPath, assets };
}

async function verifyDesktopRendererBeforePack(context = {}) {
  const result = verifyDesktopRenderer(context.appDir);
  console.log(`Verified desktop renderer assets in ${result.indexPath}`);
}

module.exports = verifyDesktopRendererBeforePack;
module.exports.verifyDesktopRenderer = verifyDesktopRenderer;

if (require.main === module) {
  verifyDesktopRendererBeforePack().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
