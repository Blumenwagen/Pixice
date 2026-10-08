// Reference: T3 Code's released composerContextRecords / composerContextReferences
// (v0.0.46-nightly.20261008.2813). Text contains stable references; bounded,
// versioned records carry their source content independently of display labels.
export const CONTEXT_CLIPBOARD_MIME = "application/x-pixice-composer-context+json";
export const COMPOSER_CONTEXT_EVENT = "pixice:composer-context";
export const MAX_CONTEXT_RECORDS = 64;
export const MAX_CONTEXT_TEXT = 32 * 1024;
export const MAX_CONTEXT_TOTAL = 512 * 1024;
export const CONTEXT_KINDS = ["file", "image", "thread", "skill", "pull-request", "terminal", "review", "preview", "citation"];
const ALIASES = { "review-comment": "review", "preview-annotation": "preview", pr: "pull-request" };
const SOURCE_FIELDS = ["projectId", "threadId", "hostId", "deviceId", "messageId", "turnId", "itemId", "terminalId", "terminalLabel", "tabId", "attachmentId", "path", "relativePath", "url", "title", "name", "selector", "branch", "baseBranch", "headBranch", "state", "rangeLabel", "language"];
const NUMERIC_SOURCE_FIELDS = ["lineStart", "lineEnd", "number", "startIndex", "endIndex"];
const insertionDelivery = new WeakMap();
const INSERTION_TTL = 15 * 60 * 1000;
const insertionScope = (projectId, threadId, hostId) => JSON.stringify([hostId || "local", projectId, threadId ?? null]);
function deliveryFor(target) {
  let delivery = insertionDelivery.get(target);
  if (!delivery) { delivery = { subscriptions: new Map(), pending: new Map() }; insertionDelivery.set(target, delivery); }
  for (const [key, value] of delivery.pending) if (Date.now() - value.at > INSERTION_TTL) delivery.pending.delete(key);
  return delivery;
}
const TOKEN = /\[((?:\\.|[^\]\\\r\n])*)\]\((pixice-context:\/\/v1\/([a-z-]+)\/([^\s)]+))\)/g;
const cleanString = (value, max = 4096) => typeof value === "string" ? value.replace(/\0/g, "").slice(0, max) : "";
const boundedText = (value, max = MAX_CONTEXT_TEXT) => {
  const text = typeof value === "string" ? value.replace(/\0/g, "") : "";
  return text.length > max ? `${text.slice(0, max - 16)}\n… truncated …` : text;
};
const stableId = (value) => cleanString(value, 512).trim();
const unescapeLabel = (label) => label.replace(/\\([\\\[\]])/g, "$1");
const escapeLabel = (label) => label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
// encodeURIComponent leaves parentheses literal, but ')' terminates Markdown
// destinations. Paths such as "Project (1)/notes.md" must remain one atom.
const encodeContextId = (id) => encodeURIComponent(id).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export function normalizeContextRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = ALIASES[value.kind ?? value.type] ?? (value.kind ?? value.type);
  if (!CONTEXT_KINDS.includes(kind)) return null;
  const id = stableId(value.id ?? value.contextId);
  if (!id) return null;
  const source = {};
  const inputSource = value.source && typeof value.source === "object" ? value.source : value;
  for (const key of SOURCE_FIELDS) {
    const text = cleanString(inputSource[key]);
    if (text) source[key] = text;
  }
  for (const key of NUMERIC_SOURCE_FIELDS) {
    if (Number.isSafeInteger(inputSource[key]) && inputSource[key] >= 0) source[key] = inputSource[key];
  }
  if (!source.path && inputSource.filePath) source.path = cleanString(inputSource.filePath);
  if (!source.url && inputSource.pageUrl) source.url = cleanString(inputSource.pageUrl);
  if (!source.title && inputSource.pageTitle) source.title = cleanString(inputSource.pageTitle);
  const label = cleanString(value.label || source.title || source.name || source.relativePath || source.path || kind, 160).replace(/[\r\n]+/g, " ").trim() || kind;
  const record = { version: 1, id, kind, type: kind, label, source };
  for (const key of ["text", "diff", "comment"]) {
    if (typeof value[key] === "string") record[key] = boundedText(value[key], key === "comment" ? 4000 : MAX_CONTEXT_TEXT);
  }
  if (typeof value.imageId === "string") record.imageId = stableId(value.imageId);
  if (typeof value.attachmentId === "string") record.attachmentId = stableId(value.attachmentId);
  if (typeof value.unavailable === "boolean") record.unavailable = value.unavailable;
  return record;
}

