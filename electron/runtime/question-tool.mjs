import { z } from "zod";

export const LOOM_QUESTION_METHOD = "loom/requestUserInput";
export const LOOM_QUESTION_TOOL_NAME = "request_user_input";

const optionShape = {
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  recommended: z.boolean()
};

const questionShape = {
  id: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  header: z.string().trim().min(1).max(40),
  question: z.string().trim().min(1).max(400),
  options: z.array(z.object(optionShape)).min(2).max(3)
};

export const loomQuestionToolShape = {
  questions: z.array(z.object(questionShape)).min(1).max(3)
};

export const loomQuestionInputSchema = z.object(loomQuestionToolShape);

const questionInputSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "One to three questions shown sequentially. Every question must have exactly one recommended option.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_]*$", description: "Stable snake_case answer key." },
          header: { type: "string", minLength: 1, maxLength: 40, description: "Short step label." },
          question: { type: "string", minLength: 1, maxLength: 400, description: "The question shown to the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1, maxLength: 80 },
                description: { type: "string", minLength: 1, maxLength: 240 },
                recommended: { type: "boolean", description: "True for exactly one option in this question." }
              },
              required: ["label", "description", "recommended"],
              additionalProperties: false
            }
          }
        },
        required: ["id", "header", "question", "options"],
        additionalProperties: false
      }
    }
  },
  required: ["questions"],
  additionalProperties: false
};

export const questionDynamicTools = [{
  type: "namespace",
  name: "loom",
  description: "Interact with Loom's native UI. These tools are available in every mode.",
  tools: [{
    type: "function",
    name: LOOM_QUESTION_TOOL_NAME,
    description: "Ask the user one to three short multiple-choice questions in Loom's composer and wait for their answers. Use when an answer materially changes the work. Put the recommended choice first and mark exactly one option per question as recommended.",
    inputSchema: questionInputSchema
  }]
}];

export function normalizeLoomQuestions(input) {
  const parsed = loomQuestionInputSchema.parse(input);
  return parsed.questions.map((question) => {
    const firstRecommended = question.options.findIndex((option) => option.recommended);
    return {
      ...question,
      options: question.options.map((option, index) => ({
        ...option,
        recommended: index === (firstRecommended === -1 ? 0 : firstRecommended)
      }))
    };
  });
}

export function isLoomQuestionToolCall(request) {
  return request?.method === "item/tool/call"
    && request.params?.namespace === "loom"
    && request.params?.tool === LOOM_QUESTION_TOOL_NAME;
}

export function loomQuestionRequest(request) {
  return {
    ...request,
    method: LOOM_QUESTION_METHOD,
    params: {
      threadId: request.params?.threadId,
      turnId: request.params?.turnId,
      questions: normalizeLoomQuestions(request.params?.arguments ?? {})
    }
  };
}

export function loomQuestionToolResult({ answers = {}, action = "answer" } = {}) {
  const value = action === "cancel"
    ? { cancelled: true, answers: {} }
    : { cancelled: false, answers };
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }]
  };
}
