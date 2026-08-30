import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { runIosCommand } from "./ios-environment.mjs";

const SKIP_DIRECTORIES = new Set([".git", ".build", "build", "DerivedData", "node_modules"]);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalRoots(roots) {
  return [...new Set((roots ?? []).map((root) => realpathSync(root)))];
}

export function resolveXcodeContainer(containerPath, roots) {
  const canonical = canonicalRoots(roots);
  if (!canonical.length) throw new Error("At least one project root is required");
  const candidate = path.isAbsolute(containerPath)
    ? path.resolve(containerPath)
    : path.resolve(canonical[0], containerPath);
  const resolved = realpathSync(candidate);
  if (!canonical.some((root) => isWithin(root, resolved))) throw new Error("Xcode container is outside the selected project");
  if (!statSync(resolved).isDirectory()) throw new Error("Xcode container must be a directory");
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".xcodeproj" && extension !== ".xcworkspace") {
    throw new Error("Select an .xcodeproj or .xcworkspace container");
  }
  return {
    path: resolved,
    kind: extension === ".xcworkspace" ? "workspace" : "project",
    root: canonical.find((root) => isWithin(root, resolved))
  };
}

export function findXcodeContainers(roots, { maxDepth = 4 } = {}) {
  const canonical = canonicalRoots(roots);
  const found = [];

  const visit = (directory, root, depth) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      if (extension === ".xcworkspace" || extension === ".xcodeproj") {
        found.push({
          path: target,
          relativePath: path.relative(root, target),
          kind: extension === ".xcworkspace" ? "workspace" : "project"
        });
        continue;
      }
      visit(target, root, depth + 1);
    }
  };

  canonical.forEach((root) => visit(root, root, 0));
  return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function containerArguments(container) {
  return [container.kind === "workspace" ? "-workspace" : "-project", container.path];
}

function parseJson(output, label) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function listXcodeSchemes(container, { runCommand = runIosCommand } = {}) {
  const result = await runCommand("xcodebuild", [...containerArguments(container), "-list", "-json"]);
  const value = parseJson(result.stdout, "xcodebuild -list");
  const schemes = value.workspace?.schemes ?? value.project?.schemes ?? [];
  return [...new Set(schemes.map((scheme) => String(scheme).trim()).filter(Boolean))].sort();
}

export async function discoverXcodeProjects({ roots, runCommand = runIosCommand, maxDepth = 4 }) {
  const containers = findXcodeContainers(roots, { maxDepth });
  const discovered = [];
  for (const container of containers) {
    try {
      discovered.push({ ...container, schemes: await listXcodeSchemes(container, { runCommand }), error: null });
    } catch (error) {
      discovered.push({ ...container, schemes: [], error: error.message });
    }
  }
  return discovered;
}

export async function resolveAppBuildSettings({
  container,
  scheme,
  configuration = "Debug",
  simulatorUdid,
  derivedDataPath,
  runCommand = runIosCommand
}) {
  const args = [
    ...containerArguments(container),
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", `id=${simulatorUdid}`,
    "-derivedDataPath", derivedDataPath,
    "-showBuildSettings",
    "-json"
  ];
  const result = await runCommand("xcodebuild", args, { timeoutMs: 120_000 });
  const entries = parseJson(result.stdout, "xcodebuild -showBuildSettings");
  if (!Array.isArray(entries)) throw new Error("xcodebuild did not return build settings entries");
  const candidate = entries.find((entry) => entry.buildSettings?.WRAPPER_EXTENSION === "app")
    ?? entries.find((entry) => entry.buildSettings?.FULL_PRODUCT_NAME?.endsWith(".app"));
  const settings = candidate?.buildSettings;
  if (!settings) throw new Error(`Scheme ${scheme} does not expose an application product`);
  const targetBuildDirectory = settings.TARGET_BUILD_DIR;
  const wrapperName = settings.FULL_PRODUCT_NAME || settings.WRAPPER_NAME;
  const bundleIdentifier = settings.PRODUCT_BUNDLE_IDENTIFIER;
  if (!targetBuildDirectory || !wrapperName || !bundleIdentifier) {
    throw new Error(`Scheme ${scheme} returned incomplete application build settings`);
  }
  return {
    target: candidate.target ?? null,
    productName: settings.PRODUCT_NAME ?? path.basename(wrapperName, ".app"),
    appPath: path.join(targetBuildDirectory, wrapperName),
    bundleIdentifier,
    targetBuildDirectory,
    wrapperName
  };
}

export function xcodeContainerArguments(container) {
  return containerArguments(container);
}
