import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeThreadName,
  ThreadNamer,
  THREAD_NAMING_EFFORT,
  THREAD_NAMING_MODEL
} from "../electron/runtime/thread-namer.mjs";

class FakeRuntime extends EventEmitter {
  constructor(output = "Authentication session repair") {
    super();
    this.output = output;
    this.request = vi.fn(this.#request.bind(this));
  }

  async #request(method, params) {
    if (method === "thread/start") return { thread: { id: "title-helper", ephemeral: true } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("event", {
          type: "ActivityReceived",
          payload: {
            method: "item/completed",
            threadId: params.threadId,
            turnId: "title-turn",
            item: { id: "title-message", type: "agentMessage", text: this.output }
          }
        });
        this.emit("event", {
          type: "TaskUpdated",
          payload: { method: "turn/completed", threadId: params.threadId, turn: { id: "title-turn", status: "completed" } }
        });
      });
      return { turn: { id: "title-turn", status: "inProgress" } };
    }
    if (method === "thread/name/set") return {};
    throw new Error(`Unexpected request: ${method}`);
  }
}

describe("ThreadNamer", () => {
  it("uses an ephemeral Luna low-reasoning turn and applies the generated name", async () => {
    const runtime = new FakeRuntime();
    const namer = new ThreadNamer(runtime, { timeoutMs: 1_000 });
    const named = vi.fn();
    namer.on("named", named);

    await expect(namer.nameThread({
      threadId: "task-1",
      cwd: "/work/aurora",
      source: "Fix authentication sessions after the cookie migration",
      kind: "task"
    })).resolves.toBe("Authentication session repair");

    expect(runtime.request).toHaveBeenNthCalledWith(1, "thread/start", expect.objectContaining({
      cwd: "/work/aurora",
      model: THREAD_NAMING_MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true
    }));
    expect(runtime.request).toHaveBeenNthCalledWith(2, "turn/start", expect.objectContaining({
      threadId: "title-helper",
      model: THREAD_NAMING_MODEL,
      effort: THREAD_NAMING_EFFORT,
      sandboxPolicy: { type: "readOnly" }
    }));
    expect(runtime.request).toHaveBeenNthCalledWith(3, "thread/name/set", {
      threadId: "task-1",
      name: "Authentication session repair"
    });
    expect(namer.isInternalThread("title-helper")).toBe(true);
    expect(named).toHaveBeenCalledWith({ threadId: "task-1", name: "Authentication session repair", kind: "task" });
  });

  it("coalesces duplicate naming requests for the same thread", async () => {
    const runtime = new FakeRuntime();
    const namer = new ThreadNamer(runtime, { timeoutMs: 1_000 });
    const request = { threadId: "agent-1", cwd: "/work/aurora", source: "Audit runtime safety", kind: "thread" };

    const first = namer.nameThread(request);
    const second = namer.nameThread(request);
    await Promise.all([first, second]);

    expect(runtime.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(runtime.request.mock.calls.filter(([method]) => method === "thread/name/set")).toHaveLength(1);
  });

  it("normalizes model formatting and bounds long names", () => {
    expect(sanitizeThreadName("Title: “Fix session cookie tests”\nExtra detail")).toBe("Fix session cookie tests");
    expect(sanitizeThreadName("```text\nRepair authentication middleware behavior across every supported runtime and deployment target\n```")).toMatch(/^Repair authentication middleware behavior/);
    expect(sanitizeThreadName("   ")).toBeNull();
  });
});
