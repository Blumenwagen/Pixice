import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const STARTER_KIND = "swiftui-ios-starter";
const MARKER_FILE = ".pixice-ios-starter.json";
const DEFAULT_ORGANIZATION_IDENTIFIER = "com.pixice.generated";
const DEFAULT_DEPLOYMENT_TARGET = "17.0";
const SWIFT_RESERVED_WORDS = new Set([
  "actor", "associatedtype", "break", "case", "catch", "class", "continue", "default",
  "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let",
  "nil", "nonisolated", "open", "operator", "precedencegroup", "private", "protocol", "public",
  "repeat", "rethrows", "return", "self", "some", "static", "struct", "subscript", "super",
  "switch", "throws", "true", "try", "typealias", "var", "where", "while"
]);

function cleanTokens(value, label) {
  const text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error(`${label} must contain at least one letter or number`);
  return tokens;
}

function swiftIdentifier(value, label) {
  const identifier = cleanTokens(value, label)
    .map((token) => `${token[0].toUpperCase()}${token.slice(1)}`)
    .join("")
    .slice(0, 64);
  const prefixed = /^\d/.test(identifier) ? `App${identifier}` : identifier;
  return SWIFT_RESERVED_WORDS.has(prefixed.toLowerCase()) ? `App${prefixed}` : prefixed;
}

export function sanitizeProductName(value) {
  return swiftIdentifier(value, "Product name");
}

export function sanitizeModuleName(value) {
  return swiftIdentifier(value, "Module name");
}

export function sanitizeDisplayName(value) {
  return cleanTokens(value, "Display name").join(" ").slice(0, 80);
}

function bundleSegment(value, label) {
  const segment = cleanTokens(value, label).join("-").toLowerCase().slice(0, 63);
  return /^\d/.test(segment) ? `app-${segment}` : segment;
}

export function sanitizeOrganizationIdentifier(value = DEFAULT_ORGANIZATION_IDENTIFIER) {
  const segments = String(value ?? "").split(".").filter(Boolean).map((segment) => bundleSegment(segment, "Organization identifier"));
  if (segments.length < 2) throw new Error("Organization identifier must contain at least two reverse-DNS segments");
  return segments.join(".");
}

function validateBundleIdentifier(value) {
  const identifier = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*){2,}$/.test(identifier)) {
    throw new Error("Bundle identifier must use at least three reverse-DNS segments containing letters, numbers, or hyphens");
  }
  return identifier.toLowerCase();
}

function validateDeploymentTarget(value) {
  const target = String(value ?? DEFAULT_DEPLOYMENT_TARGET).trim();
  if (!/^(?:1[7-9]|[2-9]\d)(?:\.\d{1,2})?$/.test(target)) {
    throw new Error("Deployment target must be iOS 17.0 or newer, such as 17.0");
  }
  return target.includes(".") ? target : `${target}.0`;
}

