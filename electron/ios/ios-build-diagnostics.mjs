import path from "node:path";

const DEFAULT_LIMITS = Object.freeze({
  maxDiagnostics: 200,
  maxLogLines: 120,
  maxLogLineLength: 2_000,
  maxPendingLineLength: 64 * 1024,
  maxDiagnosticMessageLength: 4_000,
  maxDeduplicationKeys: 500
});

const HARD_LIMITS = Object.freeze({
  maxDiagnostics: 2_000,
  maxLogLines: 2_000,
  maxLogLineLength: 16_000,
  maxPendingLineLength: 256 * 1024,
  maxDiagnosticMessageLength: 16_000,
  maxDeduplicationKeys: 4_000
});

const COMPILER_DIAGNOSTIC = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+?)\s*$/i;
const BUILD_DIAGNOSTIC = /^(?:xcodebuild:\s*)?(fatal error|error|warning):\s*(.+?)\s*$/i;
const TARGET_CONTEXT = /\s+\(in target ['"](.+?)['"] from project ['"](.+?)['"]\)\s*$/;
const TARGET_HEADER = /^=== BUILD (?:AGGREGATE )?TARGET (.+?) OF PROJECT (.+?) WITH CONFIGURATION (.+?) ===$/;

function boundedInteger(value, fallback, hardLimit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), hardLimit);
}

function buildLimits(overrides = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
    key,
    boundedInteger(overrides[key], fallback, HARD_LIMITS[key])
  ]));
}

function clampText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, "");
}

function contextFromLine(line) {
  const match = line.match(TARGET_CONTEXT);
  if (!match) return { line, target: null, project: null };
  return {
    line: line.slice(0, match.index).trimEnd(),
    target: match[1],
    project: match[2]
  };
}

function compilerForPath(filePath) {
  return path.extname(filePath).toLowerCase() === ".swift" ? "swift" : "clang";
}

function normalizeSeverity(value) {
  const severity = String(value).toLowerCase();
  return severity === "fatal error" ? "error" : severity;
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function phaseForLine(line) {
  const progressLine = line.replace(/^\[\d+\/\d+\]\s*/, "");
  const command = progressLine.trimStart().split(/\s+/, 1)[0];
  if (/^(Resolve Package Graph|Resolved source packages)/.test(progressLine)) {
    return { phase: "resolving-packages", action: "resolve-packages" };
  }
  if (/^(ComputeTargetDependencyGraph|Prepare packages|CreateBuildDescription|Build description)/.test(progressLine)) {
    return { phase: "planning", action: "plan-build" };
  }
  if (/^(SwiftCompile|CompileSwift|CompileC|CompileMetalFile|MetalCompile)/.test(command)) {
    return { phase: "compiling", action: command };
  }
  if (/^(CompileAssetCatalog|CompileStoryboard|CompileXIB|LinkStoryboards|ProcessInfoPlistFile|ProcessProductPackaging|CpResource|CopyStringsFile|CopySwiftLibs)/.test(command)) {
    return { phase: "processing-resources", action: command };
  }
  if (/^(Ld|Libtool|CreateUniversalBinary|GenerateTAPI)/.test(command)) {
    return { phase: "linking", action: command };
  }
  if (/^(CodeSign|RegisterExecutionPolicyException)/.test(command)) {
    return { phase: "signing", action: command };
  }
  if (/^(Test Suite|Test Case)/.test(progressLine)) {
    return { phase: "testing", action: command };
  }
  if (/^(Validate|Touch)/.test(command)) {
    return { phase: command === "Validate" ? "validating" : "finalizing", action: command };
  }
  return null;
}

function terminalProgress(line) {
  const match = line.match(/^\*\* (BUILD|TEST) (SUCCEEDED|FAILED|CANCELLED) \*\*$/);
  if (!match) return null;
  const status = match[2] === "SUCCEEDED"
    ? "succeeded"
    : match[2] === "CANCELLED" ? "cancelled" : "failed";
  return { status, phase: "finished", action: `${match[1].toLowerCase()}-${match[2].toLowerCase()}` };
}

function progressUnits(line) {
  const match = line.match(/^\[(\d+)\/(\d+)\]\s*/);
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1) return null;
  return { completed: Math.min(completed, total), total };
}