export function normalizeContextRecords(records) {
  if (!Array.isArray(records)) return [];
  const result = new Map();
  let total = 0;
  for (const value of records.slice(0, MAX_CONTEXT_RECORDS * 2)) {
    const record = normalizeContextRecord(value);
    if (!record) continue;
    const key = `${record.kind}:${record.id}`;
    const size = JSON.stringify(record).length;
    if (total + size > MAX_CONTEXT_TOTAL || (!result.has(key) && result.size >= MAX_CONTEXT_RECORDS)) continue;
    total += size;
    result.set(key, record);
  }
  return [...result.values()];
}

export function mergeContextRecords(current, incoming) {
  const merged = new Map(normalizeContextRecords(current).map(record => [`${record.kind}:${record.id}`, record]));
  for (const record of normalizeContextRecords(incoming)) merged.set(`${record.kind}:${record.id}`, record);
  return normalizeContextRecords([...merged.values()]);
}

export function serializeContextToken(value) {
  const record = normalizeContextRecord(value);
  return record ? `[${escapeLabel(record.label)}](pixice-context://v1/${record.kind}/${encodeContextId(record.id)})` : "";
}

export function parseContextTokens(text) {
  if (typeof text !== "string") return [];
  const tokens = [];
  for (const match of text.matchAll(new RegExp(TOKEN.source, "g"))) {
    if (!CONTEXT_KINDS.includes(match[3])) continue;
    let id;
    try { id = decodeURIComponent(match[4]); } catch { continue; }
    if (!id || id.length > 512) continue;
    tokens.push({ start: match.index, end: match.index + match[0].length, source: match[0], url: match[2], label: unescapeLabel(match[1]), id, kind: match[3], type: match[3] });
  }
  return tokens;
}

export function referencedContextRecords(text, records) {
  const keys = new Set(parseContextTokens(text).map(token => `${token.kind}:${token.id}`));
  return normalizeContextRecords(records).filter(record => keys.has(`${record.kind}:${record.id}`));
}