function pbxId(seed, role) {
  return createHash("sha1").update(`${seed}:${role}`).digest("hex").slice(0, 24).toUpperCase();
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function swiftString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function renderProject(config) {
  const { productName, moduleName, displayName, bundleIdentifier, deploymentTarget } = config;
  const seed = `${productName}:${moduleName}:${bundleIdentifier}`;
  const id = (role) => pbxId(seed, role);
  const appFile = `${productName}App.swift`;
  const testFile = `${moduleName}Tests.swift`;
  const ids = {
    appBuild: id("app-build"), contentBuild: id("content-build"), metadataBuild: id("metadata-build"), testBuild: id("test-build"),
    appFile: id("app-file"), contentFile: id("content-file"), metadataFile: id("metadata-file"), testFile: id("test-file"),
    appProduct: id("app-product"), testProduct: id("test-product"), sourceGroup: id("source-group"),
    testsGroup: id("tests-group"), productsGroup: id("products-group"), mainGroup: id("main-group"),
    appSources: id("app-sources"), appFrameworks: id("app-frameworks"), appResources: id("app-resources"),
    testSources: id("test-sources"), testFrameworks: id("test-frameworks"), testResources: id("test-resources"),
    appTarget: id("app-target"), testTarget: id("test-target"), project: id("project"), proxy: id("test-proxy"), dependency: id("test-dependency"),
    projectDebug: id("project-debug"), projectRelease: id("project-release"), appDebug: id("app-debug"),
    appRelease: id("app-release"), testDebug: id("test-debug"), testRelease: id("test-release"),
    projectConfig: id("project-config"), appConfig: id("app-config"), testConfig: id("test-config")
  };

  const projectFile = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {};
\tobjectVersion = 56;
\tobjects = {

/* Begin PBXBuildFile section */
\t\t${ids.appBuild} /* ${appFile} in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.appFile} /* ${appFile} */; };
\t\t${ids.contentBuild} /* ContentView.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.contentFile} /* ContentView.swift */; };
\t\t${ids.metadataBuild} /* AppMetadata.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.metadataFile} /* AppMetadata.swift */; };
\t\t${ids.testBuild} /* ${testFile} in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.testFile} /* ${testFile} */; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
\t\t${ids.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${ids.project} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${ids.appTarget};
\t\t\tremoteInfo = ${productName};
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
\t\t${ids.appFile} /* ${appFile} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${appFile}; sourceTree = "<group>"; };
\t\t${ids.contentFile} /* ContentView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; };
\t\t${ids.metadataFile} /* AppMetadata.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppMetadata.swift; sourceTree = "<group>"; };
\t\t${ids.testFile} /* ${testFile} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${testFile}; sourceTree = "<group>"; };
\t\t${ids.appProduct} /* ${productName}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${productName}.app; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${ids.testProduct} /* ${moduleName}Tests.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = ${moduleName}Tests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${ids.appFrameworks} /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testFrameworks} /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${ids.mainGroup} = {isa = PBXGroup; children = (${ids.sourceGroup} /* ${productName} */, ${ids.testsGroup} /* ${moduleName}Tests */, ${ids.productsGroup} /* Products */); sourceTree = "<group>"; };
\t\t${ids.sourceGroup} /* ${productName} */ = {isa = PBXGroup; children = (${ids.appFile} /* ${appFile} */, ${ids.contentFile} /* ContentView.swift */, ${ids.metadataFile} /* AppMetadata.swift */); path = ${productName}; sourceTree = "<group>"; };
\t\t${ids.testsGroup} /* ${moduleName}Tests */ = {isa = PBXGroup; children = (${ids.testFile} /* ${testFile} */); path = ${moduleName}Tests; sourceTree = "<group>"; };
\t\t${ids.productsGroup} /* Products */ = {isa = PBXGroup; children = (${ids.appProduct} /* ${productName}.app */, ${ids.testProduct} /* ${moduleName}Tests.xctest */); name = Products; sourceTree = "<group>"; };
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${ids.appTarget} /* ${productName} */ = {isa = PBXNativeTarget; buildConfigurationList = ${ids.appConfig} /* Build configuration list for PBXNativeTarget \"${productName}\" */; buildPhases = (${ids.appSources} /* Sources */, ${ids.appFrameworks} /* Frameworks */, ${ids.appResources} /* Resources */); buildRules = (); dependencies = (); name = ${productName}; productName = ${productName}; productReference = ${ids.appProduct} /* ${productName}.app */; productType = "com.apple.product-type.application"; };
\t\t${ids.testTarget} /* ${moduleName}Tests */ = {isa = PBXNativeTarget; buildConfigurationList = ${ids.testConfig} /* Build configuration list for PBXNativeTarget \"${moduleName}Tests\" */; buildPhases = (${ids.testSources} /* Sources */, ${ids.testFrameworks} /* Frameworks */, ${ids.testResources} /* Resources */); buildRules = (); dependencies = (${ids.dependency} /* PBXTargetDependency */); name = ${moduleName}Tests; productName = ${moduleName}Tests; productReference = ${ids.testProduct} /* ${moduleName}Tests.xctest */; productType = "com.apple.product-type.bundle.unit-test"; };
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${ids.project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1600; LastUpgradeCheck = 1600; TargetAttributes = {${ids.appTarget} = {CreatedOnToolsVersion = 16.0; }; ${ids.testTarget} = {CreatedOnToolsVersion = 16.0; TestTargetID = ${ids.appTarget}; }; }; };
\t\t\tbuildConfigurationList = ${ids.projectConfig} /* Build configuration list for PBXProject \"${productName}\" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (en, Base);
\t\t\tmainGroup = ${ids.mainGroup};
\t\t\tproductRefGroup = ${ids.productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (${ids.appTarget} /* ${productName} */, ${ids.testTarget} /* ${moduleName}Tests */);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${ids.appResources} /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testResources} /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${ids.appSources} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ids.appBuild} /* ${appFile} in Sources */, ${ids.contentBuild} /* ContentView.swift in Sources */, ${ids.metadataBuild} /* AppMetadata.swift in Sources */); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testSources} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ids.testBuild} /* ${testFile} in Sources */); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
\t\t${ids.dependency} /* PBXTargetDependency */ = {isa = PBXTargetDependency; target = ${ids.appTarget} /* ${productName} */; targetProxy = ${ids.proxy} /* PBXContainerItemProxy */; };
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
\t\t${ids.projectDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; ENABLE_TESTABILITY = YES; GCC_C_LANGUAGE_STANDARD = gnu17; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; SDKROOT = iphoneos; SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)"; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; }; name = Debug; };
\t\t${ids.projectRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; GCC_C_LANGUAGE_STANDARD = gnu17; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; SDKROOT = iphoneos; SWIFT_COMPILATION_MODE = wholemodule; VALIDATE_PRODUCT = YES; }; name = Release; };
\t\t${ids.appDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; ENABLE_PREVIEWS = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = "${displayName}"; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_MODULE_NAME = ${moduleName}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Debug; };
\t\t${ids.appRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = "${displayName}"; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_MODULE_NAME = ${moduleName}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Release; };
\t\t${ids.testDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks"; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}.tests; PRODUCT_MODULE_NAME = ${moduleName}Tests; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/${productName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${productName}"; }; name = Debug; };
\t\t${ids.testRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks"; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}.tests; PRODUCT_MODULE_NAME = ${moduleName}Tests; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/${productName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${productName}"; }; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${ids.projectConfig} /* Build configuration list for PBXProject \"${productName}\" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.projectDebug} /* Debug */, ${ids.projectRelease} /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
\t\t${ids.appConfig} /* Build configuration list for PBXNativeTarget \"${productName}\" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.appDebug} /* Debug */, ${ids.appRelease} /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
\t\t${ids.testConfig} /* Build configuration list for PBXNativeTarget \"${moduleName}Tests\" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.testDebug} /* Debug */, ${ids.testRelease} /* Release */); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
\t};
\trootObject = ${ids.project} /* Project object */;
}
`;

  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${xmlEscape(productName)}.app" BlueprintName="${xmlEscape(productName)}" ReferencedContainer="container:${xmlEscape(productName)}.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.testTarget}" BuildableName="${xmlEscape(moduleName)}Tests.xctest" BlueprintName="${xmlEscape(moduleName)}Tests" ReferencedContainer="container:${xmlEscape(productName)}.xcodeproj"/>
      </TestableReference>
    </Testables>
    <MacroExpansion><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${xmlEscape(productName)}.app" BlueprintName="${xmlEscape(productName)}" ReferencedContainer="container:${xmlEscape(productName)}.xcodeproj"/></MacroExpansion>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${xmlEscape(productName)}.app" BlueprintName="${xmlEscape(productName)}" ReferencedContainer="container:${xmlEscape(productName)}.xcodeproj"/></BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
    <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${xmlEscape(productName)}.app" BlueprintName="${xmlEscape(productName)}" ReferencedContainer="container:${xmlEscape(productName)}.xcodeproj"/></BuildableProductRunnable>
  </ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;

  const appSource = `import SwiftUI

