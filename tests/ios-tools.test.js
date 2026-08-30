import { describe, expect, it, vi } from "vitest";
import { IosTools, PIXICE_IOS_MCP_TOOLS, iosDynamicTools } from "../electron/ios/ios-tools.mjs";

function harness() {
  const service = {
    environment: vi.fn(async () => ({ ready: true })),
    discover: vi.fn(async (context) => ({ projectId: context.projectId, containers: [] })),
    createStarter: vi.fn(async (_context, args) => ({ created: true, name: args.name })),
    start: vi.fn(async (request) => ({ id: "session-1", status: "ready", ...request })),
    status: vi.fn(async (workspaceId) => ({ workspaceId, status: "ready" })),
    stop: vi.fn(async (workspaceId) => ({ workspaceId, status: "stopped" })),
    action: vi.fn(async (_workspaceId, action) => action === "screenshot"
      ? { dataUrl: "data:image/png;base64,AA==", evidence: { width: 1179, height: 2556 } }
      : action === "inspect"
        ? { elements: [], screenshot: { dataUrl: "data:image/png;base64,AA==", evidence: { captured: true } } }
      : { action, ok: true })
  };
  const onOpen = vi.fn();
  const tools = new IosTools({
    service,
    threadContext: (threadId) => threadId === "thread-1"
      ? { projectId: "project-1", roots: ["/project"] }
      : null,
    onOpen
  });
  return { tools, service, onOpen };
}

describe("Pixice iOS tools", () => {
  it("publishes a bounded namespace for both provider runtimes", () => {
    expect(iosDynamicTools[0].name).toBe("pixice_ios");
    expect(iosDynamicTools[0].tools.map(({ name }) => name)).toEqual([
      "environment", "discover", "create_starter", "start", "status", "stop", "inspect", "tap", "type",
      "swipe", "button", "rotate", "appearance", "screenshot", "logs"
    ]);
    expect(PIXICE_IOS_MCP_TOOLS).toContain("mcp__pixice_ios__screenshot");
  });

  it("starts only inside the calling thread's project and opens Preview", async () => {
    const { tools, service, onOpen } = harness();
    const response = await tools.handleToolCall({
      threadId: "thread-1",
      source: "codex",
      tool: "start",
      arguments: {
        containerPath: "Demo.xcodeproj",
        scheme: "Demo",
        simulatorUdid: "SIM-1"
      }
    });

    expect(response.success).toBe(true);
    expect(service.start).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "thread-1",
      projectId: "project-1",
      roots: ["/project"],
      configuration: "Debug",
      source: "codex"
    }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "thread-1", projectId: "project-1" }));
  });

  it("rejects unscoped calls and invalid coordinate combinations", async () => {
    const { tools, service } = harness();

    expect((await tools.handleToolCall({ tool: "status", arguments: {} })).success).toBe(false);
    const invalid = await tools.handleToolCall({
      threadId: "thread-1",
      tool: "tap",
      arguments: { x: 0.5 }
    });
    expect(invalid.success).toBe(false);
    expect(invalid.contentItems[0].text).toContain("either elementId or both normalized x and y");
    expect(service.action).not.toHaveBeenCalled();
  });

  it("returns screenshots as image tool content", async () => {
    const { tools } = harness();
    const response = await tools.handleToolCall({ threadId: "thread-1", tool: "screenshot", arguments: {} });

    expect(response).toEqual({
      success: true,
      contentItems: [
        { type: "inputText", text: JSON.stringify({ width: 1179, height: 2556 }) },
        { type: "inputImage", imageUrl: "data:image/png;base64,AA==" }
      ]
    });
  });

  it("returns inspection metadata and its frame without duplicating the data URL", async () => {
    const { tools } = harness();
    const response = await tools.handleToolCall({ threadId: "thread-1", tool: "inspect", arguments: {} });

    expect(response.success).toBe(true);
    expect(response.contentItems[0].text).not.toContain("data:image");
    expect(response.contentItems[1]).toEqual({ type: "inputImage", imageUrl: "data:image/png;base64,AA==" });
  });

  it("keeps stop and actions scoped to the calling workspace", async () => {
    const { tools, service } = harness();
    await tools.handleToolCall({ threadId: "thread-1", tool: "stop", arguments: {} });
    await tools.handleToolCall({ threadId: "thread-1", tool: "rotate", arguments: { orientation: "landscape_left" } });

    expect(service.stop).toHaveBeenCalledWith("thread-1", "Stopped by the controlling agent");
    expect(service.action).toHaveBeenCalledWith("thread-1", "rotate", { orientation: "landscape_left" });
  });
});
