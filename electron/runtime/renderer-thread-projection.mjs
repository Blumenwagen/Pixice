const TOOL_ITEM_TYPES = new Set(["mcpToolCall", "dynamicToolCall"]);

function compactLine(value, depth = 0) {
  if (value == null || depth > 4) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 160);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      const line = compactLine(entry, depth + 1);
      if (line) return line;
    }
    return "";
  }
  if (typeof value !== "object") return String(value).slice(0, 160);
  for (const key of ["text", "message", "error", "output", "content", "contentItems", "result"]) {
    const line = compactLine(value[key], depth + 1);
    if (line) return line;
  }
  return "";
}

// The host validates exact injected context fingerprints. Never hide a user
// message merely because it begins with a familiar marker or JSON shape.
export function projectFocusUserItem(item, isInternalContext = () => false, turnId) {
  if (item?.type !== "userMessage") return item;
  return { ...item, content: (item.content ?? []).flatMap((part, index) => {
    if (index !== 0 || part.type !== "text" && part.type !== "inputText") return [part];
    let text = part.text ?? "";
    if (text.startsWith("[Pixice Focus state brief]\n")) {
      const end = text.indexOf("\n", "[Pixice Focus state brief]\n".length);
      const context = end < 0 ? text : text.slice(0, end);
      if (isInternalContext(context, { item, turnId })) text = end < 0 ? "" : text.slice(end + 1);
    }
    return text ? [{ ...part, text }] : [];
  }) };
}

export function projectRendererItem(item, isInternalContext, turnId) {
  if (item?.type === "userMessage") return projectFocusUserItem(item, isInternalContext, turnId);
  if (item?.type === "commandExecution" && item.aggregatedOutput?.length > 8192) {
    return { ...item, aggregatedOutput: `${item.aggregatedOutput.slice(0, 4096)}\n… Output shortened for display …\n${item.aggregatedOutput.slice(-4096)}`, outputTruncated: true };
  }
  if (!TOOL_ITEM_TYPES.has(item?.type)) return item;
  if (/image(?:_gen|gen|generation)/i.test(item.tool ?? "")) return item;
  const {
    result,
    structuredContent,
    contentItems,
    output,
    _meta,
    ...projected
  } = item;
  if (JSON.stringify(projected.arguments ?? null).length > 8192) {
    projected.arguments = { summary: "Large tool input omitted from the chat display." };
  }
  const resultSummary = compactLine(result ?? structuredContent ?? contentItems ?? output);
  return resultSummary ? { ...projected, resultSummary } : projected;
}

function projectRendererTurn(turn, isInternalContext) {
  return { ...turn, items: (turn?.items ?? []).map((item) => projectRendererItem(item, isInternalContext, turn.id)) };
}

export function projectRendererThread(thread, contextForThread = () => undefined, originForTurn = () => thread.id) {
  if (!thread?.turns) return thread;
  return { ...thread, turns: thread.turns.map((turn) => projectRendererTurn(turn, contextForThread(originForTurn(turn)))) };
}

export function projectRuntimePayloadForRenderer(payload = {}, contextForThread = () => undefined) {
  let projected = payload;
  if (payload.item) projected = { ...projected, item: projectRendererItem(payload.item, contextForThread(payload.threadId), payload.turnId) };
  if (payload.turn) projected = { ...projected, turn: projectRendererTurn(payload.turn, contextForThread(payload.threadId)) };
  if (payload.thread) projected = { ...projected, thread: projectRendererThread(payload.thread, contextForThread) };
  return projected;
}