export function createContextRecord(kind, data = {}) {
  const normalizedKind = ALIASES[kind] ?? kind;
  const source = data.source ?? {};
  const stable = normalizedKind === "thread" ? source.threadId
    : normalizedKind === "file" || normalizedKind === "skill" ? source.path
    : normalizedKind === "pull-request" ? source.url
    : normalizedKind === "image" ? data.imageId ?? data.attachmentId : null;
  const id = data.id || (stable ? `${normalizedKind}:${source.projectId || ""}:${stable}` : globalThis.crypto?.randomUUID?.() || `ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return normalizeContextRecord({ ...data, id, kind: normalizedKind });
}

export function contextSendIssues(text, records, scope = {}) {
  const byId = new Map(normalizeContextRecords(records).map(record => [`${record.kind}:${record.id}`, record]));
  const issues = new Map();
  for (const token of parseContextTokens(text)) {
    const key = `${token.kind}:${token.id}`;
    const record = byId.get(key);
    if (!record || record.unavailable) {
      issues.set(key, { ...token, reason: "missing", message: `Reselect ${token.label}: its context is unavailable.` });
      continue;
    }
    const source = record.source;
    const scopedResource = ["file", "image", "skill", "thread", "pull-request"].includes(record.kind);
    if (scopedResource && ((source.projectId && scope.projectId && source.projectId !== scope.projectId) || (source.hostId && scope.hostId && source.hostId !== scope.hostId))) {
      issues.set(key, { ...token, reason: "scope", message: `Reselect ${record.label}: it belongs to another project or host.` });
    } else if ((record.kind === "image" || (record.kind === "file" && (record.attachmentId || source.attachmentId))) && Array.isArray(scope.attachments) && !scope.attachments.some(attachment => [record.imageId, record.attachmentId, source.attachmentId].filter(Boolean).includes(attachment.id))) {
      issues.set(key, { ...token, reason: "attachment", message: `Reselect ${record.label}: its ${record.kind === "image" ? "image" : "file"} is no longer attached.` });
    }
  }
  return [...issues.values()];
}

function contextProviderBlock(record) {
  const source = record.source;
  const details = [];
  if (source.title && source.title !== record.label) details.push(`Title: ${source.title}`);
  if (source.path) details.push(`Path: ${source.path}`);
  if (source.url) details.push(`URL: ${source.url}`);
  if (source.threadId) details.push(`Thread: ${source.threadId}${source.projectId ? ` (project ${source.projectId})` : ""}`);
  if (source.messageId) details.push(`Message: ${source.messageId}`);
  if (source.itemId) details.push(`Item: ${source.itemId}`);
  if (source.turnId) details.push(`Turn: ${source.turnId}`);
  if (source.terminalId || source.terminalLabel) details.push(`Terminal: ${source.terminalLabel || source.terminalId}${source.terminalLabel && source.terminalId ? ` (${source.terminalId})` : ""}`);
  if (source.rangeLabel || source.lineStart != null) details.push(`Selection: ${source.rangeLabel || `${source.lineStart}${source.lineEnd != null ? `–${source.lineEnd}` : ""}`}`);
  if (source.selector) details.push(`Element: ${source.selector}`);
  if (source.state) details.push(`State: ${source.state}`);
  if (source.baseBranch || source.headBranch) details.push(`Branches: ${source.headBranch || "?"} → ${source.baseBranch || "?"}`);
  if (record.kind === "thread") details.push(`Read this thread's history on demand with pixice_bridge.read_thread({targetThreadId:${JSON.stringify(source.threadId || "")}}). Follow its pagination when more history is needed. This reference does not authorize sending messages to it.`);
  if (record.kind === "skill") details.push("Use the referenced skill and read its instructions before applying it.");
  if (record.kind === "image") details.push(`Image attachment: ${record.label} (reference ${record.imageId || record.attachmentId || source.attachmentId || record.id})`);
  if (record.kind === "file" && (record.attachmentId || source.attachmentId)) details.push(`File attachment: ${record.label} (reference ${record.attachmentId || source.attachmentId})`);
  if (record.kind !== "thread" && record.text) details.push(`Selected source content:\n${record.text}`);
  if (record.kind !== "thread" && record.diff) details.push(`Selected diff:\n${record.diff}`);
  if (record.comment) details.push(`User comment:\n${record.comment}`);
  return `\n<context-reference kind=${JSON.stringify(record.kind)} label=${JSON.stringify(record.label)}>\n${details.join("\n")}\n</context-reference>\n`;
}

// Expand only chips still present in the draft. Removing a chip cannot silently
// keep sending its former excerpt; thread references never pull eager history.
export function serializeContextForProvider(text, records) {
  const source = typeof text === "string" ? text : "";
  const byId = new Map(normalizeContextRecords(records).map(record => [`${record.kind}:${record.id}`, record]));
  let result = "";
  let offset = 0;
  for (const token of parseContextTokens(source)) {
    result += source.slice(offset, token.start);
    const record = byId.get(`${token.kind}:${token.id}`);
    result += record ? contextProviderBlock(record) : `${token.label} (context unavailable)`;
    offset = token.end;
  }
  return result + source.slice(offset);
}

// Conversation presentation only. These labels confer no source authority and
// never create records, read history, interpret HTML, or affect provider input.
export function contextPromptTextForDisplay(text) {
  if (typeof text !== "string") return "";
  const displayTokens = source => {
    let result = "";
    let offset = 0;
    for (const token of parseContextTokens(source)) {
      result += source.slice(offset, token.start) + token.label;
      offset = token.end;
    }
    return result + source.slice(offset);
  };
  const opener = /<context-reference\s+kind=("(?:\\.|[^"\\])*")\s+label=("(?:\\.|[^"\\])*")\s*>/g;
  const closingTag = "</context-reference>";
  let displayed = "";
  let offset = 0;
  let match;
  while ((match = opener.exec(text))) {
    const close = text.indexOf(closingTag, opener.lastIndex);
    // No later opening can form a complete block without a closing tag.
    if (close < 0) return displayed + displayTokens(text.slice(offset, match.index)) + text.slice(match.index);
    const end = close + closingTag.length;
    let kind;
    let label;
    try { kind = JSON.parse(match[1]); label = JSON.parse(match[2]); } catch { /* Keep malformed attribute encoding untouched. */ }
    if (!CONTEXT_KINDS.includes(kind) || typeof label !== "string") {
      // Keep an unknown transport-looking block intact, including its body.
      displayed += displayTokens(text.slice(offset, match.index)) + text.slice(match.index, end);
      offset = end;
      opener.lastIndex = end;
      continue;
    }
    displayed += displayTokens(text.slice(offset, match.index)) + label;
    offset = end;
    opener.lastIndex = end;
  }
  return displayed + displayTokens(text.slice(offset));
}

export function encodeContextClipboard(text, records, source = {}) {
  return JSON.stringify({ version: 1, text: boundedText(text, MAX_CONTEXT_TOTAL), records: referencedContextRecords(text, records), source: { projectId: cleanString(source.projectId, 512), threadId: cleanString(source.threadId, 512), hostId: cleanString(source.hostId, 512) } });
}

export function decodeContextClipboard(value) {
  if (typeof value !== "string" || value.length > MAX_CONTEXT_TOTAL * 2) return null;
  try {
    const payload = JSON.parse(value);
    if (payload.version !== 1 || typeof payload.text !== "string") return null;
    return { version: 1, text: boundedText(payload.text, MAX_CONTEXT_TOTAL), records: referencedContextRecords(payload.text, payload.records), source: payload.source && typeof payload.source === "object" ? { projectId: cleanString(payload.source.projectId, 512), threadId: cleanString(payload.source.threadId, 512), hostId: cleanString(payload.source.hostId, 512) } : {} };
  } catch { return null; }
}

export function composerContextTrigger(text, selectionStart = text?.length ?? 0) {
  if (typeof text !== "string") return null;
  const before = text.slice(0, selectionStart);
  const match = /(?:^|[\s(])([@#])([^\s@#]*)$/.exec(before);
  if (!match) return null;
  const start = selectionStart - match[2].length - 1;
  if (parseContextTokens(text).some(token => start >= token.start && start < token.end)) return null;
  return { marker: match[1], query: match[2], start, end: selectionStart, kind: match[1] === "#" ? "pull-request" : "all" };
}

export function requestComposerContext({ projectId, threadId = null, hostId, record, records, target = globalThis.window } = {}) {
  const normalized = normalizeContextRecords(records ?? (record ? [record] : []));
  if (!projectId || !normalized.length || !target?.dispatchEvent) return false;
  const destinationHost = hostId || normalized[0]?.source.hostId || "local";
  const key = insertionScope(projectId, threadId, destinationHost);
  const delivery = deliveryFor(target);
  if (!delivery.subscriptions.get(key)) {
    const pending = mergeContextRecords(delivery.pending.get(key)?.records ?? [], normalized).slice(-16);
    delivery.pending.delete(key);
    delivery.pending.set(key, { at: Date.now(), records: pending });
    while (delivery.pending.size > 16) delivery.pending.delete(delivery.pending.keys().next().value);
  }
  target.dispatchEvent(new CustomEvent(COMPOSER_CONTEXT_EVENT, { detail: { projectId, threadId, hostId: destinationHost, records: normalized } }));
  return true;
}

export function subscribeComposerContext({ projectId, threadId = null, hostId = "local", onInsert, target = globalThis.window } = {}) {
  if (!target?.addEventListener) return () => {};
  const key = insertionScope(projectId, threadId, hostId);
  const delivery = deliveryFor(target);
  delivery.subscriptions.set(key, (delivery.subscriptions.get(key) ?? 0) + 1);
  const listener = (event) => {
    const detail = event.detail;
    if (!detail || insertionScope(detail.projectId, detail.threadId, detail.hostId) !== key) return;
    const records = normalizeContextRecords(detail.records);
    if (records.length) onInsert?.(records);
  };
  target.addEventListener(COMPOSER_CONTEXT_EVENT, listener);
  const pending = delivery.pending.get(key);
  if (pending) { delivery.pending.delete(key); onInsert?.(pending.records); }
  return () => {
    target.removeEventListener(COMPOSER_CONTEXT_EVENT, listener);
    const count = delivery.subscriptions.get(key) ?? 1;
    if (count <= 1) delivery.subscriptions.delete(key); else delivery.subscriptions.set(key, count - 1);
  };
}
