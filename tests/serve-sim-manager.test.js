import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ServeSimManager, parseServeSimReadiness } from "../electron/ios/serve-sim-manager.mjs";

class FakeChild extends EventEmitter {
  constructor({ pid = 100, exitOnSignal = null } = {}) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitOnSignal = exitOnSignal;
    this.kill = vi.fn((signal = "SIGTERM") => {
      if (this.exitOnSignal === signal || this.exitOnSignal === true) queueMicrotask(() => this.exit(null, signal));
      return true;
    });
  }

  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function harness({ mainChild = new FakeChild(), cleanupExitCode = 0, managerOptions = {} } = {}) {
  const calls = [];
  const cleanupChildren = [];
  const spawn = vi.fn((command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("--kill")) {
      const child = new FakeChild({ pid: 200 + cleanupChildren.length, exitOnSignal: "SIGKILL" });
      cleanupChildren.push(child);
      queueMicrotask(() => child.exit(cleanupExitCode));
      return child;
    }
    return mainChild;
  });
  const manager = new ServeSimManager({
    spawnImpl: spawn,
    allocatePort: vi.fn(async () => 43210),
    readyTimeoutMs: 100,
    stopTimeoutMs: 10,
    cleanupTimeoutMs: 50,
    now: () => "2026-08-29T12:00:00.000Z",
    ...managerOptions
  });
  return { manager, mainChild, spawn, calls, cleanupChildren };
}

async function startReady(context, { workspaceId = "thread-1", simulatorUdid = "SIM-ONE", port } = {}) {
  const started = context.manager.start({ workspaceId, simulatorUdid, ...(port ? { port } : {}) });
  await vi.waitFor(() => expect(context.calls.some((call) => !call.args.includes("--kill"))).toBe(true));
  context.mainChild.stdout.write('{"pid":777,"device":"SIM-ONE","url":"http://localhost:43210",');
  context.mainChild.stdout.write('"streamUrl":"http://127.0.0.1:3100"}\n');
  return started;
}

describe("serve-sim readiness parsing", () => {
  it("accepts loopback JSON and rejects banners, remote URLs, and another Simulator", () => {
    expect(parseServeSimReadiness('{"url":"http://localhost:3200","streamUrl":"http://127.0.0.1:3100","pid":42}', {
      expectedUdid: "SIM-ONE"
    })).toEqual({ previewUrl: "http://localhost:3200", streamUrl: "http://127.0.0.1:3100", port: 3200, pid: 42 });
    expect(parseServeSimReadiness("Preview at http://localhost:3200")).toBeNull();
    expect(parseServeSimReadiness({ url: "http://192.168.1.2:3200" })).toBeNull();
    expect(parseServeSimReadiness({ device: "SIM-TWO", url: "http://localhost:3200" }, { expectedUdid: "SIM-ONE" })).toBeNull();
  });

  it("supports nested machine-readable results", () => {
    expect(parseServeSimReadiness({ data: { simulatorUdid: "SIM-ONE", previewUrl: "http://[::1]:3300/" } }, {
      expectedUdid: "SIM-ONE"
    })).toMatchObject({ previewUrl: "http://[::1]:3300", port: 3300 });
  });
});

