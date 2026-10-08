import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import { startService } from "../electron/backend/service.mjs";
import { ApplicationClient } from "../electron/connect/application-client.mjs";
import { RemoteClient } from "../src/connect/client.js";
import { BackendFixtureProvider } from "./fixtures/backend-provider.mjs";
import { FocusStore } from "../electron/persistence/focus-store.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { FocusVisuals } from "../electron/runtime/focus-visuals.mjs";
import { FocusSessionRenewal, renewalEvidence } from "../electron/runtime/focus-session-renewal.mjs";
import { projectRendererThread, projectRuntimePayloadForRenderer } from "../electron/runtime/renderer-thread-projection.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function eventually(read, test) {
  for (let i = 0; i < 150; i++) { const value = await read(); if (test(value)) return value; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Expected fixture condition did not occur.");
}

async function fixture({ focusProvider = "codex" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pixice-renewal-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providers = { codex: new BackendFixtureProvider(), claude: new BackendFixtureProvider("claude") };
  const provider = providers[focusProvider];
  const claudeRequest = providers.claude.request.bind(providers.claude);
  providers.claude.request = (method, params) => method === "model/list" ? Promise.resolve({ data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture Claude" }] }) : claudeRequest(method, params);
  const calls = [];
  const original = provider.request.bind(provider);
  provider.request = async (method, params) => { calls.push({ method, params }); return original(method, params); };
  let database;
  const service = await startService({ dataDirectory: path.join(root, "data"), resourcesPath: path.resolve("resources"),
    clientDirectory: path.resolve("dist/client"), version: "test", providerFactories: {
      codex: (context) => { database = context.database; return providers.codex; }, claude: () => providers.claude
    } });
  cleanup.push(() => service.stop({ force: true }));
  await service.ready;
  provider.emit("status", { state: "ready" });
  const connect = async () => {
    const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: "service.status" });
    cleanup.push(() => client.close()); await client.connect(); return client;
  };
  const client = await connect();
  const folder = path.join(root, "project"); await mkdir(folder);
  const project = await client.call("projects.create", { displayName: "Renewal fixture", icon: "folder", color: "gray", folders: [folder] });
  const focus = await client.call("focus.ensure", { projectId: project.id, model: `${focusProvider}:fixture-model` });
  const store = new FocusStore(database);
  let sequence = 0;
  const replies = new Map();
  provider.respond = (id, response) => { const callback = replies.get(id); if (callback) { replies.delete(id); callback(response); } };
  const tool = async (name, args = {}, threadId = focus.thread.id, namespace = "pixice_focus") => {
    const id = `tool-${++sequence}`;
    const response = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Tool timeout")), 2000); replies.set(id, (value) => { clearTimeout(timer); resolve(value); }); });
    provider.emit("server-request", { id, method: "item/tool/call", params: { namespace, tool: name, arguments: args, threadId } });
    const result = await response; const output = JSON.parse(result.contentItems[0].text);
    if (!result.success) throw new Error(output.error); return output;
  };
  const finish = (threadId) => {
    const turn = provider.threads.get(threadId).turns.at(-1); turn.status = "completed";
    provider.event({ method: "turn/completed", threadId, turn });
  };
  return { root, service, provider, providers, client, connect, database, project, focus, store, calls, tool, finish, original, focusProvider };
}

async function forkFixture({ remap = false, summaryResponse = false, coalesce = false, focusProvider = "codex" } = {}) {
  const f = await fixture({ focusProvider });
  f.provider.request = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "thread/fork") {
      const source = f.provider.threads.get(params.threadId);
      const boundary = source.turns.findIndex((turn) => turn.id === params.lastTurnId);
      const turns = structuredClone(source.turns.slice(0, boundary + 1));
      if (remap) for (const turn of turns) { turn.id = randomUUID(); for (const item of turn.items) item.id = randomUUID(); }
      const thread = { ...structuredClone(source), id: randomUUID(), turns, status: { type: "idle" } };
      f.provider.threads.set(thread.id, thread);
      // Exercise the provider announcement before the fork response reaches the
      // application and before its copied-message proof has been persisted.
      f.provider.event({ method: "thread/started", thread });
      return { thread: summaryResponse ? { ...thread, turns: [] } : structuredClone(thread) };
    }
    if (method === "thread/name/set") return {};
    const response = await f.original(method, params);
    if (method === "turn/start") {
      response.turn.items = [
        { type: "userMessage", id: randomUUID(), content: coalesce ? [{ type: "text", text: params.input.map((part) => part.text).join("\n") }] : structuredClone(params.input) },
        { type: "agentMessage", id: randomUUID(), text: "Fixture final answer", phase: "final_answer" }
      ];
    }
    return response;
  };
  const submit = async (id, text) => {
    const response = await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text, model: `${focusProvider}:fixture-model`, permissionMode: "full-access" });
    f.finish(id);
    await eventually(() => f.service.application.state(), (state) => state.activeTurns === 0);
    return response;
  };
  const fork = (id, turn = f.provider.threads.get(id).turns.at(-1), extra = {}) => f.client.call("threads.fork", {
    projectId: f.project.id, threadId: id, lastTurnId: turn.id, lastItemId: turn.items.findLast((item) => item.type === "agentMessage").id, ...extra
  });
  const projection = (database) => (id) => (text, context) => Boolean(database.focusContextProof(id, text, context));
  // Trusted fixture setup for already recorded copies, not a supported native
  // protected fork. No provider creation call or pre-response identity claim.
  const seedRecordedCopy = async (id, turn = f.provider.threads.get(id).turns.at(-1)) => {
    const source = f.provider.threads.get(id);
    const turns = structuredClone(source.turns.slice(0, source.turns.findIndex((entry) => entry.id === turn.id) + 1));
    if (remap) for (const entry of turns) { entry.id = randomUUID(); for (const item of entry.items) item.id = randomUUID(); }
    const thread = { ...structuredClone(source), id: randomUUID(), turns, parentThreadId: null, forkedFromId: id, status: { type: "idle" } };
    const plan = f.database.focusForkCopyPlan(f.project.id, source, turn.id, turn.items.findLast((item) => item.type === "agentMessage").id);
    f.database.inheritFocusForkContext(plan, thread);
    f.provider.threads.set(thread.id, thread);
    f.database.saveThreadProviderBinding({ threadId: thread.id, provider: focusProvider, cwd: thread.cwd, forkedFromId: id });
    f.database.saveProviderThreadSnapshot(thread.id, thread);
    f.provider.event({ method: "thread/started", thread });
    return { thread: projectRendererThread(thread, projection(f.database)) };
  };
  return { ...f, submit, fork, projection, seedRecordedCopy };
}

async function reopenForkFixture(f) {
  const threads = Object.fromEntries(Object.entries(f.providers).map(([id, provider]) => [id, structuredClone([...provider.threads])]));
  await f.service.stop({ force: true });
  const providers = { codex: new BackendFixtureProvider(), claude: new BackendFixtureProvider("claude") };
  for (const [id, provider] of Object.entries(providers)) provider.threads = new Map(threads[id]);
  const provider = providers[f.focusProvider];
  let database;
  const service = await startService({ dataDirectory: path.join(f.root, "data"), resourcesPath: path.resolve("resources"),
    clientDirectory: path.resolve("dist/client"), version: "test", providerFactories: {
      codex: (context) => { database = context.database; return providers.codex; }, claude: () => providers.claude
    } });
  cleanup.push(() => service.stop({ force: true })); await service.ready;
  provider.emit("status", { state: "ready" });
  const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: "service.status" });
  cleanup.push(() => client.close()); await client.connect();
  return { service, client, provider, providers, database };
}

