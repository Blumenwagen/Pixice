import React, { useEffect, useState } from "react";
import { ConnectRoot } from "./connect/ConnectRoot.jsx";
import { App } from "./App.jsx";
import { WorkflowHost } from "./components/workflows/WorkflowHost.jsx";
import { TaskPreviewHost } from "./components/TaskPreviewHost.jsx";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary.jsx";
import { CAPABILITIES, CONNECT_ERROR_CODES, OPERATIONS, PROTOCOL_VERSION, READ_OPERATIONS } from "../electron/connect/protocol.mjs";
import { OBSERVER_OPERATIONS } from "../electron/connect/access-policy.mjs";
import "./styles.css";
import "./components/workflows/WorkflowHost.css";
import "./connect-preview.css";

const FIXTURE_HOSTS = Object.freeze({ local: "local", operator: "host-b", observer: "observer-c" });
const FIXTURE_PROJECTS = Object.freeze([
  { id: "project-a", name: "Loom desktop", displayName: "Loom desktop", canonicalPath: "/Users/blumenwagen/Developer/Loom" },
  { id: "project-b", name: "Beacon mobile", displayName: "Beacon mobile", canonicalPath: "/Users/blumenwagen/Developer/Beacon" },
  { id: "project-secret", name: "Private prototype", displayName: "Private prototype", canonicalPath: "/Users/blumenwagen/Developer/Private-prototype" }
]);

const NOW = "2026-09-12T08:00:00.000Z";
const FIXTURE_STORAGE_PREFIX = "__pixice.connect.preview.v2.";
const FIXTURE_HOST_STATE_PREFIX = "host-state.";
const POLL_WAIT_MS = 250;
const EVENT_RETENTION = 120;
const GENERATED_FILE_PATH = "generated-fixture.md";
const GENERATED_FILE_CONTENT = "# Generated Connect fixture\n\nThis file is synthetic preview evidence.\n";
const TRANSFER_LIMITS = Object.freeze({
  maxFileBytes: 26_214_400,
  maxFiles: 10,
  maxProjectBytes: 262_144_000,
  maxGlobalBytes: 1_073_741_824,
  chunkBytes: 1_048_576,
  ttlMs: 3_600_000,
  maxDownloadBytes: 104_857_600
});
const FRAME = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#171717"/><rect x="24" y="24" width="592" height="46" rx="9" fill="#2b2b2b"/><circle cx="49" cy="47" r="8" fill="#ff5364"/><text x="72" y="53" fill="#f0f0f0" font-family="sans-serif" font-size="18">Pixice remote browser fixture</text><rect x="24" y="91" width="190" height="236" rx="9" fill="#222"/><rect x="234" y="91" width="382" height="18" rx="5" fill="#45cc7b" opacity=".78"/><rect x="234" y="124" width="310" height="12" rx="4" fill="#858585"/><rect x="234" y="151" width="340" height="12" rx="4" fill="#858585" opacity=".65"/><rect x="234" y="194" width="150" height="72" rx="8" fill="#303030"/><rect x="403" y="194" width="171" height="72" rx="8" fill="#303030"/></svg>`)}`;
const TURN_MUTATION_OPERATIONS = new Set(["threads.create", "threads.fork", "threads.archive", "turns.start", "turns.steer", "turns.interrupt"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function copy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeHeaders(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get(name) { return values.get(String(name).toLowerCase()) ?? null; } };
}

function binaryBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value ?? ""));
}

async function requestBytes(value) {
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  return binaryBytes(value);
}

async function sha256Bytes(bytes) {
  if (!globalThis.crypto?.subtle) throw error("The fixture cannot verify a file hash.", CONNECT_ERROR_CODES.INTERNAL_ERROR, 500);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function response(body, status = 200, headers = {}) {
  const isBinary = body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  const bytes = isBinary ? binaryBytes(body) : null;
  const encoded = bytes ?? new TextEncoder().encode(JSON.stringify(body));
  const responseHeaders = { "Content-Type": isBinary ? "application/octet-stream" : "application/json", ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: makeHeaders(responseHeaders),
    url: "",
    redirected: false,
    async json() { return isBinary ? JSON.parse(new TextDecoder().decode(bytes)) : copy(body); },
    async text() { return new TextDecoder().decode(encoded); },
    async arrayBuffer() { return encoded.slice().buffer; },
    clone() { return response(body, status, responseHeaders); },
    body: bytes ? {
      getReader() {
        let read = false;
        return {
          async read() { if (read) return { done: true, value: undefined }; read = true; return { done: false, value: bytes.slice() }; },
          async cancel() { read = true; }
        };
      }
    } : null
  };
}

function error(message, code = CONNECT_ERROR_CODES.NOT_FOUND, status = 404) {
  return Object.assign(new Error(message), { code, status, uncertain: false });
}

function safePayload(payload = {}) {
  const result = {};
  for (const key of ["projectId", "threadId", "path", "workspaceId", "tabId", "width", "height", "quality", "reason", "requestId", "requestGeneration"]) {
    if (payload[key] !== undefined && (typeof payload[key] === "string" || typeof payload[key] === "number")) result[key] = payload[key];
  }
  return result;
}

function createHub() {
  const listeners = new Set();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); }
  };
}

function makeTurn(id, role, text, status = "completed") {
  const startedAt = status === "completed" ? NOW : new Date().toISOString();
  return {
    id,
    status,
    startedAt,
    ...(status === "completed" ? { completedAt: NOW } : {}),
    items: [role === "user"
      ? { id: `${id}-item`, type: "userMessage", content: [{ type: "text", text }] }
      : { id: `${id}-item`, type: "agentMessage", text }]
  };
}

function makeBrowserTab(id, url = "https://fixture.pixice.test/") {
  return { id, title: "Fixture page", url, favicon: null, loading: false, error: null, canGoBack: false, canGoForward: false, history: [url], historyIndex: 0 };
}

function makeThread(hostId, projectId, title, turns = [], extra = {}) {
  return {
    id: "thread-collision",
    projectId,
    name: title,
    preview: "A completed task retained for fixture inspection.",
    status: { type: "idle" },
    createdAt: NOW,
    updatedAt: NOW,
    turns,
    cwd: FIXTURE_PROJECTS.find((project) => project.id === projectId)?.canonicalPath,
    hostId,
    ...extra
  };
}

function projectFor(id) { return FIXTURE_PROJECTS.find((project) => project.id === id) || null; }

function taskFor(host, projectId) {
  const title = projectId === "project-b" ? "Review remote mobile handoff" : projectId === "project-secret" ? "Private release task" : "Stabilize Connect transport";
  return makeThread(host.id, projectId, title, [
    makeTurn(`${host.id}-turn-1`, "user", "Please check the current handoff."),
    makeTurn(`${host.id}-turn-2`, "assistant", "The handoff is ready for review.")
  ]);
}

function makeHost(id, role, projectIds) {
  const host = {
    id, role, projectIds: [...projectIds], deviceId: `fixture-device-${id}`, token: `${id}-fixture-token`,
    name: id === "host-b" ? "Beacon host" : id === "observer-c" ? "Observer tablet" : "This device",
    online: true, providerConnected: true, responseLoss: false, dropNextChunkResponse: false,
    browserFrameError: false, viewportWidth: 640, generation: 1, sequence: 1, instanceId: `${id}-backend-1`,
    events: [], waiters: new Set(), commands: new Map(), dynamicThreads: new Map(), nextThreadId: 1,
    attention: new Map(), attentionGenerations: new Map(), uploads: new Map(), nextUploadId: 1,
    currentThreadByProject: new Map(), browserSequence: 0,
    browser: { native: true, activeTabId: "fixture-tab", workspaceId: null, projectId: null, frameId: null, viewport: { workspaceId: null, visible: false, bounds: null }, viewportCalls: [], tabs: [makeBrowserTab("fixture-tab")] },
    eventHub: createHub()
  };
  host.events.push({
    type: "ConnectReset",
    payload: { attention: [], reason: "fixture startup" },
    instanceId: host.instanceId,
    sequence: host.sequence,
    protocol: PROTOCOL_VERSION
  });
  return host;
}

