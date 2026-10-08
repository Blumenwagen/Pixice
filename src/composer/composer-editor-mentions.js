import { parseContextTokens } from "./context.js";

// Adapter between Pixice's durable context records and the T3 document model.
// Raw token source travels with the atom, so labels and IDs never drift while editing.
export function splitPromptIntoComposerSegments(value) {
  const segments = [];
  let cursor = 0;
  for (const token of parseContextTokens(value)) {
    if (token.start < cursor) continue;
    if (token.start > cursor) segments.push({ type: "text", text: value.slice(cursor, token.start) });
    segments.push({
      type: "context-reference", kind: token.kind ?? token.type,
      contextId: token.id, label: token.label, source: token.source
    });
    cursor = token.end;
  }
  if (cursor < value.length) segments.push({ type: "text", text: value.slice(cursor) });
  return segments;
}

export function collectInlineContextIds(value) {
  return parseContextTokens(value).map(token => token.id);
}

export function markdownToFlat(map, offset, bias = 1) {
  const bounded = Math.max(0, Math.min(offset, map.value.length));
  for (const run of map.runs) {
    if (bounded < run.mdStart + run.mdLen || (run.mdLen === 0 && bounded === run.mdStart)) {
      if (run.kind === "prefix") return run.flatStart;
      const within = bounded - run.mdStart - run.openLen;
      const bodyLength = run.mdLen - run.openLen - run.closeLen;
      if (within <= 0) return run.flatStart;
      if (within >= bodyLength) return run.flatStart + run.docLen;
      if (run.kind === "token") return run.flatStart + (bias > 0 ? run.docLen : 0);
      return run.flatStart + Math.min(run.docLen, within);
    }
  }
  return map.docLength;
}