describe("Focus session replacement behavior", () => {
  it("exposes manual Focus reset through the real Connect API facade with authoritative events and stale CAS errors", async () => {
    const f = await fixture(); const values = new Map();
    vi.stubGlobal("localStorage", { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
    cleanup.push(() => vi.unstubAllGlobals());
    const remote = new RemoteClient({ id: f.service.descriptor.hostId, endpoint: f.service.descriptor.endpoint, token: f.service.descriptor.token, name: "Fixture host" });
    cleanup.push(() => remote.close()); await remote.connect();
    const events = []; remote.api.events.subscribe((event) => events.push(event));
    f.database.setProjectFocusStopped(f.project.id, true);
    f.store.createWork(f.project.id, { title: "Paused fixture", status: "paused", coordinatorThreadId: f.focus.thread.id });
    const before = await remote.api.focus.state({ projectId: f.project.id });
    const renewed = await remote.api.focus.refresh({ projectId: f.project.id, expectedGeneration: before.session.generation });
    expect(renewed.session).toMatchObject({ generation: 2, stopped: true });
    expect((await remote.api.focus.state({ projectId: f.project.id })).work).toEqual(before.work);
    expect((await remote.api.focus.history({ projectId: f.project.id })).generations).toHaveLength(2);
    await eventually(() => events.find((event) => event.type === "FocusUpdated" && event.payload?.session?.generation === 2), Boolean);
    await expect(remote.api.focus.refresh({ projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/session changed/);
    expect(f.provider.starts).toBe(0);
  });
  it("refreshes loaded role and current durable brief, reconnects, and retains role after compaction", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Newest project fact", userMemory: "" }, 1);
    f.store.createWork(f.project.id, { title: "Pending verified review", status: "review", coordinatorThreadId: id });
    await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: "Check current state", model: "codex:fixture-model" });
    const role = f.calls.find((call) => call.method === "thread/start").params.developerInstructions;
    const turn = f.calls.findLast((call) => call.method === "turn/start");
    const brief = JSON.parse(turn.params.input[0].text.split("\n").slice(1).join("\n"));
    expect(brief.memory.project).toBe("Newest project fact"); expect(brief.pendingReviews).toHaveLength(1);
    expect(f.calls.findLast((call) => call.method === "thread/resume").params.developerInstructions).toBe(role);
    expect(role).not.toContain("Newest project fact");
    f.finish(id);
    await eventually(() => f.service.application.state(), (state) => state.activeTurns === 0);
    f.provider.event({ method: "thread/compacted", threadId: id });
    f.provider.emit("status", { state: "reconnecting" }); f.provider.emit("status", { state: "ready" });
    await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: "Continue", model: "codex:fixture-model" });
    expect(f.calls.findLast((call) => call.method === "thread/resume").params.developerInstructions).toBe(role);
  });

  it("replaces at a long-history boundary, retains visible searchable history, and routes two clients authoritatively", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    f.provider.threads.get(id).turns = [{ id: "historical", status: "completed", items: [
      { id: "history-fact", type: "agentMessage", text: "Historical export decision " + "x".repeat(170_000) }
    ] }];
    for (let i = 0; i < 24; i++) { f.database.incrementProjectFocusTurn(f.project.id, id); f.database.incrementProjectFocusSessionTurn(f.project.id, id); }
    const second = await f.connect();
    await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: "Boundary", model: "codex:fixture-model" });
    expect(f.database.getProjectFocusSession(f.project.id).threadId).toBe(id);
    f.finish(id);
    const session = await eventually(() => f.client.call("focus.history", { projectId: f.project.id }), (value) => value.session.generation === 2);
    expect(session.generations.map((item) => item.threadId)).toContain(id);
    expect(session.session.renewalEvidence.reason).toBe("bounded-history");
    const current = await second.call("focus.ensure", { projectId: f.project.id });
    expect(current.thread.id).toBe(session.session.threadId);
    expect(current.thread.turns.some((turn) => turn.focusOriginThreadId === id)).toBe(true);
    expect(f.database.searchProjectFocusHistory(f.project.id, "Historical export")).not.toHaveLength(0);
    expect(f.provider.threads.has(id)).toBe(true);
    await expect(second.call("turns.start", { projectId: f.project.id, threadId: id, text: "Stale", model: "codex:fixture-model" })).rejects.toThrow(/not submitted/);
    await second.call("turns.start", { projectId: f.project.id, threadId: current.thread.id, text: "Fresh", model: "codex:fixture-model" });
    const input = f.calls.findLast((call) => call.method === "turn/start").params.input;
    expect(JSON.stringify(input).length).toBeLessThan(25_000);
    expect(JSON.stringify(input)).not.toContain("Historical export decision");
  });

  it("rolls back failed creation and rejects racing manual refreshes", async () => {
    const f = await fixture(); const { projectId, generation } = f.focus.session;
    f.provider.request = async (method, params) => { if (method === "thread/start") throw new Error("Provider failed before creation"); return f.original(method, params); };
    await expect(f.client.call("focus.refresh", { projectId, expectedGeneration: generation })).rejects.toThrow(/Provider failed/);
    expect(f.database.getProjectFocusSession(projectId).threadId).toBe(f.focus.thread.id);
    f.provider.request = f.original;
    const results = await Promise.allSettled([f.client.call("focus.refresh", { projectId, expectedGeneration: generation }), f.client.call("focus.refresh", { projectId, expectedGeneration: generation })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.database.getProjectFocusSession(projectId).generation).toBe(2);
    expect(f.provider.starts).toBe(0);
  });

  it("does not clear a newer Stop when an admitted turn returns late", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    const admitted = deferred(); const release = deferred(); let turnId;
    f.provider.request = async (method, params) => {
      const result = await f.original(method, params);
      if (method === "turn/start" && params.threadId === id) {
        const staleResponse = structuredClone(result);
        turnId = result.turn.id; admitted.resolve(); await release.promise; return staleResponse;
      }
      return result;
    };
    const start = f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: "Admit", model: "codex:fixture-model" });
    await admitted.promise;
    await f.client.call("turns.interrupt", { projectId: f.project.id, threadId: id, turnId });
    release.resolve(); await start;
    expect(f.database.getProjectFocusSession(f.project.id).stopped).toBe(true);
    expect(f.service.application.state().activeTurns).toBe(0);
  });

  it("preserves Stop, paused/cancelled workers and pending reviews after manual replacement", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    const work = ["paused", "cancelled", "review"].map((status) => f.store.createWork(f.project.id, { title: status, status, coordinatorThreadId: id }));
    const event = f.store.appendEvent(f.project.id, { workId: work[2].id, kind: "review-ready", message: "Review pending" });
    f.store.markEventsDelivered(f.project.id, [event.id]);
    const started = await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: "Run", model: "codex:fixture-model" });
    await f.client.call("turns.interrupt", { projectId: f.project.id, threadId: id, turnId: started.turn.id });
    const refresh = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    expect(refresh.session.stopped).toBe(true);
    const count = f.provider.starts;
    const pending = f.store.appendEvent(f.project.id, { workId: work[2].id, kind: "review-ready", message: "Another review event" });
    // flush is triggered at coordinator completion. Stopped delivery must remain pending.
    f.provider.event({ method: "turn/completed", threadId: refresh.session.threadId, turn: { id: "stop-event", status: "interrupted", items: [] } });
    await new Promise((r) => setTimeout(r, 40));
    expect(f.provider.starts).toBe(count);
    expect(f.store.pendingEvents(f.project.id).some((item) => item.id === pending.id)).toBe(true);
    expect(work.map((item) => f.store.getWork(f.project.id, item.id).status)).toEqual(["paused", "cancelled", "review"]);
    await f.client.call("turns.start", { projectId: f.project.id, threadId: refresh.session.threadId, text: "Review now", model: "codex:fixture-model" });
    const brief = JSON.parse(f.calls.findLast((call) => call.method === "turn/start").params.input[0].text.split("\n").slice(1).join("\n"));
    expect(brief.pendingReviews).toContain(work[2].id);
    expect(f.database.getProjectFocusSession(f.project.id).stopped).toBe(false);
  });

  it("blocks voice and active turns, and vetoes a late voice start during creation", async () => {
    const f = await fixture(); let voice = true;
    f.service.application.setFocusVoiceGuard(() => voice);
    await expect(f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/voice/);
    voice = false;
    const started = await f.client.call("turns.start", { projectId: f.project.id, threadId: f.focus.thread.id, text: "Busy", model: "codex:fixture-model" });
    await expect(f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/idle boundary/);
    await f.client.call("turns.interrupt", { projectId: f.project.id, threadId: f.focus.thread.id, turnId: started.turn.id });
    const wait = deferred(); const creating = deferred();
    f.provider.request = async (method, params) => { if (method === "thread/start") { creating.resolve(); await wait.promise; } return f.original(method, params); };
    const rotation = f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    await creating.promise; voice = true; wait.resolve();
    await expect(rotation).rejects.toThrow(/voice/);
    expect(f.database.getProjectFocusSession(f.project.id).threadId).toBe(f.focus.thread.id);
  });

  it("enforces cross-instance CAS and rolls back a stale stop revision", async () => {
    const f = await fixture(); let count = 0;
    const renewal = () => new FocusSessionRenewal({ database: f.database, safeBoundary: () => true, handoff: () => "bounded handoff",
      createSession: async () => { count++; return { thread: { id: `candidate-${count}` } }; } });
    const result = await Promise.allSettled([renewal().refresh(f.project.id, { expectedGeneration: 1 }), renewal().refresh(f.project.id, { expectedGeneration: 1 })]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const current = f.database.getProjectFocusSession(f.project.id);
    const blocked = new FocusSessionRenewal({ database: f.database, safeBoundary: () => true, handoff: () => "handoff", createSession: async () => {
      f.database.setProjectFocusStopped(f.project.id, true); return { thread: { id: "must-not-publish" } };
    } });
    await expect(blocked.refresh(f.project.id, { expectedGeneration: current.generation })).rejects.toThrow(/changed during renewal/);
    expect(f.database.getProjectFocusSession(f.project.id)).toMatchObject({ threadId: current.threadId, stopped: true });
    const collision = new FocusSessionRenewal({ database: f.database, safeBoundary: () => true, handoff: () => "handoff", createSession: async () => ({ thread: { id: f.focus.thread.id } }) });
    await expect(collision.refresh(f.project.id, { expectedGeneration: current.generation })).rejects.toThrow();
    expect(f.database.getProjectFocusSession(f.project.id)).toMatchObject({ threadId: current.threadId, generation: current.generation });
  });

  it("serializes voice preparation against renewal and rejects its stale scope before starting it", async () => {
    const f = await fixture(); const creating = deferred(); const release = deferred(); let voiceStarted = false;
    f.provider.request = async (method, params) => {
      if (method === "thread/start") { creating.resolve(); await release.promise; }
      return f.original(method, params);
    };
    const refresh = f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    await creating.promise;
    const voice = f.service.application.withFocusSessionAdmission({ projectId: f.project.id, threadId: f.focus.thread.id }, () => { voiceStarted = true; });
    // Attach the rejection handler before releasing the candidate to avoid an
    // unhandled rejection while the independently queued operation finishes.
    const checked = expect(voice).rejects.toThrow(/authoritative Focus session changed/);
    release.resolve(); await refresh; await checked;
    expect(voiceStarted).toBe(false);
  });

  it("carries pending worker questions across replacement and preserves their response generation", async () => {
    const f = await fixture();
    const work = await f.tool("dispatch_work", { title: "Question fixture", prompt: "Inspect and report", access: "read" });
    const worker = await eventually(() => f.client.call("focus.state", { projectId: f.project.id }), (state) => state.work.find((item) => item.id === work.id)?.status === "running");
    const workerId = worker.work.find((item) => item.id === work.id).threadId;
    const starts = f.provider.starts;
    f.provider.emit("server-request", { id: "worker-pick", method: "item/tool/requestUserInput", params: {
      threadId: workerId, questions: [{ id: "scope", header: "Scope", question: "Project or global?", options: [{ label: "Project", description: "This project" }, { label: "Global", description: "All projects" }] }]
    } });
    const review = await eventually(() => f.calls.findLast((call) => call.method === "thread/start" && call.params.threadSource === "pixiceFocusQuestionReview"), Boolean);
    const reviewerId = [...f.provider.threads.values()].findLast((thread) => thread.id !== workerId && thread.id !== f.focus.thread.id).id;
    await eventually(() => f.provider.threads.get(reviewerId).turns.at(-1), Boolean);
    expect(review.params.permissionMode).toBe("read-only");
    const turn = f.provider.threads.get(reviewerId).turns.at(-1);
    turn.items = [{ id: "review-question", type: "agentMessage", text: JSON.stringify({ action: "escalate", reason: "User preference" }) }];
    f.finish(reviewerId);
    const before = await eventually(() => f.tool("list_questions"), (questions) => questions.length === 1);
    const current = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    const after = await f.tool("list_questions", {}, current.session.threadId);
    expect(after).toEqual(before);
    const attention = await f.client.call("tasks.interventions");
    expect(attention.requests.find((item) => item.id === "worker-pick").params.threadId).toBe(current.session.threadId);
    await expect(f.tool("answer_question", { requestId: "worker-pick", requestGeneration: before[0].requestGeneration + 1, answers: { scope: "Project" } }, current.session.threadId)).rejects.toThrow(/no longer pending/);
    await f.tool("answer_question", { requestId: "worker-pick", requestGeneration: before[0].requestGeneration, answers: { scope: "Project" } }, current.session.threadId);
    expect(await f.tool("list_questions", {}, current.session.threadId)).toEqual([]);
    expect(f.store.getWork(f.project.id, work.id)).toMatchObject({ threadId: workerId, permissionMode: "full-access", status: "running" });
    // Only the question reviewer and a coordinator answer receipt turn may start.
    expect(f.provider.starts - starts).toBeLessThanOrEqual(2);
  });

  it("uses last-turn context evidence rather than total billing tokens", () => {
    expect(renewalEvidence({ usage: { total: { inputTokens: 10_000_000 }, last: { inputTokens: 5000 }, modelContextWindow: 100_000 }, session: { sessionTurnCount: 100 }, transcript: { turns: ["x".repeat(170_000)] } })).toBeNull();
    expect(renewalEvidence({ usage: { last: { inputTokens: 80_000 }, modelContextWindow: 100_000 }, session: { sessionTurnCount: 1 } })).toMatchObject({ reason: "context-pressure" });
  });

  it("persists generation, handoff, Stop, ownership and immutable visual origins across reopening", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pixice-renewal-reopen-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const database = new PixiceDatabase(root);
    const timestamp = new Date().toISOString();
    database.createProject({ id: "p", canonicalPath: root, displayName: "P", folders: [root], createdAt: timestamp, updatedAt: timestamp });
    database.saveProjectFocusSession({ projectId: "p", threadId: "origin" });
    database.setProjectFocusStopped("p", true);
    const store = new FocusStore(database);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    const image = path.join(root, "frame.png"); await writeFile(image, png);
    const visuals = new FocusVisuals({ userDataPath: root });
    const staged = await visuals.stage("p", "origin", [{ source: "file", path: image }]);
    const worker = store.createWork("p", { title: "Paused worker", coordinatorThreadId: "origin", threadId: "worker", status: "paused", visuals: staged });
    const session = database.getProjectFocusSession("p");
    database.replaceProjectFocusSession({ projectId: "p", threadId: "new", expectedGeneration: 1, expectedRevision: session.revision, handoff: "small handoff", evidence: { reason: "manual" } });
    database.db.close();
    const reopened = new PixiceDatabase(root); const reopenedStore = new FocusStore(reopened);
    try {
      expect(reopened.getProjectFocusSession("p")).toMatchObject({ generation: 2, handoff: "small handoff", stopped: true });
      expect(reopened.getFocusProjectForThread("origin")).toBe("p");
      const saved = reopenedStore.getWork("p", worker.id);
      expect(saved).toMatchObject({ status: "paused", coordinatorThreadId: "origin", threadId: "worker" });
      expect(saved.visuals[0].originCoordinatorThreadId).toBe("origin");
      expect(await visuals.load("p", "new", saved.visuals)).toEqual([`data:image/png;base64,${png.toString("base64")}`]);
    } finally { reopened.db.close(); }
  });
  it("blocks unknown voice guards before creation and publication, permitting explicit false only", async () => {
    const f = await fixture();
    const starts = f.calls.filter((call) => call.method === "thread/start").length;
    for (const value of [undefined, null, 0, "", true]) {
      f.service.application.setFocusVoiceGuard(() => value);
      await expect(f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/voice/);
      expect(f.database.getProjectFocusSession(f.project.id).generation).toBe(1);
    }
    f.service.application.setFocusVoiceGuard(() => { throw new Error("unknown"); });
    await expect(f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/voice state/);
    expect(f.calls.filter((call) => call.method === "thread/start")).toHaveLength(starts);
    let checks = 0;
    f.service.application.setFocusVoiceGuard(() => ++checks === 1 ? false : undefined);
    await expect(f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).rejects.toThrow(/unknown/);
    expect(f.database.getProjectFocusSession(f.project.id).generation).toBe(1);
    f.service.application.setFocusVoiceGuard(() => false);
    expect((await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 })).session.generation).toBe(2);
  });

  it("admits Instrument starts with role and brief, refreshes active steers without resume, and rejects stale events", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    const document = { version: 1, title: "Fixture control", state: {}, layout: { type: "text", text: "Control" },
      actions: { check: { type: "sendAgentEvent", event: "check", payload: { value: "inspect" } } } };
    const created = await f.tool("create_instrument", { document }, id, "pixice_instruments");
    const submit = () => f.client.call("instruments.event", { projectId: f.project.id, threadId: id, instrumentId: created.instrument.id, actionId: "check", model: "codex:fixture-model", permissionMode: "read-only" });
    const sent = await submit(); expect(sent.status).toBe("sent");
    expect(f.calls.findLast((call) => call.method === "turn/start").params.permissionMode).toBe("full-access");
    expect(f.calls.findLast((call) => call.method === "thread/resume").params.developerInstructions).toContain("Managed Pixice Focus coordinator");
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Fresh active context", userMemory: "" }, 1);
    const afterStart = f.calls.length;
    f.provider.request = async (method, params) => { f.calls.push({ method, params }); if (method === "turn/steer") return { turnId: params.expectedTurnId }; return f.original(method, params); };
    const turnId = f.provider.threads.get(id).turns.at(-1).id;
    await f.client.call("turns.steer", { projectId: f.project.id, threadId: id, turnId, text: "Fresh follow-up" });
    expect(f.calls.slice(afterStart).some((call) => call.method === "thread/resume")).toBe(false);
    expect(f.calls.findLast((call) => call.method === "turn/steer").params.input[0].text).toContain("Fresh active context");
    await submit();
    expect(f.calls.findLast((call) => call.method === "turn/steer").params.input[0].text).toContain("Fresh active context");
    const resumes = f.calls.filter((call) => call.method === "thread/resume").length;
    await f.tool("record_decision", { text: "Current direction", workIds: [] });
    const update = await f.tool("dispatch_work", { title: "Fixture update", prompt: "Report fixture result", access: "read" });
    const running = await eventually(() => f.store.getWork(f.project.id, update.id), (work) => work.status === "running");
    f.provider.threads.get(running.threadId).turns.at(-1).items = [{ type: "agentMessage", text: "Fixture result" }];
    f.finish(running.threadId);
    await eventually(() => f.calls.findLast((call) => call.method === "turn/steer"), (call) => call.params.input.some((part) => part.text?.startsWith("[Pixice Focus work updates]")));
    expect(f.calls.findLast((call) => call.method === "turn/steer").params.input[0].text).toContain("Current direction");
    expect(f.calls.filter((call) => call.method === "thread/resume")).toHaveLength(resumes);
    await f.client.call("turns.interrupt", { projectId: f.project.id, threadId: id, turnId });
    await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    const count = f.calls.length;
    await expect(submit()).rejects.toThrow(/Focus session changed/);
    await expect(f.client.call("turns.steer", { projectId: f.project.id, threadId: id, turnId, text: "Stale" })).rejects.toThrow(/Focus session changed/);
    expect(f.calls.slice(count).some((call) => ["turn/start", "turn/steer", "thread/resume"].includes(call.method))).toBe(false);
  });

  it("projects only proven injected context from responses, events and retained history", async () => {
    const f = await fixture(); const id = f.focus.thread.id; const events = [];
    const second = await f.connect(); second.subscribe((event) => events.push(event));
    f.provider.request = async (method, params) => {
      f.calls.push({ method, params });
      if (method === "turn/start" && params.threadId === id) {
        const turn = { id: "echo-turn", status: "inProgress", items: [{ type: "userMessage", id: "echo-user",
          content: [{ type: "text", text: params.input.map((part) => part.text).join("\n") }] }] };
        f.provider.threads.get(id).turns.push(turn); f.provider.event({ method: "turn/started", threadId: id, turn }); return { turn };
      }
      return f.original(method, params);
    };
    const authored = '[Pixice Focus state brief]\n{"userAuthored":true}';
    const started = await f.client.call("turns.start", { projectId: f.project.id, threadId: id, text: authored, model: "codex:fixture-model" });
    expect(started.turn.items[0].content[0].text).toBe(authored);
    const snapshot = await f.client.call("threads.read", { projectId: f.project.id, threadId: id });
    expect(snapshot.thread.turns[0].items[0].content[0].text).toBe(authored);
    const event = await eventually(() => events.find((event) => event.payload?.method === "turn/started" && event.payload?.threadId === id), Boolean);
    expect(event.payload.turn.items[0].content[0].text).toBe(authored);
    const input = f.calls.findLast((call) => call.method === "turn/start").params.input;
    expect(input[0].text).toContain('"coordinatorThreadId"'); expect(input[1].text).toBe(authored);
    f.finish(id);
    await eventually(() => f.service.application.state(), (state) => state.activeTurns === 0);
    const renewed = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    const history = await f.client.call("threads.read", { projectId: f.project.id, threadId: renewed.session.threadId });
    expect(history.thread.turns[0].items[0].content[0].text).toBe(authored);
    const hashes = f.database.db.prepare("SELECT COUNT(*) AS n FROM project_focus_context_parts").get().n; expect(hashes).toBeGreaterThan(0);
  });

  it("renews escaped supported memory and reports records beyond the 200-work read", async () => {
    const f = await fixture(); const id = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "\\".repeat(6000), userMemory: "\\".repeat(2000) }, 1);
    f.database.incrementProjectFocusTurn(f.project.id, id, "\\".repeat(2000));
    for (let i = 0; i < 205; i++) f.store.createWork(f.project.id, { title: `Paused ${i}`, status: "paused", coordinatorThreadId: id });
    const renewed = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    expect(renewed.session.handoff.length).toBeLessThanOrEqual(24000);
    const brief = JSON.parse(renewed.session.handoff.split("\n").slice(1).join("\n"));
    expect(brief.work.length + brief.omittedWork).toBe(205);
    expect(brief.pendingEvents.length + brief.omittedEvents).toBe(f.store.coordinatorCounts(f.project.id).events);
  });

  it("stages historical unstaged conversation visuals with immutable origin and rejects foreign messages", async () => {
    const f = await fixture(); const old = f.focus.thread.id;
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
    f.provider.threads.get(old).turns = [{ id: "visual-history", status: "completed", items: [{ type: "userMessage", id: "old-image", content: [{ type: "image", url }] }] }];
    const renewed = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    const current = renewed.session.threadId;
    const work = f.store.createWork(f.project.id, { title: "Paused image work", status: "paused", coordinatorThreadId: old });
    const visual = await f.tool("follow_up", { workId: work.id, prompt: "Keep paused and inspect image", visuals: [{ source: "conversation", messageId: "old-image", index: 0 }] }, current);
    const saved = f.store.getWork(f.project.id, work.id);
    expect(saved.visuals[0].originCoordinatorThreadId).toBe(old);
    expect(saved.visuals[0].path).toContain(path.join(f.project.id, old));
    const folder = path.join(f.root, "foreign"); await mkdir(folder);
    const foreignProject = await f.client.call("projects.create", { displayName: "Foreign", icon: "folder", color: "gray", folders: [folder] });
    const foreign = await f.client.call("focus.ensure", { projectId: foreignProject.id, model: "codex:fixture-model" });
    f.provider.threads.get(foreign.thread.id).turns = [{ id: "foreign-turn", items: [{ type: "userMessage", id: "foreign-image", content: [{ type: "image", url }] }] }];
    await expect(f.tool("follow_up", { workId: work.id, prompt: "Foreign", visuals: [{ source: "conversation", messageId: "foreign-image", index: 0 }] }, current)).rejects.toThrow(/not found/);
    expect(f.store.getWork(f.project.id, work.id).visuals).toEqual(saved.visuals);
  });

  it("guards bridge completion starts and retired parents through shared Focus admission", async () => {
    const f = await fixture();
    const parent = (await f.client.call("threads.create", { projectId: f.project.id, model: "codex:fixture-model" })).thread.id;
    const children = [];
    const spawn = async (label) => {
      const before = new Set(f.provider.threads.keys());
      const result = f.tool("spawn_thread", { model: "codex:fixture-model", prompt: label, permissionMode: "full-access" }, parent, "pixice_bridge");
      const child = await eventually(() => [...f.provider.threads.values()].find((thread) => !before.has(thread.id) && thread.turns.length), Boolean);
      children.push(child.id); return { result };
    };
    const first = await spawn("Fixture child one"); const second = await spawn("Fixture child two");
    const previous = f.database.getProjectFocusSession(f.project.id);
    f.database.replaceProjectFocusSession({ projectId: f.project.id, threadId: parent, expectedGeneration: 1, expectedRevision: previous.revision, handoff: "fixture promotion", evidence: {} });
    f.provider.threads.get(children[0]).turns.at(-1).items = [{ type: "agentMessage", text: "Bridge result" }];
    f.finish(children[0]); await first.result;
    const admitted = await eventually(() => f.calls.findLast((call) => call.method === "turn/start" && call.params.threadId === parent), Boolean);
    expect(admitted.params.input[0].text).toContain('"generation":2');
    expect(admitted.params.permissionMode).toBe("full-access");
    expect(f.calls.findLast((call) => call.method === "thread/resume" && call.params.threadId === parent).params.developerInstructions).toContain("Managed Pixice Focus coordinator");
    const turnId = f.provider.threads.get(parent).turns.at(-1).id;
    await f.client.call("turns.interrupt", { projectId: f.project.id, threadId: parent, turnId });
    const renewed = await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 2 });
    const before = f.calls.length;
    f.provider.threads.get(children[1]).turns.at(-1).items = [{ type: "agentMessage", text: "Late bridge result" }];
    f.finish(children[1]); await second.result;
    // Barrier after bridge's next-tick completion callback and project admission.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.client.call("focus.history", { projectId: f.project.id });
    expect(f.calls.slice(before).some((call) => call.method === "turn/start" && call.params.threadId === parent)).toBe(false);
    expect(f.database.getProjectFocusSession(f.project.id)).toMatchObject({ threadId: renewed.session.threadId, stopped: true });
  });

  it.each([false, true])("projects recorded current and retired Focus copies, updates and search with remapped IDs=%s", async (remap) => {
    const f = await forkFixture({ remap, summaryResponse: remap }); const sourceId = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(sourceId, "Visible original request");
    const sourceTurn = f.provider.threads.get(sourceId).turns[0];
    const original = await f.client.call("threads.read", { projectId: f.project.id, threadId: sourceId });
    expect(JSON.stringify(original)).not.toContain("Internalneedleprivate");
    const events = []; f.client.subscribe((event) => events.push(event));
    await expect(f.fork(sourceId, sourceTurn, { focusOriginThreadId: "spoof", copiedContext: { originThreadId: sourceId } })).rejects.toThrow(/Unrecognized key/);
    const currentFork = await f.seedRecordedCopy(sourceId, sourceTurn);
    const forkId = currentFork.thread.id;
    expect(currentFork.thread.parentThreadId).toBeNull(); expect(currentFork.thread.forkedFromId).toBe(sourceId);
    expect(JSON.stringify(currentFork)).not.toContain("Internalneedleprivate");
    expect(currentFork.thread.turns[0].items[0].content[0].text).toBe("Visible original request");
    expect(JSON.stringify(await f.client.call("threads.read", { projectId: f.project.id, threadId: forkId }))).not.toContain("Internalneedleprivate");
    const announcement = await eventually(() => events.find((event) => event.payload?.method === "thread/started" && event.payload?.thread?.id === forkId), Boolean);
    expect(JSON.stringify(announcement)).not.toContain("Internalneedleprivate");
    const copied = f.provider.threads.get(forkId).turns[0];
    f.provider.event({ method: "item/started", threadId: forkId, turnId: copied.id, item: copied.items[0] });
    const update = await eventually(() => events.find((event) => event.payload?.item?.id === copied.items[0].id && event.payload?.threadId === forkId), Boolean);
    expect(update.payload.item.content[0].text).toBe("Visible original request");
    f.database.saveProviderThreadSnapshot(forkId, f.provider.threads.get(forkId));
    expect(f.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate")).toEqual([]);
    expect(f.database.searchProjectFocusHistory(f.project.id, "Visible original request").some((item) => item.threadId === forkId)).toBe(true);
    await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    const retiredFork = await f.seedRecordedCopy(sourceId, sourceTurn);
    expect(JSON.stringify(retiredFork)).not.toContain("Internalneedleprivate");
    expect(retiredFork.thread.turns[0].items[0].content[0].text).toBe("Visible original request");
    expect(JSON.stringify(await f.client.call("threads.read", { projectId: f.project.id, threadId: retiredFork.thread.id }))).not.toContain("Internalneedleprivate");
  });

  it("inherits only copied-message proof through fork-of-fork while preserving fresh tails and exact pasted prior briefs", async () => {
    const f = await forkFixture(); const sourceId = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(sourceId, "Original visible request");
    const originalBrief = f.calls.findLast((call) => call.method === "turn/start").params.input[0].text;
    const first = await f.seedRecordedCopy(sourceId); const id = first.thread.id;
    const fresh = await f.submit(id, "Fresh fork tail");
    const pasted = originalBrief + "\nLegitimate pasted tail";
    const paste = await f.submit(id, pasted);
    expect(paste.turn.items[0].content[0].text).toBe(pasted);
    const second = await f.seedRecordedCopy(id); const secondId = second.thread.id;
    const userMessages = second.thread.turns.map((turn) => turn.items[0].content[0].text);
    expect(userMessages).toEqual(["Original visible request", "Fresh fork tail", pasted]);
    expect(f.database.hasFocusContextPart(secondId, createHash("sha256").update(originalBrief).digest("hex"))).toBe(false);
    const raw = f.provider.threads.get(secondId);
    // Provider-supplied origin metadata is not a way to inherit thread-wide proof.
    raw.turns.at(-1).focusOriginThreadId = sourceId;
    const read = await f.client.call("threads.read", { projectId: f.project.id, threadId: secondId });
    expect(read.thread.turns.at(-1).items[0].content[0].text).toBe(pasted);
    const events = []; f.client.subscribe((event) => events.push(event));
    f.provider.event({ method: "item/started", threadId: secondId, turnId: raw.turns.at(-1).id, item: raw.turns.at(-1).items[0] });
    const live = await eventually(() => events.find((event) => event.payload?.item?.id === raw.turns.at(-1).items[0].id), Boolean);
    expect(live.payload.item.content[0].text).toBe(pasted);
    f.database.saveProviderThreadSnapshot(secondId, raw);
    const search = f.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate", 20);
    expect(search).not.toHaveLength(0); // Deliberate user paste is searchable.
    expect(search.every((item) => item.itemId === raw.turns.at(-1).items[0].id || item.itemId === f.provider.threads.get(id).turns.at(-1).items[0].id)).toBe(true);
    const reopened = new PixiceDatabase(path.join(f.root, "data"));
    try {
      const snapshot = reopened.getProviderThreadSnapshot(secondId);
      const projected = projectRendererThread(snapshot, f.projection(reopened));
      expect(projected.turns.map((turn) => turn.items[0].content[0].text)).toEqual(userMessages);
      const copiedItem = snapshot.turns[0].items[0];
      const projectedEvent = projectRuntimePayloadForRenderer({ threadId: secondId, turnId: snapshot.turns[0].id, item: copiedItem }, f.projection(reopened));
      expect(projectedEvent.item.content[0].text).toBe("Original visible request");
      reopened.saveProviderThreadSnapshot(secondId, snapshot);
      expect(reopened.searchProjectFocusHistory(f.project.id, "Fresh fork tail").some((item) => item.threadId === secondId)).toBe(true);
      expect(reopened.searchProjectFocusHistory(f.project.id, "Internalneedleprivate", 20).every((item) => item.itemId === snapshot.turns.at(-1).items[0].id || item.itemId === f.provider.threads.get(id).turns.at(-1).items[0].id)).toBe(true);
    } finally { reopened.db.close(); }
  });

  it("keeps fork provenance project-isolated and rejects caller spoofing and unverified copies", async () => {
    const f = await forkFixture(); const id = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(id, "Original request"); const fork = await f.seedRecordedCopy(id);
    const otherFolder = path.join(f.root, "other-project"); await mkdir(otherFolder);
    // Overlapping folders cannot override the copied history's durable owner.
    const other = await f.client.call("projects.create", { displayName: "Other", icon: "folder", color: "gray", folders: [f.root] });
    const turn = f.provider.threads.get(fork.thread.id).turns[0];
    const payload = { projectId: other.id, threadId: fork.thread.id, lastTurnId: turn.id, lastItemId: turn.items[1].id };
    await expect(f.client.call("threads.fork", payload)).rejects.toThrow(/outside|another project/);
    expect(f.database.searchProjectFocusHistory(other.id, "Original request")).toEqual([]);
    const raw = structuredClone(f.provider.threads.get(fork.thread.id));
    raw.turns[0].id = "fresh-turn"; raw.turns[0].items[0].id = "fresh-message";
    raw.turns[0].focusOriginThreadId = id;
    const unrelated = projectRendererThread(raw, f.projection(f.database));
    expect(unrelated.turns[0].items[0].content[0].text).toContain("Internalneedleprivate"); // Caller data, no copied-item proof.
    const changed = structuredClone(f.provider.threads.get(fork.thread.id));
    changed.turns[0].items[0].content.push({ type: "text", text: "Authored change" });
    expect(projectRendererThread(changed, f.projection(f.database)).turns[0].items[0].content[0].text).toContain("Internalneedleprivate");
    const future = await f.submit(fork.thread.id, "Fresh isolated tail");
    expect(future.turn.items[0].content[0].text).toBe("Fresh isolated tail");
  });

  it("keeps a recorded failed candidate protected without releasing its private history", async () => {
    const f = await forkFixture();
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(f.focus.thread.id, "Visible input");
    const candidate = { ...structuredClone(f.provider.threads.get(f.focus.thread.id)), id: randomUUID() };
    candidate.turns[0].items[0].content[0].text += " changed by provider";
    f.provider.threads.set(candidate.id, candidate);
    f.database.db.prepare(`INSERT INTO project_focus_fork_candidates
      (thread_id, project_id, source_thread_id, provider, operation_id, identity, disposition, reason, created_at)
      VALUES (?, ?, ?, 'codex', ?, 'response', 'failed', 'Historical rejected changed copy', ?)`)
      .run(candidate.id, f.project.id, f.focus.thread.id, randomUUID(), new Date().toISOString());
    f.database.saveThreadProviderBinding({ threadId: candidate.id, provider: "codex", cwd: candidate.cwd });
    f.database.saveProviderThreadSnapshot(candidate.id, candidate);
    const events = []; f.client.subscribe((event) => events.push(event));
    await expect(f.fork(f.focus.thread.id)).rejects.toThrow(/unsupported/);
    await expect(Promise.resolve().then(() => f.database.inheritFocusForkContext(
      f.database.focusForkCopyPlan(f.project.id, f.provider.threads.get(f.focus.thread.id), candidate.turns[0].id, candidate.turns[0].items[1].id), candidate)))
      .rejects.toThrow(/authority changed/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((event) => JSON.stringify(event).includes("Internalneedleprivate"))).toBe(false);
    expect(f.database.db.prepare("SELECT COUNT(*) AS n FROM project_focus_fork_threads").get().n).toBe(0);
    expect(f.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate")).toEqual([]);
    expect(f.database.getFocusForkCandidate(candidate.id)).toMatchObject({ disposition: "failed", identity: "response" });
    expect(f.provider.threads.has(candidate.id)).toBe(true); // Recoverable, not deleted.
    await expect(f.client.call("threads.read", { projectId: f.project.id, threadId: candidate.id })).rejects.toThrow(/quarantined/);
    expect((await f.client.call("threads.list", { projectId: f.project.id })).data.some((thread) => thread.id === candidate.id)).toBe(false);
    expect(f.database.getProviderThreadSnapshot(candidate.id)).toBeNull();
    expect(f.database.getProviderThreadSummary(candidate.id)).toBeNull();
    expect(f.database.listProviderThreadSummaries().some((thread) => thread.id === candidate.id)).toBe(false);
    expect(f.database.listConnectOverview({ threadIds: [candidate.id] }).providerThreads.some((thread) => thread.id === candidate.id)).toBe(false);
    expect(JSON.stringify(f.database.getProviderThreadSnapshotForDiagnosis(candidate.id))).toContain("Internalneedleprivate");
    const published = []; f.service.application.events.on("event", (event) => published.push(event));
    f.provider.event({ method: "item/started", threadId: candidate.id, turnId: candidate.turns[0].id, item: candidate.turns[0].items[0] });
    f.provider.event({ method: "thread/started", thread: candidate });
    f.database.saveProviderThreadSnapshot(candidate.id, candidate);
    expect(published.some((event) => JSON.stringify(event).includes("Internalneedleprivate"))).toBe(false);
    expect(f.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate")).toEqual([]);

    const reopened = await reopenForkFixture(f);
    expect(reopened.database.getFocusForkCandidate(candidate.id).disposition).toBe("failed");
    expect(reopened.database.getProviderThreadSnapshot(candidate.id)).toBeNull();
    expect(JSON.stringify(reopened.database.getProviderThreadSnapshotForDiagnosis(candidate.id))).toContain("Internalneedleprivate");
    await expect(reopened.client.call("threads.read", { projectId: f.project.id, threadId: candidate.id })).rejects.toThrow(/quarantined/);
    expect((await reopened.client.call("threads.list", { projectId: f.project.id })).data.some((thread) => thread.id === candidate.id)).toBe(false);
    const afterRestart = []; reopened.service.application.events.on("event", (event) => afterRestart.push(event));
    reopened.provider.event({ method: "item/started", threadId: candidate.id, turnId: candidate.turns[0].id, item: candidate.turns[0].items[0] });
    reopened.database.saveProviderThreadSnapshot(candidate.id, candidate);
    expect(afterRestart.some((event) => JSON.stringify(event).includes("Internalneedleprivate"))).toBe(false);
    expect(reopened.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate")).toEqual([]);
  });

  it("strips a copied coalesced insertion once and retains an exact prior brief pasted by the Focus user", async () => {
    const f = await forkFixture({ coalesce: true }); const id = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(id, "Original visible request");
    const prior = f.calls.findLast((call) => call.method === "turn/start").params.input[0].text;
    const authored = prior + "\nUser pasted prior brief";
    const normal = await f.submit(id, authored);
    expect(normal.turn.items[0].content[0].text).toBe(authored);
    const earlier = await f.seedRecordedCopy(id, f.provider.threads.get(id).turns[0]);
    expect(earlier.thread.turns).toHaveLength(1);
    expect(earlier.thread.turns[0].items[0].content[0].text).toBe("Original visible request");
    const fork = await f.seedRecordedCopy(id);
    expect(fork.thread.turns[0].items[0].content[0].text).toBe("Original visible request");
    expect(fork.thread.turns[1].items[0].content[0].text).toBe(authored);
    const again = await f.seedRecordedCopy(fork.thread.id);
    const read = await f.client.call("threads.read", { projectId: f.project.id, threadId: again.thread.id });
    expect(read.thread.turns[1].items[0].content[0].text).toBe(authored);
    expect(read.thread.turns[0].items[0].content[0].text).not.toContain("Internalneedleprivate");
    const pastedId = f.provider.threads.get(id).turns[1].items[0].id;
    expect(f.database.searchProjectFocusHistory(f.project.id, "Internalneedleprivate", 20).every((item) => item.itemId === pastedId)).toBe(true);
  });

  it.each(["codex", "claude"])("gates current, retired and inherited protected forks on %s before any creation RPC", async (focusProvider) => {
    const f = await forkFixture({ focusProvider }); const id = f.focus.thread.id;
    f.database.replaceProjectFocusMemory(f.project.id, { projectMemory: "Internalneedleprivate", userMemory: "" }, 1);
    await f.submit(id, "Visible input");
    const first = await f.seedRecordedCopy(id);
    await f.submit(first.thread.id, "Fresh independent tail");
    const second = await f.seedRecordedCopy(first.thread.id);
    const before = [...f.provider.threads.keys()];
    const native = vi.fn(() => { throw new Error("Provider failure without creation identity must never be reached"); });
    const previous = f.provider.request;
    f.provider.request = (method, params) => method === "thread/fork" ? native(params) : previous(method, params);
    const generation = f.database.getProjectFocusSession(f.project.id);
    for (const threadId of [id, first.thread.id, second.thread.id]) {
      await expect(f.fork(threadId)).rejects.toThrow(/unsupported.*No fork was created.*\/new.*normal task/);
    }
    expect(f.database.getProjectFocusSession(f.project.id)).toEqual(generation);
    await f.client.call("focus.refresh", { projectId: f.project.id, expectedGeneration: 1 });
    await expect(f.fork(id)).rejects.toThrow(/unsupported/);
    expect(native).not.toHaveBeenCalled();
    expect(f.calls.filter((call) => call.method === "thread/fork")).toEqual([]);
    expect(before.every((threadId) => f.provider.threads.has(threadId))).toBe(true);
    expect(f.provider.threads.size).toBe(before.length + 1); // Only the requested Focus renewal.
    for (const table of ["project_focus_fork_operations", "project_focus_fork_known_threads", "project_focus_fork_candidates"]) {
      expect(f.database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    }
    const copied = f.provider.threads.get(second.thread.id).turns[0];
    const reopened = await reopenForkFixture(f);
    await expect(reopened.client.call("threads.fork", { projectId: f.project.id, threadId: second.thread.id,
      lastTurnId: copied.id, lastItemId: copied.items[1].id })).rejects.toThrow(/unsupported/);
    expect(reopened.database.getFocusForkOperation(focusProvider)).toBeNull();
    expect(reopened.database.db.prepare("SELECT COUNT(*) AS n FROM project_focus_fork_candidates").get().n).toBe(0);
  });

  it("leaves unrelated existing, external and new sessions usable across projects/providers and restart after rejection", async () => {
    const f = await forkFixture(); const id = f.focus.thread.id;
    await f.submit(id, "Visible request");
    const prior = f.calls.findLast((call) => call.method === "turn/start").params.input[0].text;
    const folder = path.join(f.root, "project-B"); await mkdir(folder);
    const other = await f.client.call("projects.create", { displayName: "Project B", icon: "folder", color: "gray", folders: [folder] });
    const existing = [];
    for (const project of [f.project, other]) for (const provider of ["codex", "claude"]) {
      const created = await f.client.call("threads.create", { projectId: project.id, model: `${provider}:fixture-model` });
      existing.push({ project, provider, id: created.thread.id });
    }
    await expect(f.fork(id)).rejects.toThrow(/unsupported/);
    const check = async (host, entries) => {
      const published = []; host.service.application.events.on("event", (event) => published.push(event));
      for (const entry of entries) {
        const provider = host.providers[entry.provider];
        const item = { type: "userMessage", id: randomUUID(), content: [{ type: "text", text: prior + "\nLegitimate unrelated exact paste" }] };
        const turn = { id: randomUUID(), status: "completed", items: [item] };
        const thread = provider.threads.get(entry.id); thread.turns = [turn];
        // Discover unbound Claude identities by provider list; Codex can read
        // unbound identities directly. Neither path infers fork ownership.
        if (entry.provider === "claude") await host.client.call("threads.list", { projectId: entry.project.id });
        const read = await host.client.call("threads.read", { projectId: entry.project.id, threadId: thread.id });
        expect(read.thread.turns[0].items[0]).toEqual(item);
        provider.event({ method: "thread/started", thread });
        provider.event({ method: "item/started", threadId: thread.id, turnId: turn.id, item });
        expect(published.find((event) => event.payload?.thread?.id === thread.id)?.payload.thread.turns[0].items[0]).toEqual(item);
        expect(published.filter((event) => event.payload?.item?.id === item.id)).toHaveLength(1);
        expect((await host.client.call("threads.list", { projectId: entry.project.id })).data.some((value) => value.id === thread.id)).toBe(true);
        expect(host.database.getFocusForkCandidate(thread.id)).toBeNull();
      }
    };
    const external = (host) => [f.project, other].flatMap((project) => ["codex", "claude"].map((provider) => {
      const thread = { id: randomUUID(), cwd: project.folders[0], turns: [], status: { type: "idle" } };
      host.providers[provider].threads.set(thread.id, thread);
      return { project, provider, id: thread.id };
    }));
    await check(f, [...existing, ...external(f)]);
    const reopened = await reopenForkFixture(f);
    const newEntries = [];
    for (const project of [f.project, other]) for (const provider of ["codex", "claude"]) {
      const created = await reopened.client.call("threads.create", { projectId: project.id, model: `${provider}:fixture-model` });
      newEntries.push({ project, provider, id: created.thread.id });
    }
    await check(reopened, [...existing, ...external(reopened), ...newEntries]);
    for (const table of ["project_focus_fork_operations", "project_focus_fork_known_threads", "project_focus_fork_candidates"]) {
      expect(reopened.database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    }
  });

  it("preserves legacy unresolved records without expanding their guard to unrelated external identities", async () => {
    const f = await forkFixture(); await f.submit(f.focus.thread.id, "Visible request");
    const otherFolder = path.join(f.root, "legacy-other-project"); await mkdir(otherFolder);
    const other = await f.client.call("projects.create", { displayName: "External project B", icon: "folder", color: "gray", folders: [otherFolder] });
    const operationId = randomUUID();
    f.database.db.prepare(`INSERT INTO project_focus_fork_operations (operation_id, provider, project_id, source_thread_id, disposition)
      VALUES (?, 'codex', ?, ?, 'unresolved')`).run(operationId, f.project.id, f.focus.thread.id);
    const candidate = { ...structuredClone(f.provider.threads.get(f.focus.thread.id)), id: randomUUID() };
    f.provider.threads.set(candidate.id, candidate);
    f.database.db.prepare(`INSERT INTO project_focus_fork_candidates
      (thread_id, project_id, source_thread_id, provider, operation_id, identity, disposition, reason, created_at)
      VALUES (?, ?, ?, 'codex', ?, 'uncorrelated', 'unresolved', 'Retained historical incident', ?)`)
      .run(candidate.id, f.project.id, f.focus.thread.id, operationId, new Date().toISOString());
    f.database.saveThreadProviderBinding({ threadId: candidate.id, provider: "codex", cwd: candidate.cwd });
    f.database.saveProviderThreadSnapshot(candidate.id, candidate);
    const operation = f.database.getFocusForkOperation("codex"); const record = f.database.getFocusForkCandidate(candidate.id);
    await expect(f.fork(f.focus.thread.id)).rejects.toThrow(/unsupported/);
    const reopened = await reopenForkFixture(f);
    expect(reopened.database.getFocusForkOperation("codex")).toEqual(operation);
    expect(reopened.database.getFocusForkCandidate(candidate.id)).toEqual(record);
    await expect(reopened.client.call("threads.read", { projectId: f.project.id, threadId: candidate.id })).rejects.toThrow(/quarantined/);
    const external = { id: randomUUID(), cwd: other.folders[0], turns: [], status: { type: "idle" } };
    reopened.provider.threads.set(external.id, external);
    const published = []; reopened.service.application.events.on("event", (event) => published.push(event));
    reopened.provider.event({ method: "thread/started", thread: external });
    expect(published.some((event) => event.payload?.thread?.id === external.id)).toBe(true);
    const list = await reopened.client.call("threads.list", { projectId: other.id });
    expect(list.data.some((thread) => thread.id === external.id)).toBe(true);
    expect(list.data.some((thread) => thread.id === candidate.id)).toBe(false);
    expect((await reopened.client.call("threads.read", { projectId: other.id, threadId: external.id })).thread.id).toBe(external.id);
    expect(reopened.database.getFocusForkCandidate(external.id)).toBeNull();
    expect(reopened.database.getFocusForkCandidate(candidate.id)).toEqual(record);
    expect(reopened.database.getFocusForkOperation("codex")).toEqual(operation);
  });

  it.each(["codex", "claude"])("keeps ordinary %s forks, exact pasted brief text, lineage and independent continuation supported", async (focusProvider) => {
    const f = await forkFixture({ focusProvider }); await f.submit(f.focus.thread.id, "Focus request");
    const prior = f.calls.findLast((call) => call.method === "turn/start").params.input[0].text;
    const normal = await f.client.call("threads.create", { projectId: f.project.id, model: `${focusProvider}:fixture-model` });
    const paste = prior + "\nUser authored paste";
    await f.submit(normal.thread.id, paste);
    const fork = await f.fork(normal.thread.id);
    expect(fork.thread.turns[0].items[0].content[0].text).toBe(paste);
    expect(fork.thread).toMatchObject({ parentThreadId: null, forkedFromId: normal.thread.id });
    expect(f.calls.filter((call) => call.method === "thread/fork")).toHaveLength(1);
    const again = await f.fork(fork.thread.id);
    expect(again.thread.turns[0].items[0].content[0].text).toBe(paste);
    expect((await f.submit(again.thread.id, "Fresh normal tail")).turn.items[0].content[0].text).toBe("Fresh normal tail");
    expect(f.database.getFocusForkOperation(focusProvider)).toBeNull();
    expect(f.database.getFocusForkCandidate(again.thread.id)).toBeNull();
  });

  it("permits a Focus fork boundary with no protected copied insertion even when later turns have one", async () => {
    const f = await forkFixture(); const id = f.focus.thread.id;
    const turn = { id: randomUUID(), status: "completed", items: [
      { id: randomUUID(), type: "userMessage", content: [{ type: "text", text: "Ordinary earlier history" }] },
      { id: randomUUID(), type: "agentMessage", text: "Earlier final answer", phase: "final_answer" }
    ] };
    f.provider.threads.get(id).turns.push(turn);
    await f.submit(id, "Later protected request");
    const fork = await f.fork(id, turn);
    expect(fork.thread.turns).toHaveLength(1);
    expect(fork.thread.turns[0].items[0].content[0].text).toBe("Ordinary earlier history");
    expect(f.calls.filter((call) => call.method === "thread/fork")).toHaveLength(1);
    expect((await f.fork(fork.thread.id)).thread.turns[0].items[0].content[0].text).toBe("Ordinary earlier history");
    await expect(f.fork(id)).rejects.toThrow(/unsupported/);
  });

});