function hostStateKey(hostId) { return `${FIXTURE_HOST_STATE_PREFIX}${hostId}`; }

function persistHostState(host, storage) {
  if (!storage) return;
  const threads = [...host.dynamicThreads.values()]
    .filter((thread) => thread && typeof thread.id === "string" && typeof thread.projectId === "string" && allowedProject(host, thread.projectId))
    .map(copy);
  storage.setItem(hostStateKey(host.id), JSON.stringify({ nextThreadId: host.nextThreadId, threads }));
}

function restoreHostState(host, storage) {
  if (!storage) return;
  let snapshot;
  try { snapshot = JSON.parse(storage.getItem(hostStateKey(host.id)) || "null"); } catch { return; }
  if (!snapshot || !Array.isArray(snapshot.threads)) return;
  let highestThreadNumber = 0;
  for (const candidate of snapshot.threads.slice(0, 200)) {
    if (!candidate || typeof candidate.id !== "string" || !allowedProject(host, candidate.projectId)) continue;
    const thread = { ...candidate, hostId: host.id };
    host.dynamicThreads.set(threadKey(thread.projectId, thread.id), thread);
    host.currentThreadByProject.set(thread.projectId, thread.id);
    const threadNumber = Number(thread.id.split("-thread-").at(-1));
    if (Number.isInteger(threadNumber) && threadNumber > 0) highestThreadNumber = Math.max(highestThreadNumber, threadNumber);
  }
  const storedNext = Number(snapshot.nextThreadId);
  host.nextThreadId = Math.max(1, Number.isInteger(storedNext) ? storedNext : 1, highestThreadNumber + 1);
}

