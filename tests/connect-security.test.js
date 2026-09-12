import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ApplicationRegistry } from "../electron/backend/registry.mjs";
import { startService } from "../electron/backend/service.mjs";
import { filterObserverEvent, filterObserverReadiness } from "../electron/connect/access-policy.mjs";
import { ApplicationClient } from "../electron/connect/application-client.mjs";
import { ConnectServer } from "../electron/connect/server.mjs";
import { normalizeCodexEvent } from "../electron/runtime/capability-adapter.mjs";
import { readFileDiff } from "../electron/git/worktrees.mjs";
import { BackendFixtureProvider } from "./fixtures/backend-provider.mjs";

const run = promisify(execFile);
const cleanup = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function observerAccess(projectId) {
  return { role: "observer", projectIds: [projectId] };
}

describe("Connect security boundaries", () => {
  it("filters the real normalized runtime event shapes and strips collaboration details", () => {
    const access = observerAccess("project-a");
    const resolveProject = (event) => event.payload.projectId;
    const delta = normalizeCodexEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "visible text" }
    });
    const filteredDelta = filterObserverEvent({
      ...delta,
      payload: { ...delta.payload, projectId: "project-a", secret: "private" }
    }, access, resolveProject);
    expect(filteredDelta).toMatchObject({
      type: "ActivityReceived",
      payload: { method: "item/agentMessage/delta", threadId: "thread-a", delta: "visible text", projectId: "project-a" }
    });
    expect(filteredDelta.payload).not.toHaveProperty("secret");

    const completed = normalizeCodexEvent({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed", error: { message: "private" } } }
    });
    const filteredCompleted = filterObserverEvent({
      ...completed,
      payload: { ...completed.payload, projectId: "project-a" }
    }, access, resolveProject);
    expect(filteredCompleted.payload.turn).toEqual({ id: "turn-a", status: "completed" });

    const collaboration = normalizeCodexEvent({
      method: "collab/updated",
      params: {
        threadId: "thread-a",
        item: { id: "collab", type: "collabAgentToolCall", receiverThreadIds: ["thread-b"], secret: "private" }
      }
    });
    expect(filterObserverEvent({
      ...collaboration,
      payload: { ...collaboration.payload, projectId: "project-a" }
    }, access, resolveProject)).toBeNull();

    const account = normalizeCodexEvent({ method: "account/identity", params: { threadId: "thread-a", email: "owner@example.test" } });
    expect(filterObserverEvent({ ...account, payload: { ...account.payload, projectId: "project-a" } }, access, resolveProject)).toBeNull();
    expect(filterObserverEvent({ ...delta, payload: { ...delta.payload, projectId: "project-b" } }, access, resolveProject)).toBeNull();
  });

  it("redacts host-specific readiness diagnostics for observers", () => {
    expect(filterObserverReadiness({
      provider: { connected: false, reason: "/Users/private/.codex/account.json" },
      browser: { available: true, reason: null },
      providerConnected: false
    })).toEqual({
      provider: { connected: false, reason: "Provider is unavailable." },
      browser: { available: true, reason: null }
    });
  });

  it("passes trusted registry context as the first handler argument", async () => {
    const registry = new ApplicationRegistry();
    registry.handle("projects:list", (context, payload) => ({ context, payload }));
    await expect(registry.invoke("projects:list", { requested: true }, { remote: true, access: observerAccess("project-a") })).resolves.toEqual({
      context: { remote: true, access: observerAccess("project-a") },
      payload: { requested: true }
    });
  });

  it("replays every retained SSE sequence for a mixed-scope observer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pixice-connect-sse-security-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const clientDirectory = path.join(directory, "client");
    await mkdir(clientDirectory);
    await writeFile(path.join(clientDirectory, "index.html"), "<!doctype html><title>Pixice</title>");
    const server = new ConnectServer({
      directory,
      clientDirectory,
      knownProjectIds: () => ["project-a", "project-b"],
      eventFilter: () => true,
      invoke: async () => null
    });
    server.state.enabled = true;
    server.state.port = 0;
    await server.start();
    cleanup.push(() => server.stop());
    const endpoint = `http://127.0.0.1:${server.status().port}`;
    const offer = server.pairOffer({ role: "observer", projectIds: ["project-a"] });
    const pairingToken = new URLSearchParams(new URL(offer.url).hash.slice(1)).get("pair");
    const paired = await fetch(`${endpoint}/api/connect/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pairingToken, name: "SSE observer" })
    }).then((response) => response.json());
    const retained = 140;
    for (let index = 1; index <= retained; index += 1) {
      server.publish({
        type: index % 5 === 0 ? "RuntimeEvent" : "TaskUpdated",
        payload: {
          projectId: index % 2 ? "project-a" : "project-b",
          threadId: `thread-${index}`,
          method: index % 5 === 0 ? "account/identity" : "thread/status/changed",
          status: { type: "idle" },
          secret: "must-not-leak"
        }
      });
    }
    const response = await fetch(`${endpoint}/api/connect/events?cursor=0&instanceId=${server.instanceId}`, { headers: { Authorization: `Bearer ${paired.token}` } });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let parsed = [];
    while (!parsed.some((event) => event.type === "ConnectReady")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      parsed = [...text.matchAll(/data: ([^\n]+)\n\n/g)].map((match) => JSON.parse(match[1]));
    }
    await reader.cancel();
    expect(parsed).toHaveLength(retained + 1);
    expect(parsed.slice(0, retained).map((event) => event.sequence)).toEqual(Array.from({ length: retained }, (_, index) => index + 1));
    expect(parsed.at(-1)).toMatchObject({ type: "ConnectReady", sequence: retained });
    expect(parsed.filter((event) => event.type === "TaskUpdated").every((event) => event.payload.projectId === "project-a")).toBe(true);
    expect(parsed.some((event) => JSON.stringify(event).includes("must-not-leak"))).toBe(false);
  });

  it("keeps nested thread ownership stable across observer reads and future events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-connect-nested-security-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const provider = new BackendFixtureProvider();
    provider.listNested = true;
    const service = await startService({
      dataDirectory: path.join(root, "data"),
      resourcesPath: path.resolve("resources"),
      clientDirectory: path.resolve("dist/client"),
      version: "security-test",
      providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider("claude") }
    });
    cleanup.push(() => service.stop({ force: true }));
    await service.ready;
    const owner = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: "service.status" });
    cleanup.push(() => owner.close());
    await owner.connect();
    const projectAPath = path.join(root, "project-a");
    const projectBPath = path.join(projectAPath, "nested-project-b");
    await mkdir(projectBPath, { recursive: true });
    const projectA = await owner.call("projects.create", { displayName: "Project A", icon: "folder", color: "gray", folders: [projectAPath] });
    const projectB = await owner.call("projects.create", { displayName: "Project B", icon: "folder", color: "blue", folders: [projectBPath] });
    const foreignThread = {
      id: "foreign-thread",
      cwd: projectB.canonicalPath,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [],
      status: { type: "idle" }
    };
    provider.threads.set(foreignThread.id, foreignThread);
    await owner.call("threads.list", { projectId: projectB.id });
    const localNestedList = await owner.call("threads.list", { projectId: projectA.id });
    expect(localNestedList.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: foreignThread.id })]));

    service.remote.state.enabled = true;
    service.remote.state.port = 0;
    await service.remote.start();
    const endpoint = `http://127.0.0.1:${service.remote.status().port}`;
    const pairObserver = async (projectId, name) => {
      const offer = service.remote.pairOffer({ role: "observer", projectIds: [projectId] });
      const token = new URLSearchParams(new URL(offer.url).hash.slice(1)).get("pair");
      return fetch(`${endpoint}/api/connect/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name })
      }).then((response) => response.json());
    };
    const observerA = await pairObserver(projectA.id, "Observer A");
    const observerB = await pairObserver(projectB.id, "Observer B");
    const remoteCall = (token, operation, payload) => fetch(`${endpoint}/api/connect/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, payload, instanceId: service.remote.instanceId, id: randomUUID(), issuedAt: Date.now() })
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const listA = await remoteCall(observerA.token, "threads.list", { projectId: projectA.id });
    expect(listA.status).toBe(200);
    expect(listA.body.result.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: foreignThread.id })]));
    const readA = await remoteCall(observerA.token, "threads.read", { projectId: projectA.id, threadId: foreignThread.id });
    expect(readA).toMatchObject({ status: 400, body: { error: "The selected Connect data could not be read." } });
    const readB = await remoteCall(observerB.token, "threads.read", { projectId: projectB.id, threadId: foreignThread.id });
    expect(readB).toMatchObject({ status: 200, body: { result: { thread: { id: foreignThread.id } } } });
    const receiptsA = await remoteCall(observerA.token, "tasks.receipts", { projectId: projectA.id });
    expect(receiptsA).toMatchObject({ status: 200, body: { result: [] } });

    const cursor = service.remote.sequence;
    const started = await owner.call("turns.start", { projectId: projectB.id, threadId: foreignThread.id, text: "start nested task", model: "codex:fixture-model" });
    expect(started.turn.id).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    const poll = (token) => fetch(`${endpoint}/api/connect/poll?cursor=${cursor}&instanceId=${service.remote.instanceId}&wait=0`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json());
    const eventsA = await poll(observerA.token);
    const eventsB = await poll(observerB.token);
    expect(eventsA.events.every((event) => event.type === "ConnectCursor")).toBe(true);
    expect(eventsB.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TaskReceiptUpdated", payload: expect.objectContaining({ projectId: projectB.id }) }),
      expect.objectContaining({ type: "TaskUpdated", payload: expect.objectContaining({ projectId: projectB.id }) })
    ]));
  });

  it("rejects an intermediate symlink during untracked review fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pixice-review-symlink-security-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const scope = path.join(root, "scope");
    const outside = path.join(root, "outside");
    await mkdir(scope);
    await mkdir(outside);
    await writeFile(path.join(scope, "allowed.txt"), "allowed\n");
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(scope, "link"));
    await run("git", ["init"], { cwd: root });
    const allowed = await readFileDiff({ workingPath: root, scopePath: scope, filePath: "allowed.txt" });
    expect(allowed).toContain("allowed.txt");
    await expect(readFileDiff({ workingPath: root, scopePath: scope, filePath: "link/secret.txt" })).rejects.toThrow("outside the project scope");
  });
});