@main
struct ${moduleName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;

  const contentSource = `import SwiftUI

struct ContentView: View {
    @State private var count = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "sparkles")
                    .font(.system(size: 48))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)

                Text(AppMetadata.displayName)
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("welcome.title")

                Text("Count: \\(count)")
                    .font(.title2.monospacedDigit())
                    .accessibilityIdentifier("counter.value")

                Button("Increment") {
                    count += 1
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("counter.increment")
            }
            .padding(24)
            .navigationTitle("Welcome")
        }
    }
}

#Preview("Default") {
    ContentView()
}

#Preview("Large text") {
    ContentView()
        .environment(\\.dynamicTypeSize, .accessibility3)
}
`;

  const metadataSource = `enum AppMetadata {
    static let displayName = "${swiftString(displayName)}"
    static let bundleIdentifier = "${swiftString(bundleIdentifier)}"
}
`;

  const testSource = `import XCTest
@testable import ${moduleName}

final class ${moduleName}Tests: XCTestCase {
    func testGeneratedMetadata() {
        XCTAssertEqual(AppMetadata.displayName, "${swiftString(displayName)}")
        XCTAssertEqual(AppMetadata.bundleIdentifier, "${swiftString(bundleIdentifier)}")
    }
}
`;

  const buildCommand = `xcodebuild -project "${productName}.xcodeproj" -scheme "${productName}" -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath .pixice-derived-data CODE_SIGNING_ALLOWED=NO build`;
  const testCommand = `xcodebuild -project "${productName}.xcodeproj" -scheme "${productName}" -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath .pixice-derived-data CODE_SIGNING_ALLOWED=NO test`;
  const readme = `# ${displayName}

Pixice generated this deterministic SwiftUI starter. It targets iOS ${deploymentTarget} and has no third-party dependencies.

## Build for Simulator

From this directory, run:

\`\`\`sh
${buildCommand}
\`\`\`

Run the unit tests with:

\`\`\`sh
${testCommand}
\`\`\`

Change the Simulator name if that device is not installed. Pixice can supply a destination by UDID as \`-destination 'platform=iOS Simulator,id=<UDID>'\`.
`;

