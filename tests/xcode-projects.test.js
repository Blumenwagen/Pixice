import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverXcodeProjects,
  findXcodeContainers,
  resolveAppBuildSettings,
  resolveXcodeContainer
} from "../electron/ios/xcode-projects.mjs";

function projectTree() {
  const root = mkdtempSync(path.join(tmpdir(), "pixice-xcode-projects-"));
  mkdirSync(path.join(root, "App.xcodeproj"));
  mkdirSync(path.join(root, "Nested", "Demo.xcworkspace"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "Ignored.xcodeproj"), { recursive: true });
  return root;
}

describe("Xcode project discovery", () => {
  it("finds bounded project containers and skips generated directories", () => {
    const root = projectTree();
    const canonicalRoot = realpathSync(root);

    expect(findXcodeContainers([root])).toEqual([
      { path: path.join(canonicalRoot, "App.xcodeproj"), relativePath: "App.xcodeproj", kind: "project" },
      { path: path.join(canonicalRoot, "Nested", "Demo.xcworkspace"), relativePath: path.join("Nested", "Demo.xcworkspace"), kind: "workspace" }
    ]);
  });

  it("rejects containers outside project roots", () => {
    const root = projectTree();
    const external = projectTree();

    expect(resolveXcodeContainer("App.xcodeproj", [root])).toMatchObject({ kind: "project", root: realpathSync(root) });
    expect(() => resolveXcodeContainer(path.join(external, "App.xcodeproj"), [root]))
      .toThrow("outside the selected project");
  });

  it("collects shared schemes while retaining per-container errors", async () => {
    const root = projectTree();
    const runCommand = vi.fn(async (_command, args) => {
      if (args.some((argument) => argument.endsWith?.("App.xcodeproj"))) {
        return { stdout: JSON.stringify({ project: { schemes: ["Demo", "Demo"] } }) };
      }
      throw new Error("workspace is damaged");
    });

    const containers = await discoverXcodeProjects({ roots: [root], runCommand });

    expect(containers[0]).toMatchObject({ relativePath: "App.xcodeproj", schemes: ["Demo"], error: null });
    expect(containers[1]).toMatchObject({ relativePath: path.join("Nested", "Demo.xcworkspace"), schemes: [], error: "workspace is damaged" });
  });

  it("resolves the application product from JSON build settings", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify([
        { target: "Library", buildSettings: { PRODUCT_NAME: "Library" } },
        {
          target: "Demo",
          buildSettings: {
            WRAPPER_EXTENSION: "app",
            FULL_PRODUCT_NAME: "Demo.app",
            PRODUCT_NAME: "Demo",
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.demo",
            TARGET_BUILD_DIR: "/tmp/Derived/Products"
          }
        }
      ])
    }));

    const result = await resolveAppBuildSettings({
      container: { kind: "project", path: "/project/Demo.xcodeproj" },
      scheme: "Demo",
      simulatorUdid: "SIM-1",
      derivedDataPath: "/tmp/Derived",
      runCommand
    });

    expect(result).toEqual({
      target: "Demo",
      productName: "Demo",
      appPath: "/tmp/Derived/Products/Demo.app",
      bundleIdentifier: "com.example.demo",
      targetBuildDirectory: "/tmp/Derived/Products",
      wrapperName: "Demo.app"
    });
    expect(runCommand.mock.calls[0][1]).toContain("-showBuildSettings");
  });
});
