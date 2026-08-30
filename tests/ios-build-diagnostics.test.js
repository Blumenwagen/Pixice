import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  XCODE_DIAGNOSTIC_DEFAULT_LIMITS,
  createXcodeBuildDiagnosticsParser,
  createXcresultHandoff,
  stripAnsi
} from "../electron/ios/ios-build-diagnostics.mjs";

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xcodebuild");

function fixture(name, projectRoot = "/workspace/My App") {
  return fs.readFileSync(path.join(fixtureDirectory, name), "utf8")
    .replaceAll("__PROJECT_ROOT__", projectRoot)
    .replaceAll("<ESC>", "\u001b");
}

function pushInBufferChunks(parser, text, sizes = [1, 2, 7, 19, 3, 41]) {
  const buffer = Buffer.from(text);
  let offset = 0;
  let index = 0;
  const deltas = [];
  while (offset < buffer.length) {
    const end = Math.min(buffer.length, offset + sizes[index % sizes.length]);
    deltas.push(parser.push(buffer.subarray(offset, end)));
    offset = end;
    index += 1;
  }
  return deltas;
}

describe("Xcode build diagnostics", () => {
  it("parses chunked Swift and Clang failures with target context and no ANSI escapes", () => {
    const projectRoot = "/workspace/My App";
    const parser = createXcodeBuildDiagnosticsParser({ projectRoot });
    const deltas = pushInBufferChunks(parser, fixture("mixed-failure.txt", projectRoot));
    const result = parser.finish({ exitCode: 65 });

    expect(result.progress).toMatchObject({
      status: "failed",
      phase: "finished",
      action: "build-failed",
      target: "PixiceDemo",
      project: "PixiceDemo",
      configuration: "Debug"
    });
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics[0]).toMatchObject({
      id: "xcode-diagnostic-1",
      kind: "compiler",
      compiler: "swift",
      severity: "error",
      path: "/workspace/My App/PixiceDemo/ContentView.swift",
      line: 17,
      column: 9,
      message: "cannot find 'missingValue' in scope",
      target: "PixiceDemo",
      phase: "compiling",
      pathScope: "project",
      openable: true
    });
    expect(result.diagnostics[1]).toMatchObject({ compiler: "swift", severity: "warning", line: 21, column: 5 });
    expect(result.diagnostics[2]).toMatchObject({
      compiler: "clang",
      severity: "error",
      path: "/workspace/My App/PixiceDemo/AppDelegate.m",
      line: 8,
      column: 3
    });
    expect(result.statistics).toMatchObject({ diagnostics: 3, duplicateDiagnostics: 1, droppedDiagnostics: 0 });
    expect(result.logText).not.toContain("\u001b");
    expect(result.logTail.at(-1)).toBe("** BUILD FAILED **");
    expect(deltas.flatMap((delta) => delta.diagnostics)).toHaveLength(3);
  });

  it("normalizes relative paths and lets the host decide which files are openable", () => {
    const normalizePath = vi.fn((absolutePath, context) => context.rawPath.startsWith("generated/")
      ? absolutePath.replace("/generated/", "/Sources/")
      : absolutePath);
    const isPathAllowed = vi.fn((absolutePath) => absolutePath.startsWith("/workspace/App/Sources/"));
    const parser = createXcodeBuildDiagnosticsParser({
      projectRoot: "/workspace/App",
      normalizePath,
      isPathAllowed
    });

    parser.push("generated/View.swift:4:2: warning: emoji 👩🏽‍💻 survived\n");
    parser.push("/tmp/Dependency.c:9: error: external failure\n");
    const result = parser.finish({ exitCode: 1 });

    expect(result.diagnostics[0]).toMatchObject({
      path: "/workspace/App/Sources/View.swift",
      pathScope: "project",
      openable: true,
      message: "emoji 👩🏽‍💻 survived"
    });
    expect(result.diagnostics[1]).toMatchObject({
      path: "/tmp/Dependency.c",
      pathScope: "external",
      openable: false
    });
    expect(normalizePath).toHaveBeenCalledWith("/workspace/App/generated/View.swift", expect.objectContaining({
      kind: "diagnostic",
      rawPath: "generated/View.swift",
      projectRoot: "/workspace/App"
    }));
    expect(isPathAllowed).toHaveBeenCalledTimes(2);
  });

  it("bounds diagnostics, log storage, messages, deduplication, and incomplete lines", () => {
    const parser = createXcodeBuildDiagnosticsParser({
      projectRoot: "/workspace/App",
      limits: {
        maxDiagnostics: 2,
        maxDeduplicationKeys: 2,
        maxLogLines: 3,
        maxLogLineLength: 24,
        maxDiagnosticMessageLength: 18,
        maxPendingLineLength: 80
      }
    });

    parser.push(`${"x".repeat(200)}\n`);
    parser.push("A.swift:1:1: error: first diagnostic message is long\n");
    parser.push("B.swift:2:2: warning: second diagnostic\n");
    parser.push("C.swift:3:3: error: third diagnostic\n");
    parser.push("last unterminated line");
    const result = parser.finish({ exitCode: 65 });

    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].message).toBe("first diagnostic …");
    expect(result.statistics).toMatchObject({
      diagnostics: 2,
      droppedDiagnostics: 1,
      omittedLogLines: 2,
      truncatedLines: 1
    });
    expect(result.logTail).toHaveLength(3);
    expect(result.logTail.every((line) => line.length <= 24)).toBe(true);
    expect(result.logTail.at(-1)).toBe("last unterminated line");
    expect(result.truncated).toEqual({ diagnostics: true, log: true, lines: true });
  });

  it("handles split UTF-8 bytes, optional notes, incremental progress, and exit-derived success", () => {
    const parser = createXcodeBuildDiagnosticsParser({ projectRoot: "/workspace/App", includeNotes: true });
    const output = [
      "=== BUILD TARGET App OF PROJECT App WITH CONFIGURATION Debug ===",
      "[2/5] SwiftCompile normal arm64 /workspace/App/View.swift (in target 'App' from project 'App')",
      "/workspace/App/View.swift:3:1: note: café 👩🏽‍💻",
      "Touch /tmp/App.app (in target 'App' from project 'App')"
    ].join("\n") + "\n";
    const deltas = pushInBufferChunks(parser, output, [2, 1, 3]);
    const result = parser.finish({ exitCode: 0 });

    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: "note",
      message: "café 👩🏽‍💻"
    })]);
    expect(result.progress).toMatchObject({ status: "succeeded", phase: "finished", action: "build-succeeded" });
    const progress = deltas.map((delta) => delta.progress).filter(Boolean);
    expect(progress.some((item) => item.phase === "compiling" && item.completedUnits === 2 && item.totalUnits === 5)).toBe(true);
    expect(progress.some((item) => item.phase === "finalizing")).toBe(true);
  });

  it("treats a CRLF split across chunks as one line boundary", () => {
    const parser = createXcodeBuildDiagnosticsParser({ projectRoot: "/workspace/App" });

    parser.push("first line\r");
    parser.push("\n/workspace/App/View.swift:2: warning: second line\r");
    parser.push("\n");
    const result = parser.finish();

    expect(result.statistics.lines).toBe(2);
    expect(result.logTail).toEqual([
      "first line",
      "/workspace/App/View.swift:2: warning: second line"
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ line: 2, column: null })]);
  });

  it("emits generic build failures and a normalized xcresult handoff", () => {
    const parser = createXcodeBuildDiagnosticsParser({ projectRoot: "/workspace/App" });
    parser.push("xcodebuild: error: The workspace named App does not contain a scheme named Missing.\n");
    const result = parser.finish({
      exitCode: 65,
      xcresultPath: "/tmp/App Build.xcresult"
    });

    expect(result.diagnostics).toEqual([expect.objectContaining({
      kind: "build",
      severity: "error",
      path: null,
      openable: false,
      message: "The workspace named App does not contain a scheme named Missing."
    })]);
    expect(result.xcresult).toEqual({
      format: "xcresult",
      bundlePath: "/tmp/App Build.xcresult",
      status: "pending-analysis"
    });
    expect(createXcresultHandoff(null)).toBeNull();
  });

  it("rejects output after finish and exposes safe default limits", () => {
    const parser = createXcodeBuildDiagnosticsParser();
    parser.finish({ signal: "SIGTERM" });

    expect(parser.snapshot().progress.status).toBe("cancelled");
    expect(() => parser.push("late output")).toThrow("has finished");
    expect(() => createXcodeBuildDiagnosticsParser().push(123)).toThrow("string, Buffer, or Uint8Array");
    expect(XCODE_DIAGNOSTIC_DEFAULT_LIMITS.maxDiagnostics).toBe(200);
    expect(stripAnsi("\u001b[31merror\u001b[0m \u009b33mwarning\u009b0m")).toBe("error warning");
  });
});
