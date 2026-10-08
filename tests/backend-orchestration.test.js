// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startService } from "../electron/backend/service.mjs";
import { ApplicationClient } from "../electron/connect/application-client.mjs";
import { BackendFixtureProvider } from "./fixtures/backend-provider.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class OrchestrationProvider extends BackendFixtureProvider {
  constructor() { super(); this.requests = []; this.responses = []; this.confirmResponses = true; }
  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "model/list" && this.focusModel) return { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Fixture Focus model", isDefault: true }] };
    if (method === "turn/start" && this.rejectNextStart) {
      this.rejectNextStart = false;
      throw Object.assign(new Error("The provider rejected this prompt before dispatch"), { providerRejected: true, code: -32602 });
    }
    if (method === "turn/interrupt" && this.deferStop) return { accepted: true };
    if (method === "turn/steer") {
      const turn = this.threads.get(params.threadId)?.turns.find(candidate => candidate.id === params.expectedTurnId);
      if (turn?.status !== "inProgress") throw Object.assign(new Error("The expected turn stopped"), { code: -32000 });
      turn.items.push({ id: randomUUID(), type: "userMessage", content: structuredClone(params.input) });
      return { turn: structuredClone(turn) };
    }
    const response = await super.request(method, params);
    if (method === "turn/start") {
      const turn = this.threads.get(params.threadId).turns.find(candidate => candidate.id === response.turn.id);
      turn.items.push({ id: randomUUID(), type: "userMessage", content: structuredClone(params.input) });
      if (this.completeBeforeReply) this.complete(params.threadId, turn.id);
      if (this.loseStartReply) throw Object.assign(new Error("Provider accepted the turn but its response was lost"), this.numericStartError ? { code: -32603 } : {});
    }
    return response;
  }
  respond(id, response) {
    this.responses.push({ id, response });
    if (this.confirmResponses) return super.respond(id);
    return { written: true, resolved: false };
  }
  complete(threadId, turnId, status = "completed") {
    const thread = this.threads.get(threadId);
    const turn = thread.turns.find(candidate => candidate.id === turnId);
    turn.status = status;
    turn.items.push({ id: randomUUID(), type: "agentMessage", text: `Result for ${turnId}`, phase: "final_answer" });
    this.event({ method: "turn/completed", threadId, turn: structuredClone(turn) });
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pixice-orchestration-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "project");
  await mkdir(folder); await writeFile(path.join(folder, "file.txt"), "fixture\n");
  const provider = new OrchestrationProvider();
  const connect = async () => {
    const service = await startService({ dataDirectory: path.join(root, "data"), resourcesPath: path.resolve("resources"), clientDirectory: path.resolve("dist/client"), version: "test",
      providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider("claude") } });
    cleanups.push(() => service.stop({ force: true })); await service.ready;
    const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: "service.status" });
    cleanups.push(() => client.close()); await client.connect();
    return { service, client };
  };
  const { service, client } = await connect();
  const project = await client.call("projects.create", { displayName: "Orchestration", icon: "folder", color: "gray", folders: [folder] });
  const { thread } = await client.call("threads.create", { projectId: project.id, model: "codex:fixture-model" });
  const input = { projectId: project.id, threadId: thread.id, text: "Perform the requested work", model: "codex:fixture-model" };
  return { provider, service, client, project, thread, input, connect };
}

function computerUsePermission(provider, service, threadId, turnId, overrides = {}) {
  const id = randomUUID();
  provider.emit("server-request", { id, method: "mcpServer/elicitation/request", params: {
    threadId, turnId, serverName: "computer-use", mode: "form", message: "Allow ChatGPT to use Safari?",
    _meta: { app_name: "Safari", persist: ["session", "always"] },
    requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", oneOf: [
      { const: "once", title: "Allow once" }, { const: "session", title: "Allow for this session" }, { const: "always", title: "Always allow Safari" }
    ] } } }, ...overrides
  } });
  return service.application.attention().find(request => request.id === id);
}

