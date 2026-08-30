import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { inspectIosEnvironment } from "./ios-environment.mjs";
import { IosSessionRegistry } from "./ios-session-registry.mjs";
import { createXcodeBuildDiagnosticsParser } from "./ios-build-diagnostics.mjs";
import { SERVE_SIM_PACKAGE_SPEC, ServeSimManager } from "./serve-sim-manager.mjs";
import { createSwiftUIStarter } from "./swiftui-starter.mjs";
import {
  discoverXcodeProjects,
  listXcodeSchemes,
  resolveAppBuildSettings,
  resolveXcodeContainer,
  xcodeContainerArguments
} from "./xcode-projects.mjs";

const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_AX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;
const SUPPORTED_ACTIONS = new Set(["inspect", "tap", "type", "swipe", "button", "rotate", "appearance", "screenshot", "logs"]);
const HARDWARE_BUTTONS = new Set(["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"]);
const ORIENTATIONS = new Set(["portrait", "portrait_upside_down", "landscape_left", "landscape_right"]);

function requiredString(value, label, maxLength = 10_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength || normalized.includes("\0") || /[\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function configurationName(value) {
  const normalized = requiredString(value ?? "Debug", "Build configuration", 200);
  if (!/^[A-Za-z0-9 ._+-]+$/.test(normalized)) throw new Error("Build configuration is invalid");
  return normalized;
}

function appendBounded(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_COMMAND_OUTPUT);
}

function commandFailure(command, args, code, signal, stdout, stderr) {
  const detail = String(stderr || stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  return Object.assign(new Error(detail || `${command} exited with ${code ?? signal ?? "an unknown status"}`), {
    code: "IOS_COMMAND_FAILED",
    command,
    args: [...args],
    exitCode: code,
    signal,
    stdout,
    stderr
  });
}

/** Spawn an iOS command without a shell, with bounded output and cooperative cancellation. */
export function runIosProcess(command, args, {
  signal = null,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  onStdout = null,
  onStderr = null,
  spawnImpl = spawn,
  environment = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: environment
      });
    } catch (error) {
      reject(Object.assign(new Error(`Could not start ${command}: ${error.message}`), {
        code: "IOS_COMMAND_SPAWN_FAILED",
        command,
        cause: error
      }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      child.kill?.("SIGTERM");
      killTimer = setTimeout(() => child.kill?.("SIGKILL"), 2_000);
      killTimer.unref?.();
    }, timeoutMs) : null;
    timeout?.unref?.();

    const abort = () => {
      child.kill?.("SIGTERM");
      killTimer = setTimeout(() => child.kill?.("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
      onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
      onStderr?.(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      reject(Object.assign(new Error(`Could not run ${command}: ${error.message}`), {
        code: "IOS_COMMAND_SPAWN_FAILED",
        command,
        cause: error
      }));
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(Object.assign(new Error(String(signal.reason || "iOS command was cancelled")), {
          code: "IOS_COMMAND_ABORTED",
          command,
          args: [...args],
          exitCode: code,
          signal: childSignal,
          stdout,
          stderr
        }));
      } else if (code !== 0) {
        reject(commandFailure(command, args, code, childSignal, stdout, stderr));
      } else {
        resolve({ stdout, stderr, code, signal: childSignal });
      }
    });
  });
}

