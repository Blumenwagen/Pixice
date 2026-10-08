import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  sanitizeThreadName,
  ThreadNamer,
  THREAD_NAMING_EFFORT,
  THREAD_NAMING_MODEL
} from "../electron/runtime/thread-namer.mjs";
import { resolveThreadNamingModel, THREAD_NAMING_AUTO, THREAD_NAMING_OFF } from "../electron/runtime/thread-naming-models.mjs";

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

  it("prefers the strongest cheap and fast profile and only uses advertised effort", () => {
    const models = [
      { id: "claude:haiku", model: "haiku", provider: "claude", displayName: "Claude Haiku" },
      {
        id: "codex:gpt-5.6-luna",
        model: "gpt-5.6-luna",
        provider: "codex",
        displayName: "GPT 5.6 Luna",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }]
      }
    ];

    expect(resolveThreadNamingModel(THREAD_NAMING_AUTO, models)).toMatchObject({
      id: "codex:gpt-5.6-luna",
      provider: "codex",
      effort: "low"
    });
    expect(resolveThreadNamingModel(THREAD_NAMING_AUTO, models.slice(0, 1))).toMatchObject({
      id: "claude:haiku",
      provider: "claude",
      effort: null
    });
  });

  it("falls back to future discovered agent models and uses their advertised default effort", () => {
    const models = [
      { id: "codex:gpt-7-hidden", model: "gpt-7-hidden", provider: "codex", hidden: true },
      {
        id: "codex:gpt-7-nova",
        model: "gpt-7-nova",
        provider: "codex",
        defaultReasoningEffort: "economy",
        supportedReasoningEfforts: [{ reasoningEffort: "economy" }, { reasoningEffort: "high" }]
      },
      { id: "claude:claude-oracle-7", model: "claude-oracle-7", provider: "claude" }
    ];

    expect(resolveThreadNamingModel(THREAD_NAMING_AUTO, models)).toMatchObject({
      id: "codex:gpt-7-nova",
      effort: "economy"
    });
    expect(resolveThreadNamingModel("claude:claude-oracle-7", models)).toMatchObject({
      id: "claude:claude-oracle-7",
      effort: null
    });
  });

  it("uses Haiku through the provider-neutral runtime when it is the automatic choice", async () => {
    const runtime = new FakeRuntime();
    const namer = new ThreadNamer(runtime, {
      timeoutMs: 1_000,
      models: async () => [{ id: "claude:haiku", model: "haiku", provider: "claude", displayName: "Claude Haiku" }]
    });

    await namer.nameThread({ threadId: "task-1", cwd: "/work/aurora", source: "Fix the sign-in flow", kind: "task" });

    expect(runtime.request).toHaveBeenNthCalledWith(1, "thread/start", expect.objectContaining({ model: "claude:haiku", ephemeral: true }));
    expect(runtime.request).toHaveBeenNthCalledWith(2, "turn/start", expect.not.objectContaining({ effort: expect.anything() }));
  });

  it("skips the helper turn when automatic naming is disabled", async () => {
    const runtime = new FakeRuntime();
    const namer = new ThreadNamer(runtime, {
      selection: () => THREAD_NAMING_OFF,
      models: async () => [{ id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", provider: "codex" }]
    });

    await expect(namer.nameThread({ threadId: "task-1", cwd: "/work/aurora", source: "Fix the sign-in flow" })).resolves.toBeNull();
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it("normalizes model formatting and bounds long names", () => {
    expect(sanitizeThreadName("Title: “Fix session cookie tests”\nExtra detail")).toBe("Fix session cookie tests");
    expect(sanitizeThreadName("```text\nRepair authentication middleware behavior across every supported runtime and deployment target\n```")).toMatch(/^Repair authentication middleware behavior/);
    expect(sanitizeThreadName("   ")).toBeNull();
  });
});