describe("Computer Use native per-app approvals", () => {
  it.each([
    ["accept", { action: "accept", content: { approval: "once" } }],
    ["acceptForSession", { action: "accept", _meta: { persist: "session" }, content: { approval: "session" } }],
    ["acceptAlways", { action: "accept", _meta: { persist: "always" }, content: { approval: "always" } }]
  ])("sends %s through the real backend as the provider's advertised app grant", async (decision, response) => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    const pending = computerUsePermission(provider, service, thread.id, started.turn.id);
    expect(await client.call("elicitations.respond", { requestId: pending.id, requestGeneration: pending.requestGeneration, decision })).toMatchObject({ resolved: true });
    expect(provider.responses).toContainEqual({ id: pending.id, response });
    expect(service.application.attention()).toEqual([]);
    expect(provider.requests.find(request => request.method === "turn/start").params.permissionMode).toBe("workspace-write");
  });

  it("preserves native persistence metadata from a supported raw form response", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    const pending = computerUsePermission(provider, service, thread.id, started.turn.id);
    const response = { action: "accept", _meta: { persist: "always" }, content: { approval: "always" } };
    await client.call("elicitations.respond", { requestId: pending.id, requestGeneration: pending.requestGeneration, ...response });
    expect(provider.responses).toContainEqual({ id: pending.id, response });
  });

  it("does not invent unsupported permanent grants or bypass ordinary required input", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    const once = computerUsePermission(provider, service, thread.id, started.turn.id, { _meta: {}, requestedSchema: {
      type: "object", required: ["approval"], properties: { approval: { type: "string", enum: ["once"] } }
    } });
    await expect(client.call("elicitations.respond", { requestId: once.id, requestGeneration: once.requestGeneration, decision: "acceptAlways" })).rejects.toThrow();
    const form = computerUsePermission(provider, service, thread.id, started.turn.id, { requestedSchema: {
      type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } }
    } });
    await expect(client.call("elicitations.respond", { requestId: form.id, requestGeneration: form.requestGeneration, decision: "acceptAlways" })).rejects.toThrow();
    await expect(client.call("elicitations.respond", { requestId: once.id, requestGeneration: once.requestGeneration, action: "accept", content: { approval: "once" }, _meta: { persist: "always" } })).rejects.toThrow();
    expect(provider.responses).toEqual([]);
    await client.call("elicitations.respond", { requestId: form.id, requestGeneration: form.requestGeneration, action: "accept", content: { email: "user@example.com" } });
    expect(provider.responses).toEqual([{ id: form.id, response: { action: "accept", content: { email: "user@example.com" } } }]);
  });

  it("keeps Always allow visible until native confirmation and fences stale generations", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    const pending = computerUsePermission(provider, service, thread.id, started.turn.id);
    await expect(client.call("elicitations.respond", { requestId: pending.id, requestGeneration: pending.requestGeneration + 1, decision: "acceptAlways" })).rejects.toThrow(/current|pending/);
    expect(provider.responses).toEqual([]);
    provider.confirmResponses = false;
    const result = client.call("elicitations.respond", { requestId: pending.id, requestGeneration: pending.requestGeneration, decision: "acceptAlways" });
    await vi.waitFor(() => expect(provider.responses).toHaveLength(1));
    expect(service.application.attention()).toContainEqual(expect.objectContaining({ id: pending.id, responseState: "responding" }));
    provider.event({ method: "serverRequest/resolved", requestId: pending.id, threadId: thread.id, turnId: started.turn.id });
    expect(await result).toMatchObject({ resolved: true });
    expect(service.application.attention()).toEqual([]);
  });

  it("routes a Focus worker's app permission without changing the worker access policy", async () => {
    const { client, provider, service, project } = await fixture();
    provider.focusModel = true;
    const focus = await client.call("focus.ensure", { projectId: project.id, model: "codex:gpt-5.6-luna" });
    const coordinatorThreadId = focus.thread.id;
    const coordinatorTurn = await client.call("turns.start", { projectId: project.id, threadId: coordinatorThreadId, text: "Inspect the project in Safari", model: "codex:gpt-5.6-luna" });
    const toolRequestId = randomUUID();
    provider.emit("server-request", { id: toolRequestId, method: "item/tool/call", params: {
      threadId: coordinatorThreadId, turnId: coordinatorTurn.turn.id, namespace: "pixice_focus", tool: "dispatch_work",
      arguments: { title: "Inspect Safari", prompt: "Inspect the requested page", model: "codex:gpt-5.6-luna", access: "read" }
    } });
    let work;
    await vi.waitFor(async () => {
      const state = await client.call("focus.state", { projectId: project.id });
      work = state.work.find(entry => entry.title === "Inspect Safari");
      expect(work?.threadId).toBeTruthy(); expect(work?.turnId).toBeTruthy();
    });
    const pending = computerUsePermission(provider, service, work.threadId, work.turnId);
    expect(pending.projectId).toBe(project.id);
    expect(pending.params._meta).toEqual({ app_name: "Safari", persist: ["session", "always"] });
    await client.call("elicitations.respond", { requestId: pending.id, requestGeneration: pending.requestGeneration, decision: "acceptAlways" });
    expect(provider.responses).toContainEqual({ id: pending.id, response: { action: "accept", _meta: { persist: "always" }, content: { approval: "always" } } });
    const state = await client.call("focus.state", { projectId: project.id });
    expect(state.work.find(entry => entry.id === work.id).permissionMode).toBe("read-only");
    expect(service.application.attention()).toEqual([]);
  });
});