  return {
    buildCommand,
    testCommand,
    files: {
      [`${productName}.xcodeproj/project.pbxproj`]: projectFile,
      [`${productName}.xcodeproj/xcshareddata/xcschemes/${productName}.xcscheme`]: scheme,
      [`${productName}/${appFile}`]: appSource,
      [`${productName}/ContentView.swift`]: contentSource,
      [`${productName}/AppMetadata.swift`]: metadataSource,
      [`${moduleName}Tests/${testFile}`]: testSource,
      "README.md": readme
    }
  };
}

export function planSwiftUIStarter({
  name,
  moduleName: requestedModuleName,
  displayName: requestedDisplayName,
  organizationIdentifier = DEFAULT_ORGANIZATION_IDENTIFIER,
  bundleIdentifier: requestedBundleIdentifier,
  deploymentTarget = DEFAULT_DEPLOYMENT_TARGET
} = {}) {
  const productName = sanitizeProductName(name);
  const moduleName = sanitizeModuleName(requestedModuleName || productName);
  const displayName = sanitizeDisplayName(requestedDisplayName || name);
  const organization = sanitizeOrganizationIdentifier(organizationIdentifier);
  const bundleIdentifier = requestedBundleIdentifier
    ? validateBundleIdentifier(requestedBundleIdentifier)
    : `${organization}.${bundleSegment(productName, "Product name")}`;
  const config = {
    productName,
    moduleName,
    displayName,
    bundleIdentifier,
    deploymentTarget: validateDeploymentTarget(deploymentTarget)
  };
  const rendered = renderProject(config);
  const marker = {
    schemaVersion: 1,
    generator: "pixice",
    kind: STARTER_KIND,
    ...config,
    files: [...Object.keys(rendered.files), MARKER_FILE].sort()
  };
  return {
    ...config,
    ...rendered,
    files: {
      ...rendered.files,
      [MARKER_FILE]: `${JSON.stringify(marker, null, 2)}\n`
    }
  };
}

