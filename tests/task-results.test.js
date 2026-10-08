import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { TaskResults, verificationEvidence } from "../electron/runtime/task-results.mjs";

const cleanup = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function fixture(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-results-"));
  const database = new PixiceDatabase(directory);
  cleanup.push(() => { database.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const date = new Date().toISOString();
  const project = database.createProject({ id: "project", folders: [directory], displayName: "Sample", createdAt: date, updatedAt: date });
  const snapshot = { repositories: [{ root: directory, tree: "tree", commit: "commit" }], folders: [{ repository: 0, relative: "." }] };
  const service = new TaskResults({ database, directory,
    captureSnapshot: vi.fn(async () => snapshot), readChanges: vi.fn(async () => ({ files: [], fileCount: 0, patch: "" })),
    readThread: vi.fn(async () => null), ...overrides });
  const begin = (threadId = "thread", text = "Build the feature") => service.begin({ project, threadId, input: [{ type: "text", text }], prompt: text, model: "codex:gpt-6-astra" });
  const complete = (threadId = "thread", turnId = "turn") => {
    service.started(threadId, turnId);
    return service.complete(threadId, { id: turnId, status: "completed", items: [
    { id: "check", type: "commandExecution", command: "pnpm test", exitCode: 0, aggregatedOutput: "12 passed" },
    { id: "answer", type: "agentMessage", text: "Feature implemented." }
    ] });
  };
  return { service, database, project, begin, complete, directory, snapshot };
}

describe("task receipts and usage", () => {
  it("persists evidence and a single starting snapshot across follow-up turns", async () => {
    const { service, begin, complete, database, directory } = fixture();
    await begin(); service.started("thread", "turn"); await complete();
    const receipt = service.receipt("thread");
    expect(receipt).toMatchObject({ status: "completed", summary: "Feature implemented.", replayAvailable: true, checks: [{ status: "passed", output: "12 passed" }] });
    const reopened = new TaskResults({ database, directory });
    expect(reopened.receipt("thread").summary).toBe("Feature implemented.");
    await begin("thread", "Fix the edge case");
    expect(service.receipt("thread")).toMatchObject({ status: "running", promptCount: 2 });
    expect(service.captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it("counts delegated usage and preserves unpriced token totals", async () => {
    const { service, database, begin, complete } = fixture();
    await begin(); await complete();
    database.saveThreadLink({ childThreadId: "child", parentThreadId: "thread" });
    database.recordUsageEvent({ id: "parent", threadId: "thread", provider: "codex", inputTokens: 100, costUsd: 2 });
    database.recordUsageEvent({ id: "child", threadId: "child", provider: "codex", inputTokens: 50, costUsd: 1 });
    database.recordUsageEvent({ id: "unknown", threadId: "thread", provider: "codex", inputTokens: 25 });
    expect(service.receipt("thread").usage).toMatchObject({ tokens: 175, costUsd: 3, unpricedEvents: 1 });
    service.save({ ...service.get("thread"), outcome: "accepted", acceptedAt: "legacy" });
    expect(service.receipt("thread")).not.toHaveProperty("outcome");
    expect(service.receipt("thread")).not.toHaveProperty("acceptedAt");
  });

  it("does not turn missing evidence or an interrupted run into a success", async () => {
    expect(verificationEvidence([{ id: "turn", items: [{ id: "echo", type: "commandExecution", command: "echo 'tests passed'", exitCode: 0 }] }])).toEqual([]);
    expect(verificationEvidence([{ id: "turn", items: [{ id: "x", type: "commandExecution", command: "npm test", status: "completed" }] }])[0].status).toBe("unknown");
    const { service, begin } = fixture({ captureSnapshot: vi.fn(async () => { throw new Error("Not a Git repository"); }) });
    await begin();
    service.started("thread", "turn");
    await service.complete("thread", { id: "turn", status: "interrupted", items: [] });
    expect(service.receipt("thread")).toMatchObject({ status: "interrupted", replayAvailable: false });
  });

  it("keeps masked command exits unconfirmed and earlier checks separate", async () => {
    for (const command of ["npm test || true", "npm test; echo done", "npm test | cat", "npm test && npm run build"]) {
      expect(verificationEvidence([{ id: "turn", items: [{ id: command, type: "commandExecution", command, exitCode: 0 }] }])[0].status).toBe("unknown");
    }
    const { service, begin, complete } = fixture();
    await begin(); await complete(); await begin("thread", "Change the implementation");
    service.started("thread", "followup");
    await service.complete("thread", { id: "followup", status: "completed", items: [] });
    expect(service.receipt("thread").checks).toEqual([]);
    expect(service.receipt("thread").turns[0].checks[0].status).toBe("passed");
  });

  it("preserves attachment bytes across edits and two replay generations", async () => {
    let sequence = 0;
    const value = fixture({ startThread: async () => ({ thread: { id: `replay-${++sequence}` } }),
      createWorkspace: async (snapshot, destination) => {
        const root = path.join(destination, "workspace");
        mkdirSync(root, { recursive: true });
        return { folders: [root], snapshot: { ...snapshot, repositories: [{ ...snapshot.repositories[0], root }] } };
      } });
    const { service, project, directory, complete } = value;
    const attachmentRoot = path.join(directory, "attachments");
    mkdirSync(attachmentRoot);
    const attached = path.join(attachmentRoot, "brief.txt");
    writeFileSync(attached, "original brief");
    await service.begin({ project, threadId: "thread", input: [{ type: "text", text: `Read ${attached}` }], prompt: "Read brief", attachmentRoot });
    await complete();
    writeFileSync(attached, "changed after run");
    service.startTurn = async (turn) => {
      await service.begin({ ...turn, prompt: turn.text });
      service.started(turn.threadId, "turn");
    };
    for (const [source, child] of [["thread", "replay-1"], ["replay-1", "replay-2"]]) {
      await service.replay({ threadId: source, revision: service.get(source).revision, model: "claude:sonnet" });
      const prompt = service.get(child).prompts[0];
      const file = prompt.frozenAttachments[0].path;
      expect(prompt.input[0].text).toBe(`Read ${file}`);
      expect(readFileSync(file, "utf8")).toBe("original brief");
      expect(file).not.toBe(attached);
      if (source !== "thread") expect(file).not.toBe(service.get(source).prompts[0].frozenAttachments[0].path);
      writeFileSync(file, "edited by replay");
      await complete(child);
    }
  });

  it("replays all original prompts in order without deadlocking completion", async () => {
    const fixtureValue = fixture({ startThread: async () => ({ thread: { id: "child-replay" } }),
      createWorkspace: async (snapshot) => ({ folders: [path.join(fixtureValue.directory, "replay")], snapshot }) });
    const { service, begin, complete } = fixtureValue;
    await begin(); await complete(); await begin("thread", "Second instruction"); await complete("thread", "second");
    let sequence = 0;
    service.startTurn = async (value) => {
      const turnId = `replayed-${++sequence}`;
      await service.begin({ ...value, prompt: value.text });
      service.started(value.threadId, turnId);
      setTimeout(() => void service.complete(value.threadId, { id: turnId, status: "completed", items: [] }), 0);
    };
    await service.replay({ threadId: "thread", revision: service.get("thread").revision, model: "codex:gpt-6-astra" });
    await vi.waitFor(() => expect(service.get("child-replay").status).toBe("completed"));
    expect(service.get("child-replay").prompts.map((prompt) => prompt.text)).toEqual(["Build the feature", "Second instruction"]);
    expect(service.get("child-replay").turns).toHaveLength(2);
    await service.complete("child-replay", { id: "replayed-2", status: "completed", items: [] });
    expect(service.get("child-replay").turns).toHaveLength(2);
  });

  it("replays a definitively rejected prompt only once after its retry is accepted", async () => {
    const value = fixture({ startThread: vi.fn(async () => ({ thread: { id: "retry-replay" } })),
      createWorkspace: async (snapshot) => ({ folders: [path.join(value.directory, "retry-replay")], snapshot }) });
    const { service, begin, complete } = value;
    await begin("thread", "Queued instruction");
    const rejectedRevision = service.get("thread").executionRevision;
    service.failed("thread", Object.assign(new Error("Provider rejected the dispatch before execution"), { providerRejected: true }));
    expect(service.get("thread").prompts).toEqual([expect.objectContaining({ text: "Queued instruction", acceptance: "rejected" })]);
    expect(service.receipt("thread")).toMatchObject({ status: "failed", replayAvailable: false, pendingStart: false });

    await begin("thread", "Queued instruction");
    expect(service.get("thread").prompts).toHaveLength(1);
    expect(service.get("thread").rejectedAttempts).toEqual([expect.objectContaining({ executionRevision: rejectedRevision })]);
    await complete("thread", "accepted-retry");
    await begin("thread", "Accepted follow-up");
    await complete("thread", "accepted-followup");
    expect(service.receipt("thread")).toMatchObject({ status: "completed", replayAvailable: true, promptCount: 2 });

    let sequence = 0;
    service.startTurn = vi.fn(async (turn) => {
      await service.begin({ ...turn, prompt: turn.text });
      const turnId = `replayed-${++sequence}`;
      service.started(turn.threadId, turnId);
      await service.complete(turn.threadId, { id: turnId, status: "completed", items: [] });
    });
    await service.replay({ threadId: "thread", revision: service.get("thread").revision, model: "claude:sonnet" });
    await vi.waitFor(() => expect(service.get("retry-replay").status).toBe("completed"));
    expect(service.startTurn.mock.calls.map(([turn]) => turn.text)).toEqual(["Queued instruction", "Accepted follow-up"]);
    expect(service.get("retry-replay").turns).toHaveLength(2);
    expect(service.captureSnapshot).toHaveBeenCalledTimes(1);
  });

  it("preserves unconfirmed lost-response inputs and keeps them out of manual replay", async () => {
    const { service, database, directory, project, begin, complete } = fixture();
    await begin("thread", "Unknown provider execution");
    service.failed("thread", Object.assign(new Error("Start response was lost"), { uncertain: true }));
    const uncertain = service.get("thread").prompts[0];
    expect(uncertain).toMatchObject({ text: "Unknown provider execution", acceptance: "uncertain" });
    expect(service.receipt("thread")).toMatchObject({ recoveryPending: true, replayHeld: true, replayAvailable: false });
    const reopened = new TaskResults({ database, directory, readThread: async () => null });
    expect(reopened.get("thread").prompts[0]).toEqual(uncertain);

    // Even if later work is recorded, that cannot prove the lost dispatch never
    // executed or silently add its unbound input to a replay sequence.
    await service.begin({ project, threadId: "thread", input: [{ type: "text", text: "Later accepted work" }], prompt: "Later accepted work" });
    await complete("thread", "later-turn");
    expect(service.get("thread").prompts[0]).toEqual(uncertain);
    expect(service.receipt("thread")).toMatchObject({ status: "completed", replayHeld: true, replayAvailable: false });
    await expect(service.replay({ threadId: "thread", revision: service.get("thread").revision })).rejects.toThrow("Confirm the provider turn's state");
  });

  it("replays frozen prompts into a separate project and stops its queue on interruption", async () => {
    let child = 0;
    const startThread = vi.fn(async () => ({ thread: { id: `replay-${++child}` } }));
    const startTurn = vi.fn(async () => {});
    const { service, begin, complete, directory, project } = fixture({ startThread, startTurn,
      createWorkspace: vi.fn(async (snapshot) => ({ folders: [path.join(directory, "isolated")], snapshot })) });
    await begin(); await complete();
    await begin("thread", "Also add keyboard support"); await complete("thread", "second");
    const result = await service.replay({ threadId: "thread", revision: service.get("thread").revision, model: "claude:sonnet" });
    expect(result.project.id).not.toBe(project.id);
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "replay-1", text: "Build the feature", model: "claude:sonnet" }));
    expect(service.get("replay-1").replayQueue).toHaveLength(1);
    service.stopReplay("replay-1");
    await service.nextReplayTurn("replay-1");
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("preserves a known active receipt as uncertain on restart and reconciles only its exact turn", async () => {
    const { service, database, directory, project, begin } = fixture();
    await begin();
    service.started("thread", "recorded-turn");
    service.save({ ...service.get("thread"), replayQueue: [{ text: "Queued replay must not launch" }] });
    const startTurn = vi.fn();
    const reopened = new TaskResults({ database, directory, startTurn, readThread: async () => null });
    expect(reopened.receipt("thread")).toMatchObject({ status: "uncertain", recoveryPending: true, activeTurnId: "recorded-turn", replayAvailable: false, remainingReplayTurns: 0 });
    await reopened.nextReplayTurn("thread");
    expect(startTurn).not.toHaveBeenCalled();
    await reopened.observeThread(project, { id: "thread", turns: [{ id: "recorded-turn", status: "inProgress" }, { id: "unrelated-later", status: "completed", items: [{ type: "agentMessage", text: "Wrong result" }] }] });
    expect(reopened.receipt("thread")).toMatchObject({ status: "running", recoveryPending: false, activeTurnId: "recorded-turn" });
    expect(reopened.get("thread").turns).toEqual([]);
    await reopened.observeThread(project, { id: "thread", turns: [{ id: "recorded-turn", status: "completed", items: [{ type: "agentMessage", text: "Exact recovered result" }] }, { id: "unrelated-later", status: "inProgress" }] });
    expect(reopened.receipt("thread")).toMatchObject({ status: "completed", summary: "Exact recovered result", recoveryPending: false, activeTurnId: null });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("does not claim interrupted or completed when a restarted provider omits the active identity", async () => {
    const { service, database, directory, project, begin } = fixture();
    await begin(); service.started("thread", "missing-turn");
    const reopened = new TaskResults({ database, directory });
    await reopened.observeThread(project, { id: "thread", turns: [{ id: "newer", status: "completed" }] });
    expect(reopened.receipt("thread")).toMatchObject({ status: "uncertain", recoveryPending: true, activeTurnId: "missing-turn", replayAvailable: false });
    expect(reopened.receipt("thread").error).toContain("missing-turn");
    expect(reopened.get("thread").turns).toEqual([]);
  });

  it("buffers a terminal-before-start response without assigning unrelated notifications to the prompt", async () => {
    const { service, begin } = fixture();
    await begin();
    await service.complete("thread", { id: "stale", status: "completed", items: [{ type: "agentMessage", text: "Wrong answer" }] });
    await service.complete("thread", { id: "real", status: "completed", items: [{ type: "agentMessage", text: "Early final answer" }] });
    expect(service.get("thread").activeTurnId).toBeNull();
    service.started("thread", "real");
    await vi.waitFor(() => expect(service.receipt("thread").status).toBe("completed"));
    expect(service.get("thread").turns.map((turn) => turn.id)).toEqual(["real"]);
    expect(service.receipt("thread").summary).toBe("Early final answer");
    service.started("thread", "real");
    expect(service.receipt("thread")).toMatchObject({ status: "completed", activeTurnId: null });
  });

  it("retains an older accepted result in history without replacing a newer active receipt", async () => {
    const { service, begin } = fixture();
    await begin(); service.started("thread", "old-turn");
    // A newer user request is accepted before a delayed old terminal arrives.
    await begin("thread", "New request"); service.started("thread", "new-turn");
    const current = service.get("thread");
    await service.complete("thread", { id: "old-turn", status: "completed", items: [{ type: "agentMessage", text: "Old answer" }] });
    expect(service.get("thread")).toMatchObject({ status: "running", activeTurnId: "new-turn", executionRevision: current.executionRevision, summary: null });
    expect(service.get("thread").turns).toEqual([expect.objectContaining({ id: "old-turn", summary: "Old answer" })]);
    expect(service.readChanges).not.toHaveBeenCalled();
    await service.complete("thread", { id: "new-turn", status: "completed", items: [{ type: "agentMessage", text: "New answer" }] });
    expect(service.receipt("thread")).toMatchObject({ status: "completed", summary: "New answer" });
    expect(service.get("thread").turns.map((turn) => turn.id)).toEqual(["old-turn", "new-turn"]);
  });

  it.each(["hydration", "diff"])("fences a receipt changed while asynchronous %s is pending", async (phase) => {
    let resume;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const pause = () => new Promise((resolve) => { resume = resolve; entered(); });
    const { service, begin } = fixture(phase === "hydration" ? { readThread: vi.fn(pause) } : { readChanges: vi.fn(pause) });
    // Avoid pausing initial empty-thread discovery before the receipt exists.
    if (phase === "hydration") service.readThread.mockResolvedValueOnce(null);
    await begin(); service.started("thread", "old-turn");
    const finishing = service.complete("thread", { id: "old-turn", status: "completed", items: [{ type: "agentMessage", text: "Old result" }] });
    await enteredPromise;
    const old = service.get("thread");
    service.save({ ...old, executionRevision: "new-execution", status: "running", activeTurnId: "new-turn", summary: "New state", changes: { fileCount: 9 },
      prompts: [...old.prompts, { text: "New work", turnId: "new-turn", startedAt: new Date().toISOString() }], replayQueue: [{ text: "Keep this queued" }] });
    resume(phase === "hydration" ? { thread: { id: "thread", turns: [{ id: "old-turn", status: "completed", items: [] }] } } : { fileCount: 1 });
    await finishing;
    expect(service.get("thread")).toMatchObject({ status: "running", activeTurnId: "new-turn", executionRevision: "new-execution", summary: "New state", changes: { fileCount: 9 }, replayQueue: [{ text: "Keep this queued" }] });
    expect(service.get("thread").turns).toEqual([expect.objectContaining({ id: "old-turn" })]);
  });

  it("keeps uncertain dispatch failures truthful and rejects failure callbacks from older executions", async () => {
    const { service, begin } = fixture();
    await begin(); service.started("thread", "old-turn");
    const oldRevision = service.get("thread").executionRevision;
    service.failed("thread", Object.assign(new Error("Start response lost"), { uncertain: true }));
    expect(service.receipt("thread")).toMatchObject({ status: "uncertain", recoveryPending: true, replayHeld: true, replayAvailable: false, completedAt: null });
    await begin("thread", "Explicit new request"); service.started("thread", "new-turn");
    service.failed("thread", new Error("Delayed old failure"), { executionRevision: oldRevision, turnId: "old-turn" });
    expect(service.receipt("thread")).toMatchObject({ status: "running", activeTurnId: "new-turn", error: null });
  });
});