describe("T3 V2 reference orchestration at the backend boundary", () => {
  it("deduplicates stable ordinary turn commands without a second provider start", async () => {
    const { client, provider, input } = await fixture();
    const commandId = randomUUID();
    const first = await client.call("turns.start", { ...input, commandId });
    const again = await client.call("turns.start", { ...input, commandId });
    expect(again.turn.id).toBe(first.turn.id); expect(provider.starts).toBe(1);
  });

  it("keeps a newer turn and queue reservation when an old completion is replayed", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const first = await client.call("turns.start", input);
    provider.complete(thread.id, first.turn.id);
    await vi.waitFor(() => expect(service.application.connectTaskReceipt(thread.id)?.status).toBe("completed"));
    const second = await client.call("turns.start", { ...input, text: "Continue with newer work" });
    await client.call("turns.queue", { ...input, text: "Wait until newer work completes" });
    provider.complete(thread.id, first.turn.id);
    await client.call("service.status");
    expect(provider.starts).toBe(2); expect(service.status().activeTurns).toBe(1);
    expect(service.application.connectTaskReceipt(thread.id)).toMatchObject({ status: "running", activeTurnId: second.turn.id });
    provider.complete(thread.id, second.turn.id);
    await vi.waitFor(() => expect(provider.starts).toBe(3));
  });

  it("retains running state after interrupt acknowledgement until the exact terminal event", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const first = await client.call("turns.start", input);
    provider.deferStop = true;
    expect(await client.call("turns.interrupt", { projectId: input.projectId, threadId: thread.id, turnId: first.turn.id })).toMatchObject({ stopping: true });
    expect(service.status().activeTurns).toBe(1);
    await expect(client.call("turns.start", { ...input, text: "Premature replacement" })).rejects.toThrow(/running|reconciliation/);
    provider.complete(thread.id, first.turn.id, "interrupted");
    await vi.waitFor(() => expect(service.status().activeTurns).toBe(0));
    await client.call("turns.start", { ...input, text: "Confirmed replacement" });
    expect(provider.starts).toBe(2);
  });

  it("keeps approvals visible after transport write and resolves only on provider confirmation", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    const requestId = randomUUID(); provider.confirmResponses = false;
    provider.emit("server-request", { id: requestId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: started.turn.id, command: "fixture command" } });
    const pending = service.application.attention().find(request => request.id === requestId);
    const result = client.call("approvals.resolve", { requestId, requestGeneration: pending.requestGeneration, decision: "accept" });
    await vi.waitFor(() => expect(provider.responses).toHaveLength(1));
    expect(service.application.attention()).toContainEqual(expect.objectContaining({ id: requestId, responseState: "responding" }));
    provider.event({ method: "serverRequest/resolved", requestId, threadId: thread.id });
    expect(await result).toMatchObject({ ok: true, resolved: true });
    expect(service.application.attention()).toEqual([]);
  });

  it("does not reopen a turn that completed before its start RPC response", async () => {
    const { client, provider, service, input, thread } = await fixture();
    provider.completeBeforeReply = true;
    const started = await client.call("turns.start", input);
    await vi.waitFor(() => expect(service.application.connectTaskReceipt(thread.id)?.status).toBe("completed"));
    expect(service.status().activeTurns).toBe(0);
    expect(started.turn.status).toBe("completed");
    expect(service.application.connectTaskReceipt(thread.id)?.turns).toContainEqual(expect.objectContaining({ id: started.turn.id, status: "completed" }));
  });

  it("holds an unknown accepted turn across restart without repeating paid execution", async () => {
    const { client, provider, service, input, thread, connect } = await fixture();
    provider.loseStartReply = true; provider.deferStop = true;
    await expect(client.call("turns.start", { ...input, commandId: "lost-start-reply" })).rejects.toThrow(/response was lost/);
    expect(provider.starts).toBe(1);
    client.close(); await service.stop({ force: true });
    provider.loseStartReply = false;
    const reopened = await connect();
    expect(provider.starts).toBe(1);
    await expect(reopened.client.call("turns.start", { ...input, commandId: "lost-start-reply" })).rejects.toThrow(/identity|reconcil|uncertain|response was lost/);
    await expect(reopened.client.call("turns.start", { ...input, text: "Do not dispatch a replacement" })).rejects.toThrow(/running|reconciliation/);
    expect(provider.starts).toBe(1);
    expect(reopened.service.application.connectTaskReceipt(thread.id)).toMatchObject({ status: "uncertain" });
  });

  it("treats a numeric internal provider error after acceptance as uncertain", async () => {
    const { client, provider, service, input, thread } = await fixture();
    provider.loseStartReply = true; provider.numericStartError = true;
    await expect(client.call("turns.start", { ...input, commandId: "numeric-internal-error" })).rejects.toThrow(/response was lost/);
    expect(service.application.connectTaskReceipt(thread.id)?.status).toBe("uncertain");
    await expect(client.call("turns.start", { ...input, commandId: "numeric-internal-error" })).rejects.toThrow();
    expect(provider.starts).toBe(1);
  });

  it("allows an explicit queue retry only after proven provider rejection", async () => {
    const { client, provider, service, input, thread } = await fixture();
    provider.rejectNextStart = true;
    await client.call("turns.queue", input);
    await vi.waitFor(async () => expect((await client.call("turns.queueList", { projectId: input.projectId, threadId: thread.id })).entries[0]?.state).toBe("failed"));
    await client.call("turns.queueResume", { projectId: input.projectId, threadId: thread.id });
    await vi.waitFor(() => expect(provider.starts).toBe(1));
    const accepted = provider.threads.get(thread.id).turns[0];
    provider.complete(thread.id, accepted.id);
    await vi.waitFor(() => expect(service.application.connectTaskReceipt(thread.id)?.status).toBe("completed"));
    expect(service.application.connectTaskReceipt(thread.id)?.prompts).toHaveLength(1);
  });

  it("ignores delayed unknown start notifications once the exact owned turn is complete", async () => {
    const { client, provider, service, input, thread } = await fixture();
    const started = await client.call("turns.start", input);
    provider.complete(thread.id, started.turn.id);
    await vi.waitFor(() => expect(service.application.connectTaskReceipt(thread.id)?.status).toBe("completed"));
    provider.event({ method: "turn/started", threadId: thread.id, turn: { id: started.turn.id, status: "inProgress" } });
    expect(service.status().activeTurns).toBe(0);
  });

  it("reconciles a recorded exact turn after restart even when the provider has newer history", async () => {
    const { client, provider, service, input, thread, connect } = await fixture();
    const started = await client.call("turns.start", input); provider.deferStop = true;
    client.close(); await service.stop({ force: true });
    const original = provider.threads.get(thread.id).turns.find(turn => turn.id === started.turn.id);
    original.status = "completed";
    original.items.push({ id: "recovered-answer", type: "agentMessage", text: "Exact recovered result", phase: "final_answer" });
    provider.threads.get(thread.id).turns.push({ id: "unrelated-newer-turn", status: "completed", items: [{ type: "agentMessage", text: "Wrong result" }] });
    const reopened = await connect();
    const receipt = reopened.service.application.connectTaskReceipt(thread.id);
    expect(receipt).toMatchObject({ status: "completed", summary: "Exact recovered result" });
    expect(receipt.turns).toContainEqual(expect.objectContaining({ id: started.turn.id }));
    expect(provider.starts).toBe(1);
  });
});
