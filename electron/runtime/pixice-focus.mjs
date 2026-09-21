import { z } from "zod";

export const PIXICE_FOCUS_NAMESPACE = "pixice_focus";
export const PIXICE_FOCUS_MCP_TOOLS = new Set([
  "mcp__pixice_focus__read_memory",
  "mcp__pixice_focus__update_memory",
  "mcp__pixice_focus__search_history"
]);
export const PROJECT_FOCUS_MEMORY_LIMIT = 6_000;
export const USER_FOCUS_MEMORY_LIMIT = 2_000;

const target = z.enum(["project", "user"]);
const operation = z.object({
  target,
  action: z.enum(["append", "replace", "remove"]),
  oldText: z.string().max(PROJECT_FOCUS_MEMORY_LIMIT).optional(),
  text: z.string().max(PROJECT_FOCUS_MEMORY_LIMIT).optional()
}).strict();

export const pixiceFocusToolShapes = {
  read_memory: {},
  update_memory: {
    expectedRevision: z.number().int().nonnegative(),
    operations: z.array(operation).min(1).max(20)
  },
  search_history: {
    query: z.string().trim().min(2).max(240),
    limit: z.number().int().min(1).max(20).default(8)
  }
};
const schemas = Object.fromEntries(Object.entries(pixiceFocusToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]));

export const pixiceFocusTools = [
  {
    type: "function",
    name: "read_memory",
    description: "Read the Focus coordinator's bounded project and user memory with revision and capacity information.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "update_memory",
    description: "Atomically append, replace, or remove stable facts in Focus memory. Read memory first and consolidate it when it is near capacity.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              target: { type: "string", enum: ["project", "user"] },
              action: { type: "string", enum: ["append", "replace", "remove"] },
              oldText: { type: "string", maxLength: PROJECT_FOCUS_MEMORY_LIMIT },
              text: { type: "string", maxLength: PROJECT_FOCUS_MEMORY_LIMIT }
            },
            required: ["target", "action"],
            additionalProperties: false
          }
        }
      },
      required: ["expectedRevision", "operations"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "search_history",
    description: "Search the complete indexed Focus conversation when the bounded hot memory does not contain enough detail.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 240 },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
];

export const pixiceFocusDynamicTools = [{
  type: "namespace",
  name: PIXICE_FOCUS_NAMESPACE,
  description: "Maintain bounded, curated memory for the one persistent Focus coordinator in the current Pixice project. These tools work only from that coordinator thread.",
  tools: pixiceFocusTools
}];

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  };
}

function memoryView(memory, session = null) {
  const projectChars = memory.projectMemory.length;
  const userChars = memory.userMemory.length;
  return {
    ...memory,
    session,
    capacity: {
      project: { used: projectChars, limit: PROJECT_FOCUS_MEMORY_LIMIT, nearCapacity: projectChars >= PROJECT_FOCUS_MEMORY_LIMIT * 0.8 },
      user: { used: userChars, limit: USER_FOCUS_MEMORY_LIMIT, nearCapacity: userChars >= USER_FOCUS_MEMORY_LIMIT * 0.8 }
    }
  };
}

function assertSafeMemory(text) {
  if (!text) return;
  const unsafe = [
    /<\/?(?:system|developer|assistant|tool)\b/i,
    /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
    /\bBEGIN\s+(?:SYSTEM|PROMPT|INSTRUCTIONS)\b/i
  ];
  if (unsafe.some((pattern) => pattern.test(text))) {
    throw new Error("Focus memory rejected text that looks like embedded instructions.");
  }
}

function occurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function editMemory(source, input) {
  const text = input.text?.trim() ?? "";
  const oldText = input.oldText ?? "";
  if (input.action === "append") {
    if (!text) throw new Error("Append needs non-empty text.");
    assertSafeMemory(text);
    if (source.includes(text)) throw new Error("Focus memory already contains that exact text.");
    return source ? `${source.trimEnd()}\n${text}` : text;
  }
  if (!oldText) throw new Error(`${input.action} needs oldText.`);
  const count = occurrences(source, oldText);
  if (count !== 1) throw new Error(`oldText must match exactly once; found ${count} matches.`);
  if (input.action === "remove") return source.replace(oldText, "").trim();
  assertSafeMemory(text);
  return source.replace(oldText, text).trim();
}

export class PixiceFocusMemory {
  constructor({ database, onChange = () => {} }) {
    this.database = database;
    this.onChange = onChange;
  }

  read(projectId) {
    return memoryView(
      this.database.getProjectFocusMemory(projectId),
      this.database.getProjectFocusSession(projectId)
    );
  }

  replaceFromMaintenance(projectId, memory, reviewedTurnCount) {
    const projectMemory = String(memory.projectMemory ?? "").trim().slice(0, PROJECT_FOCUS_MEMORY_LIMIT);
    const userMemory = String(memory.userMemory ?? "").trim().slice(0, USER_FOCUS_MEMORY_LIMIT);
    assertSafeMemory(projectMemory);
    assertSafeMemory(userMemory);
    const saved = this.database.replaceProjectFocusMemory(projectId, { projectMemory, userMemory });
    this.database.markProjectFocusMemoryReviewed(projectId, reviewedTurnCount);
    this.onChange({ projectId, memory: saved });
    return memoryView(saved, this.database.getProjectFocusSession(projectId));
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Focus memory tools require an active coordinator thread.");
      const session = this.database.getProjectFocusSessionByThread(params.threadId);
      if (!session) throw new Error("Focus memory is available only in a project's Focus coordinator.");
      const schema = schemas[params.tool];
      if (!schema) throw new Error(`Unknown Focus memory tool: ${params.tool}`);
      const input = schema.parse(params.arguments ?? {});
      if (params.tool === "read_memory") return textResult(this.read(session.projectId));
      if (params.tool === "search_history") {
        return textResult({
          projectId: session.projectId,
          query: input.query,
          results: this.database.searchProjectFocusHistory(session.projectId, input.query, input.limit)
        });
      }

      const current = this.database.getProjectFocusMemory(session.projectId);
      if (current.revision !== input.expectedRevision) {
        throw new Error("Focus memory changed. Read it again before editing.");
      }
      const next = {
        projectMemory: current.projectMemory,
        userMemory: current.userMemory
      };
      for (const change of input.operations) {
        const key = change.target === "project" ? "projectMemory" : "userMemory";
        next[key] = editMemory(next[key], change);
      }
      if (next.projectMemory.length > PROJECT_FOCUS_MEMORY_LIMIT) {
        throw new Error(`Project memory exceeds ${PROJECT_FOCUS_MEMORY_LIMIT} characters. Consolidate or replace older notes.`);
      }
      if (next.userMemory.length > USER_FOCUS_MEMORY_LIMIT) {
        throw new Error(`User memory exceeds ${USER_FOCUS_MEMORY_LIMIT} characters. Consolidate or replace older notes.`);
      }
      const saved = this.database.replaceProjectFocusMemory(session.projectId, next, current.revision);
      this.onChange({ projectId: session.projectId, threadId: params.threadId, memory: saved });
      return textResult(memoryView(saved, this.database.getProjectFocusSession(session.projectId)));
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }
}
