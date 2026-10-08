import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectServer } from "../electron/connect/server.mjs";
import { HtmlReplyDocuments } from "../electron/runtime/html-reply-documents.mjs";

const hosts = [];
afterEach(async () => { for (const { server, directory } of hosts.splice(0)) { await server.stop(); await rm(directory, { recursive: true, force: true }); } });
const input = { projectId: "project", threadId: "thread", html: '<button onclick="this.textContent=\'Selected\'">Choose</button>', nonce: "nonce", title: "Interactive page" };
async function host() {
  const directory = await mkdtemp(path.join(tmpdir(), "pixice-html-transport-"));
  let projectExists = true;
  const invoke = vi.fn(async (operation, payload) => { if (operation !== "htmlReplies.list" || payload.projectId !== "project" || payload.threadId !== "thread") throw new Error("Wrong conversation"); return []; });
  const server = new ConnectServer({ directory, invoke, operations: new Map([["htmlReplies.document", "html-replies:document"], ["htmlReplies.list", "html-replies:list"]]), readOperations: new Set(["htmlReplies.document", "htmlReplies.list"]), projectExists: (id) => projectExists && id === "project" });
  server.state.enabled = true; server.state.port = 0; hosts.push({ server, directory }); await server.start();
  const endpoint = server.localOrigin();
  const offer = server.pairOffer();
  const pair = await fetch(`${endpoint}/api/connect/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(new URL(offer.url).hash.slice(1)).get("pair"), name: "Desktop" }) });
  const device = await pair.json();
  const mint = async (payload = input, token = device.token) => {
    const response = await fetch(`${endpoint}/api/connect/call`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ operation: "htmlReplies.document", payload, instanceId: server.instanceId, id: randomUUID(), issuedAt: Date.now() }) });
    return { response, body: await response.json() };
  };
  return { server, endpoint, invoke, device, mint, deleteProject: () => { projectExists = false; } };
}
describe("isolated HTML document transport", () => {
  it("mints only after authenticated scope validation and serves a script-capable document with its own restrictive policy", async () => {
    const { mint, invoke, endpoint } = await host();
    const { response, body } = await mint();
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith("htmlReplies.list", { projectId: "project", threadId: "thread" }, expect.objectContaining({ deviceId: expect.any(String) }));
    expect(body.result.url).toMatch(new RegExp(`^${endpoint}/api/html-replies/document/[A-Za-z0-9_-]{43}$`));
    const document = await fetch(body.result.url);
    expect(document.status).toBe(200);
    expect(document.headers.get("x-frame-options")).toBeNull();
    expect(document.headers.get("cache-control")).toContain("no-store");
    expect(document.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");
    expect(document.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(document.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await document.text()).toContain("Choose</button>");
    expect((await mint(input, null)).response.status).toBe(401);
    expect((await mint({ ...input, threadId: "other-thread" })).response.status).toBe(400);
  });
  it("revokes document access when a device is revoked, its project disappears, or the token expires", async () => {
    const first = await host();
    const url = (await first.mint()).body.result.url;
    first.server.revoke({ id: first.device.deviceId });
    expect((await fetch(url)).status).toBe(404);
    const second = await host();
    const next = (await second.mint()).body.result.url;
    second.deleteProject(); expect((await fetch(next)).status).toBe(404);
    const third = await host();
    const last = (await third.mint()).body.result.url;
    third.server.htmlReplyDocuments.read(new URL(last).pathname.split("/").at(-1)).expiresAt = 0;
    expect((await fetch(last)).status).toBe(404);
  });
  it("bounds retained documents and discards expired content without writing it to durable state", () => {
    let now = 1000;
    const documents = new HtmlReplyDocuments({ now: () => now, maxDocuments: 2 });
    const first = documents.create(input, "device");
    const second = documents.create(input, "device");
    documents.create(input, "device");
    expect(documents.read(first.path.split("/").at(-1))).toBeNull();
    expect(documents.documents.size).toBe(2);
    now = second.expiresAt + 1;
    documents.prune(); expect(documents.documents.size).toBe(0); expect(documents.bytes).toBe(0);
  });
});
