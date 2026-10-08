import { describe, expect, it, vi } from "vitest";
import { PixicePullRequests, PIXICE_PULL_REQUEST_NAMESPACE, PIXICE_PULL_REQUEST_MCP_TOOLS, pullRequestDynamicTools } from "../electron/github/pull-request-tools.mjs";

describe("provider-neutral native PR tools", () => {
  const setup = () => {
    const service = { context: vi.fn(async () => ({})), links: vi.fn(() => []), list: vi.fn(async () => []), read: vi.fn(async () => ({ number: 42 })), link: vi.fn(async () => ({ links: [] })), watch: vi.fn(async () => ({ active: true })), stopWatch: vi.fn(async () => ({ ok: true })) };
    const onStopWatch = vi.fn(), tools = new PixicePullRequests({ service, threadContext: async () => ({ projectId: "project" }), onStopWatch });
    return { service, tools, onStopWatch };
  };
  it("uses the runtime's chat/project ownership rather than model-supplied identifiers", async () => {
    const { service, tools } = setup();
    const result = await tools.handleToolCall({ threadId: "thread", tool: "watch_pull_request", arguments: { reference: "42" } });
    expect(result.success).toBe(true); expect(service.watch).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", reference: "42" });
    const forged = await tools.handleToolCall({ threadId: "thread", tool: "read_pull_request", arguments: { reference: "42", projectId: "another" } });
    expect(forged.success).toBe(false); expect(service.read).not.toHaveBeenCalled();
  });
  it("exposes only read/link/watch/stop, without remote writes or git actions", () => {
    expect(pullRequestDynamicTools[0].name).toBe(PIXICE_PULL_REQUEST_NAMESPACE);
    expect(pullRequestDynamicTools[0].tools.map((tool) => tool.name)).toEqual(["list_pull_requests", "read_pull_request", "link_pull_request", "watch_pull_request", "unwatch_pull_request"]);
    expect(PIXICE_PULL_REQUEST_MCP_TOOLS.has("mcp__pixice_pull_requests__watch_pull_request")).toBe(true);
  });
  it("validates before work, returns errors to both providers and cancels queued wakes on stop", async () => {
    const { service, tools, onStopWatch } = setup();
    expect((await tools.handleToolCall({ tool: "read_pull_request", arguments: { reference: "42" } })).success).toBe(false);
    expect((await tools.handleToolCall({ threadId: "thread", tool: "create_pull_request", arguments: {} })).success).toBe(false);
    await tools.handleToolCall({ threadId: "thread", tool: "unwatch_pull_request", arguments: { url: "https://github.com/acme/project/pull/42" } });
    expect(service.stopWatch).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", url: "https://github.com/acme/project/pull/42" });
    expect(onStopWatch).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", url: "https://github.com/acme/project/pull/42" });
    service.read.mockRejectedValue(new Error("Not authenticated"));
    const result = await tools.handleToolCall({ threadId: "thread", tool: "read_pull_request", arguments: { reference: "42" } });
    expect(result.success).toBe(false); expect(JSON.parse(result.contentItems[0].text)).toEqual({ error: "Not authenticated" });
  });
});
