import { describe, expect, it } from "vitest";
import {
  isLoomQuestionToolCall,
  loomQuestionRequest,
  loomQuestionToolResult,
  questionDynamicTools
} from "../electron/runtime/question-tool.mjs";

const request = {
  id: 42,
  method: "item/tool/call",
  params: {
    namespace: "loom",
    tool: "request_user_input",
    threadId: "thread-1",
    turnId: "turn-1",
    arguments: {
      questions: [{
        id: "approach",
        header: "Approach",
        question: "How should Loom proceed?",
        options: [
          { label: "Build it", description: "Implement the flow.", recommended: false },
          { label: "Plan it", description: "Prepare a plan.", recommended: false }
        ]
      }]
    }
  }
};

describe("Loom question tool", () => {
  it("is advertised as an always-available dynamic tool", () => {
    expect(questionDynamicTools).toEqual([
      expect.objectContaining({
        name: "loom",
        tools: [expect.objectContaining({ name: "request_user_input" })]
      })
    ]);
  });

  it("normalizes a tool call into a thread-scoped composer request", () => {
    expect(isLoomQuestionToolCall(request)).toBe(true);
    expect(loomQuestionRequest(request)).toMatchObject({
      id: 42,
      method: "loom/requestUserInput",
      params: {
        threadId: "thread-1",
        questions: [{
          id: "approach",
          options: [
            expect.objectContaining({ label: "Build it", recommended: true }),
            expect.objectContaining({ label: "Plan it", recommended: false })
          ]
        }]
      }
    });
  });

  it("returns the collected answers to the blocked model tool call", () => {
    expect(loomQuestionToolResult({ answers: { approach: "Build it" } })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ cancelled: false, answers: { approach: "Build it" } }) }]
    });
  });
});
