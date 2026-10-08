// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startService } from "../electron/backend/service.mjs";
import { ApplicationClient } from "../electron/connect/application-client.mjs";
import { BackendFixtureProvider } from "./fixtures/backend-provider.mjs";
import { createContextRecord, serializeContextToken } from "../src/composer/context.js";

const run = promisify(execFile);
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class FeatureProvider extends BackendFixtureProvider {
  constructor() { super(); this.requests = []; }
  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "thread/fork") {
      const source = this.threads.get(params.threadId);
      const index = source?.turns.findIndex((turn) => turn.id === params.lastTurnId) ?? -1;
      if (index < 0) throw new Error("Unknown native fork boundary");
      const thread = { ...structuredClone(source), id: randomUUID(), turns: structuredClone(source.turns.slice(0, index + 1)), forkedFromId: source.id };
      this.threads.set(thread.id, thread); return { thread };
    }
    if (method === "thread/archive") {
      if (this.archiveError) throw new Error(this.archiveError);
      const thread = this.threads.get(params.threadId); thread.archived = true;
      return { ok: true };
    }
    if (method === "thread/name/set") { this.threads.get(params.threadId).name = params.name; return { ok: true }; }
    if (method === "thread/revert") {
      const thread = this.threads.get(params.threadId);
      const index = thread?.turns.findIndex((turn) => turn.id === params.beforeTurnId) ?? -1;
      if (index < 0) throw new Error("Unknown native rewind boundary");
      thread.turns = thread.turns.slice(0, index); thread.status = { type: "idle" };
      return { thread: structuredClone(thread) };
    }
    if (method === "turn/steer") {
      const thread = this.threads.get(params.threadId);
      const turn = thread?.turns.find((candidate) => candidate.id === params.expectedTurnId);
      if (turn?.status !== "inProgress") throw new Error("The turn is no longer active");
      turn.items.push({ id: `steer-${turn.items.length}`, type: "userMessage", content: params.input });
      return { turn: structuredClone(turn) };
    }
    const response = await super.request(method, params);
    if (method === "thread/start") response.thread.historyMode = "paginated";
    if (method === "turn/start") {
      const thread = this.threads.get(params.threadId);
      thread.status = { type: "active" };
      const turn = thread.turns.find((candidate) => candidate.id === response.turn.id);
      turn.items.push({ id: `prompt-${turn.id}`, type: "userMessage", content: structuredClone(params.input) });
    }
    return response;
  }
  complete(threadId) {
    const thread = this.threads.get(threadId);
    const turn = thread.turns.findLast((candidate) => candidate.status === "inProgress");
    turn.status = "completed";
    turn.items.push({ id: `answer-${turn.id}`, type: "agentMessage", text: "Completed the requested change.", phase: "final_answer" });
    thread.status = { type: "idle" };
    this.event({ method: "turn/completed", threadId, turn: structuredClone(turn) });
  }
}

async function fixture({ nested = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pixice-backend-features-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const folder = nested ? path.join(repository, "packages", "app") : repository;
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "file.txt"), "original\n");
  if (nested) await writeFile(path.join(repository, "outside.txt"), "outside\n");
  const git = async (...args) => (await run("git", args, { cwd: repository })).stdout.trim();
  await git("init"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.test"); await git("add", "."); await git("commit", "-m", "initial");
  const provider = new FeatureProvider();
  const service = await startService({ dataDirectory: path.join(directory, "data"), resourcesPath: path.resolve("resources"), clientDirectory: path.resolve("dist/client"), version: "test",
    providerFactories: { codex: () => provider, claude: () => new BackendFixtureProvider("claude") } });
  cleanups.push(() => service.stop({ force: true }));
  await service.ready;
  const client = new ApplicationClient({ id: service.descriptor.hostId, endpoint: service.descriptor.endpoint, token: service.descriptor.token }, { probe: "service.status" });
  cleanups.push(() => client.close());
  await client.connect();
  await client.call("app.saveSettings", { threadNamingModel: "off" });
  const project = await client.call("projects.create", { displayName: "Feature project", icon: "folder", color: "gray", folders: [folder] });
  return { directory, repository, folder, git, provider, service, client, project };
}

