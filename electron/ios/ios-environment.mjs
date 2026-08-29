import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function runIosCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    windowsHide: true
  });
}

function commandError(error) {
  return String(error?.stderr || error?.message || error || "Command failed").trim();
}

async function probe(runCommand, command, args) {
  try {
    const result = await runCommand(command, args);
    return {
      ok: true,
      stdout: String(result?.stdout ?? "").trim(),
      stderr: String(result?.stderr ?? "").trim()
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: commandError(error) };
  }
}

export function parseXcodeVersion(output) {
  const text = String(output ?? "").trim();
  const version = text.match(/^Xcode\s+([^\s]+)/m)?.[1] ?? null;
  const buildVersion = text.match(/^Build version\s+(.+)$/m)?.[1]?.trim() ?? null;
  return { version, buildVersion, raw: text };
}

export function parseSimulatorDevices(output) {
  let value;
  try {
    value = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error("simctl returned invalid JSON");
  }

  if (!value?.devices || typeof value.devices !== "object" || Array.isArray(value.devices)) {
    throw new Error("simctl did not return a device map");
  }

  return Object.entries(value.devices)
    .flatMap(([runtimeIdentifier, devices]) => Array.isArray(devices)
      ? devices.map((device) => ({
        udid: String(device.udid ?? ""),
        name: String(device.name ?? "Unknown Simulator"),
        state: String(device.state ?? "Unknown"),
        runtimeIdentifier,
        available: device.isAvailable !== false && !device.availabilityError
      }))
      : [])
    .filter((device) => device.udid && device.available)
    .sort((left, right) => {
      const bootOrder = Number(right.state === "Booted") - Number(left.state === "Booted");
      return bootOrder || left.name.localeCompare(right.name) || left.udid.localeCompare(right.udid);
    });
}

function issue(code, message, detail = null) {
  return { code, message, ...(detail ? { detail } : {}) };
}

export async function inspectIosEnvironment({
  platform = process.platform,
  arch = process.arch,
  runCommand = runIosCommand
} = {}) {
  const host = {
    platform,
    arch,
    supportsXcode: platform === "darwin",
    supportsSimulatorStreaming: platform === "darwin" && arch === "arm64"
  };

  if (!host.supportsXcode) {
    return {
      ready: false,
      host,
      developerDirectory: null,
      xcode: null,
      simulators: [],
      issues: [issue("macos_required", "iOS development requires macOS.")]
    };
  }

  const [developerDirectoryProbe, xcodeProbe, simulatorProbe] = await Promise.all([
    probe(runCommand, "xcode-select", ["-p"]),
    probe(runCommand, "xcodebuild", ["-version"]),
    probe(runCommand, "xcrun", ["simctl", "list", "devices", "available", "-j"])
  ]);

  const issues = [];
  const developerDirectory = developerDirectoryProbe.ok ? developerDirectoryProbe.stdout : null;
  if (!developerDirectoryProbe.ok) {
    issues.push(issue("developer_directory_unavailable", "The active Xcode developer directory is unavailable.", developerDirectoryProbe.stderr));
  }

  const xcode = xcodeProbe.ok ? parseXcodeVersion(xcodeProbe.stdout) : null;
  if (!xcodeProbe.ok || !xcode?.version) {
    issues.push(issue("full_xcode_required", "Install or select the full Xcode application.", xcodeProbe.stderr || xcode?.raw));
  }

  let simulators = [];
  if (simulatorProbe.ok) {
    try {
      simulators = parseSimulatorDevices(simulatorProbe.stdout);
      if (!simulators.length) issues.push(issue("simulator_unavailable", "Install at least one available iOS Simulator runtime."));
    } catch (error) {
      issues.push(issue("simulator_list_invalid", error.message));
    }
  } else {
    issues.push(issue("simctl_unavailable", "Simulator command-line tools are unavailable.", simulatorProbe.stderr));
  }

  if (!host.supportsSimulatorStreaming) {
    issues.push(issue("streaming_arch_unsupported", "Interactive Simulator streaming currently requires Apple Silicon."));
  }

  return {
    ready: issues.length === 0,
    host,
    developerDirectory,
    xcode,
    simulators,
    issues
  };
}