function projectIdsFor(host) { return [...host.projectIds]; }
function allowedProject(host, projectId) { return typeof projectId === "string" && projectIdsFor(host).includes(projectId); }
function requireProject(host, projectId) {
  if (typeof projectId !== "string" || !projectFor(projectId)) throw error("Project not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  if (!allowedProject(host, projectId)) throw error("That project is outside this host scope.", CONNECT_ERROR_CODES.FORBIDDEN, 403);
  return projectFor(projectId);
}

function threadKey(projectId, threadId) { return `${projectId}:${threadId}`; }

function getThread(host, projectId, threadId) {
  requireProject(host, projectId);
  if (typeof threadId !== "string" || !threadId) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  if (threadId === "thread-collision") return copy(host.dynamicThreads.get(threadKey(projectId, threadId)) || taskFor(host, projectId));
  const dynamic = host.dynamicThreads.get(threadKey(projectId, threadId));
  return dynamic ? copy(dynamic) : null;
}

function projectsFor(host) { return FIXTURE_PROJECTS.filter((project) => allowedProject(host, project.id)).map(copy); }

function threadsFor(host, projectId) {
  requireProject(host, projectId);
  const staticThread = getThread(host, projectId, "thread-collision");
  const dynamic = [...host.dynamicThreads.values()].filter((thread) => thread.projectId === projectId && thread.id !== "thread-collision");
  return [staticThread, ...dynamic].map((thread) => ({ id: thread.id, projectId: thread.projectId, name: thread.name, preview: thread.preview, status: copy(thread.status), updatedAt: thread.updatedAt }));
}

function threadOverviewStatus(thread) {
  if (thread.status?.type === "failed" || thread.status === "failed") return "failed";
  if (thread.status?.type === "active" || thread.status === "running" || thread.turns?.some((turn) => turn.status === "inProgress")) return "running";
  if (thread.status?.type === "waiting" || thread.status === "waiting") return "waiting";
  return "completed";
}

function runtimeFor(host) {
  const providerState = host.providerConnected ? "ready" : "disconnected";
  return { state: host.online ? "ready" : "offline", connected: host.online, readiness: { provider: { connected: host.providerConnected }, browser: { available: true, canStart: true } }, providers: { codex: { connected: host.providerConnected, state: providerState } } };
}

function makeReceipt(host, projectId, threadId = "thread-collision") {
  return { status: "completed", revision: 14, projectId, threadId, summary: "Checks passed on the host. The result is available as read-only evidence.", checks: [{ command: "pnpm test --filter connect", status: "passed", exitCode: 0 }], changes: { fileCount: 2, files: [{ path: "src/connect/observer-workspace.jsx", plus: 92, minus: 12 }, { path: "src/connect/mobile-connect.css", plus: 118, minus: 0 }] }, hostId: host.id };
}

function makeBoard(projectId) {
  return { data: [{ id: `${projectId}-task-1`, projectId, title: "Verify observer snapshot", description: "Read-only coverage for Board, files, and receipts.", phaseId: "phase-review", owner: "Mara", status: "active" }, { id: `${projectId}-task-2`, projectId, title: "Publish fixture notes", description: "Keep the preview scenario easy to reproduce.", phaseId: "phase-ready", owner: "Nico", status: "ready" }], phases: [{ id: "phase-review", name: "Review" }, { id: "phase-ready", name: "Ready" }] };
}

function makeReview(projectId) {
  return { projectId, repository: { branch: "fixture/connect-preview", clean: false }, files: [
    { path: "src/connect/observer-workspace.jsx", plus: 92, minus: 12, content: "export function ObserverWorkspace({ api, hostId }) {\n  // Fixture content is read-only in this view.\n}\n" },
    { path: "src/connect/mobile-connect.css", plus: 118, minus: 0, content: ".connect-observer-workspace {\n  display: grid;\n}\n" },
    { path: "docs/observer-fixture.md", plus: 34, minus: 0, content: "# Observer fixture\n\nThis file exists to make the project review list concrete.\n" },
    { path: GENERATED_FILE_PATH, plus: 4, minus: 0, content: GENERATED_FILE_CONTENT, kind: "markdown", name: GENERATED_FILE_PATH, external: false }
  ] };
}

function knownFile(host, projectId, filePath) {
  requireProject(host, projectId);
  const file = makeReview(projectId).files.find((candidate) => candidate.path === filePath);
  if (!file) throw error("File not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  return file;
}

function snapshotEvent(host, reason = "snapshot") {
  const existing = [...host.events].reverse().find((event) => event.type === "ConnectReset" && event.instanceId === host.instanceId);
  return existing || { type: "ConnectReset", payload: { attention: [...host.attention.values()].map(copy), reason }, instanceId: host.instanceId, sequence: host.sequence, protocol: PROTOCOL_VERSION };
}

function resolvePollWaiter(waiter, events) {
  if (waiter.settled) return;
  waiter.settled = true; waiter.host.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.signal?.removeEventListener?.("abort", waiter.onAbort); waiter.resolve(response({ events }));
}

function rejectPollWaiter(waiter, cause) {
  if (waiter.settled) return;
  waiter.settled = true; waiter.host.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.signal?.removeEventListener?.("abort", waiter.onAbort); waiter.reject(cause);
}

function emitHostEvent(state, host, type, payload = {}) {
  host.sequence += 1;
  const event = { type, payload: copy(payload), instanceId: host.instanceId, sequence: host.sequence, protocol: PROTOCOL_VERSION };
  host.events.push(event);
  if (host.events.length > EVENT_RETENTION) host.events.splice(0, host.events.length - EVENT_RETENTION);
  host.eventHub.emit(event);
  for (const waiter of [...host.waiters]) {
    const events = host.instanceId !== waiter.instanceId ? [snapshotEvent(host, "instance-changed")] : host.events.filter((candidate) => candidate.sequence > waiter.cursor).slice(0, 50);
    if (host.instanceId !== waiter.instanceId || (events.length && events[0].sequence <= waiter.cursor + 1)) resolvePollWaiter(waiter, events);
  }
  state.notify();
  return event;
}

function resetHost(state, host, reason = "fixture restart", { clearUploads = false, clearTaskState = false } = {}) {
  host.generation += 1; host.instanceId = `${host.id}-backend-${host.generation}`; host.sequence = 0; host.events = [];
  host.commands.clear(); host.attention.clear(); host.browserSequence = 0;
  host.browser.workspaceId = null; host.browser.projectId = null; host.browser.frameId = null; host.browser.activeTabId = "fixture-tab"; host.browser.tabs = [makeBrowserTab("fixture-tab")]; host.browser.viewport = { workspaceId: null, visible: false, bounds: null }; host.browser.viewportCalls = [];
  if (clearTaskState) {
    host.dynamicThreads.clear();
    host.currentThreadByProject.clear();
    host.attentionGenerations.clear();
  }
  if (clearUploads) host.uploads.clear();
  emitHostEvent(state, host, "ConnectReset", { attention: [], reason });
  if (!clearTaskState) persistHostState(host, state.localStorage);
}

function updateThread(host, projectId, threadId, prompt) {
  requireProject(host, projectId);
  const requested = threadId || "thread-collision";
  const current = getThread(host, projectId, requested);
  if (!current) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  const turn = makeTurn(`${host.id}-turn-${current.turns.length + 1}`, "user", prompt || "Fixture task submitted", "inProgress");
  current.turns = [...current.turns, turn]; current.status = { type: "active", activeFlags: [] }; current.updatedAt = NOW;
  host.dynamicThreads.set(threadKey(projectId, current.id), current);
  host.currentThreadByProject.set(projectId, current.id);
  return { thread: current, turn };
}

function createThread(host, projectId, title = "Untitled fixture task") {
  requireProject(host, projectId);
  const id = `${host.id}-${projectId}-thread-${host.nextThreadId++}`;
  const thread = makeThread(host.id, projectId, title, []); thread.id = id; thread.preview = "A new fixture task ready for a prompt.";
  host.dynamicThreads.set(threadKey(projectId, id), thread);
  host.currentThreadByProject.set(projectId, id);
  return thread;
}

function providerPayload(host) { return { codex: { connected: host.providerConnected, state: host.providerConnected ? "ready" : "disconnected" } }; }

function browserPayload(host) {
  return { native: host.browser.native, workspaceId: host.browser.workspaceId, activeTabId: host.browser.activeTabId, tabs: host.browser.tabs.map(({ history: _history, historyIndex: _historyIndex, ...tab }) => copy(tab)) };
}

function browserTab(host, tabId = host.browser.activeTabId) {
  const tab = host.browser.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw error("Browser tab not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  return tab;
}

function syncBrowserHistory(tab) {
  tab.url = tab.history[tab.historyIndex] ?? tab.url;
  tab.canGoBack = tab.historyIndex > 0;
  tab.canGoForward = tab.historyIndex < tab.history.length - 1;
  tab.title = "Fixture page";
  tab.loading = false;
  tab.error = null;
}

function browserSession(host, payload, { requireFrame = false, allowInactiveTab = false } = {}) {
  const workspaceId = payload?.workspaceId;
  const tabId = payload?.tabId;
  if (typeof workspaceId !== "string" || !workspaceId || (tabId !== undefined && !allowInactiveTab && tabId !== host.browser.activeTabId)) throw error("The browser session is no longer current.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  if (tabId !== undefined) browserTab(host, tabId);
  if (requireFrame && (workspaceId !== host.browser.workspaceId || tabId !== host.browser.activeTabId || payload.frameId !== host.browser.frameId)) throw error("The browser frame is stale. Refresh the preview.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  if (!host.browser.workspaceId) host.browser.workspaceId = workspaceId;
  if (payload.projectId) host.browser.projectId = payload.projectId;
  return { workspaceId, tabId: tabId ?? host.browser.activeTabId };
}

function validateBrowserInput(host, payload) {
  browserSession(host, payload, { requireFrame: true });
  const input = payload?.input;
  if (!input || typeof input !== "object" || typeof input.type !== "string") throw error("Browser input is invalid.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  if (["click", "scroll"].includes(input.type)) {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x >= host.browser.frameWidth || input.y >= host.browser.frameHeight) throw error("The browser input is outside the current frame.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  }
  if (input.type === "text" && (typeof input.text !== "string" || input.text.length > 10_000)) throw error("Browser text input is invalid.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  host.browser.lastInput = safePayload(payload);
}

function requestPayload(host, kind) {
  const id = `fixture-${kind}-request`; const generation = (host.attentionGenerations.get(id) || 0) + 1; host.attentionGenerations.set(id, generation);
  return { id, requestId: id, method: kind === "approval" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput", requestGeneration: generation, projectId: host.projectIds[0], threadId: "thread-collision", params: kind === "question" ? { threadId: "thread-collision", questions: [{ id: "fixture-question", question: "Which fixture path should the task use?", options: [{ label: "Safe path" }, { label: "Fast path" }] }] } : { threadId: "thread-collision", command: "pnpm test" } };
}

function validateAttention(host, payload) {
  const requestId = String(payload?.requestId ?? ""); const current = host.attention.get(requestId);
  if (!current || Number(payload?.requestGeneration) !== Number(current.requestGeneration)) throw error("This request is no longer current. Refresh the task.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
  return current;
}

function transferId(host) { return `00000000-0000-4000-8000-${(host.nextUploadId++).toString(16).padStart(12, "0")}`; }
function transferRecord(host, id, projectId) { const record = host.uploads.get(id); if (!record || record.projectId !== projectId) throw error("Upload not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); return record; }
function parseJsonBody(init) { try { return JSON.parse(init.body || "{}"); } catch { throw error("Invalid JSON.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400); } }
function authHeader(init) { return init.headers?.get?.("Authorization") || init.headers?.Authorization || init.headers?.authorization; }
function headerValue(init, name) {
  const headers = init?.headers;
  if (headers?.get) return headers.get(name);
  if (!headers || typeof headers !== "object") return undefined;
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function makeServiceWorker(windowRef) {
  const listeners = new Set();
  return { scriptURL: new URL("/connect-sw.js", windowRef.location.href).href, addEventListener(type, listener) { if (type === "message") listeners.add(listener); }, removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); }, emitMessage(data) { const event = new MessageEvent("message", { data, origin: windowRef.location.origin }); Object.defineProperty(event, "source", { configurable: true, value: { scriptURL: this.scriptURL } }); for (const listener of [...listeners]) listener(event); return event; } };
}

function fixtureStorage(windowRef, original, kind) {
  const prefix = `${FIXTURE_STORAGE_PREFIX}${kind}.`; const fallback = new Map();
  const readOriginal = (key) => { try { return original?.getItem?.(key) ?? null; } catch { return fallback.get(key) ?? null; } };
  const writeOriginal = (key, value) => { try { original?.setItem?.(key, value); } catch { fallback.set(key, String(value)); } };
  const removeOriginal = (key) => { try { original?.removeItem?.(key); } catch { fallback.delete(key); } };
  const fixtureKeys = () => {
    const keys = new Set();
    try {
      for (let index = 0; index < (original?.length ?? 0); index += 1) {
        const key = original.key(index);
        if (key?.startsWith(prefix)) keys.add(key.slice(prefix.length));
      }
    } catch {
      for (const key of fallback.keys()) if (key.startsWith(prefix)) keys.add(key.slice(prefix.length));
    }
    return [...keys];
  };
  const storage = { get length() { return fixtureKeys().length; }, key(index) { return fixtureKeys()[index] ?? null; }, getItem(key) { return readOriginal(`${prefix}${String(key)}`); }, setItem(key, value) { writeOriginal(`${prefix}${String(key)}`, String(value)); }, removeItem(key) { removeOriginal(`${prefix}${String(key)}`); }, clear() { for (const key of fixtureKeys()) removeOriginal(`${prefix}${key}`); }, clearFixture() { this.clear(); }, prefix };
  void windowRef;
  return storage;
}

function makeApi(state, host) {
  const api = {};
  for (const [group, entries] of Object.entries(CAPABILITIES)) api[group] = Object.fromEntries(Object.entries(entries).map(([name]) => [name, (payload) => perform(state, host, `${group}.${name}`, payload)]));
  if (host.id === "local") {
    api.browser.setViewport = async (payload = {}) => {
      host.browser.viewport = {
        workspaceId: payload.workspaceId ?? host.browser.viewport.workspaceId,
        visible: Boolean(payload.visible),
        bounds: payload.bounds ? copy(payload.bounds) : host.browser.viewport.bounds
      };
      host.browser.viewportCalls.push(copy(host.browser.viewport));
      host.browser.viewportCalls.splice(0, Math.max(0, host.browser.viewportCalls.length - 200));
      return browserPayload(host);
    };
  }
  api.app.bootstrap = (payload) => perform(state, host, "app.bootstrap", payload);
  api.app.saveSettings = async (patch = {}) => ({ ...patch });
  api.events = { subscribe: host.eventHub.subscribe };
  api.service = { connection: async () => ({ state: host.online ? "connected" : "offline", connected: host.online }), start: async () => { host.online = true; const next = { state: "connected", connected: true }; emitHostEvent(state, host, "ServiceConnectionState", next); return next; } };
  api.connect = { status: async () => ({ hostId: host.id, instanceId: host.instanceId }) };
  api.remote = host.id === "local" ? undefined : { hostId: host.id, name: host.name, endpoint: `https://${host.id === "host-b" ? "host-b" : "observer-c"}.example`, token: host.token, deviceId: host.deviceId, role: host.role, projectIds: host.role === "observer" ? [...host.projectIds] : null, capabilities: { role: host.role, projectIds: host.role === "observer" ? [...host.projectIds] : null, transfers: { uploads: host.role !== "observer", downloads: true, limits: TRANSFER_LIMITS } } };
  api.extensions = { list: async () => ({ skills: [], apps: [], mcp: [], errors: [] }) };
  api.github = { status: async () => ({ available: false, authenticated: false, message: "Fixture GitHub is unavailable." }), login: async () => { throw error("GitHub sign-in is unavailable in the fixture.", CONNECT_ERROR_CODES.METHOD_NOT_ALLOWED, 405); }, logout: async () => ({ available: false, authenticated: false }) };
  api.updates = { status: async () => ({ supported: false, state: "development", message: "Updates are unavailable in the preview fixture." }) };
  api.external = { openEditor: async () => ({ ok: true }), openTerminal: async () => ({ ok: true }), reveal: async () => ({ ok: true }) };
  api.preview = { setContext: async () => ({ ok: true }) };
  api.workflowCredentials = { list: async () => [], create: async () => ({ ok: true }), update: async () => ({ ok: true }), delete: async () => ({ ok: true }) };
  api.ios = { environment: async () => ({ available: false, supported: false, message: "Simulator unavailable in the preview fixture." }), discover: async () => [], createStarter: async () => { throw error("Simulator unavailable.", CONNECT_ERROR_CODES.METHOD_NOT_ALLOWED, 405); }, start: async () => { throw error("Simulator unavailable.", CONNECT_ERROR_CODES.METHOD_NOT_ALLOWED, 405); }, state: async () => null, stop: async () => null, action: async () => null, adopt: async () => null };
  return api;
}

async function perform(state, host, operation, payload = {}) {
  const projectId = payload?.projectId;
  if (host.role === "observer" && !OBSERVER_OPERATIONS.has(operation)) throw error("Observer access is read-only.", CONNECT_ERROR_CODES.FORBIDDEN, 403);
  const turnMutation = TURN_MUTATION_OPERATIONS.has(operation);
  state.calls.push({ at: new Date().toISOString(), hostId: host.id, projectId: typeof projectId === "string" ? projectId : null, operation, payload: safePayload(payload), mutation: !READ_OPERATIONS.has(operation), turnMutation });
  state.calls.splice(0, Math.max(0, state.calls.length - 200));
  if (turnMutation) state.mutationCount += 1;
  state.notify();
  if (operation === "app.bootstrap") return { projects: projectsFor(host), models: [{ id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT 5.6 Luna", provider: "codex", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }], runtime: runtimeFor(host), settings: { accentColor: "rose", defaultModel: "gpt-5.6-luna", defaultEffort: "high", defaultPermissionMode: "workspace-write" }, ...(host.role === "operator" ? { providers: [{ id: "codex", name: "Codex", connected: host.providerConnected, status: { state: host.providerConnected ? "ready" : "disconnected" } }] } : {}) };
  if (operation === "app.overview") return { projects: projectsFor(host), tasks: projectsFor(host).flatMap((project) => threadsFor(host, project.id).map((thread) => ({ projectId: project.id, threadId: thread.id, title: thread.name, status: threadOverviewStatus(getThread(host, project.id, thread.id)), updatedAt: NOW }))), checkedAt: new Date().toISOString() };
  if (operation === "runtime.status") return runtimeFor(host);
  if (operation === "projects.list") return projectsFor(host);
  if (operation === "projects.touch") return copy(requireProject(host, projectId));
  if (operation === "projects.directories") return { path: payload.path || "/Users/blumenwagen/Developer", parent: "/Users/blumenwagen", directories: [{ name: "Loom", path: "/Users/blumenwagen/Developer/Loom" }, { name: "Beacon", path: "/Users/blumenwagen/Developer/Beacon" }] };
  if (operation === "models.list") return (await perform(state, host, "app.bootstrap")).models;
  if (operation === "providers.list") return [{ id: "codex", name: "Codex", connected: host.providerConnected, status: { state: host.providerConnected ? "ready" : "disconnected" } }];
  if (operation === "threads.list") return { data: threadsFor(host, projectId), phases: [] };
  if (operation === "threads.read") { const thread = getThread(host, projectId, payload.threadId); if (!thread) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); return { thread, plan: [{ step: "Inspect host result", status: "completed" }, { step: "Review changed files", status: "completed" }] }; }
  if (operation === "threads.children") { if (!getThread(host, projectId, payload.threadId)) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); return { data: [] }; }
  if (operation === "threads.create") { const thread = createThread(host, projectId); persistHostState(host, state.localStorage); emitHostEvent(state, host, "TaskUpdated", { projectId, threadId: thread.id, method: "thread/started", thread: { id: thread.id, status: thread.status } }); return { thread: copy(thread) }; }
  if (operation === "threads.fork") { const source = getThread(host, projectId, payload.threadId); if (!source) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); const forked = createThread(host, projectId, `${source.name} (fork)`); forked.forkedFromId = source.id; forked.turns = source.turns.slice(0, source.turns.findIndex((turn) => turn.id === payload.lastTurnId) + 1); host.dynamicThreads.set(`${projectId}:${forked.id}`, forked); persistHostState(host, state.localStorage); return { thread: copy(forked) }; }
  if (operation === "threads.archive") { if (!getThread(host, projectId, payload.threadId)) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); host.dynamicThreads.delete(`${projectId}:${payload.threadId}`); if (host.currentThreadByProject.get(projectId) === payload.threadId) host.currentThreadByProject.delete(projectId); persistHostState(host, state.localStorage); emitHostEvent(state, host, "TaskUpdated", { projectId, threadId: payload.threadId, method: "thread/archived" }); return { ok: true, threadId: payload.threadId }; }
  if (operation === "tasks.receipts") return projectsFor(host).filter((project) => !projectId || project.id === projectId).map((project) => makeReceipt(host, project.id));
  if (operation === "tasks.receipt") { requireProject(host, projectId); const thread = payload.threadId ? getThread(host, projectId, payload.threadId) : taskFor(host, projectId); if (!thread) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); return makeReceipt(host, projectId, thread.id); }
  if (operation === "tasks.interventions") return { requests: [...host.attention.values()].map(copy) };
  if (["board.list", "board.read", "board.activity"].includes(operation)) { requireProject(host, projectId || host.projectIds[0]); return makeBoard(projectId || host.projectIds[0]); }
  if (operation === "review.read") { requireProject(host, projectId || host.projectIds[0]); return makeReview(projectId || host.projectIds[0]); }
  if (operation === "review.file") { const file = knownFile(host, projectId, payload.path); return { path: file.path, content: file.content, plus: file.plus ?? 0, minus: file.minus ?? 0 }; }
  if (["files.read", "files.preview"].includes(operation)) { const file = knownFile(host, projectId, payload.path); return { path: file.path, name: file.name || file.path.split("/").at(-1), kind: file.kind || "text", content: file.content, external: false, editable: false }; }
  if (operation === "files.write") { const file = knownFile(host, projectId, payload.path); return { ...file, content: String(payload.content ?? ""), mtimeMs: Date.now(), editable: true }; }
  if (operation === "git.status") { requireProject(host, projectId || host.projectIds[0]); return { branch: "fixture/connect-preview", clean: false, changed: makeReview(projectId || host.projectIds[0]).files.map((file) => file.path), installSupported: false }; }
  if (operation === "usage.summary") return { totals: { inputTokens: 2380, outputTokens: 512 }, rangeDays: 7 };
  if (operation === "usage.limits") return { available: true, message: "Fixture usage limits" };
  if (operation === "proactivity.list") return { data: [] };
  if (operation === "proactivity.resolve") { requireProject(host, projectId); return { ok: true }; }
  if (operation === "browser.state") {
    browserSession(host, payload);
    return browserPayload(host);
  }
  if (operation === "browser.frame") {
    const session = browserSession(host, payload);
    browserTab(host, session.tabId);
    const frameId = globalThis.crypto.randomUUID();
    host.browser.workspaceId = session.workspaceId;
    host.browser.frameId = frameId;
    host.browser.frameWidth = host.viewportWidth;
    host.browser.frameHeight = 360;
    return host.browserFrameError
      ? { frameId, width: host.viewportWidth, height: 360, image: "data:image/png;base64,fixture-invalid-frame" }
      : { frameId, width: host.viewportWidth, height: 360, image: FRAME, supportedOptions: ["quality"] };
  }
  if (["browser.create", "browser.close", "browser.activate", "browser.navigate", "browser.history", "browser.input", "browser.adopt", "browser.destroy"].includes(operation)) {
    if (operation === "browser.input") validateBrowserInput(host, payload);
    else if (operation === "browser.adopt") {
      if (typeof payload.fromWorkspaceId !== "string" || typeof payload.toWorkspaceId !== "string" || !payload.fromWorkspaceId || !payload.toWorkspaceId) throw error("The browser workspace is invalid.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
      host.browser.workspaceId = payload.toWorkspaceId;
      host.browser.frameId = null;
    } else if (operation === "browser.destroy") {
      browserSession(host, payload);
      host.browser.workspaceId = null;
      host.browser.projectId = null;
      host.browser.frameId = null;
      host.browser.activeTabId = null;
      host.browser.tabs = [];
      emitHostEvent(state, host, "BrowserState", { ...browserPayload(host), workspaceId: payload.workspaceId });
      return { destroyed: true, workspaceId: payload.workspaceId };
    } else if (operation === "browser.create") {
      const session = browserSession(host, payload);
      const url = typeof payload.url === "string" && payload.url.trim() ? payload.url.trim() : "https://fixture.pixice.test/";
      const tab = makeBrowserTab(globalThis.crypto.randomUUID(), url);
      host.browser.tabs = [...host.browser.tabs, tab];
      host.browser.activeTabId = tab.id;
      host.browser.workspaceId = session.workspaceId;
      host.browser.frameId = null;
    } else if (operation === "browser.close") {
      browserSession(host, payload, { allowInactiveTab: true });
      const tabId = payload.tabId ?? host.browser.activeTabId;
      browserTab(host, tabId);
      const wasActive = tabId === host.browser.activeTabId;
      host.browser.tabs = host.browser.tabs.filter((tab) => tab.id !== tabId);
      if (wasActive) host.browser.activeTabId = host.browser.tabs.at(-1)?.id ?? null;
      if (wasActive || host.browser.activeTabId === null) host.browser.frameId = null;
    } else if (operation === "browser.activate") {
      browserSession(host, payload, { allowInactiveTab: true });
      browserTab(host, payload.tabId);
      if (host.browser.activeTabId !== payload.tabId) host.browser.frameId = null;
      host.browser.activeTabId = payload.tabId;
    } else if (operation === "browser.navigate") {
      browserSession(host, payload, { allowInactiveTab: true });
      const tab = browserTab(host, payload.tabId);
      if (typeof payload.url !== "string" || !payload.url.trim()) throw error("A browser URL is required.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(payload.url.trim());
      tab.historyIndex += 1;
      syncBrowserHistory(tab);
      if (tab.id === host.browser.activeTabId) host.browser.frameId = null;
    } else if (operation === "browser.history") {
      browserSession(host, payload);
      const tab = browserTab(host);
      if (!["back", "forward", "reload", "stop"].includes(payload.action)) throw error("Unsupported browser history action.", CONNECT_ERROR_CODES.INVALID_REQUEST, 400);
      if (payload.action === "back" && tab.historyIndex > 0) tab.historyIndex -= 1;
      if (payload.action === "forward" && tab.historyIndex < tab.history.length - 1) tab.historyIndex += 1;
      syncBrowserHistory(tab);
      if (["back", "forward", "reload"].includes(payload.action)) host.browser.frameId = null;
    }
    if (operation === "browser.input") return { ok: true };
    if (operation === "browser.adopt") return { ok: true };
    emitHostEvent(state, host, "BrowserState", { ...browserPayload(host), workspaceId: host.browser.workspaceId || payload.workspaceId || "fixture-thread" });
    return browserPayload(host);
  }
  if (operation === "turns.start" || operation === "turns.steer") { const target = updateThread(host, projectId, payload.threadId, payload.text); persistHostState(host, state.localStorage); const eventPayload = { projectId, threadId: target.thread.id, method: "turn/started", thread: { id: target.thread.id, status: target.thread.status }, turn: target.turn }; emitHostEvent(state, host, "TaskUpdated", eventPayload); emitHostEvent(state, host, "ActivityReceived", eventPayload); emitHostEvent(state, host, "FilePreviewOpenRequested", { workspaceId: target.thread.id, threadId: target.thread.id, projectId, source: "fixture", file: { path: GENERATED_FILE_PATH, name: GENERATED_FILE_PATH, kind: "markdown", content: GENERATED_FILE_CONTENT, external: false, editable: false } }); return { turn: copy(target.turn) }; }
  if (operation === "turns.interrupt") { const target = getThread(host, projectId, payload.threadId); if (!target) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404); const current = host.dynamicThreads.get(`${projectId}:${target.id}`) || target; current.status = { type: "interrupted" }; const active = current.turns.at(-1); if (active) active.status = "interrupted"; host.dynamicThreads.set(`${projectId}:${current.id}`, current); host.currentThreadByProject.set(projectId, current.id); persistHostState(host, state.localStorage); emitHostEvent(state, host, "TaskUpdated", { projectId, threadId: current.id, method: "thread/status/changed", status: current.status }); return { ok: true }; }
  if (["approvals.resolve", "requests.respond", "questions.respond", "elicitations.respond"].includes(operation)) { const current = validateAttention(host, payload); host.attention.delete(current.id); emitHostEvent(state, host, "AttentionResolved", { requestId: current.id, projectId: current.projectId, threadId: current.threadId }); return { ok: true, requestId: current.id }; }
  if (operation === "workflows.list") return { data: [] };
  if (operation === "workflows.read") throw error("Workflow not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
  if (operation.startsWith("instruments.")) { if (["instruments.list", "instruments.tools"].includes(operation)) return { data: [] }; throw error("Instrument action is unavailable in the fixture.", CONNECT_ERROR_CODES.METHOD_NOT_ALLOWED, 405); }
  throw error(`Fixture operation is not implemented: ${operation}`, CONNECT_ERROR_CODES.NOT_FOUND, 404);
}

function authHost(state, url) { if (url.hostname === "host-b.example") return state.hosts[FIXTURE_HOSTS.operator]; if (url.hostname === "observer-c.example") return state.hosts[FIXTURE_HOSTS.observer]; return state.hosts.local; }

function installFixture(windowRef = window) {
  if (windowRef.__pixiceConnectFixture?.restore && !windowRef.__pixiceConnectFixture.restored) return windowRef.__pixiceConnectFixture;
  const previous = { pixice: Object.getOwnPropertyDescriptor(windowRef, "pixice"), fetch: Object.getOwnPropertyDescriptor(windowRef, "fetch"), localStorage: Object.getOwnPropertyDescriptor(windowRef, "localStorage"), sessionStorage: Object.getOwnPropertyDescriptor(windowRef, "sessionStorage"), serviceWorker: Object.getOwnPropertyDescriptor(windowRef.navigator, "serviceWorker"), fixture: Object.getOwnPropertyDescriptor(windowRef, "__pixiceConnectFixture") };
  const localStorage = fixtureStorage(windowRef, windowRef.localStorage, "local"); const sessionStorage = fixtureStorage(windowRef, windowRef.sessionStorage, "session");
  const state = { restored: false, mountRevision: 0, calls: [], pollRequests: 0, mutationCount: 0, listeners: new Set(), mountListeners: new Set(), hosts: { local: makeHost("local", "operator", ["project-a"]), "host-b": makeHost("host-b", "operator", ["project-b", "project-a"]), "observer-c": makeHost("observer-c", "observer", ["project-b"]) }, localApi: null, localStorage, sessionStorage, serviceWorker: null, notify() { for (const listener of [...state.listeners]) listener(); }, subscribe(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); }, subscribeMount(listener) { state.mountListeners.add(listener); return () => state.mountListeners.delete(listener); } };
  state.serviceWorker = makeServiceWorker(windowRef); state.localApi = makeApi(state, state.hosts.local); state.hostApis = Object.fromEntries(Object.entries(state.hosts).map(([id, host]) => [id, makeApi(state, host)]));
  const seedStorage = () => { if (localStorage.getItem("fixture-seeded") !== "1") { localStorage.setItem("pixice.connect.instances", JSON.stringify([{ id: "host-b", endpoint: "https://host-b.example", token: state.hosts["host-b"].token, name: "Beacon host", role: "operator", projectIds: null, deviceId: state.hosts["host-b"].deviceId }, { id: "observer-c", endpoint: "https://observer-c.example", token: state.hosts["observer-c"].token, name: "Observer tablet", role: "observer", projectIds: ["project-b"], deviceId: state.hosts["observer-c"].deviceId }])); localStorage.setItem("fixture-seeded", "1"); } if (!sessionStorage.getItem("pixice.connect.active")) sessionStorage.setItem("pixice.connect.active", "__pixice_local__"); };
  seedStorage();
  for (const host of Object.values(state.hosts)) restoreHostState(host, localStorage);
  Object.defineProperty(windowRef, "localStorage", { configurable: true, value: localStorage }); Object.defineProperty(windowRef, "sessionStorage", { configurable: true, value: sessionStorage }); Object.defineProperty(windowRef, "pixice", { configurable: true, writable: true, value: state.localApi }); Object.defineProperty(windowRef.navigator, "serviceWorker", { configurable: true, value: state.serviceWorker }); windowRef.__pixiceConnectFixture = state;
  const originalFetch = windowRef.fetch?.bind(windowRef);
  windowRef.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; const url = new URL(requestUrl, windowRef.location.href); if (!url.pathname.startsWith("/api/connect/")) return originalFetch ? originalFetch(input, init) : response({ error: "Fetch unavailable" }, 503);
    const host = authHost(state, url); if (!host.online) throw new TypeError("Fixture host is offline."); if (url.pathname !== "/api/connect/info" && authHeader(init) !== `Bearer ${host.token}`) return response({ error: "Authentication required", code: CONNECT_ERROR_CODES.AUTH_REQUIRED }, 401);
    if (url.pathname === "/api/connect/info") return response({ protocol: PROTOCOL_VERSION, hostId: host.id, instanceId: host.instanceId });
    if (url.pathname === "/api/connect/session") return response({ protocol: PROTOCOL_VERSION, hostId: host.id, instanceId: host.instanceId, role: host.role, projectIds: host.role === "observer" ? [...host.projectIds] : null, operations: [...(host.role === "observer" ? OBSERVER_OPERATIONS : OPERATIONS.keys())], readiness: runtimeFor(host).readiness, expiresAt: "2026-10-12T08:00:00.000Z", transfers: { uploads: host.role !== "observer", downloads: true, limits: TRANSFER_LIMITS } });
    if (url.pathname === "/api/connect/poll") {
      state.pollRequests += 1;
      const cursor = Number(url.searchParams.get("cursor") || 0); const instanceId = url.searchParams.get("instanceId") || "";
      if (instanceId !== host.instanceId) return response({ events: [snapshotEvent(host, "instance-changed")] });
      if (cursor === 0) return response({ events: [snapshotEvent(host, "snapshot")] });
      const firstSequence = host.events[0]?.sequence; if (firstSequence !== undefined && cursor < firstSequence - 1) return response({ events: [snapshotEvent(host, "event-gap")] });
      const ready = host.events.filter((event) => event.sequence > cursor).slice(0, 50); if (ready.length || url.searchParams.get("wait") === "0") return response({ events: ready });
      return new Promise((resolve, reject) => { const waiter = { host, cursor, instanceId, resolve, reject, settled: false, timer: null, signal: init.signal, onAbort: null }; waiter.onAbort = () => rejectPollWaiter(waiter, new DOMException("Aborted", "AbortError")); host.waiters.add(waiter); waiter.timer = setTimeout(() => resolvePollWaiter(waiter, []), POLL_WAIT_MS); if (init.signal?.aborted) waiter.onAbort(); else init.signal?.addEventListener?.("abort", waiter.onAbort, { once: true }); });
    }
    if (url.pathname.startsWith("/api/connect/uploads")) {
      if (host.role === "observer") return response({ error: "File uploads are not available to observers.", code: CONNECT_ERROR_CODES.FORBIDDEN }, 403);
      const statusMatch = /^\/api\/connect\/uploads\/([^/]+)$/.exec(url.pathname); const chunkMatch = /^\/api\/connect\/uploads\/([^/]+)\/chunk$/.exec(url.pathname); const completeMatch = /^\/api\/connect\/uploads\/([^/]+)\/complete$/.exec(url.pathname); const cancelMatch = /^\/api\/connect\/uploads\/([^/]+)\/cancel$/.exec(url.pathname); const project = url.searchParams.get("projectId");
      if (url.pathname === "/api/connect/uploads" && init.method === "POST") {
        const body = parseJsonBody(init);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["projectId", "name", "mimeType", "size", "sha256"].includes(key))) return response({ error: "Invalid upload metadata", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        requireProject(host, body.projectId);
        const active = [...host.uploads.values()].filter((record) => record.projectId === body.projectId);
        const projectBytes = active.reduce((total, record) => total + record.size, 0);
        const globalBytes = [...host.uploads.values()].reduce((total, record) => total + record.size, 0);
        if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 180 || body.name.includes("/") || body.name.includes("\\") || /[\u0000-\u001f\u007f]/.test(body.name)) return response({ error: "Invalid file name", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        if (typeof body.mimeType !== "string" || !MIME_PATTERN.test(body.mimeType)) return response({ error: "Invalid MIME type", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        if (!Number.isInteger(body.size) || body.size < 0 || body.size > TRANSFER_LIMITS.maxFileBytes) return response({ error: "File is too large", code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE }, 413);
        if (active.length >= TRANSFER_LIMITS.maxFiles) return response({ error: "The transfer file limit has been reached.", code: CONNECT_ERROR_CODES.RATE_LIMITED }, 429);
        if (projectBytes + body.size > TRANSFER_LIMITS.maxProjectBytes || globalBytes + body.size > TRANSFER_LIMITS.maxGlobalBytes) return response({ error: "The transfer storage quota has been reached.", code: CONNECT_ERROR_CODES.RATE_LIMITED }, 429);
        if (typeof body.sha256 !== "string" || !HASH_PATTERN.test(body.sha256)) return response({ error: "SHA-256 is invalid", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        const id = transferId(host);
        host.uploads.set(id, { id, projectId: body.projectId, name: body.name, mimeType: body.mimeType.toLowerCase(), size: body.size, sha256: body.sha256.toLowerCase(), offset: 0, state: "uploading", bytes: new Uint8Array(body.size), lastChunk: null });
        return response({ id, offset: 0, size: body.size, state: "uploading", chunkBytes: TRANSFER_LIMITS.chunkBytes });
      }
      if (statusMatch && init.method !== "POST") { const record = transferRecord(host, statusMatch[1], project); return response({ id: record.id, offset: record.offset, size: record.size, state: record.state, name: record.name, mimeType: record.mimeType }); }
      if (chunkMatch && init.method === "POST") {
        const record = transferRecord(host, chunkMatch[1], project);
        const offset = Number(url.searchParams.get("offset"));
        const bytes = await requestBytes(init.body);
        const expectedHash = String(headerValue(init, "X-Pixice-Chunk-Sha256") ?? "").toLowerCase();
        const declaredLength = headerValue(init, "Content-Length");
        if (!HASH_PATTERN.test(expectedHash)) return response({ error: "X-Pixice-Chunk-Sha256 is required.", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        if (declaredLength !== undefined && (!Number.isInteger(Number(declaredLength)) || Number(declaredLength) < 0 || Number(declaredLength) > TRANSFER_LIMITS.chunkBytes)) return response({ error: "Invalid chunk length", code: CONNECT_ERROR_CODES.REQUEST_TOO_LARGE }, 413);
        if (!Number.isInteger(offset) || offset < 0 || offset > record.size || bytes.length > TRANSFER_LIMITS.chunkBytes) return response({ error: "Invalid upload offset", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        const actualHash = await sha256Bytes(bytes);
        if (actualHash !== expectedHash) return response({ error: "The chunk hash does not match.", code: CONNECT_ERROR_CODES.CONFLICT }, 409);
        if (offset < record.offset) {
          const replay = record.bytes.slice(offset, Math.min(record.offset, offset + bytes.length));
          if (replay.length !== bytes.length || replay.some((value, index) => value !== bytes[index])) return response({ error: "Upload replay differs", code: CONNECT_ERROR_CODES.CONFLICT }, 409);
          return response({ id: record.id, offset: record.offset, size: record.size, state: record.state });
        }
        if (offset !== record.offset || offset + bytes.length > record.size) return response({ error: "Upload offset conflict", code: CONNECT_ERROR_CODES.CONFLICT }, 409);
        record.bytes.set(bytes, offset); record.offset += bytes.length; record.lastChunk = { offset, length: bytes.length, sha256: actualHash };
        if (host.dropNextChunkResponse) { host.dropNextChunkResponse = false; throw new TypeError("Fixture dropped the chunk response after accepting it."); }
        return response({ id: record.id, offset: record.offset, size: record.size, state: record.state });
      }
      if (completeMatch && init.method === "POST") {
        const body = parseJsonBody(init);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.projectId !== "string") return response({ error: "Invalid upload completion", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
        const record = transferRecord(host, completeMatch[1], body.projectId);
        if (record.offset !== record.size) return response({ error: "Upload is incomplete", code: CONNECT_ERROR_CODES.CONFLICT }, 409);
        if (await sha256Bytes(record.bytes) !== record.sha256) { host.uploads.delete(record.id); return response({ error: "The completed file hash does not match.", code: CONNECT_ERROR_CODES.CONFLICT }, 409); }
        record.state = "ready";
        return response({ id: record.id, offset: record.offset, size: record.size, state: "ready" });
      }
      if (cancelMatch && init.method === "POST") { const body = parseJsonBody(init); const record = transferRecord(host, cancelMatch[1], body.projectId); host.uploads.delete(record.id); return response({ id: record.id, state: "cancelled", offset: record.offset, size: record.size }); }
      return response({ error: "Upload route not found", code: CONNECT_ERROR_CODES.NOT_FOUND }, 404);
    }
    if (url.pathname === "/api/connect/download" && init.method !== "POST") { const projectId = url.searchParams.get("projectId"); requireProject(host, projectId); const filePath = url.searchParams.get("path"); const file = knownFile(host, projectId, filePath); const bytes = new TextEncoder().encode(file.content || ""); return response(bytes, 200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength, "Content-Disposition": `attachment; filename="${filePath.split("/").at(-1)}"`, "Cache-Control": "no-store" }); }
    if (url.pathname.startsWith("/api/connect/commands/")) { const id = decodeURIComponent(url.pathname.split("/").at(-1)); const record = host.commands.get(id); return response(record || { id, status: "unknown", outcome: "unknown", meaning: "The command outcome is unknown. This does not mean it was never sent.", instanceId: url.searchParams.get("instanceId") || null, currentInstanceId: host.instanceId, result: null }); }
    if (url.pathname === "/api/connect/call" && init.method === "POST") {
      const body = parseJsonBody(init); if (!body.operation || !body.id) return response({ error: "Invalid command descriptor", code: CONNECT_ERROR_CODES.INVALID_REQUEST }, 400);
      try { const result = await perform(state, host, body.operation, body.payload, body); if (!READ_OPERATIONS.has(body.operation)) { host.commands.set(body.id, { id: body.id, operation: body.operation, issuedAt: body.issuedAt, instanceId: host.instanceId, status: "completed", outcome: "completed", result }); if (host.responseLoss && ["threads.create", "threads.fork", "turns.start", "turns.steer"].includes(body.operation)) throw Object.assign(new TypeError("Fixture dropped the command response after accepting it."), { uncertain: true, code: CONNECT_ERROR_CODES.NETWORK_ERROR }); } return response({ result }); }
      catch (cause) { if (!READ_OPERATIONS.has(body.operation) && body.id && !host.commands.has(body.id)) host.commands.set(body.id, { id: body.id, operation: body.operation, issuedAt: body.issuedAt, instanceId: host.instanceId, status: cause.uncertain ? "completed" : "failed", outcome: cause.uncertain ? "completed" : "failed", result: cause.uncertain ? null : undefined, error: cause.uncertain ? undefined : cause.message, code: cause.uncertain ? undefined : cause.code }); if (cause.uncertain) throw cause; return response({ error: cause.message, code: cause.code || CONNECT_ERROR_CODES.INTERNAL_ERROR }, cause.status || 500); }
    }
    return response({ error: "Not found", code: CONNECT_ERROR_CODES.NOT_FOUND }, 404);
  };
  state.reset = () => { localStorage.clearFixture(); sessionStorage.clearFixture(); state.calls.length = 0; state.pollRequests = 0; state.mutationCount = 0; for (const host of Object.values(state.hosts)) { host.online = true; host.providerConnected = true; host.responseLoss = false; host.dropNextChunkResponse = false; host.browserFrameError = false; host.nextThreadId = 1; host.nextUploadId = 1; resetHost(state, host, "fixture reset", { clearUploads: true, clearTaskState: true }); } seedStorage(); state.mountRevision += 1; state.notify(); for (const listener of [...state.mountListeners]) listener(); };
  state.toggleHost = (id, patch) => { const host = state.hosts[id]; Object.assign(host, patch); emitHostEvent(state, host, "RuntimeStatus", { ...runtimeFor(host), providers: providerPayload(host) }); };
  state.restartHost = (id = "host-b") => resetHost(state, state.hosts[id]);
  state.emitAttention = (kind, hostId = "local") => { const host = state.hosts[hostId]; const payload = requestPayload(host, kind); host.attention.set(payload.id, payload); emitHostEvent(state, host, "AttentionRequired", payload); };
  state.pushTarget = (target) => { state.serviceWorker.emitMessage({ type: "pixice-connect-open", target }); };
  state.deepLinkTarget = (target) => { const query = new URLSearchParams({ connectHost: target.hostId, connectProject: target.projectId, connectThread: target.threadId }); windowRef.history.replaceState({}, "", `${windowRef.location.pathname}?${query}`); state.pushTarget(target); };
  state.openGeneratedFile = (hostId = "host-b", projectId = "project-b", threadId) => {
    const host = state.hosts[hostId];
    const targetThreadId = threadId || host.currentThreadByProject.get(projectId) || "thread-collision";
    if (!getThread(host, projectId, targetThreadId)) throw error("Task not found.", CONNECT_ERROR_CODES.NOT_FOUND, 404);
    return emitHostEvent(state, host, "FilePreviewOpenRequested", { workspaceId: targetThreadId, threadId: targetThreadId, projectId, source: "fixture-toolbar", file: { path: GENERATED_FILE_PATH, name: GENERATED_FILE_PATH, kind: "markdown", content: GENERATED_FILE_CONTENT, external: false, editable: false } });
  };
  state.attachSampleFiles = () => {
    const inputs = [...windowRef.document.querySelectorAll(".composer-file-input")];
    const visible = inputs.filter((input) => !input.disabled && !input.closest("[hidden]") && input.getAttribute("aria-hidden") !== "true");
    const input = visible.find((candidate) => candidate.closest(".execution-workspace-shell")) || visible.find((candidate) => candidate.multiple) || visible[0];
    if (!input) return false;
    const file = new windowRef.File(["Synthetic Connect fixture attachment\n"], "fixture-sample.txt", { type: "text/plain" });
    try {
      const transfer = new windowRef.DataTransfer();
      transfer.items.add(file);
      Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
    } catch {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
    }
    input.dispatchEvent(new windowRef.Event("change", { bubbles: true }));
    return true;
  };
  state.restore = () => { if (state.restored || windowRef.__pixiceConnectFixture !== state) return false; state.restored = true; for (const host of Object.values(state.hosts)) for (const waiter of [...host.waiters]) rejectPollWaiter(waiter, new DOMException("Fixture disposed", "AbortError")); if (previous.pixice) Object.defineProperty(windowRef, "pixice", previous.pixice); else delete windowRef.pixice; if (previous.fetch) Object.defineProperty(windowRef, "fetch", previous.fetch); else delete windowRef.fetch; if (previous.localStorage) Object.defineProperty(windowRef, "localStorage", previous.localStorage); else delete windowRef.localStorage; if (previous.sessionStorage) Object.defineProperty(windowRef, "sessionStorage", previous.sessionStorage); else delete windowRef.sessionStorage; if (previous.serviceWorker) Object.defineProperty(windowRef.navigator, "serviceWorker", previous.serviceWorker); else delete windowRef.navigator.serviceWorker; if (previous.fixture) Object.defineProperty(windowRef, "__pixiceConnectFixture", previous.fixture); else delete windowRef.__pixiceConnectFixture; return true; };
  return state;
}

export function FixtureToolbar({ fixture }) {
  const [, redraw] = useState(0); const [open, setOpen] = useState(false);
  useEffect(() => fixture?.subscribe(() => redraw((value) => value + 1)), [fixture]);
  if (!fixture || fixture.restored) return null;
  const remote = fixture.hosts[FIXTURE_HOSTS.operator]; const lastCall = fixture.calls.at(-1);
  return <aside className={`connect-fixture-toolbar${open ? " is-open" : ""}`} aria-label="Connect preview fixture controls">
    <button type="button" className="connect-fixture-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Fixture · {fixture.calls.length} calls · {fixture.mutationCount} mutations</button>
    {open && <div className="connect-fixture-controls">
      <span className="connect-fixture-summary">{lastCall ? `${lastCall.hostId} · ${lastCall.projectId || "n/a"} · ${lastCall.operation}` : "No host calls yet"}</span>
      <label><input type="checkbox" checked={!remote.online} onChange={(event) => fixture.toggleHost("host-b", { online: !event.target.checked })} /> B offline</label>
      <label><input type="checkbox" checked={!remote.providerConnected} onChange={(event) => fixture.toggleHost("host-b", { providerConnected: !event.target.checked })} /> Provider off</label>
      <label><input type="checkbox" checked={remote.responseLoss} onChange={(event) => { remote.responseLoss = event.target.checked; fixture.notify(); }} /> Drop responses</label>
      <label><input type="checkbox" checked={remote.dropNextChunkResponse} onChange={(event) => { remote.dropNextChunkResponse = event.target.checked; fixture.notify(); }} /> Drop next chunk response</label>
      <button type="button" onClick={() => fixture.attachSampleFiles()}>Attach sample files</button><button type="button" onClick={() => fixture.openGeneratedFile()}>Open generated file</button><button type="button" onClick={() => fixture.restartHost()}>Restart B</button>
      <button type="button" onClick={() => fixture.pushTarget({ hostId: "observer-c", projectId: "project-b", threadId: "thread-collision" })}>Push observer target</button><button type="button" onClick={() => fixture.deepLinkTarget({ hostId: "observer-c", projectId: "project-b", threadId: "thread-collision" })}>Deep-link target</button>
      <button type="button" onClick={() => fixture.emitAttention("approval", remote.id)}>Approval gen {remote.attentionGenerations.get("fixture-approval-request") || 0}</button><button type="button" onClick={() => fixture.emitAttention("question", remote.id)}>Question gen {remote.attentionGenerations.get("fixture-question-request") || 0}</button>
      <label>Viewport <input type="range" min="360" max="960" step="40" value={remote.viewportWidth} onChange={(event) => { remote.viewportWidth = Number(event.target.value); fixture.toggleHost("host-b", {}); }} /></label><small>Remote browser frame: {remote.browserFrameError ? "error" : `${remote.viewportWidth}×360`}</small><button type="button" onClick={() => { remote.browserFrameError = !remote.browserFrameError; fixture.toggleHost("host-b", {}); }}>{remote.browserFrameError ? "Recover frame" : "Frame error"}</button><button type="button" onClick={() => fixture.reset()}>Reset fixture</button>
    </div>}
  </aside>;
}

export function ConnectPreview({ fixture = typeof window !== "undefined" ? window.__pixiceConnectFixture : null } = {}) {
  const [, redraw] = useState(0);
  useEffect(() => fixture?.subscribeMount(() => redraw((value) => value + 1)), [fixture]);
  return <><div key={fixture?.mountRevision ?? 0}><RendererErrorBoundary><ConnectRoot><WorkflowHost><TaskPreviewHost><App /></TaskPreviewHost></WorkflowHost></ConnectRoot></RendererErrorBoundary></div><FixtureToolbar fixture={fixture} /></>;
}

ConnectPreview.installFixture = installFixture;
ConnectPreview.fixtureHosts = FIXTURE_HOSTS;
