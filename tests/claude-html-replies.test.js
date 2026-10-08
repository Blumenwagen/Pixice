import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncPromptQueue, ClaudeProvider, claudePermissionSettings } from "../electron/providers/claude-provider.mjs";
import { PixiceDatabase } from "../electron/persistence/database.mjs";
import { htmlReplyDynamicTools } from "../electron/runtime/html-replies.mjs";
import { pullRequestDynamicTools } from "../electron/github/pull-request-tools.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(dynamicTools) {
  const directory = mkdtempSync(path.join(tmpdir(), "pixice-claude-html-"));
  const database = new PixiceDatabase(directory);
  const output = new AsyncPromptQueue();
  const pixiceHtml = { handleToolCall: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: '{"reference":"page"}' }] }) };
  const pixicePullRequests = { handleToolCall: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "{}" }] }) };
  let args;
  const provider = new ClaudeProvider({ database, pixiceHtml, pixicePullRequests, queryFactory: (value) => { args = value; return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: vi.fn() }; } });
  cleanups.push(async () => { await provider.stop(); database.db.close(); rmSync(directory, { recursive: true, force: true }); });
  await provider.start();
  const { thread } = await provider.request("thread/start", { cwd: directory, model: "sonnet", permissionMode: "read-only", dynamicTools });
  await provider.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Make a chart" }], model: "sonnet", permissionMode: "read-only" });
  return { args, pixiceHtml, pixicePullRequests, thread };
}
describe("Claude HTML reply bridge", () => {
  it("registers published HTML tools and routes to the owning conversation with strict input validation", async () => {
    const { args, pixiceHtml, thread } = await fixture(htmlReplyDynamicTools);
    const tools = args.options.mcpServers.pixice_html.instance._registeredTools;
    expect(Object.keys(tools)).toEqual(["publish", "list"]);
    const result = await tools.publish.handler({ html: "<button>Try it</button>", title: "Chart" });
    expect(result.isError).toBe(false);
    expect(pixiceHtml.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({ namespace: "pixice_html", tool: "publish", threadId: thread.id, arguments: { html: "<button>Try it</button>", title: "Chart" } }));
    await expect(tools.publish.handler({ html: "<p>Page</p>", path: "other.html", title: "Chart" })).rejects.toThrow("exactly one");
    expect(claudePermissionSettings("read-only").tools).toContain("mcp__pixice_html__publish");
    await expect(args.options.canUseTool("mcp__pixice_html__publish", {}, {})).resolves.toMatchObject({ behavior: "allow" });
  });
  it("omits the bridge from workers whose explicit tool profile excludes HTML replies", async () => {
    const { args } = await fixture([]);
    expect(args.options.mcpServers.pixice_html).toBeUndefined();
    await expect(args.options.canUseTool("mcp__pixice_html__publish", {}, {})).resolves.toMatchObject({ behavior: "deny" });
  });
  it("registers the native PR tools and routes reads to the owning chat", async () => {
    const { args, pixicePullRequests, thread } = await fixture(pullRequestDynamicTools);
    const tools = args.options.mcpServers.pixice_pull_requests.instance._registeredTools;
    expect(Object.keys(tools)).toEqual(pullRequestDynamicTools[0].tools.map((definition) => definition.name));
    await tools.read_pull_request.handler({ reference: "https://github.com/team/repo/pull/3" });
    expect(pixicePullRequests.handleToolCall).toHaveBeenCalledWith(expect.objectContaining({ namespace: "pixice_pull_requests", tool: "read_pull_request", threadId: thread.id, arguments: { reference: "https://github.com/team/repo/pull/3" } }));
  });
});
