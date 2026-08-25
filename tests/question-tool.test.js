import { describe, expect, it } from "vitest";
import {
  isPixiceQuestionToolCall,
  pixiceQuestionRequest,
  pixiceQuestionToolResult,
  questionDynamicTools
} from "../electron/runtime/question-tool.mjs";

const request = {
  id: 42,
  method: "item/tool/call",
  params: {
    namespace: "pixice",
    tool: "request_user_input",
    threadId: "thread-1",
    turnId: "turn-1",
    arguments: {
      questions: [{
        id: "approach",
        header: "Approach",
        question: "How should Pixice proceed?",
        options: [
          { label: "Build it", description: "Implement the flow.", recommended: false },
          { label: "Plan it", description: "Prepare a plan.", recommended: false }
        ]
      }]
    }
  }
};

describe("Pixice question tool", () => {
  it("is advertised as an always-available dynamic tool", () => {
    expect(questionDynamicTools).toEqual([
      expect.objectContaining({
        name: "pixice",
        tools: [expect.objectContaining({ name: "request_user_input" })]
      })
    ]);
  });

  it("normalizes a tool call into a thread-scoped composer request", () => {
    expect(isPixiceQuestionToolCall(request)).toBe(true);
    expect(pixiceQuestionRequest(request)).toMatchObject({
      id: 42,
      method: "pixice/requestUserInput",
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
    expect(pixiceQuestionToolResult({ answers: { approach: "Build it" } })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ cancelled: false, answers: { approach: "Build it" } }) }]
    });
  });
});
