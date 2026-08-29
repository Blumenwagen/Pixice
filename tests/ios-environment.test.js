import { describe, expect, it, vi } from "vitest";
import {
  inspectIosEnvironment,
  parseSimulatorDevices,
  parseXcodeVersion
} from "../electron/ios/ios-environment.mjs";

const simulatorJson = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: "shutdown", name: "iPhone 17", state: "Shutdown", isAvailable: true },
      { udid: "booted", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
      { udid: "missing", name: "Old iPhone", state: "Shutdown", isAvailable: false }
    ]
  }
});

describe("iOS environment", () => {
  it("parses Xcode and available Simulator metadata", () => {
    expect(parseXcodeVersion("Xcode 27.0\nBuild version 18A123")).toEqual({
      version: "27.0",
      buildVersion: "18A123",
      raw: "Xcode 27.0\nBuild version 18A123"
    });
    expect(parseSimulatorDevices(simulatorJson)).toEqual([
      {
        udid: "booted",
        name: "iPhone 17 Pro",
        state: "Booted",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        available: true
      },
      {
        udid: "shutdown",
        name: "iPhone 17",
        state: "Shutdown",
        runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        available: true
      }
    ]);
  });

  it("reports a ready Apple Silicon Xcode environment", async () => {
    const runCommand = vi.fn(async (command) => {
      if (command === "xcode-select") return { stdout: "/Applications/Xcode.app/Contents/Developer" };
      if (command === "xcodebuild") return { stdout: "Xcode 27.0\nBuild version 18A123" };
      return { stdout: simulatorJson };
    });

    const result = await inspectIosEnvironment({ platform: "darwin", arch: "arm64", runCommand });

    expect(result.ready).toBe(true);
    expect(result.simulators).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(runCommand).toHaveBeenCalledWith("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  });

  it("returns actionable issues when only command-line tools are active", async () => {
    const runCommand = vi.fn(async (command) => {
      if (command === "xcode-select") return { stdout: "/Library/Developer/CommandLineTools" };
      const error = new Error("utility unavailable");
      error.stderr = command === "xcodebuild"
        ? "tool 'xcodebuild' requires Xcode"
        : "unable to find utility simctl";
      throw error;
    });

    const result = await inspectIosEnvironment({ platform: "darwin", arch: "arm64", runCommand });

    expect(result.ready).toBe(false);
    expect(result.developerDirectory).toBe("/Library/Developer/CommandLineTools");
    expect(result.issues.map(({ code }) => code)).toEqual(["full_xcode_required", "simctl_unavailable"]);
    expect(result.issues[0].detail).toContain("requires Xcode");
  });

  it("does not invoke Apple tools on unsupported hosts", async () => {
    const runCommand = vi.fn();

    const result = await inspectIosEnvironment({ platform: "linux", arch: "x64", runCommand });

    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([{ code: "macos_required", message: "iOS development requires macOS." }]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
