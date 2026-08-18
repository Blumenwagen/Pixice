import { describe, expect, it } from "vitest";
import { buildClaudeUserMessage, buildCodexUserInput } from "../electron/runtime/user-input.mjs";

describe("Codex user input", () => {
  it("keeps text and images as native ordered app-server input", () => {
    expect(buildCodexUserInput("  Compare these  ", ["data:image/png;base64,AA==", "data:image/webp;base64,BB=="])).toEqual([
      { type: "text", text: "Compare these", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AA==" },
      { type: "image", url: "data:image/webp;base64,BB==" }
    ]);
  });

  it("supports an image-only prompt", () => {
    expect(buildCodexUserInput("", ["data:image/png;base64,AA=="])).toEqual([
      { type: "image", url: "data:image/png;base64,AA==" }
    ]);
  });
});

describe("Claude user input", () => {
  it("translates text and data URLs to Agent SDK content blocks", () => {
    const message = buildClaudeUserMessage("  inspect this  ", ["data:image/png;base64,aGVsbG8="]);
    expect(message).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
        ]
      },
      parent_tool_use_id: null
    });
  });
});
