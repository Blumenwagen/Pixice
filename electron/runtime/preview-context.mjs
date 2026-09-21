import { z } from "zod";

export const PIXICE_PREVIEW_NAMESPACE = "pixice_preview";
export const PREVIEW_CONTEXT_START = "<pixice-preview-context>";
export const PREVIEW_CONTEXT_END = "</pixice-preview-context>";

export const previewContextToolShapes = {
  current: z.object({}).strict(),
  open_file: z.object({ path: z.string().trim().min(1).max(10_000) }).strict(),
  present_thread: z.object({ threadId: z.string().trim().min(1).max(500) }).strict()
};

function functionTool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  };
}

export const previewContextDynamicTools = [{
  type: "namespace",
  name: PIXICE_PREVIEW_NAMESPACE,
  description: "Inspect or open content in the current thread's Pixice Preview workspace.",
  tools: [
    functionTool("current", "Return metadata for the selected Preview tab without reading its page or file contents. Use the resource-specific tool named in the result when deeper inspection is relevant."),
    functionTool("open_file", "Open a local file in this thread's Preview. Use this when the user explicitly asks to open or show a file. Absolute paths outside the project are allowed.", {
      path: { type: "string", description: "Project-relative path, absolute local path, or file URL requested by the user." }
    }, ["path"]),
    functionTool("present_thread", "Present another thread's Preview workspace in this conversation without navigating away from the current thread. Use this to show the user UI prototypes or artifacts produced by a delegated worker.", {
      threadId: { type: "string", description: "Worker or project thread whose Preview workspace should be shown." }
    }, ["threadId"])
  ]
}];

export const PIXICE_PREVIEW_MCP_TOOLS = new Set([
  "mcp__pixice_preview__current",
  "mcp__pixice_preview__open_file",
  "mcp__pixice_preview__present_thread"
]);

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  };
}

const PREVIEW_ACTIVE_METADATA_FIELDS = [
  "kind",
  "id",
  "title",
  "url",
  "path",
  "projectId",
  "taskId",
  "proposalId",
  "workflowId",
  "instrumentId",
  "documentVersion",
  "editable",
  "dirty",
  "simulatorUdid",
  "sessionId",
  "status",
  "threadId",
  "forkedFromId",
  "hostThreadId"
];

function activeTabMetadata(active) {
  if (!active || typeof active !== "object") return null;
  return Object.fromEntries(PREVIEW_ACTIVE_METADATA_FIELDS
    .filter((field) => active[field] !== undefined)
    .map((field) => [field, active[field]]));
}

function selectedKindLabel(kind) {
  if (kind === "browser") return "a browser tab";
  if (kind === "file") return "a file tab";
  if (kind === "instrument") return "a Tool tab";
  if (kind === "task" || kind === "plan") return "a work item tab";
  if (kind === "task-map") return "a Task Map tab";
  if (kind === "workflow") return "a Workflow tab";
  if (kind === "simulator") return "an iOS Simulator tab";
  if (kind === "thread") return "a Side Thread chat tab";
  if (kind === "new") return "the new-tab chooser";
  return "a tab";
}

function inspectionToolFor(kind) {
  if (kind === "browser") return "pixice_browser.inspect";
  if (kind === "file") return "Read the reported project path with the available file tools";
  if (kind === "instrument") return "pixice_instruments.inspect_instrument";
  if (kind === "task" || kind === "plan") return "pixice_board.read_task";
  if (kind === "workflow") return "pixice_bridge.inspect_workflow";
  if (kind === "simulator") return "pixice_ios.status";
  return null;
}

export function previewContextHint(context) {
  if (!context?.open || !context.active?.kind) return "";
  return `${PREVIEW_CONTEXT_START}Pixice Preview is open in this thread with ${selectedKindLabel(context.active.kind)} selected. If the user's request may refer to it, call pixice_preview.current before asking what they mean.${PREVIEW_CONTEXT_END}`;
}

export function appendPreviewContextHint(text, context) {
  const hint = previewContextHint(context);
  return hint ? [String(text ?? "").trim(), hint].filter(Boolean).join("\n\n") : String(text ?? "");
}

export function stripPreviewContextHint(text) {
  return String(text ?? "")
    .replace(/\s*<pixice-preview-context>[\s\S]*?<\/pixice-preview-context>/g, "")
    .trim();
}

export class PreviewContextRegistry {
  #contexts = new Map();
  #openFile;
  #presentThread;

  constructor({ openFile = null, presentThread = null } = {}) {
    this.#openFile = openFile;
    this.#presentThread = presentThread;
  }

  set(threadId, context) {
    if (!threadId) throw new Error("A thread-scoped Preview workspace is required");
    const normalized = context?.open
      ? { open: true, tabCount: context.tabCount ?? 0, active: activeTabMetadata(context.active) }
      : { open: false, tabCount: 0, active: null };
    this.#contexts.set(threadId, normalized);
    return normalized;
  }

  current(threadId) {
    return this.#contexts.get(threadId) ?? { open: false, tabCount: 0, active: null };
  }

  adopt(fromThreadId, toThreadId) {
    if (fromThreadId === toThreadId) return this.current(toThreadId);
    const context = this.#contexts.get(fromThreadId);
    if (!context) return this.current(toThreadId);
    this.#contexts.delete(fromThreadId);
    this.#contexts.set(toThreadId, context);
    return context;
  }

  clear(threadId) {
    this.#contexts.delete(threadId);
  }

  async handleToolCall(params) {
    if (!params.threadId) return textResult("Pixice Preview tools require a thread-scoped call.", false);
    if (params.tool === "current") {
      const context = this.current(params.threadId);
      return textResult({
        ...context,
        ...(context.active?.kind ? { inspectWith: inspectionToolFor(context.active.kind) } : {})
      });
    }
    if (params.tool === "open_file") {
      if (!this.#openFile) return textResult("Opening files in Preview is unavailable.", false);
      const value = previewContextToolShapes.open_file.parse(params.arguments ?? {});
      return textResult(await this.#openFile({
        threadId: params.threadId,
        turnId: params.turnId,
        source: params.source,
        path: value.path
      }));
    }
    if (params.tool === "present_thread") {
      if (!this.#presentThread) return textResult("Presenting another thread's Preview is unavailable.", false);
      const value = previewContextToolShapes.present_thread.parse(params.arguments ?? {});
      return textResult(await this.#presentThread({
        threadId: params.threadId,
        turnId: params.turnId,
        source: params.source,
        sourceThreadId: value.threadId
      }));
    }
    return textResult(`Unknown Pixice Preview tool: ${params.tool}`, false);
  }
}
