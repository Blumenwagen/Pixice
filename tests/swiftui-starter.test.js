import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSwiftUIStarter,
  planSwiftUIStarter,
  sanitizeDisplayName,
  sanitizeModuleName,
  sanitizeOrganizationIdentifier,
  sanitizeProductName
} from "../electron/ios/swiftui-starter.mjs";

async function tempWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), "pixice-swiftui-starter-"));
}

describe("SwiftUI starter planning", () => {
  it("sanitizes names and creates reverse-DNS defaults", () => {
    expect(sanitizeProductName("  42 café tracker! ")).toBe("App42CafeTracker");
    expect(sanitizeModuleName("switch")).toBe("AppSwitch");
    expect(sanitizeDisplayName("My / Cool \\ App")).toBe("My Cool App");
    expect(sanitizeOrganizationIdentifier("CH.Example Studio")).toBe("ch.example-studio");

    expect(planSwiftUIStarter({ name: "42 café tracker!", organizationIdentifier: "ch.example" })).toMatchObject({
      productName: "App42CafeTracker",
      moduleName: "App42CafeTracker",
      displayName: "42 cafe tracker",
      bundleIdentifier: "ch.example.app42cafetracker",
      deploymentTarget: "17.0"
    });
  });

  it("renders a deterministic, self-contained Xcode project", () => {
    const first = planSwiftUIStarter({ name: "Focus Bloom", moduleName: "FocusKit", organizationIdentifier: "com.example" });
    const second = planSwiftUIStarter({ name: "Focus Bloom", moduleName: "FocusKit", organizationIdentifier: "com.example" });

    expect(first).toEqual(second);
    expect(Object.keys(first.files).sort()).toMatchInlineSnapshot(`
      [
        ".pixice-ios-starter.json",
        "FocusBloom.xcodeproj/project.pbxproj",
        "FocusBloom.xcodeproj/xcshareddata/xcschemes/FocusBloom.xcscheme",
        "FocusBloom/AppMetadata.swift",
        "FocusBloom/ContentView.swift",
        "FocusBloom/FocusBloomApp.swift",
        "FocusKitTests/FocusKitTests.swift",
        "README.md",
      ]
    `);
    expect(first.files["FocusBloom/ContentView.swift"]).toContain("#Preview(\"Default\")");
    expect(first.files["FocusBloom/ContentView.swift"]).toContain(".accessibilityIdentifier(\"counter.increment\")");
    expect(first.files["FocusBloom.xcodeproj/project.pbxproj"]).toContain("productType = \"com.apple.product-type.application\"");
    expect(first.files["FocusBloom.xcodeproj/project.pbxproj"]).toContain("productType = \"com.apple.product-type.bundle.unit-test\"");
    expect(first.files["FocusBloom.xcodeproj/project.pbxproj"]).toContain("PRODUCT_MODULE_NAME = FocusKit");
    expect(first.files["FocusBloom.xcodeproj/xcshareddata/xcschemes/FocusBloom.xcscheme"]).toContain("FocusKitTests.xctest");
    const testableReference = first.files["FocusBloom.xcodeproj/xcshareddata/xcschemes/FocusBloom.xcscheme"]
      .match(/<TestableReference[\s\S]*?<\/TestableReference>/)?.[0];
    expect(testableReference?.match(/<BuildableReference/g)).toHaveLength(1);
    expect(first.files["README.md"]).toContain(first.buildCommand);
    expect(first.buildCommand).toBe("xcodebuild -project \"FocusBloom.xcodeproj\" -scheme \"FocusBloom\" -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath .pixice-derived-data CODE_SIGNING_ALLOWED=NO build");
  });

  it("rejects invalid identifiers and unsupported deployment targets", () => {
    expect(() => planSwiftUIStarter({ name: "App", bundleIdentifier: "not-reverse-dns" })).toThrow("three reverse-DNS segments");
    expect(() => planSwiftUIStarter({ name: "App", deploymentTarget: "16.0" })).toThrow("iOS 17.0 or newer");
    expect(() => planSwiftUIStarter({ name: "***" })).toThrow("at least one letter or number");
  });
});

describe("SwiftUI starter creation", () => {
  it("writes the planned project and returns build metadata", async () => {
    const workspaceRoot = await tempWorkspace();
    const result = await createSwiftUIStarter({
      workspaceRoot,
      relativeDirectory: "apps/focus",
      name: "Focus Bloom",
      organizationIdentifier: "com.example"
    });
    const resolvedWorkspace = await realpath(workspaceRoot);

    expect(result).toMatchObject({
      destination: path.join(resolvedWorkspace, "apps/focus"),
      productName: "FocusBloom",
      bundleIdentifier: "com.example.focusbloom",
      deploymentTarget: "17.0"
    });
    expect(result.files).toHaveLength(8);
    expect(await readFile(path.join(result.destination, "FocusBloom/FocusBloomApp.swift"), "utf8")).toContain("struct FocusBloomApp: App");
    expect(JSON.parse(await readFile(path.join(result.destination, ".pixice-ios-starter.json"), "utf8"))).toMatchObject({
      generator: "pixice",
      kind: "swiftui-ios-starter",
      productName: "FocusBloom"
    });
  });

  it("blocks traversal, symlink escapes, and overwrite by default", async () => {
    const workspaceRoot = await tempWorkspace();
    const outside = await tempWorkspace();
    await symlink(outside, path.join(workspaceRoot, "linked"));

    await expect(createSwiftUIStarter({ workspaceRoot, relativeDirectory: "../outside", name: "App" })).rejects.toThrow("path traversal");
    await expect(createSwiftUIStarter({ workspaceRoot, relativeDirectory: "linked/app", name: "App" })).rejects.toThrow("symbolic link");

    await createSwiftUIStarter({ workspaceRoot, relativeDirectory: "existing", name: "App" });
    await expect(createSwiftUIStarter({ workspaceRoot, relativeDirectory: "existing", name: "App" })).rejects.toThrow("already exists");
  });

  it("regenerates marked starters but refuses arbitrary directories", async () => {
    const workspaceRoot = await tempWorkspace();
    await createSwiftUIStarter({ workspaceRoot, relativeDirectory: "starter", name: "App" });
    await writeFile(path.join(workspaceRoot, "starter/App/ContentView.swift"), "changed", "utf8");

    await createSwiftUIStarter({ workspaceRoot, relativeDirectory: "starter", name: "App", overwrite: true });
    expect(await readFile(path.join(workspaceRoot, "starter/App/ContentView.swift"), "utf8")).toContain("#Preview");

    await mkdir(path.join(workspaceRoot, "handmade"));
    await writeFile(path.join(workspaceRoot, "handmade/project.pbxproj"), "user project", "utf8");
    await expect(createSwiftUIStarter({ workspaceRoot, relativeDirectory: "handmade", name: "App", overwrite: true }))
      .rejects.toThrow("not a Pixice SwiftUI starter");
    expect(await readFile(path.join(workspaceRoot, "handmade/project.pbxproj"), "utf8")).toBe("user project");
  });
});
