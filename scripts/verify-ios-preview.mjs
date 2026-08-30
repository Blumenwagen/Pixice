#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createSwiftUIStarter } from "../electron/ios/swiftui-starter.mjs";

const run = promisify(execFile);

async function collectSwiftFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSwiftFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".swift")) files.push(target);
  }
  return files.sort();
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("Skipped generated SwiftUI starter verification because Apple command-line tools are unavailable on this platform.");
    return;
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), "pixice-ios-preview-verification-"));
  try {
    const starter = await createSwiftUIStarter({
      workspaceRoot: workspace,
      relativeDirectory: "VerificationApp",
      name: "Pixice Verification",
      organizationIdentifier: "com.pixice.verification"
    });
    const swiftFiles = await collectSwiftFiles(starter.destination);
    if (!swiftFiles.length) throw new Error("The generated SwiftUI starter contains no Swift files");
    const emptyResourceDirectory = path.join(workspace, "empty-swift-resources");
    await mkdir(emptyResourceDirectory);

    for (const swiftFile of swiftFiles) {
      await run("swiftc", [
        "-frontend",
        "-parse",
        "-nostdimport",
        "-resource-dir",
        emptyResourceDirectory,
        swiftFile
      ]);
    }

    const projectPath = path.join(starter.destination, `${starter.productName}.xcodeproj`, "project.pbxproj");
    const schemePath = path.join(
      starter.destination,
      `${starter.productName}.xcodeproj`,
      "xcshareddata",
      "xcschemes",
      `${starter.productName}.xcscheme`
    );
    await run("plutil", ["-lint", projectPath]);
    await run("xmllint", ["--noout", schemePath]);

    const scheme = await readFile(schemePath, "utf8");
    const testableReference = scheme.match(/<TestableReference[\s\S]*?<\/TestableReference>/)?.[0];
    const testBuildables = testableReference?.match(/<BuildableReference/g)?.length ?? 0;
    if (testBuildables !== 1) throw new Error(`Expected one test buildable in the shared scheme; found ${testBuildables}`);

    console.log(`Verified generated SwiftUI starter: ${swiftFiles.length} Swift files, project plist, and shared scheme.`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