function sessionHash(projectId, workspaceId) {
  return createHash("sha256").update(`${projectId}\0${workspaceId}`).digest("hex").slice(0, 24);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function publicSnapshot(value) {
  if (!value) return null;
  const snapshot = clone(value);
  delete snapshot.scratchPath;
  delete snapshot.derivedDataPath;
  delete snapshot.appPath;
  return snapshot;
}

function parseLaunchPid(output, bundleIdentifier) {
  const match = String(output ?? "").trim().match(/:\s*(\d+)\s*$/);
  return { bundleIdentifier, pid: match ? Number(match[1]) : null };
}

function boundedLines(value, limit) {
  return String(value ?? "").split(/\r?\n/).filter(Boolean).slice(-limit);
}

function loopbackUrl(value, endpoint) {
  if (!value) return null;
  try {
    const url = new URL(endpoint, String(value));
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) return null;
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function frameValue(frame, key, nestedKey) {
  return Number(frame?.[key] ?? frame?.[key.toUpperCase()] ?? frame?.[nestedKey]?.[key] ?? frame?.[nestedKey]?.[key.toUpperCase()]);
}

function normalizedAxElements(value, config, limit) {
  const nodes = [];
  const visit = (candidate) => {
    if (!candidate || nodes.length >= limit) return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object") return;
    const frame = candidate.frame ?? candidate.bounds ?? candidate.rect;
    if (frame) nodes.push(candidate);
    const children = candidate.children ?? candidate.elements ?? candidate.nodes;
    if (children && children !== candidate) visit(children);
  };
  visit(value);
  const usedIds = new Set();
  return nodes.slice(0, limit).map((node, index) => {
    const rawFrame = node.frame ?? node.bounds ?? node.rect;
    let x = frameValue(rawFrame, "x", "origin");
    let y = frameValue(rawFrame, "y", "origin");
    let width = frameValue(rawFrame, "width", "size");
    let height = frameValue(rawFrame, "height", "size");
    if ([x, y, width, height].some((number) => !Number.isFinite(number))) return null;
    if (Math.max(x, y, width, height) > 1 && config?.width > 0 && config?.height > 0) {
      x /= config.width;
      width /= config.width;
      y /= config.height;
      height /= config.height;
    }
    const baseId = String(node.id ?? node.identifier ?? node.uid ?? `ax-${index + 1}`);
    let elementId = baseId;
    while (usedIds.has(elementId)) elementId = `${baseId}-${index + 1}`;
    usedIds.add(elementId);
    return {
      elementId,
      role: node.role ?? node.type ?? node.traits ?? null,
      label: node.label ?? node.title ?? node.name ?? null,
      value: node.value ?? null,
      enabled: node.enabled !== false,
      frame: { x, y, width, height }
    };
  }).filter(Boolean);
}

export class IosRuntimeService extends EventEmitter {
  #scratchRoot;
  #registry;
  #serveSim;
  #inspectEnvironment;
  #discoverProjects;
  #listSchemes;
  #resolveBuildSettings;
  #createStarter;
  #runCommand;
  #mkdir;
  #readFile;
  #actionDriver;
  #serveSimCommand;
  #serveSimPackageSpec;
  #fetch;
  #starts = new Map();
  #activeCommands = new Map();
  #terminal = new Map();
  #diagnostics = new Map();
  #inspections = new Map();
  #now;

  constructor({
    scratchRoot,
    registry = new IosSessionRegistry(),
    serveSim = new ServeSimManager(),
    inspectEnvironment = inspectIosEnvironment,
    discoverProjects = discoverXcodeProjects,
    listSchemes = listXcodeSchemes,
    resolveBuildSettings = resolveAppBuildSettings,
    createStarter = createSwiftUIStarter,
    runCommand = runIosProcess,
    mkdirImpl = mkdir,
    readFileImpl = readFile,
    actionDriver = null,
    serveSimCommand = "npx",
    serveSimPackageSpec = SERVE_SIM_PACKAGE_SPEC,
    fetchImpl = globalThis.fetch,
    now = () => new Date().toISOString()
  } = {}) {
    super();
    this.#scratchRoot = path.resolve(requiredString(scratchRoot, "iOS scratch root"));
    this.#registry = registry;
    this.#serveSim = serveSim;
    this.#inspectEnvironment = inspectEnvironment;
    this.#discoverProjects = discoverProjects;
    this.#listSchemes = listSchemes;
    this.#resolveBuildSettings = resolveBuildSettings;
    this.#createStarter = createStarter;
    this.#runCommand = runCommand;
    this.#mkdir = mkdirImpl;
    this.#readFile = readFileImpl;
    this.#actionDriver = actionDriver;
    this.#serveSimCommand = requiredString(serveSimCommand, "serve-sim command", 500);
    this.#serveSimPackageSpec = requiredString(serveSimPackageSpec, "serve-sim package", 500);
    this.#fetch = fetchImpl;
    this.#now = now;

    this.#serveSim.on?.("status", (event) => {
      this.emit("stream-status", clone(event));
      if (event.status === "failed") void this.#handleStreamFailure(event);
    });
    this.#serveSim.on?.("log", (event) => this.emit("log", clone(event)));
  }

  environment() {
    return this.#inspectEnvironment();
  }

  async discover({ projectId, roots }) {
    const project = requiredString(projectId, "Project", 500);
    if (!Array.isArray(roots) || !roots.length) throw new Error("At least one project root is required");
    const [environment, containers] = await Promise.all([
      this.environment(),
      this.#discoverProjects({ roots })
    ]);
    return { projectId: project, environment, containers };
  }

  async createStarter({ projectId, roots }, options = {}) {
    const project = requiredString(projectId, "Project", 500);
    if (!Array.isArray(roots) || !roots.length) throw new Error("At least one project root is required");
    const result = await this.#createStarter({
      workspaceRoot: roots[0],
      relativeDirectory: options.relativeDirectory ?? options.directory,
      name: options.name ?? options.productName,
      displayName: options.displayName ?? options.name ?? options.productName,
      organizationIdentifier: options.organizationIdentifier,
      bundleIdentifier: options.bundleIdentifier,
      deploymentTarget: options.deploymentTarget,
      overwrite: options.overwrite === true
    });
    return { projectId: project, ...result };
  }

  async adopt(fromWorkspaceId, toWorkspaceId) {
    const sourceId = requiredString(fromWorkspaceId, "Source Preview workspace", 500);
    const targetId = requiredString(toWorkspaceId, "Target Preview workspace", 500);
    if (sourceId === targetId) return this.status(targetId);
    if (this.#starts.has(sourceId)) {
      throw Object.assign(new Error("Cannot adopt an iOS session while it is starting"), {
        code: "IOS_SESSION_ADOPTION_BUSY"
      });
    }
    const source = this.#registry.snapshot(sourceId);
    if (!source) return null;
    if (this.#registry.snapshot(targetId)) throw new Error("Target Preview workspace already owns an iOS session");
    if (source.status !== "ready") {
      throw Object.assign(new Error(`Cannot adopt an iOS session while it is ${source.status}`), {
        code: "IOS_SESSION_ADOPTION_BUSY"
      });
    }

    const existingStream = this.#serveSim.snapshot?.(sourceId) ?? null;
    if (existingStream) {
      const stopped = await this.#serveSim.stop(sourceId, "Preview workspace was adopted by a thread");
      if (stopped?.status === "failed") {
        throw Object.assign(new Error(stopped.error || "Could not stop the Simulator preview stream for adoption"), {
          code: "IOS_STREAM_CLEANUP_FAILED"
        });
      }
    }
    const adopted = this.#registry.adopt(sourceId, targetId);
    this.#terminal.delete(sourceId);
    const diagnostics = this.#diagnostics.get(sourceId);
    if (diagnostics) {
      this.#diagnostics.delete(sourceId);
      this.#diagnostics.set(targetId, diagnostics);
    }
    const commands = this.#activeCommands.get(sourceId);
    if (commands) {
      this.#activeCommands.delete(sourceId);
      this.#activeCommands.set(targetId, commands);
      this.#registry.addCleanup(targetId, async () => {
        await Promise.allSettled([...(this.#activeCommands.get(targetId) ?? [])]);
        this.#activeCommands.delete(targetId);
      });
    }

    if (!existingStream) {
      const published = publicSnapshot(adopted);
      this.emit("updated", published);
      return published;
    }

    try {
      this.#update(targetId, { status: "streaming", previewUrl: null, stream: null });
      this.#registry.addCleanup(targetId, async () => {
        const stopped = await this.#serveSim.stop(targetId, "iOS session stopped");
        if (stopped?.status === "failed") throw new Error(stopped.error || "Simulator preview cleanup failed");
      });
      const stream = await this.#serveSim.start({
        workspaceId: targetId,
        simulatorUdid: adopted.simulatorUdid,
        signal: this.#registry.signal(targetId)
      });
      return this.#update(targetId, { status: "ready", previewUrl: stream.previewUrl, stream: clone(stream) });
    } catch (error) {
      const failed = this.#update(targetId, { status: "failed", error: error.message });
      this.#terminal.set(targetId, failed);
      await this.#registry.stop(targetId, `Adopted iOS stream failed: ${error.message}`);
      throw Object.assign(error, { session: failed });
    }
  }

  start(request) {
    const workspaceId = requiredString(request?.workspaceId, "Preview workspace", 500);
    const running = this.#starts.get(workspaceId);
    if (running) return running;
    const promise = this.#start(request).finally(() => this.#starts.delete(workspaceId));
    this.#starts.set(workspaceId, promise);
    return promise;
  }

  status(workspaceId) {
    const ownerId = requiredString(workspaceId, "Preview workspace", 500);
    const live = this.#registry.snapshot(ownerId);
    return publicSnapshot(live ?? this.#terminal.get(ownerId) ?? null);
  }

  async stop(workspaceId, reason = "iOS session stopped") {
    const ownerId = requiredString(workspaceId, "Preview workspace", 500);
    const before = publicSnapshot(this.#registry.snapshot(ownerId) ?? this.#terminal.get(ownerId) ?? null);
    if (!this.#registry.snapshot(ownerId)) return publicSnapshot(before);
    const stopped = await this.#registry.stop(ownerId, reason);
    const snapshot = { ...before, ...stopped, diagnostics: before?.diagnostics ?? null };
    this.#terminal.set(ownerId, snapshot);
    this.emit("updated", publicSnapshot(snapshot));
    return publicSnapshot(snapshot);
  }

  async destroy() {
    const results = await Promise.all(this.#registry.list().map(({ workspaceId }) => this.stop(workspaceId, "Pixice is shutting down")));
    await this.#serveSim.stopAll?.("Pixice is shutting down");
    return results;
  }

  async action(workspaceId, action, argumentsValue = {}) {
    const ownerId = requiredString(workspaceId, "Preview workspace", 500);
    const actionName = requiredString(action, "Simulator action", 100);
    if (!SUPPORTED_ACTIONS.has(actionName)) throw new Error(`Unsupported Simulator action: ${actionName}`);
    const session = this.#registry.snapshot(ownerId);
    if (!session || session.status !== "ready") throw new Error("The iOS Simulator session is not ready");
    const args = argumentsValue && typeof argumentsValue === "object" ? clone(argumentsValue) : {};
    this.#validateAction(actionName, args);

    if (this.#actionDriver?.perform) {
      return this.#actionDriver.perform({
        workspaceId: ownerId,
        simulatorUdid: session.simulatorUdid,
        session: publicSnapshot(session),
        action: actionName,
        arguments: args,
        runCommand: (command, commandArgs, options = {}) => this.#sessionCommand(ownerId, command, commandArgs, options)
      });
    }
    if (actionName === "screenshot") return this.#screenshot(ownerId, session);
    if (actionName === "logs") return this.#logs(ownerId, session, args);
    if (actionName === "inspect") {
      const screenshot = await this.#screenshot(ownerId, session);
      const [tree, config] = await Promise.all([
        this.#readStreamJson(session, "/ax"),
        this.#readStreamJson(session, "/config")
      ]);
      const elements = tree ? normalizedAxElements(tree, config, args.maxElements ?? 100) : [];
      this.#inspections.set(ownerId, elements);
      return {
        revision: session.updatedAt,
        elements,
        accessibilityAvailable: Boolean(tree),
        screenshot
      };
    }
    return this.#performServeSimAction(ownerId, session, actionName, args);
  }

  async #start(request) {
    const workspaceId = requiredString(request?.workspaceId, "Preview workspace", 500);
    const projectId = requiredString(request?.projectId, "Project", 500);
    const simulatorUdid = requiredString(request?.simulatorUdid, "Simulator UDID", 200);
    const scheme = requiredString(request?.scheme, "Scheme", 500);
    const configuration = configurationName(request?.configuration);
    const roots = request?.roots;
    if (!Array.isArray(roots) || !roots.length) throw new Error("At least one project root is required");

    const existing = this.#registry.snapshot(workspaceId);
    if (existing) {
      if (existing.simulatorUdid === simulatorUdid && existing.scheme === scheme && existing.status === "ready") return publicSnapshot(existing);
      await this.stop(workspaceId, "Replacing iOS session");
    }
    this.#terminal.delete(workspaceId);

    const environment = await this.environment();
    if (!environment?.ready) {
      const detail = environment?.issues?.map(({ message }) => message).filter(Boolean).join(" ");
      throw Object.assign(new Error(detail || "The iOS development environment is not ready"), {
        code: "IOS_ENVIRONMENT_NOT_READY",
        environment
      });
    }
    const simulator = environment.simulators?.find((candidate) => candidate.udid === simulatorUdid);
    if (!simulator) throw new Error(`Simulator ${simulatorUdid} is not available`);
    const container = resolveXcodeContainer(request.containerPath, roots);
    const schemes = await this.#listSchemes(container);
    if (!schemes.includes(scheme)) throw new Error(`Scheme ${scheme} is not shared by ${path.basename(container.path)}`);

    const claimed = this.#registry.claim({
      workspaceId,
      projectId,
      simulatorUdid,
      source: request.source ?? "user"
    });
    const scratchPath = path.join(this.#scratchRoot, sessionHash(projectId, workspaceId), claimed.id);
    const derivedDataPath = path.join(scratchPath, "DerivedData");
    const resultBundlePath = path.join(scratchPath, "Build.xcresult");
    await this.#mkdir(derivedDataPath, { recursive: true });
    await this.#mkdir(path.join(scratchPath, "screenshots"), { recursive: true });
    this.#activeCommands.set(workspaceId, new Set());
    this.#registry.addCleanup(workspaceId, async () => {
      await Promise.allSettled([...(this.#activeCommands.get(workspaceId) ?? [])]);
      this.#activeCommands.delete(workspaceId);
    });
    this.#update(workspaceId, {
      scheme,
      configuration,
      containerPath: container.path,
      containerKind: container.kind,
      deviceName: simulator.name,
      simulatorState: simulator.state,
      scratchPath,
      derivedDataPath,
      diagnostics: null
    });

    const parser = createXcodeBuildDiagnosticsParser({
      projectRoot: container.root,
      baseDirectory: container.root,
      allowedRoots: [container.root, ...roots]
    });
    this.#diagnostics.set(workspaceId, parser);
    try {
      await this.#boot(workspaceId, simulator);
      this.#update(workspaceId, { status: "building" });
      const buildArgs = [
        ...xcodeContainerArguments(container),
        "-scheme", scheme,
        "-configuration", configuration,
        "-destination", `id=${simulatorUdid}`,
        "-derivedDataPath", derivedDataPath,
        "-resultBundlePath", resultBundlePath,
        "build"
      ];
      let buildResult;
      try {
        buildResult = await this.#sessionCommand(workspaceId, "xcodebuild", buildArgs, {
          timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
          onStdout: (chunk) => this.#consumeBuildOutput(workspaceId, parser, chunk, "stdout"),
          onStderr: (chunk) => this.#consumeBuildOutput(workspaceId, parser, chunk, "stderr")
        });
      } catch (error) {
        const diagnostics = parser.finish({
          exitCode: error.exitCode ?? 1,
          signal: error.signal ?? null,
          xcresultPath: resultBundlePath
        });
        this.#update(workspaceId, { diagnostics });
        throw error;
      }
      const diagnostics = parser.finish({ exitCode: buildResult.code ?? 0, xcresultPath: resultBundlePath });
      this.#update(workspaceId, { diagnostics });

      const product = await this.#resolveBuildSettings({
        container,
        scheme,
        configuration,
        simulatorUdid,
        derivedDataPath
      });
      this.#registry.addCleanup(workspaceId, async () => {
        try {
          await this.#runCommand("xcrun", ["simctl", "terminate", simulatorUdid, product.bundleIdentifier], { timeoutMs: 15_000 });
        } catch {
          // The app may not have launched. Session cleanup remains successful.
        }
      });
      this.#update(workspaceId, { status: "installing", appPath: product.appPath, bundleIdentifier: product.bundleIdentifier });
      await this.#sessionCommand(workspaceId, "xcrun", ["simctl", "install", simulatorUdid, product.appPath]);

      this.#update(workspaceId, { status: "launching" });
      const launched = await this.#sessionCommand(workspaceId, "xcrun", [
        "simctl", "launch", "--terminate-running-process", simulatorUdid, product.bundleIdentifier
      ]);
      this.#update(workspaceId, { app: parseLaunchPid(launched.stdout, product.bundleIdentifier) });

      this.#update(workspaceId, { status: "streaming" });
      this.#registry.addCleanup(workspaceId, async () => {
        const stopped = await this.#serveSim.stop(workspaceId, "iOS session stopped");
        if (stopped?.status === "failed") throw new Error(stopped.error || "Simulator preview cleanup failed");
      });
      const stream = await this.#serveSim.start({
        workspaceId,
        simulatorUdid,
        signal: this.#registry.signal(workspaceId)
      });
      return this.#update(workspaceId, {
        status: "ready",
        previewUrl: stream.previewUrl,
        stream: clone(stream)
      });
    } catch (error) {
      const live = this.#registry.snapshot(workspaceId);
      if (live) {
        const diagnostics = live.diagnostics ?? this.#diagnostics.get(workspaceId)?.finish({
          exitCode: error.exitCode ?? 1,
          signal: error.signal ?? null,
          xcresultPath: resultBundlePath
        });
        const failed = this.#update(workspaceId, {
          status: "failed",
          error: error.message,
          diagnostics
        });
        this.#terminal.set(workspaceId, failed);
        await this.#registry.stop(workspaceId, `iOS session failed: ${error.message}`);
      }
      this.#diagnostics.delete(workspaceId);
      throw Object.assign(error, { session: clone(this.#terminal.get(workspaceId) ?? null) });
    }
  }

  async #boot(workspaceId, simulator) {
    this.#update(workspaceId, { status: "booting" });
    if (simulator.state !== "Booted") {
      try {
        await this.#sessionCommand(workspaceId, "xcrun", ["simctl", "boot", simulator.udid], { timeoutMs: 30_000 });
      } catch (error) {
        if (!/already booted|current state:\s*Booted/i.test(`${error.stderr ?? ""}\n${error.message}`)) throw error;
      }
    }
    await this.#sessionCommand(workspaceId, "xcrun", ["simctl", "bootstatus", simulator.udid, "-b"], { timeoutMs: 120_000 });
  }

  #sessionCommand(workspaceId, command, args, options = {}) {
    const signal = this.#registry.signal(workspaceId);
    const promise = Promise.resolve().then(() => this.#runCommand(command, args, { ...options, signal }));
    const commands = this.#activeCommands.get(workspaceId);
    commands?.add(promise);
    promise.finally(() => commands?.delete(promise)).catch(() => {});
    return promise;
  }

  #consumeBuildOutput(workspaceId, parser, chunk, stream) {
    const delta = parser.push(chunk);
    const diagnostics = parser.snapshot();
    this.#update(workspaceId, { diagnostics });
    this.emit("build-output", {
      workspaceId,
      stream,
      text: String(chunk),
      delta: clone(delta)
    });
  }

  #update(workspaceId, patch) {
    const snapshot = this.#registry.update(workspaceId, patch);
    const published = publicSnapshot(snapshot);
    this.emit("updated", published);
    return published;
  }

  async #handleStreamFailure(event) {
    const live = this.#registry.snapshot(event.workspaceId);
    if (!live || live.status !== "ready") return;
    const failed = this.#update(event.workspaceId, { status: "failed", error: event.error || "Simulator preview stream stopped" });
    this.#terminal.set(event.workspaceId, failed);
    await this.#registry.stop(event.workspaceId, "Simulator preview stream failed");
  }

  #validateAction(action, args) {
    const coordinate = (value, label) => {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
    };
    if (action === "tap") {
      const elementId = typeof args.elementId === "string" ? args.elementId.trim() : "";
      const hasCoordinates = args.x !== undefined || args.y !== undefined;
      if (Boolean(elementId) === hasCoordinates) throw new Error("Pass either an element ID or both tap coordinates");
      if (elementId.length > 500) throw new Error("Element ID is too long");
      if (!elementId) {
        coordinate(args.x, "Tap x");
        coordinate(args.y, "Tap y");
      }
    }
    if (action === "swipe") {
      coordinate(args.startX, "Swipe start x");
      coordinate(args.startY, "Swipe start y");
      coordinate(args.endX, "Swipe end x");
      coordinate(args.endY, "Swipe end y");
      const duration = args.durationMs ?? 350;
      if (!Number.isInteger(duration) || duration < 50 || duration > 5_000) throw new Error("Swipe duration must be between 50 and 5000 milliseconds");
    }
    if (action === "type") {
      if (typeof args.text !== "string") throw new Error("Typed text is required");
      if (args.text.length > 10_000) throw new Error("Typed text is too long");
    }
    if (action === "button" && !HARDWARE_BUTTONS.has(args.name)) throw new Error("Unsupported Simulator button");
    if (action === "rotate" && !ORIENTATIONS.has(args.orientation)) throw new Error("Unsupported Simulator orientation");
    if (action === "appearance" && !["light", "dark"].includes(args.theme)) throw new Error("Unsupported Simulator appearance");
    if (action === "inspect" && args.maxElements !== undefined && (!Number.isInteger(args.maxElements) || args.maxElements < 1 || args.maxElements > 500)) {
      throw new Error("Accessibility element limit must be between 1 and 500");
    }
    if (action === "logs" && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1_000)) {
      throw new Error("Log limit must be between 1 and 1000");
    }
  }

  async #performServeSimAction(workspaceId, session, action, args) {
    const target = ["-d", session.simulatorUdid];
    let commands;
    if (action === "tap") {
      if (args.elementId) {
        const element = this.#inspections.get(workspaceId)?.find((candidate) => candidate.elementId === args.elementId);
        if (!element) {
          throw Object.assign(new Error(`Accessibility element ${args.elementId} is not in the latest inspection`), {
            code: "IOS_ELEMENT_NOT_FOUND",
            elementId: args.elementId
          });
        }
        args = {
          ...args,
          x: element.frame.x + element.frame.width / 2,
          y: element.frame.y + element.frame.height / 2
        };
      }
      commands = [["tap", String(args.x), String(args.y), ...target]];
    } else if (action === "type") {
      commands = [["type", args.text, ...target]];
    } else if (action === "button") {
      commands = [["button", args.name, ...target]];
    } else if (action === "rotate") {
      commands = [["rotate", args.orientation, ...target]];
    } else if (action === "appearance") {
      commands = [["ui", "appearance", args.theme, ...target]];
    } else if (action === "swipe") {
      const steps = [
        { type: "begin", x: args.startX, y: args.startY },
        { type: "move", x: args.endX, y: args.endY },
        { type: "end", x: args.endX, y: args.endY }
      ];
      commands = steps.map((step) => ["gesture", JSON.stringify(step), ...target]);
    } else {
      throw Object.assign(new Error(`Unsupported Simulator action: ${action}`), { code: "IOS_ACTION_UNAVAILABLE", action });
    }

    const output = [];
    for (const commandArgs of commands) {
      const result = await this.#sessionCommand(workspaceId, this.#serveSimCommand, [
        "--yes", this.#serveSimPackageSpec, ...commandArgs
      ], { timeoutMs: 30_000 });
      output.push(String(result.stdout ?? "").trim());
    }
    return {
      ok: true,
      action,
      simulatorUdid: session.simulatorUdid,
      output: output.filter(Boolean)
    };
  }

  async #readStreamJson(session, endpoint) {
    if (typeof this.#fetch !== "function") return null;
    const url = loopbackUrl(session.stream?.streamUrl ?? session.streamUrl, endpoint);
    if (!url) return null;
    try {
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response?.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_AX_RESPONSE_BYTES) return null;
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
  }

  async #screenshot(workspaceId, session) {
    const screenshotPath = path.join(session.scratchPath, "screenshots", `${Date.now()}.png`);
    await this.#sessionCommand(workspaceId, "xcrun", ["simctl", "io", session.simulatorUdid, "screenshot", "--type=png", screenshotPath]);
    const bytes = await this.#readFile(screenshotPath);
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Simulator screenshot exceeds the 25 MB limit");
    return {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      evidence: { captured: true, simulatorUdid: session.simulatorUdid, capturedAt: this.#now() }
    };
  }

  async #logs(workspaceId, session, args) {
    const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1_000);
    const predicate = session.bundleIdentifier ? `process == "${session.bundleIdentifier.replaceAll('"', "")}"` : "processType == 1";
    const result = await this.#sessionCommand(workspaceId, "xcrun", [
      "simctl", "spawn", session.simulatorUdid,
      "log", "show", "--style", "compact", "--last", "5m", "--predicate", predicate
    ], { timeoutMs: 30_000 });
    const lines = boundedLines(result.stdout, limit);
    return { lines, text: lines.join("\n"), truncated: boundedLines(result.stdout, limit + 1).length > limit };
  }
}
