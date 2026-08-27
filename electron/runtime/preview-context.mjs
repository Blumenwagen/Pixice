import { z } from "zod";

export const PIXICE_PREVIEW_NAMESPACE = "pixice_preview";
export const PREVIEW_CONTEXT_START = "<pixice-preview-context>";
export const PREVIEW_CONTEXT_END = "</pixice-preview-context>";

export const previewContextToolShapes = {
  current: z.object({}).strict()
};

function functionTool(name, description, properties = {}) {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties, required: [], additionalProperties: false }
  };
}

export const previewContextDynamicTools = [{
  type: "namespace",
  name: PIXICE_PREVIEW_NAMESPACE,
  description: "Inspect what is selected in the current thread's Pixice Preview workspace. Pixice only gives the prompt a small presence hint; use this namespace to resolve what 'this' refers to before asking the user.",
  tools: [
    functionTool("current", "Return metadata for the selected Preview tab without reading its page or file contents. Use the resource-specific tool named in the result when deeper inspection is relevant.")
  ]
}];

export const PIXICE_PREVIEW_MCP_TOOLS = new Set(["mcp__pixice_preview__current"]);

function textResult(value, success = true) {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }]
  };
}

function selectedKindLabel(kind) {
  if (kind === "browser") return "a browser tab";
  if (kind === "file") return "a file tab";
  if (kind === "instrument") return "a Tool tab";
  if (kind === "task" || kind === "plan") return "a work item tab";
  if (kind === "workflow") return "a Workflow tab";
  if (kind === "new") return "the new-tab chooser";
  return "a tab";
}

function inspectionToolFor(kind) {
  if (kind === "browser") return "pixice_browser.inspect";
  if (kind === "file") return "Read the reported project path with the available file tools";
  if (kind === "instrument") return "pixice_instruments.inspect_instrument";
  if (kind === "task" || kind === "plan") return "pixice_board.read_task";
  if (kind === "workflow") return "pixice_bridge.inspect_workflow";
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

  set(threadId, context) {
    if (!threadId) throw new Error("A thread-scoped Preview workspace is required");
    const normalized = context?.open
      ? { open: true, tabCount: context.tabCount ?? 0, active: context.active ?? null }
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

  handleToolCall(params) {
    if (!params.threadId) return textResult("Pixice Preview tools require a thread-scoped call.", false);
    if (params.tool !== "current") return textResult(`Unknown Pixice Preview tool: ${params.tool}`, false);
    const context = this.current(params.threadId);
    return textResult({
      ...context,
      ...(context.active?.kind ? { inspectWith: inspectionToolFor(context.active.kind) } : {})
    });
  }
}
