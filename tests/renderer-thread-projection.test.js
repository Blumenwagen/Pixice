import { describe, expect, it } from "vitest";
import {
  projectRendererItem,
  projectRendererThread,
  projectRuntimePayloadForRenderer
} from "../electron/runtime/renderer-thread-projection.mjs";

describe("renderer thread projection", () => {
  it("removes full tool results while preserving rendered metadata", () => {
    const item = projectRendererItem({
      id: "tool-1",
      type: "mcpToolCall",
      tool: "github__fetch_pr",
      server: "github",
      status: "completed",
      arguments: { pull: 12 },
      result: { content: [{ type: "text", text: `Large result ${"x".repeat(10_000)}` }] },
      structuredContent: { rows: new Array(1_000).fill("large") },
      _meta: { internal: true }
    });

    expect(item).toMatchObject({
      id: "tool-1",
      tool: "github__fetch_pr",
      server: "github",
      status: "completed",
      arguments: { pull: 12 },
      resultSummary: expect.stringMatching(/^Large result/)
    });
    expect(item).not.toHaveProperty("result");
    expect(item).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(item).length).toBeLessThan(400);
  });

  it("keeps image generation results and projects thread and event turns", () => {
    const image = { id: "image", type: "dynamicToolCall", tool: "image_gen__imagegen", result: { image_url: "data:image/png;base64,test" } };
    expect(projectRendererItem(image)).toBe(image);

    const thread = { id: "thread", turns: [{ id: "turn", items: [{ id: "tool", type: "dynamicToolCall", tool: "web__run", result: "full result" }] }] };
    expect(projectRendererThread(thread).turns[0].items[0]).toMatchObject({ resultSummary: "full result" });
    expect(projectRuntimePayloadForRenderer({ turn: thread.turns[0] }).turn.items[0]).not.toHaveProperty("result");
  });
});
