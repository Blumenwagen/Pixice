import { describe, expect, it } from "vitest";
import {
  appendPreviewContextHint,
  PreviewContextRegistry,
  stripPreviewContextHint
} from "../electron/runtime/preview-context.mjs";

describe("Preview context", () => {
  it("adds only a compact presence hint to the prompt", () => {
    const text = appendPreviewContextHint("look at this", {
      open: true,
      tabCount: 4,
      active: {
        kind: "browser",
        id: "browser-1",
        title: "Sensitive account page",
        url: "https://example.com/private"
      }
    });

    expect(text).toContain("Pixice Preview is open in this thread with a browser tab selected");
    expect(text).toContain("pixice_preview.current");
    expect(text).not.toContain("Sensitive account page");
    expect(text).not.toContain("example.com/private");
    expect(stripPreviewContextHint(text)).toBe("look at this");
  });

  it("returns selected-tab metadata only when the agent asks for it", async () => {
    const registry = new PreviewContextRegistry();
    registry.set("thread-1", {
      open: true,
      tabCount: 2,
      active: { kind: "file", id: "file-1", title: "notes.md", path: "notes.md", dirty: true }
    });

    const response = await registry.handleToolCall({ threadId: "thread-1", tool: "current", arguments: {} });

    expect(JSON.parse(response.contentItems[0].text)).toEqual({
      open: true,
      tabCount: 2,
      active: { kind: "file", id: "file-1", title: "notes.md", path: "notes.md", dirty: true },
      inspectWith: "Read the reported project path with the available file tools"
    });
    expect(registry.current("thread-2")).toEqual({ open: false, tabCount: 0, active: null });
  });

  it("describes a Side Thread without exposing its conversation", async () => {
    const registry = new PreviewContextRegistry();
    registry.set("host-thread", {
      open: true,
      tabCount: 3,
      active: {
        kind: "thread",
        id: "thread:side-thread",
        title: "Investigate Preview state",
        threadId: "side-thread",
        forkedFromId: "source-thread",
        hostThreadId: "host-thread",
        status: "active",
        turns: [{ id: "private-turn", items: [{ type: "agentMessage", text: "Private answer" }] }]
      }
    });

    const response = await registry.handleToolCall({ threadId: "host-thread", tool: "current", arguments: {} });
    const result = JSON.parse(response.contentItems[0].text);

    expect(result).toEqual({
      open: true,
      tabCount: 3,
      active: {
        kind: "thread",
        id: "thread:side-thread",
        title: "Investigate Preview state",
        threadId: "side-thread",
        forkedFromId: "source-thread",
        hostThreadId: "host-thread",
        status: "active"
      },
      inspectWith: null
    });
    expect(response.contentItems[0].text).not.toContain("Private answer");
  });

  it("adds a compact Side Thread hint without naming either conversation", () => {
    const text = appendPreviewContextHint("compare these approaches", {
      open: true,
      tabCount: 1,
      active: {
        kind: "thread",
        title: "Private side investigation",
        threadId: "side-thread",
        hostThreadId: "host-thread"
      }
    });

    expect(text).toContain("Pixice Preview is open in this thread with a Side Thread chat tab selected");
    expect(text).toContain("pixice_preview.current");
    expect(text).not.toContain("Private side investigation");
    expect(text).not.toContain("side-thread");
    expect(text).not.toContain("host-thread");
  });

  it("describes a Task Map tab without adding task details to the hint", () => {
    const text = appendPreviewContextHint("check the split", {
      open: true,
      tabCount: 2,
      active: { kind: "task-map", title: "Private task title", projectId: "project-1" }
    });

    expect(text).toContain("Pixice Preview is open in this thread with a Task Map tab selected");
    expect(text).not.toContain("Private task title");
    expect(text).not.toContain("project-1");
  });

  it("opens a requested local file in the controlling thread", async () => {
    const openFile = async (request) => ({ opened: true, path: request.path, editable: true });
    const registry = new PreviewContextRegistry({ openFile });

    const response = await registry.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "open_file",
      source: "codex",
      arguments: { path: "/Users/me/.codex/skills/openai-docs/SKILL.md" }
    });

    expect(JSON.parse(response.contentItems[0].text)).toEqual({
      opened: true,
      path: "/Users/me/.codex/skills/openai-docs/SKILL.md",
      editable: true
    });
  });

  it("presents another thread's Preview in the controlling conversation", async () => {
    const presentThread = async (request) => ({ presented: true, sourceThreadId: request.sourceThreadId });
    const registry = new PreviewContextRegistry({ presentThread });

    const response = await registry.handleToolCall({
      threadId: "focus-thread",
      turnId: "turn-1",
      tool: "present_thread",
      source: "codex",
      arguments: { threadId: "worker-thread" }
    });

    expect(JSON.parse(response.contentItems[0].text)).toEqual({
      presented: true,
      sourceThreadId: "worker-thread"
    });
  });
});
