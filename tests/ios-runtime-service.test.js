import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IosRuntimeService } from "../electron/ios/ios-runtime-service.mjs";

const temporaryDirectories = [];

async function projectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pixice-ios-runtime-"));
  temporaryDirectories.push(root);
  const containerPath = path.join(root, "Demo.xcodeproj");
  await mkdir(containerPath);
  return { root, containerPath };
}

afterEach(async () => {
  const fs = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class FakeServeSim extends EventEmitter {
  starts = [];
  stops = [];
  sessions = new Map();
  failStop = false;

  async start(request) {
    this.starts.push(request);
    const session = {
      workspaceId: request.workspaceId,
      simulatorUdid: request.simulatorUdid,
      status: "ready",
      previewUrl: "http://127.0.0.1:41000",
      streamUrl: "http://127.0.0.1:41001",
      port: 41000
    };
    this.sessions.set(request.workspaceId, session);
    return session;
  }

  async stop(workspaceId, reason) {
    this.stops.push({ workspaceId, reason });
    this.sessions.delete(workspaceId);
    if (this.failStop) return { workspaceId, status: "failed", error: "scoped helper remained alive" };
    return { workspaceId, status: "stopped" };
  }

  snapshot(workspaceId) {
    return this.sessions.get(workspaceId) ?? null;
  }

  async stopAll() {}
}

function environment(state = "Shutdown") {
  return {
    ready: true,
    simulators: [{ udid: "SIM-ONE", name: "iPhone 16 Pro", state }],
    issues: []
  };
}

async function harness({
  simulatorState = "Shutdown",
  runCommand: runCommandOverride = null,
  actionDriver = null,
  fetchImpl = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
  readFileImpl = async () => Buffer.from("png"),
  inspectEnvironment = vi.fn(async () => environment(simulatorState))
} = {}) {
  const fixture = await projectFixture();
  const calls = [];
  const runCommand = runCommandOverride ?? vi.fn(async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "xcodebuild") {
      options.onStdout?.(Buffer.from(`${fixture.root}/Demo/ContentView.swift:7:2: warning: test warning\n`));
      options.onStdout?.(Buffer.from("** BUILD SUCCEEDED **\n"));
    }
    if (args.includes("launch")) return { code: 0, stdout: "com.example.demo: 4242\n", stderr: "" };
    if (args.includes("log")) return { code: 0, stdout: "first\nsecond\nthird\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const serveSim = new FakeServeSim();
  const resolveBuildSettings = vi.fn(async () => ({
    appPath: path.join(fixture.root, "DerivedData", "Demo.app"),
    bundleIdentifier: "com.example.demo",
    productName: "Demo"
  }));
  const service = new IosRuntimeService({
    scratchRoot: path.join(fixture.root, ".pixice-ios"),
    serveSim,
    inspectEnvironment,
    listSchemes: vi.fn(async () => ["Demo"]),
    resolveBuildSettings,
    runCommand,
    readFileImpl,
    actionDriver,
    fetchImpl,
    now: () => "2026-08-29T12:00:00.000Z"
  });
  return { service, fixture, calls, runCommand, serveSim, resolveBuildSettings, inspectEnvironment };
}

function request(fixture, overrides = {}) {
  return {
    workspaceId: "thread-1",
    projectId: "project-1",
    roots: [fixture.root],
    containerPath: fixture.containerPath,
    scheme: "Demo",
    simulatorUdid: "SIM-ONE",
    configuration: "Debug",
    ...overrides
  };
}

describe("IosRuntimeService", () => {
  it("runs the full lifecycle with explicit destination and scoped streaming", async () => {
    const context = await harness();
    const updates = [];
    context.service.on("updated", (snapshot) => updates.push(snapshot));

    const session = await context.service.start(request(context.fixture));

    expect(updates.map(({ status }) => status)).toEqual(expect.arrayContaining([
      "preparing", "booting", "building", "installing", "launching", "streaming", "ready"
    ]));
    const build = context.calls.find(({ command }) => command === "xcodebuild");
    expect(build.args[0]).toBe("-project");
    expect(build.args[1]).toMatch(/Demo\.xcodeproj$/);
    expect(build.args).toEqual(expect.arrayContaining(["-destination", "id=SIM-ONE", "-derivedDataPath"]));
    expect(build.args).not.toContain("booted");
    expect(context.calls.map(({ args }) => args).filter((args) => args[1] === "boot")).toEqual([
      ["simctl", "boot", "SIM-ONE"]
    ]);
    expect(context.serveSim.starts).toHaveLength(1);
    expect(context.serveSim.starts[0]).toMatchObject({ workspaceId: "thread-1", simulatorUdid: "SIM-ONE" });
    expect(session).toMatchObject({
      status: "ready",
      previewUrl: "http://127.0.0.1:41000",
      bundleIdentifier: "com.example.demo",
      app: { bundleIdentifier: "com.example.demo", pid: 4242 },
      diagnostics: { progress: { status: "succeeded" } }
    });
    expect(session).not.toHaveProperty("scratchPath");
    expect(session).not.toHaveProperty("derivedDataPath");
    expect(session).not.toHaveProperty("appPath");
  });

  it("skips boot for an already booted device and stops app and stream deterministically", async () => {
    const context = await harness({ simulatorState: "Booted" });
    await context.service.start(request(context.fixture));

    const stopped = await context.service.stop("thread-1", "Preview closed");

    expect(context.calls.some(({ args }) => args[1] === "boot")).toBe(false);
    expect(context.calls.some(({ args }) => args[1] === "bootstatus")).toBe(true);
    expect(context.serveSim.stops).toEqual([{ workspaceId: "thread-1", reason: "iOS session stopped" }]);
    expect(context.calls.some(({ args }) => args[1] === "terminate" && args[2] === "SIM-ONE")).toBe(true);
    expect(stopped).toMatchObject({ status: "stopped", scheme: "Demo", diagnostics: expect.any(Object) });
    expect(context.service.status("thread-1")).toMatchObject({ status: "stopped" });
  });

  it("keeps scoped stream cleanup failures visible in final session state", async () => {
    const context = await harness({ simulatorState: "Booted" });
    await context.service.start(request(context.fixture));
    context.serveSim.failStop = true;

    const stopped = await context.service.stop("thread-1");

    expect(stopped).toMatchObject({ status: "failed", error: "scoped helper remained alive" });
    expect(context.service.status("thread-1")).toMatchObject({ status: "failed" });
  });

  it("keeps parsed compiler evidence after a failed build and releases ownership", async () => {
    const fixture = await projectFixture();
    const failure = Object.assign(new Error("Build failed"), { exitCode: 65, stderr: "compile failed" });
    const runCommand = vi.fn(async (command, _args, options = {}) => {
      if (command === "xcodebuild") {
        options.onStderr?.(Buffer.from(`${fixture.root}/Demo/ContentView.swift:9:3: error: missing value\n`));
        throw failure;
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const serveSim = new FakeServeSim();
    const resolveBuildSettings = vi.fn(async () => ({
      appPath: path.join(fixture.root, "DerivedData", "Demo.app"),
      bundleIdentifier: "com.example.demo"
    }));
    const service = new IosRuntimeService({
      scratchRoot: path.join(fixture.root, ".scratch"),
      serveSim,
      inspectEnvironment: async () => environment(),
      listSchemes: async () => ["Demo"],
      resolveBuildSettings,
      runCommand
    });

    await expect(service.start(request(fixture))).rejects.toMatchObject({
      message: "Build failed",
      session: {
        status: "failed",
        diagnostics: { diagnostics: [expect.objectContaining({ severity: "error", line: 9, openable: true })] }
      }
    });
    expect(service.status("thread-1")).toMatchObject({ status: "failed", error: "Build failed" });
    expect(serveSim.starts).toHaveLength(0);

    runCommand.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(service.start(request(fixture, { workspaceId: "thread-2" }))).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects unavailable UDIDs and non-shared schemes before claiming a session", async () => {
    const context = await harness();

    await expect(context.service.start(request(context.fixture, { simulatorUdid: "SIM-MISSING" })))
      .rejects.toThrow("Simulator SIM-MISSING is not available");
    await expect(context.service.start(request(context.fixture, { scheme: "PrivateScheme" })))
      .rejects.toThrow("Scheme PrivateScheme is not shared");
    expect(context.service.status("thread-1")).toBeNull();
    expect(context.runCommand).not.toHaveBeenCalled();
  });

  it("aborts in-flight commands when Stop is requested", async () => {
    let resolveBuild;
    const buildStarted = new Promise((resolve) => { resolveBuild = resolve; });
    const runCommand = vi.fn((command, _args, { signal } = {}) => {
      if (command !== "xcodebuild") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      resolveBuild();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("Preview closed"), { code: "IOS_COMMAND_ABORTED" })), { once: true });
      });
    });
    const context = await harness({ runCommand });
    const started = context.service.start(request(context.fixture));
    await buildStarted;

    const stopped = await context.service.stop("thread-1", "Preview closed");

    await expect(started).rejects.toMatchObject({ code: "IOS_COMMAND_ABORTED" });
    expect(stopped.status).toBe("stopped");
    expect(context.service.status("thread-1")).toMatchObject({ status: "stopped" });
  });

  it("supports screenshots, logs, serve-sim controls, and injected interaction drivers", async () => {
    const perform = vi.fn(async ({ action, simulatorUdid }) => ({ action, simulatorUdid, ok: true }));
    const context = await harness();
    await context.service.start(request(context.fixture));

    const screenshot = await context.service.action("thread-1", "screenshot");
    const logs = await context.service.action("thread-1", "logs", { limit: 2 });
    expect(screenshot).toMatchObject({ dataUrl: "data:image/png;base64,cG5n", evidence: { simulatorUdid: "SIM-ONE" } });
    expect(logs.lines).toEqual(["second", "third"]);
    await expect(context.service.action("thread-1", "tap", { x: 0.5, y: 0.5 }))
      .resolves.toMatchObject({ ok: true, action: "tap", simulatorUdid: "SIM-ONE" });
    expect(context.calls.at(-1)).toMatchObject({
      command: "npx",
      args: ["--yes", "serve-sim@0.1.46", "tap", "0.5", "0.5", "-d", "SIM-ONE"]
    });

    const driven = await harness({ actionDriver: { perform } });
    await driven.service.start(request(driven.fixture));
    await expect(driven.service.action("thread-1", "rotate", { orientation: "landscape_left" }))
      .resolves.toEqual({ action: "rotate", simulatorUdid: "SIM-ONE", ok: true });
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "rotate", simulatorUdid: "SIM-ONE" }));
  });

  it("returns bounded accessibility elements and taps the latest element center", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const payload = String(url).endsWith("/config")
        ? { width: 400, height: 800 }
        : { elements: [{ identifier: "continue", role: "button", label: "Continue", frame: { x: 100, y: 200, width: 80, height: 40 } }] };
      return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(payload)) };
    });
    const context = await harness({ fetchImpl });
    await context.service.start(request(context.fixture));

    const inspection = await context.service.action("thread-1", "inspect", { maxElements: 20 });
    expect(inspection).toMatchObject({
      accessibilityAvailable: true,
      elements: [{ elementId: "continue", label: "Continue", frame: { x: 0.25, y: 0.25, width: 0.2, height: 0.05 } }]
    });
    await context.service.action("thread-1", "tap", { elementId: "continue" });
    expect(context.calls.at(-1)).toMatchObject({
      command: "npx",
      args: ["--yes", "serve-sim@0.1.46", "tap", "0.35", "0.275", "-d", "SIM-ONE"]
    });
  });

  it("adopts a ready draft session by restarting only its scoped stream", async () => {
    const context = await harness();
    await context.service.start(request(context.fixture, { workspaceId: "draft:project-1" }));

    const adopted = await context.service.adopt("draft:project-1", "thread-1");

    expect(context.serveSim.stops[0]).toEqual({
      workspaceId: "draft:project-1",
      reason: "Preview workspace was adopted by a thread"
    });
    expect(context.serveSim.starts.at(-1)).toMatchObject({ workspaceId: "thread-1", simulatorUdid: "SIM-ONE" });
    expect(context.service.status("draft:project-1")).toBeNull();
    expect(adopted).toMatchObject({ workspaceId: "thread-1", status: "ready", previewUrl: "http://127.0.0.1:41000" });

    await context.service.stop("thread-1");
    expect(context.serveSim.stops.some(({ workspaceId }) => workspaceId === "thread-1")).toBe(true);
  });

  it("discovers containers alongside current environment readiness", async () => {
    const context = await harness();
    const discovered = [{ path: context.fixture.containerPath, kind: "project", schemes: ["Demo"] }];
    const service = new IosRuntimeService({
      scratchRoot: path.join(context.fixture.root, ".other"),
      serveSim: new FakeServeSim(),
      inspectEnvironment: async () => environment(),
      discoverProjects: vi.fn(async ({ roots }) => roots[0] === context.fixture.root ? discovered : [])
    });

    await expect(service.discover({ projectId: "project-1", roots: [context.fixture.root] })).resolves.toEqual({
      projectId: "project-1",
      environment: environment(),
      containers: discovered
    });
  });

  it("creates a starter inside the selected project root", async () => {
    const context = await harness();
    const createStarter = vi.fn(async (options) => ({
      directory: path.join(options.workspaceRoot, options.relativeDirectory),
      containerPath: path.join(options.workspaceRoot, options.relativeDirectory, "Demo.xcodeproj"),
      scheme: "Demo"
    }));
    const service = new IosRuntimeService({
      scratchRoot: path.join(context.fixture.root, ".starter"),
      serveSim: new FakeServeSim(),
      createStarter
    });

    const result = await service.createStarter({ projectId: "project-1", roots: [context.fixture.root] }, {
      relativeDirectory: "Apps/Demo",
      name: "Demo",
      organizationIdentifier: "com.example"
    });

    expect(createStarter).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: context.fixture.root,
      relativeDirectory: "Apps/Demo",
      name: "Demo",
      displayName: "Demo",
      organizationIdentifier: "com.example",
      overwrite: false
    }));
    expect(result).toMatchObject({ projectId: "project-1", scheme: "Demo" });
  });

  it("passes the public starter name to the real generator", async () => {
    const context = await harness();
    const service = new IosRuntimeService({
      scratchRoot: path.join(context.fixture.root, ".real-starter"),
      serveSim: new FakeServeSim()
    });

    const result = await service.createStarter({ projectId: "project-1", roots: [context.fixture.root] }, {
      name: "Pocket Notes",
      relativeDirectory: "Apps/PocketNotes"
    });

    expect(result).toMatchObject({ projectId: "project-1", productName: "PocketNotes" });
    await expect(access(path.join(result.destination, "PocketNotes.xcodeproj", "project.pbxproj"))).resolves.toBeUndefined();
  });
});