describe("native task feature integration", () => {
  it("reads an explicitly attached thread on demand and rejects unattached or foreign history before a provider read", async () => {
    const { client, provider, project, directory } = await fixture();
    const referenceThread = (await client.call("threads.create", { projectId: project.id })).thread;
    await client.call("turns.start", { projectId: project.id, threadId: referenceThread.id, text: "Earlier design decision", model: "codex:fixture-model" });
    provider.complete(referenceThread.id);
    const unattachedThread = (await client.call("threads.create", { projectId: project.id })).thread;
    const foreignFolder = path.join(directory, "foreign-context");
    await mkdir(foreignFolder);
    const foreignProject = await client.call("projects.create", { displayName: "Foreign context", icon: "folder", color: "gray", folders: [foreignFolder] });
    const foreignThread = (await client.call("threads.create", { projectId: foreignProject.id })).thread;
    const thread = (await client.call("threads.create", { projectId: project.id })).thread;
    const reference = createContextRecord("thread", { id: "attached-thread", label: "Earlier design", source: { projectId: project.id, threadId: referenceThread.id } });
    const forged = createContextRecord("thread", { id: "foreign-thread", label: "Foreign context", source: { projectId: project.id, threadId: foreignThread.id } });
    const before = provider.requests.length;
    const started = await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: `Use ${serializeContextToken(reference)} and ${serializeContextToken(forged)}`, contextRecords: [reference, forged], model: "codex:fixture-model" });
    expect(provider.requests.slice(before).some(request => request.method === "thread/read" && [referenceThread.id, foreignThread.id].includes(request.params.threadId))).toBe(false);
    const nativeStart = provider.requests.find(request => request.method === "thread/start" && request.params.dynamicTools?.some(namespace => namespace.name === "pixice_bridge"));
    expect(nativeStart.params.dynamicTools.find(namespace => namespace.name === "pixice_bridge").tools).toContainEqual(expect.objectContaining({ name: "read_thread" }));
    provider.respond = vi.fn();
    const read = async targetThreadId => {
      const requestId = randomUUID();
      provider.emit("server-request", { id: requestId, method: "item/tool/call", params: { namespace: "pixice_bridge", tool: "read_thread", threadId: thread.id, turnId: started.turn.id, arguments: { targetThreadId } } });
      await vi.waitFor(() => expect(provider.respond).toHaveBeenCalledWith(requestId, expect.anything()));
      return provider.respond.mock.calls.find(([id]) => id === requestId)[1];
    };
    const result = await read(referenceThread.id);
    expect(result.success).toBe(true);
    expect(result.contentItems[0].text).toContain("Earlier design decision");
    const readsBeforeDenied = provider.requests.filter(request => request.method === "thread/read").length;
    expect((await read(unattachedThread.id)).success).toBe(false);
    expect((await read(foreignThread.id)).success).toBe(false);
    expect(provider.requests.filter(request => request.method === "thread/read")).toHaveLength(readsBeforeDenied);
    provider.complete(thread.id);
    const checkpoints = await client.call("history.list", { projectId: project.id, threadId: thread.id });
    const preview = await client.call("history.preview", { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id });
    await client.call("history.rewind", { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id, conversationRevision: preview.conversationRevision, restoreFiles: false });
    const readsAfterRewind = provider.requests.filter(request => request.method === "thread/read").length;
    expect((await read(referenceThread.id)).success).toBe(false);
    expect(provider.requests.filter(request => request.method === "thread/read")).toHaveLength(readsAfterRewind);
  });

  it("expands cited content and comments for the provider while keeping referenced thread history lazy", async () => {
    const { client, provider, project } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id });
    const quote = createContextRecord("citation", { id: "quote", label: "Selected answer", text: "Original source words", comment: "Apply this to the next change", source: { projectId: project.id, threadId: thread.id, itemId: "source-answer" } });
    const reference = createContextRecord("thread", { id: "reference", label: "Earlier task", text: "History must not be copied", source: { projectId: project.id, threadId: "other-task" } });
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: `Use ${serializeContextToken(quote)} and ${serializeContextToken(reference)}`, contextRecords: [quote, reference], model: "codex:fixture-model" });
    const input = provider.requests.findLast(request => request.method === "turn/start").params.input.find(part => part.type === "text").text;
    expect(input).toContain("Original source words");
    expect(input).toContain("Apply this to the next change");
    expect(input).toContain("Thread: other-task");
    expect(input).not.toContain("History must not be copied");
    expect(input).not.toContain("pixice-context://");
    await expect(client.call("turns.steer", { projectId: project.id, threadId: thread.id, turnId: thread.turns?.[0]?.id ?? provider.threads.get(thread.id).turns[0].id, text: serializeContextToken(quote), contextRecords: [] })).rejects.toThrow("context is unavailable");
    provider.complete(thread.id);
    const checkpoints = await client.call("history.list", { projectId: project.id, threadId: thread.id });
    const preview = await client.call("history.preview", { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id });
    expect(preview.input.contextRecords).toEqual([quote, reference]);
    expect(preview.input.text).toContain(serializeContextToken(quote));
  });

  it("restores queued attachment bytes and replaces edited context and attachments before dispatch", async () => {
    const { client, provider, project } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id });
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "Active work", model: "codex:fixture-model" });
    const original = { name: "notes.txt", type: "text/plain", size: 5, dataUrl: "data:text/plain;base64,bm90ZXM=" };
    const quote = createContextRecord("citation", { id: "queue-quote", label: "Quote", text: "Old excerpt", source: { projectId: project.id } });
    const queued = await client.call("turns.queue", { projectId: project.id, threadId: thread.id, text: `Read ${serializeContextToken(quote)}`, contextRecords: [quote], attachments: [original], model: "codex:fixture-model" });
    const draft = await client.call("turns.queueDraft", { projectId: project.id, threadId: thread.id, id: queued.entry.id });
    expect(draft.contextRecords).toEqual([quote]);
    expect(draft.attachments).toEqual([expect.objectContaining(original)]);
    const edited = { ...quote, text: "Edited excerpt", comment: "Check this one" };
    await client.call("turns.queueEdit", { projectId: project.id, threadId: thread.id, id: queued.entry.id, text: `Check ${serializeContextToken(edited)}`, contextRecords: [edited], replaceAttachments: true, attachments: [] });
    expect((await client.call("turns.queueDraft", { projectId: project.id, threadId: thread.id, id: queued.entry.id })).attachments).toEqual([]);
    provider.complete(thread.id);
    await vi.waitFor(() => expect(provider.starts).toBe(2));
    const input = provider.requests.findLast(request => request.method === "turn/start").params.input.find(part => part.type === "text").text;
    expect(input).toContain("Edited excerpt"); expect(input).toContain("Check this one");
    expect(input).not.toContain("Old excerpt"); expect(input).not.toContain("notes.txt");
  });

  it("lists project files for the picker without asking the provider to load a task", async () => {
    const { client, provider, project, folder } = await fixture();
    const before = provider.requests.length;
    const result = await client.call("files.list", { projectId: project.id, query: "file", limit: 20 });
    expect(result.files).toContainEqual(expect.objectContaining({ path: path.join(folder, "file.txt"), relativePath: "file.txt" }));
    expect(provider.requests.slice(before).some(request => ["thread/read", "thread/resume"].includes(request.method))).toBe(false);
  });
  it("publishes an HTML reply through the provider namespace and serves only authoritatively owned conversation documents", async () => {
    const { client, provider, project, directory } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id, model: "codex:fixture-model" });
    const start = provider.requests.find((request) => request.method === "thread/start" && request.params.cwd === thread.cwd);
    expect(start.params.dynamicTools).toContainEqual(expect.objectContaining({ name: "pixice_html", tools: expect.arrayContaining([expect.objectContaining({ name: "publish" })]) }));

    const html = '<button onclick="this.textContent=\'Selected\'">Choose</button>';
    const requestId = randomUUID();
    provider.respond = vi.fn();
    provider.emit("server-request", { id: requestId, method: "item/tool/call", params: { namespace: "pixice_html", tool: "publish", threadId: thread.id, arguments: { html, title: "Interactive choice" } } });
    await vi.waitFor(() => expect(provider.respond).toHaveBeenCalledWith(requestId, expect.objectContaining({ success: true })));
    const response = provider.respond.mock.calls.find(([id]) => id === requestId)[1];
    const published = JSON.parse(response.contentItems[0].text);
    expect(published).toMatchObject({ threadId: thread.id, title: "Interactive choice" });
    expect(published.replyMarkdown).toContain(`\`\`\`pixice-html\n`);
    expect(published.reference).toBe(`pixice-html://${thread.id}/${published.id}`);

    const foreignFolder = path.join(directory, "foreign-project");
    await mkdir(foreignFolder);
    const foreignProject = await client.call("projects.create", { displayName: "Foreign project", icon: "folder", color: "gray", folders: [foreignFolder] });
    const foreignThread = (await client.call("threads.create", { projectId: foreignProject.id, model: "codex:fixture-model" })).thread;
    await provider.stop();
    const requestCount = provider.requests.length;
    const owned = { projectId: project.id, threadId: thread.id };
    const stored = await client.call("htmlReplies.read", { ...owned, id: published.id });
    expect(stored.html).toBe(html);
    expect(await client.call("htmlReplies.list", owned)).toEqual([expect.objectContaining({ id: published.id, threadId: thread.id })]);
    const document = await client.call("htmlReplies.document", { ...owned, html: stored.html, title: stored.title, nonce: "scoped-render" });
    const rendered = await fetch(document.url);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(rendered.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await rendered.text()).toContain(html);
    expect(provider.requests).toHaveLength(requestCount);

    for (const threadId of [foreignThread.id, randomUUID()]) {
      const invalid = { projectId: project.id, threadId };
      await expect(client.call("htmlReplies.list", invalid)).rejects.toThrow(/another conversation or project/i);
      await expect(client.call("htmlReplies.read", { ...invalid, id: published.id })).rejects.toThrow(/another conversation or project/i);
      await expect(client.call("htmlReplies.document", { ...invalid, html, nonce: "invalid-render" })).rejects.toThrow(/another conversation or project/i);
    }
    await expect(client.call("htmlReplies.read", { projectId: foreignProject.id, threadId: thread.id, id: published.id })).rejects.toThrow(/another conversation or project/i);
    expect(provider.requests).toHaveLength(requestCount);
  });

  it("creates an ordinary task in a managed worktree and scopes execution, list, Review and files to it", async () => {
    const { client, provider, project, folder, repository, git } = await fixture({ nested: true });
    await writeFile(path.join(folder, "file.txt"), "starting local changes\n");
    const sourceIndex = await readFile(path.join(repository, ".git", "index"));
    const { thread } = await client.call("threads.create", { projectId: project.id, model: "codex:fixture-model", workspace: { mode: "worktree", startingState: { type: "working-tree" }, branch: "codex/feature-test" } });
    expect(thread.cwd).not.toBe(folder);
    expect(await readFile(path.join(thread.cwd, "file.txt"), "utf8")).toBe("starting local changes\n");
    expect(await readFile(path.join(repository, ".git", "index"))).toEqual(sourceIndex);
    const start = provider.requests.find((request) => request.method === "thread/start" && request.params.cwd === thread.cwd);
    expect(start.params.runtimeWorkspaceRoots).toContain(thread.cwd);
    expect(start.params.runtimeWorkspaceRoots).not.toContain(folder);
    const listed = await client.call("threads.list", { projectId: project.id });
    expect(listed.data).toContainEqual(expect.objectContaining({ id: thread.id, cwd: thread.cwd }));
    const read = await client.call("threads.read", { projectId: project.id, threadId: thread.id });
    expect(read.thread.workspace).toMatchObject({ kind: "worktree", threadId: thread.id, projectId: project.id });
    await writeFile(path.join(thread.cwd, "file.txt"), "isolated edit\n");
    const review = await client.call("review.read", { projectId: project.id, threadId: thread.id });
    expect(review.files).toContainEqual(expect.objectContaining({ path: "file.txt" }));
    expect((await client.call("files.read", { projectId: project.id, threadId: thread.id, path: "file.txt" })).content).toBe("isolated edit\n");
    await expect(client.call("files.read", { projectId: project.id, threadId: thread.id, path: "../../outside.txt" })).rejects.toThrow(/outside|scope/i);
    expect(await git("branch", "--show-current")).not.toBe("codex/feature-test");
    expect(await readFile(path.join(folder, "file.txt"), "utf8")).toBe("starting local changes\n");
  });

  it("persists queued follow-ups and submits the edited prompt only after the active turn finishes", async () => {
    const { client, provider, project } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id });
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "First task", model: "codex:fixture-model" });
    const queued = await client.call("turns.queue", { projectId: project.id, threadId: thread.id, text: "Follow-up", model: "codex:fixture-model" });
    expect(provider.starts).toBe(1);
    await client.call("turns.queueEdit", { projectId: project.id, threadId: thread.id, id: queued.entry.id, text: "Edited follow-up" });
    expect((await client.call("turns.queueList", { projectId: project.id, threadId: thread.id })).entries).toMatchObject([{ text: "Edited follow-up", state: "queued" }]);
    provider.complete(thread.id);
    await vi.waitFor(() => expect(provider.starts).toBe(2));
    const turns = provider.requests.filter((request) => request.method === "turn/start");
    expect(turns[1].params.input.find((part) => part.type === "text").text).toBe("Edited follow-up");
    await vi.waitFor(async () => expect((await client.call("turns.queueList", { projectId: project.id, threadId: thread.id })).entries).toEqual([]));
    expect((await client.call("history.list", { projectId: project.id, threadId: thread.id }))).toHaveLength(2);
  });

  it("keeps a cleaned task visible and recreates its checkout only when execution continues", async () => {
    const { client, project } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id, workspace: { mode: "worktree", startingState: { type: "ref", ref: "HEAD" } } });
    const removed = await client.call("taskWorkspaces.remove", { projectId: project.id, threadId: thread.id });
    expect(removed.status).toBe("removed");
    await expect(readFile(path.join(thread.cwd, "file.txt"))).rejects.toThrow();
    expect((await client.call("threads.list", { projectId: project.id })).data).toContainEqual(expect.objectContaining({ id: thread.id }));
    const inspection = await client.call("threads.read", { projectId: project.id, threadId: thread.id });
    expect(inspection.thread.workspace.status).toBe("removed");
    await expect(readFile(path.join(thread.cwd, "file.txt"))).rejects.toThrow();
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "Continue the task", model: "codex:fixture-model" });
    expect(await readFile(path.join(thread.cwd, "file.txt"), "utf8")).toBe("original\n");
    expect((await client.call("taskWorkspaces.read", { projectId: project.id, threadId: thread.id })).status).toBe("ready");
  });

  it("holds queued work and clears it on archive without dispatching a follow-up", async () => {
    const { client, project, provider } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id });
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "Current turn", model: "codex:fixture-model" });
    await client.call("turns.queue", { projectId: project.id, threadId: thread.id, text: "Must not run after archive", model: "codex:fixture-model" });
    await client.call("turns.queueHold", { projectId: project.id, threadId: thread.id });
    provider.complete(thread.id);
    await client.call("threads.archive", { projectId: project.id, threadId: thread.id });
    expect((await client.call("turns.queueList", { projectId: project.id, threadId: thread.id })).entries).toEqual([]);
    expect(provider.starts).toBe(1);
    expect(provider.threads.get(thread.id).archived).toBe(true);
  });

  it("retains held queued prompts when the provider rejects archive", async () => {
    const { client, project, provider } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id });
    await client.call("turns.queueHold", { projectId: project.id, threadId: thread.id });
    await client.call("turns.queue", { projectId: project.id, threadId: thread.id, text: "Keep this queued prompt", model: "codex:fixture-model" });
    provider.archiveError = "Provider refused archive";
    await expect(client.call("threads.archive", { projectId: project.id, threadId: thread.id })).rejects.toThrow("Provider refused archive");
    const queue = await client.call("turns.queueList", { projectId: project.id, threadId: thread.id });
    expect(queue).toMatchObject({ held: true, entries: [{ text: "Keep this queued prompt" }] });
    expect(provider.starts).toBe(0);
  });

  it("refuses full file restore for a shared fork and retains that safeguard after the fork is archived", async () => {
    const { client, project, provider } = await fixture();
    const { thread } = await client.call("threads.create", { projectId: project.id, workspace: { mode: "worktree", startingState: { type: "ref", ref: "HEAD" } } });
    const { turn } = await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "Original prompt", model: "codex:fixture-model" });
    provider.complete(thread.id);
    const final = provider.threads.get(thread.id).turns[0].items.find((item) => item.type === "agentMessage");
    const forked = await client.call("threads.fork", { projectId: project.id, threadId: thread.id, lastTurnId: turn.id, lastItemId: final.id });
    expect(forked.thread.cwd).toBe(thread.cwd);
    const checkpoints = await client.call("history.list", { projectId: project.id, threadId: thread.id });
    const payload = { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id };
    expect((await client.call("history.preview", payload)).restoreAllowed).toBe(false);
    await client.call("threads.archive", { projectId: project.id, threadId: forked.thread.id });
    const preview = await client.call("history.preview", payload);
    expect(preview.restoreAllowed).toBe(false);
    expect(preview.restoreReason).toMatch(/shared/);
    await expect(client.call("history.rewind", { ...payload, conversationRevision: preview.conversationRevision, workspaceRevision: preview.workspaceRevision, restoreFiles: true })).rejects.toThrow(/shared/);
    expect(provider.requests.filter((request) => request.method === "thread/revert")).toHaveLength(0);
  });

  it("rewinds authoritative native history, restores scoped files and returns the original editable prompt", async () => {
    const { client, provider, project, folder } = await fixture({ nested: true });
    const { thread } = await client.call("threads.create", { projectId: project.id, workspace: { mode: "worktree", startingState: { type: "ref", ref: "HEAD" } } });
    await client.call("turns.start", { projectId: project.id, threadId: thread.id, text: "Original edit prompt", model: "codex:fixture-model" });
    await writeFile(path.join(thread.cwd, "file.txt"), "agent edit\n");
    await writeFile(path.join(thread.cwd, "new.txt"), "agent new\n");
    provider.complete(thread.id);
    await vi.waitFor(() => expect(provider.threads.get(thread.id).turns[0].status).toBe("completed"));
    const checkpoints = await client.call("history.list", { projectId: project.id, threadId: thread.id });
    const preview = await client.call("history.preview", { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id });
    expect(preview.restoreAllowed).toBe(true);
    const result = await client.call("history.rewind", { projectId: project.id, threadId: thread.id, checkpointId: checkpoints[0].id,
      conversationRevision: preview.conversationRevision, workspaceRevision: preview.workspaceRevision, restoreFiles: true });
    expect(result.input.text).toBe("Original edit prompt");
    expect(result.thread.turns).toEqual([]);
    const fresh = await client.call("threads.read", { projectId: project.id, threadId: thread.id });
    expect(fresh.thread.turns).toEqual([]);
    expect(fresh.thread.checkpoints).toEqual([]);
    expect(await readFile(path.join(thread.cwd, "file.txt"), "utf8")).toBe("original\n");
    await expect(readFile(path.join(thread.cwd, "new.txt"))).rejects.toThrow();
    expect(await readFile(path.join(folder, "file.txt"), "utf8")).toBe("original\n");
    expect(provider.requests.filter((request) => request.method === "thread/revert")).toHaveLength(1);
    expect(provider.requests.filter((request) => request.method === "thread/rollback")).toHaveLength(0);
  });
});
