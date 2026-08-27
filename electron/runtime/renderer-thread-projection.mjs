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

export function projectRendererItem(item) {
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
  const resultSummary = compactLine(result ?? structuredContent ?? contentItems ?? output);
  return resultSummary ? { ...projected, resultSummary } : projected;
}

function projectRendererTurn(turn) {
  if (!turn?.items?.some((item) => TOOL_ITEM_TYPES.has(item?.type))) return turn;
  return { ...turn, items: turn.items.map(projectRendererItem) };
}

export function projectRendererThread(thread) {
  if (!thread?.turns?.some((turn) => turn.items?.some((item) => TOOL_ITEM_TYPES.has(item?.type)))) return thread;
  return { ...thread, turns: thread.turns.map(projectRendererTurn) };
}

export function projectRuntimePayloadForRenderer(payload = {}) {
  let projected = payload;
  if (payload.item) projected = { ...projected, item: projectRendererItem(payload.item) };
  if (payload.turn) projected = { ...projected, turn: projectRendererTurn(payload.turn) };
  if (payload.thread) projected = { ...projected, thread: projectRendererThread(payload.thread) };
  return projected;
}