async function pathExists(value) {
  try {
    return await lstat(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRelativeChild(relativeDirectory) {
  const value = String(relativeDirectory ?? "").trim();
  if (!value || value === "." || path.isAbsolute(value)) {
    throw new Error("Starter directory must be a relative child path inside the workspace");
  }
  if (value.split(/[\\/]+/).some((segment) => segment === ".." || segment === "")) {
    throw new Error("Starter directory cannot contain path traversal or empty segments");
  }
  return value;
}

async function assertNoSymlinks(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await pathExists(current);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Starter path cannot traverse a symbolic link: ${current}`);
  }
}

async function readMarker(destination) {
  const markerPath = path.join(destination, MARKER_FILE);
  const markerStats = await pathExists(markerPath);
  if (markerStats?.isSymbolicLink()) throw new Error("Existing Pixice starter marker cannot be a symbolic link");
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("Existing Pixice starter marker is invalid");
    throw error;
  }
}

export async function createSwiftUIStarter({ workspaceRoot, relativeDirectory, overwrite = false, ...options } = {}) {
  if (!String(workspaceRoot ?? "").trim()) throw new Error("Workspace root is required");
  const rootInput = path.resolve(String(workspaceRoot));
  const rootStats = await pathExists(rootInput);
  if (!rootStats?.isDirectory()) throw new Error("Workspace root must be an existing directory");
  const root = await realpath(rootInput);
  const relative = assertRelativeChild(relativeDirectory || sanitizeProductName(options.name));
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Starter directory must stay inside the workspace");
  await assertNoSymlinks(root, destination);

  const plan = planSwiftUIStarter(options);
  const destinationStats = await pathExists(destination);
  if (destinationStats) {
    if (!destinationStats.isDirectory()) throw new Error("Starter destination already exists and is not a directory");
    if (!overwrite) throw new Error("Starter destination already exists; pass overwrite: true to regenerate a Pixice starter");
    const marker = await readMarker(destination);
    if (marker?.generator !== "pixice" || marker?.kind !== STARTER_KIND) {
      throw new Error("Refusing to overwrite a directory that is not a Pixice SwiftUI starter");
    }
    if (marker.productName !== plan.productName || marker.moduleName !== plan.moduleName) {
      throw new Error("Regeneration cannot change the product or module name in an existing starter");
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinks(root, path.dirname(destination));
    await mkdir(destination);
  }

  for (const [relativePath, contents] of Object.entries(plan.files)) {
    const outputPath = path.resolve(destination, relativePath);
    if (!outputPath.startsWith(`${destination}${path.sep}`)) throw new Error("Generated file escaped the starter directory");
    await assertNoSymlinks(destination, path.dirname(outputPath));
    const existing = await pathExists(outputPath);
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite symbolic link: ${outputPath}`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await assertNoSymlinks(destination, path.dirname(outputPath));
    await writeFile(outputPath, contents, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
  }

  return {
    destination,
    productName: plan.productName,
    moduleName: plan.moduleName,
    displayName: plan.displayName,
    bundleIdentifier: plan.bundleIdentifier,
    deploymentTarget: plan.deploymentTarget,
    files: Object.keys(plan.files).sort(),
    buildCommand: plan.buildCommand,
    testCommand: plan.testCommand
  };
}