describe("ServeSimManager", () => {
  it("starts one explicit UDID, parses split JSON, and emits useful events", async () => {
    const context = harness();
    const statuses = [];
    const logs = [];
    context.manager.on("status", (event) => statuses.push(event));
    context.manager.on("log", (event) => logs.push(event));

    const session = await startReady(context);

    expect(session).toMatchObject({
      workspaceId: "thread-1",
      simulatorUdid: "SIM-ONE",
      status: "ready",
      port: 43210,
      previewUrl: "http://localhost:43210",
      streamUrl: "http://127.0.0.1:3100",
      pid: 777
    });
    expect(context.calls[0].args).toEqual(["--yes", "serve-sim@0.1.46", "--kill", "SIM-ONE", "--quiet"]);
    expect(context.calls[1].args).toEqual(["--yes", "serve-sim@0.1.46", "--quiet", "--port", "43210", "SIM-ONE"]);
    expect(statuses.map(({ status }) => status)).toEqual(["cleaning", "starting", "ready"]);
    expect(logs.some(({ stream, text }) => stream === "stdout" && text.includes("streamUrl"))).toBe(true);
  });

  it("reserves workspaces and Simulator UDIDs before asynchronous startup", () => {
    const context = harness();
    void context.manager.start({ workspaceId: "thread-1", simulatorUdid: "SIM-ONE" }).catch(() => {});

    expect(() => context.manager.start({ workspaceId: "thread-1", simulatorUdid: "SIM-TWO" }))
      .toThrow("Preview workspace already owns");
    expect(() => context.manager.start({ workspaceId: "thread-2", simulatorUdid: "SIM-ONE" }))
      .toThrow("already streamed by Preview workspace thread-1");
  });

  it("allows concurrent sessions on different Simulators", async () => {
    const children = [new FakeChild({ pid: 101 }), new FakeChild({ pid: 102 })];
    const foreground = [];
    const spawn = vi.fn((_command, args) => {
      if (args.includes("--kill")) {
        const cleanup = new FakeChild();
        queueMicrotask(() => cleanup.exit(0));
        return cleanup;
      }
      const child = children[foreground.length];
      foreground.push(child);
      return child;
    });
    const manager = new ServeSimManager({ spawnImpl: spawn, allocatePort: async ({ workspaceId }) => workspaceId === "one" ? 41001 : 41002 });
    const first = manager.start({ workspaceId: "one", simulatorUdid: "SIM-ONE" });
    const second = manager.start({ workspaceId: "two", simulatorUdid: "SIM-TWO" });
    await vi.waitFor(() => expect(foreground).toHaveLength(2));
    children[0].stdout.write('{"device":"SIM-ONE","url":"http://localhost:41001"}\n');
    children[1].stdout.write('{"device":"SIM-TWO","url":"http://localhost:41002"}\n');

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { workspaceId: "one", simulatorUdid: "SIM-ONE", port: 41001 },
      { workspaceId: "two", simulatorUdid: "SIM-TWO", port: 41002 }
    ]);
  });

  it("reports port collisions and never issues an unscoped cleanup", async () => {
    const context = harness();
    const started = context.manager.start({ workspaceId: "thread-1", simulatorUdid: "SIM-ONE", port: 45678 });
    await vi.waitFor(() => expect(context.calls).toHaveLength(2));
    context.mainChild.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:45678\n");
    context.mainChild.exit(1);

    await expect(started).rejects.toMatchObject({ code: "SERVE_SIM_PORT_IN_USE", port: 45678 });
    for (const call of context.calls.filter(({ args }) => args.includes("--kill"))) {
      expect(call.args[call.args.indexOf("--kill") + 1]).toBe("SIM-ONE");
    }
    expect(context.calls.filter(({ args }) => args.includes("--kill"))).toHaveLength(2);
    expect(context.manager.snapshot("thread-1")).toBeNull();
  });

  it("stops with SIGTERM and then performs scoped cleanup", async () => {
    const mainChild = new FakeChild({ exitOnSignal: "SIGTERM" });
    const context = harness({ mainChild });
    await startReady(context);

    const stopped = await context.manager.stop("thread-1", "Preview closed");

    expect(mainChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mainChild.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(context.calls.at(-1).args).toEqual(["--yes", "serve-sim@0.1.46", "--kill", "SIM-ONE", "--quiet"]);
    expect(stopped).toMatchObject({ status: "stopped", error: null });
    expect(context.manager.snapshot("thread-1")).toBeNull();
  });

  it("uses bounded SIGKILL when the foreground process ignores SIGTERM", async () => {
    const mainChild = new FakeChild({ exitOnSignal: "SIGKILL" });
    const context = harness({ mainChild, managerOptions: { stopTimeoutMs: 2 } });
    await startReady(context);

    await context.manager.stop("thread-1");

    expect(mainChild.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("records final scoped-cleanup failures", async () => {
    const mainChild = new FakeChild({ exitOnSignal: "SIGTERM" });
    const context = harness({ mainChild, cleanupExitCode: 1 });
    await startReady(context);

    const stopped = await context.manager.stop("thread-1");

    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("Scoped serve-sim cleanup exited with 1");
  });

  it("stops an in-flight start when its AbortSignal fires", async () => {
    const context = harness();
    const controller = new AbortController();
    const started = context.manager.start({ workspaceId: "thread-1", simulatorUdid: "SIM-ONE", signal: controller.signal });
    await vi.waitFor(() => expect(context.calls).toHaveLength(2));

    controller.abort("Thread closed");

    await expect(started).rejects.toMatchObject({ code: "SERVE_SIM_ABORTED" });
    await vi.waitFor(() => expect(context.manager.snapshot("thread-1")).toBeNull());
  });

  it("cleans up and releases ownership after an unexpected exit", async () => {
    const mainChild = new FakeChild();
    const context = harness({ mainChild });
    await startReady(context);

    mainChild.stderr.write("stream crashed\n");
    mainChild.exit(2);
    await vi.waitFor(() => expect(context.manager.snapshot("thread-1")).toBeNull());

    const restarted = context.manager.start({ workspaceId: "thread-2", simulatorUdid: "SIM-ONE" });
    await vi.waitFor(() => expect(context.manager.snapshot("thread-2")).not.toBeNull());
    const stopped = context.manager.stop("thread-2");
    await expect(restarted).rejects.toMatchObject({ code: "SERVE_SIM_ABORTED" });
    await stopped;
  });
});