export function createXcresultHandoff(bundlePath, { normalizePath } = {}) {
  if (!bundlePath) return null;
  const initial = path.resolve(String(bundlePath));
  const normalized = normalizePath
    ? normalizePath(initial, { kind: "xcresult", rawPath: String(bundlePath) })
    : initial;
  if (!normalized) return null;
  const absolutePath = path.isAbsolute(String(normalized))
    ? path.normalize(String(normalized))
    : path.resolve(String(normalized));
  return {
    format: "xcresult",
    bundlePath: absolutePath,
    status: "pending-analysis"
  };
}

export class XcodeBuildDiagnosticsParser {
  #baseDirectory;
  #projectRoot;
  #allowedRoots;
  #normalizePath;
  #isPathAllowed;
  #includeNotes;
  #limits;
  #decoder = new TextDecoder();
  #lineBuffer = "";
  #lineTruncated = false;
  #discardingLine = false;
  #skipLeadingLineFeed = false;
  #finished = false;
  #diagnostics = [];
  #deduplicationKeys = new Set();
  #logLines = [];
  #progress = {
    status: "running",
    phase: "preparing",
    action: "start",
    target: null,
    project: null,
    configuration: null,
    detail: null,
    completedUnits: null,
    totalUnits: null,
    sequence: 0
  };
  #statistics = {
    lines: 0,
    diagnostics: 0,
    duplicateDiagnostics: 0,
    droppedDiagnostics: 0,
    omittedLogLines: 0,
    truncatedLines: 0
  };
  #xcresult = null;

  constructor({
    projectRoot = null,
    baseDirectory = projectRoot || process.cwd(),
    allowedRoots,
    normalizePath = null,
    isPathAllowed = null,
    includeNotes = false,
    limits = {}
  } = {}) {
    this.#baseDirectory = path.resolve(String(baseDirectory));
    this.#projectRoot = projectRoot ? path.resolve(String(projectRoot)) : null;
    this.#allowedRoots = (allowedRoots ?? [this.#projectRoot || this.#baseDirectory])
      .filter(Boolean)
      .map((root) => path.resolve(String(root)));
    this.#normalizePath = typeof normalizePath === "function" ? normalizePath : null;
    this.#isPathAllowed = typeof isPathAllowed === "function" ? isPathAllowed : null;
    this.#includeNotes = Boolean(includeNotes);
    this.#limits = buildLimits(limits);
  }

  push(chunk) {
    if (this.#finished) throw new Error("Cannot push output after the Xcode diagnostics parser has finished");
    let text;
    if (typeof chunk === "string") {
      text = this.#decoder.decode() + chunk;
    } else if (ArrayBuffer.isView(chunk) && !(chunk instanceof DataView)) {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      text = this.#decoder.decode(bytes, { stream: true });
    } else {
      throw new TypeError("Xcode build output must be a string, Buffer, or Uint8Array");
    }

    const delta = { diagnostics: [], progress: null };
    this.#consumeText(text, delta);
    return delta;
  }

  finish({ exitCode = null, signal = null, xcresultPath = null } = {}) {
    if (!this.#finished) {
      const delta = { diagnostics: [], progress: null };
      this.#consumeText(this.#decoder.decode(), delta);
      if (this.#lineBuffer || this.#lineTruncated) this.#completeLine(delta);

      if (this.#progress.status === "running") {
        if (signal) {
          this.#setProgress({ status: "cancelled", phase: "finished", action: "cancelled", detail: String(signal) }, delta);
        } else if (exitCode !== null) {
          this.#setProgress({
            status: Number(exitCode) === 0 ? "succeeded" : "failed",
            phase: "finished",
            action: Number(exitCode) === 0 ? "build-succeeded" : "build-failed",
            detail: `xcodebuild exited with code ${exitCode}`
          }, delta);
        }
      }
      this.#xcresult = createXcresultHandoff(xcresultPath, { normalizePath: this.#normalizePath });
      this.#finished = true;
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      progress: { ...this.#progress },
      diagnostics: this.#diagnostics.map((diagnostic) => ({ ...diagnostic })),
      logTail: [...this.#logLines],
      logText: this.#logLines.join("\n"),
      statistics: { ...this.#statistics },
      truncated: {
        diagnostics: this.#statistics.droppedDiagnostics > 0,
        log: this.#statistics.omittedLogLines > 0,
        lines: this.#statistics.truncatedLines > 0
      },
      xcresult: this.#xcresult ? { ...this.#xcresult } : null
    };
  }

  #consumeText(text, delta) {
    let start = 0;
    if (this.#skipLeadingLineFeed && text.startsWith("\n")) start = 1;
    if (text.length) this.#skipLeadingLineFeed = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (character !== "\n" && character !== "\r") continue;
      this.#appendFragment(text.slice(start, index));
      this.#completeLine(delta);
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      else if (character === "\r" && index === text.length - 1) this.#skipLeadingLineFeed = true;
      start = index + 1;
    }
    this.#appendFragment(text.slice(start));
  }

  #appendFragment(fragment) {
    if (!fragment || this.#discardingLine) return;
    const remaining = this.#limits.maxPendingLineLength - this.#lineBuffer.length;
    if (fragment.length <= remaining) {
      this.#lineBuffer += fragment;
      return;
    }
    this.#lineBuffer += fragment.slice(0, remaining);
    this.#lineTruncated = true;
    this.#discardingLine = true;
  }

  #completeLine(delta) {
    const line = this.#lineTruncated
      ? `${this.#lineBuffer.slice(0, Math.max(0, this.#limits.maxPendingLineLength - 1))}…`
      : this.#lineBuffer;
    this.#lineBuffer = "";
    this.#discardingLine = false;
    if (this.#lineTruncated) this.#statistics.truncatedLines += 1;
    this.#lineTruncated = false;
    this.#processLine(stripAnsi(line).trimEnd(), delta);
  }

  #processLine(line, delta) {
    this.#statistics.lines += 1;
    if (line.trim()) this.#appendLogLine(line);

    const context = contextFromLine(line);
    this.#updateProgress(line, context, delta);
    this.#parseDiagnostic(context, delta);
  }

  #appendLogLine(line) {
    this.#logLines.push(clampText(line, this.#limits.maxLogLineLength));
    if (this.#logLines.length > this.#limits.maxLogLines) {
      this.#logLines.shift();
      this.#statistics.omittedLogLines += 1;
    }
  }

  #updateProgress(line, context, delta) {
    const terminal = terminalProgress(line);
    if (terminal) {
      this.#setProgress({ ...terminal, detail: line }, delta);
      return;
    }

    const header = line.match(TARGET_HEADER);
    if (header) {
      this.#setProgress({
        phase: "preparing",
        action: "build-target",
        target: header[1],
        project: header[2],
        configuration: header[3],
        detail: line
      }, delta);
      return;
    }

    const phase = phaseForLine(context.line);
    const units = progressUnits(context.line);
    if (phase || context.target || units) {
      this.#setProgress({
        ...(phase || {}),
        ...(context.target ? { target: context.target } : {}),
        ...(context.project ? { project: context.project } : {}),
        ...(units ? { completedUnits: units.completed, totalUnits: units.total } : {}),
        detail: context.line.trim() || line.trim()
      }, delta);
    }
  }

  #setProgress(patch, delta) {
    const next = {
      ...this.#progress,
      ...patch,
      detail: patch.detail === undefined
        ? this.#progress.detail
        : clampText(patch.detail, this.#limits.maxLogLineLength)
    };
    const changed = Object.entries(next).some(([key, value]) => key !== "sequence" && this.#progress[key] !== value);
    if (!changed) return;
    next.sequence = this.#progress.sequence + 1;
    this.#progress = next;
    delta.progress = { ...next };
  }

  #parseDiagnostic(context, delta) {
    const compilerMatch = context.line.match(COMPILER_DIAGNOSTIC);
    if (compilerMatch) {
      const severity = normalizeSeverity(compilerMatch[4]);
      if (severity === "note" && !this.#includeNotes) return;
      const filePath = this.#resolvePath(compilerMatch[1]);
      if (!filePath) return;
      this.#addDiagnostic({
        kind: "compiler",
        compiler: compilerForPath(filePath.path),
        severity,
        path: filePath.path,
        line: Number(compilerMatch[2]),
        column: compilerMatch[3] ? Number(compilerMatch[3]) : null,
        message: clampText(compilerMatch[5].trim(), this.#limits.maxDiagnosticMessageLength),
        target: context.target || this.#progress.target,
        project: context.project || this.#progress.project,
        phase: this.#progress.phase,
        pathScope: filePath.allowed ? "project" : "external",
        openable: filePath.allowed
      }, delta);
      return;
    }

    const buildMatch = context.line.match(BUILD_DIAGNOSTIC);
    if (!buildMatch) return;
    this.#addDiagnostic({
      kind: "build",
      compiler: null,
      severity: normalizeSeverity(buildMatch[1]),
      path: null,
      line: null,
      column: null,
      message: clampText(buildMatch[2].trim(), this.#limits.maxDiagnosticMessageLength),
      target: context.target || this.#progress.target,
      project: context.project || this.#progress.project,
      phase: this.#progress.phase,
      pathScope: null,
      openable: false
    }, delta);
  }

  #resolvePath(rawPath) {
    const raw = String(rawPath).trim();
    if (!raw || (raw.startsWith("<") && raw.endsWith(">"))) return null;
    const initial = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(this.#baseDirectory, raw);
    const normalized = this.#normalizePath
      ? this.#normalizePath(initial, {
        kind: "diagnostic",
        rawPath: raw,
        baseDirectory: this.#baseDirectory,
        projectRoot: this.#projectRoot
      })
      : initial;
    if (!normalized) return null;
    const absolutePath = path.isAbsolute(String(normalized))
      ? path.normalize(String(normalized))
      : path.resolve(this.#baseDirectory, String(normalized));
    const context = {
      rawPath: raw,
      projectRoot: this.#projectRoot,
      allowedRoots: [...this.#allowedRoots]
    };
    const allowed = this.#isPathAllowed
      ? Boolean(this.#isPathAllowed(absolutePath, context))
      : this.#allowedRoots.some((root) => pathIsInside(absolutePath, root));
    return { path: absolutePath, allowed };
  }

  #addDiagnostic(diagnostic, delta) {
    const key = [
      diagnostic.severity,
      diagnostic.path,
      diagnostic.line,
      diagnostic.column,
      diagnostic.message,
      diagnostic.target
    ].join("\u0000");
    if (this.#deduplicationKeys.has(key)) {
      this.#statistics.duplicateDiagnostics += 1;
      return;
    }
    if (this.#deduplicationKeys.size < this.#limits.maxDeduplicationKeys) {
      this.#deduplicationKeys.add(key);
    }
    if (this.#diagnostics.length >= this.#limits.maxDiagnostics) {
      this.#statistics.droppedDiagnostics += 1;
      return;
    }
    const stored = { id: `xcode-diagnostic-${this.#diagnostics.length + 1}`, ...diagnostic };
    this.#diagnostics.push(stored);
    this.#statistics.diagnostics += 1;
    delta.diagnostics.push({ ...stored });
  }
}

export function createXcodeBuildDiagnosticsParser(options) {
  return new XcodeBuildDiagnosticsParser(options);
}

export { DEFAULT_LIMITS as XCODE_DIAGNOSTIC_DEFAULT_LIMITS };
