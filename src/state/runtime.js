export function threadStatus(thread) {
  const status = thread?.status;
  if (typeof status === "string") return status;
  if (!status?.type) return "idle";
  if (status.type === "active" && status.activeFlags?.length) return "attention";
  return status.type === "active" ? "running" : status.type;
}

export function stripPreviewContext(text) {
  return String(text ?? "")
    .replace(/\s*<pixice-preview-context>[\s\S]*?<\/pixice-preview-context>/g, "")
    .trim();
}

export function threadTitle(thread) {
  return thread?.name?.trim() || stripPreviewContext(thread?.preview) || "Untitled task";
}

export function isSidebarThread(thread) {
  return !thread?.parentThreadId
    || thread?.bridge?.kind === "pixiceBridge"
    || Boolean(thread?.bridgeModel);
}

export function flattenItems(thread) {
  return (thread?.turns ?? []).flatMap((turn) =>
    (turn.items ?? []).map((item) => ({ ...item, turnId: turn.id, turnStatus: turn.status }))
  );
}

const turnIndexes = new WeakMap();
const itemIndexes = new WeakMap();
const itemRevisions = new WeakMap();
const turnRevisions = new WeakMap();

function indexesFor(values, cache) {
  let indexes = cache.get(values);
  if (indexes) return indexes;
  indexes = new Map(values.map((value, index) => [value.id, index]));
  cache.set(values, indexes);
  return indexes;
}

export function coalesceRuntimeDeltas(payloads = []) {
  const coalesced = [];
  const positions = new Map();
  for (const payload of payloads) {
    if (payload?.method !== "item/agentMessage/delta" || !payload.threadId || !payload.turnId || !payload.itemId) {
      coalesced.push(payload);
      continue;
    }
    const key = `${payload.threadId}\u0000${payload.turnId}\u0000${payload.itemId}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, coalesced.length);
      coalesced.push(payload);
      continue;
    }
    const existing = coalesced[position];
    coalesced[position] = {
      ...existing,
      ...payload,
      delta: `${existing.delta ?? ""}${payload.delta ?? ""}`,
      receivedAt: payload.receivedAt ?? existing.receivedAt
    };
  }
  return coalesced;
}

function hashRuntimeString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function runtimeValueSignature(value) {
  if (value == null) return "0";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return `${serialized.length}:${hashRuntimeString(serialized)}`;
}

function runtimeItemRevision(item) {
  let revision = itemRevisions.get(item);
  if (revision) return revision;
  revision = [
    item.id,
    item.type,
    item.status,
    item.phase,
    item.createdAt,
    item.completedAt,
    runtimeValueSignature(item.command),
    runtimeValueSignature(item.text),
    runtimeValueSignature(item.aggregatedOutput),
    runtimeValueSignature(item.result),
    runtimeValueSignature(item.revisedPrompt),
    item.savedPath,
    runtimeValueSignature(item.failure),
    runtimeValueSignature(item.content),
    runtimeValueSignature(item.summary),
    runtimeValueSignature(item.changes)
  ].join(":");
  itemRevisions.set(item, revision);
  return revision;
}

export function runtimeTurnRevision(turn) {
  let revision = turnRevisions.get(turn);
  if (revision) return revision;
  revision = `${turn.id}:${turn.status}:${turn.startedAt ?? turn.createdAt ?? ""}:${turn.completedAt ?? ""}:${(turn.items ?? []).map(runtimeItemRevision).join("|")}`;
  turnRevisions.set(turn, revision);
  return revision;
}

export function runtimeThreadRevision(thread) {
  return [
    thread?.id ?? "",
    thread?.name ?? "",
    thread?.preview ?? "",
    thread?.updatedAt ?? "",
    threadStatus(thread),
    (thread?.turns ?? []).map(runtimeTurnRevision).join(";")
  ].join(":");
}

function itemFingerprint(item) {
  if (item.type === "userMessage") {
    const content = item.content ?? [];
    const text = stripPreviewContext(content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const imageCount = content.filter((part) => part.type === "image").length;
    return `user:${text ?? ""}:images:${imageCount}`;
  }
  if (item.type === "agentMessage") return `agent:${item.phase ?? ""}:${item.text ?? ""}`;
  if (item.type === "reasoning") return `reasoning:${JSON.stringify(item.summary ?? item.content ?? "")}`;
  if (item.type === "commandExecution") return `command:${item.command ?? ""}`;
  if (item.type === "fileChange") return `file:${item.path ?? item.filePath ?? JSON.stringify(item.changes ?? "")}`;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return `${item.type}:${item.server ?? ""}:${item.tool ?? item.name ?? ""}:${JSON.stringify(item.arguments ?? item.input ?? "")}`;
  }
  if (item.type === "contextCompaction") return "contextCompaction";
  if (item.type === "imageGeneration") return "imageGeneration";
  return null;
}

function mergeTurnItems(currentItems = [], incomingItems = []) {
  if (!incomingItems.length) return currentItems;
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const incomingIds = new Set(incomingItems.map((item) => item.id));
  const consumedCurrentIds = new Set();
  const merged = incomingItems.map((item) => {
    let current = currentById.get(item.id);
    if (!current) {
      const fingerprint = itemFingerprint(item);
      const candidates = currentItems.filter((candidate) =>
        !incomingIds.has(candidate.id)
        && !consumedCurrentIds.has(candidate.id)
        && fingerprint
        && itemFingerprint(candidate) === fingerprint
      );
      current = item.type === "userMessage"
        ? candidates.find((candidate) => String(candidate.id).startsWith("local-user:")) ?? candidates[0]
        : candidates[0];
    }
    if (!current) return item;
    consumedCurrentIds.add(current.id);
    const next = { ...current, ...item, renderId: current.renderId ?? current.id };
    if (item.type === "agentMessage" && (current.text?.length ?? 0) > (item.text?.length ?? 0)) {
      next.text = current.text;
    }
    return next;
  });
  const retained = [];
  currentItems.forEach((item) => {
    if (incomingIds.has(item.id) || consumedCurrentIds.has(item.id)) return;
    retained.push(item);
  });
  const finalIndex = merged.findIndex((item) => item.type === "agentMessage" && item.phase === "final_answer");
  if (finalIndex === -1) merged.push(...retained);
  else merged.splice(finalIndex, 0, ...retained);
  return merged;
}

function eventTimestamp(payload) {
  return payload?.receivedAt ?? new Date().toISOString();
}

function turnStartedAt(turn, fallback) {
  return turn?.startedAt ?? turn?.createdAt ?? fallback;
}

function stampTurnItems(items = [], { startedAt, completedAt } = {}) {
  return items.map((item) => {
    if (item.type === "userMessage" && !item.createdAt) return { ...item, createdAt: startedAt };
    if (item.type === "agentMessage" && item.phase === "final_answer" && !item.createdAt) {
      return { ...item, createdAt: completedAt ?? startedAt };
    }
    return item;
  });
}

function turnIsSettled(status) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export function turnIsCompacting(turn) {
  if (!turn || turnIsSettled(turn.status)) return false;
  const item = [...(turn.items ?? [])].reverse().find((candidate) => candidate.type === "contextCompaction");
  if (!item) return false;
  return !item.completedAt && !turnIsSettled(item.status);
}

function turnFingerprint(turn) {
  const items = turn?.items ?? [];
  const userText = items
    .find((item) => item.type === "userMessage")
    ?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const agentText = items.find((item) => item.type === "agentMessage" && item.text)?.text;
  const visibleUserText = stripPreviewContext(userText);
  return visibleUserText ? `user:${visibleUserText}` : agentText ? `agent:${agentText}` : null;
}

export function mergeThreadSnapshot(current, incoming) {
  if (!current || current.id !== incoming?.id) return incoming ?? current;
  const currentTurns = new Map((current.turns ?? []).map((turn) => [turn.id, turn]));
  const incomingTurnIds = new Set((incoming.turns ?? []).map((turn) => turn.id));
  const consumedCurrentTurnIds = new Set();
  const turns = (incoming.turns ?? []).map((turn) => {
    let existing = currentTurns.get(turn.id);
    if (!existing) {
      const fingerprint = turnFingerprint(turn);
      existing = [...(current.turns ?? [])].reverse().find((candidate) =>
        !incomingTurnIds.has(candidate.id)
        && !consumedCurrentTurnIds.has(candidate.id)
        && fingerprint
        && turnFingerprint(candidate) === fingerprint
      );
    }
    if (!existing) return turn;
    consumedCurrentTurnIds.add(existing.id);
    const status = turnIsSettled(existing.status) && !turnIsSettled(turn.status)
      ? existing.status
      : turn.status;
    const merged = {
      ...existing,
      ...turn,
      renderId: existing.renderId ?? existing.id,
      status,
      items: mergeTurnItems(existing.items, turn.items)
    };
    return runtimeTurnRevision(existing) === runtimeTurnRevision(merged) ? existing : merged;
  });
  (current.turns ?? []).forEach((turn) => {
    if (!incomingTurnIds.has(turn.id) && !consumedCurrentTurnIds.has(turn.id)) turns.push(turn);
  });
  const merged = { ...current, ...incoming, turns };
  return runtimeThreadRevision(current) === runtimeThreadRevision(merged) ? current : merged;
}

function upsertItem(turn, item) {
  const currentItems = turn.items ?? [];
  const currentIndexes = indexesFor(currentItems, itemIndexes);
  const items = [...currentItems];
  let index = currentIndexes.get(item.id) ?? -1;
  if (index === -1 && item.type === "userMessage") {
    const fingerprint = itemFingerprint(item);
    index = items.findIndex((candidate) => String(candidate.id).startsWith("local-user:") && itemFingerprint(candidate) === fingerprint);
  }
  const nextIndexes = new Map(currentIndexes);
  if (index === -1) {
    nextIndexes.set(item.id, items.length);
    items.push(item);
  } else {
    const previousId = items[index].id;
    items[index] = { ...items[index], ...item, renderId: items[index].renderId ?? items[index].id };
    if (previousId !== items[index].id) nextIndexes.delete(previousId);
    nextIndexes.set(items[index].id, index);
  }
  itemIndexes.set(items, nextIndexes);
  return { ...turn, items };
}

function updateTurn(thread, turnId, updater, fallback) {
  const currentTurns = thread.turns ?? [];
  const currentIndexes = indexesFor(currentTurns, turnIndexes);
  const turns = [...currentTurns];
  const index = currentIndexes.get(turnId) ?? -1;
  const nextIndexes = new Map(currentIndexes);
  if (index === -1) {
    const turn = updater(fallback ?? { id: turnId, items: [], status: "inProgress" });
    nextIndexes.set(turn.id, turns.length);
    turns.push(turn);
  } else {
    const previousId = turns[index].id;
    turns[index] = updater(turns[index]);
    if (previousId !== turns[index].id) nextIndexes.delete(previousId);
    nextIndexes.set(turns[index].id, index);
  }
  turnIndexes.set(turns, nextIndexes);
  return { ...thread, turns };
}

export function appendLocalUserMessage(thread, {
  turnId,
  text = "",
  attachments = [],
  createdAt = new Date().toISOString(),
  messageId = null,
  skipIfMatching = false
}) {
  if (!thread || !turnId) return thread;
  const content = [];
  if (text) content.push({ type: "text", text });
  attachments.forEach((attachment) => {
    if (!attachment?.type?.startsWith("image/") || !attachment.dataUrl) return;
    content.push({
      type: "image",
      url: attachment.dataUrl,
      name: attachment.name,
      mimeType: attachment.type
    });
  });
  if (!content.length) return thread;

  return updateTurn(thread, turnId, (turn) => {
    const item = {
      id: messageId ?? `local-user:${turnId}:${createdAt}`,
      type: "userMessage",
      content,
      createdAt
    };
    const fingerprint = itemFingerprint(item);
    if (skipIfMatching && (turn.items ?? []).some((candidate) => itemFingerprint(candidate) === fingerprint)) return turn;
    return { ...turn, items: [...(turn.items ?? []), item] };
  });
}

export function removeLocalUserMessage(thread, { turnId, messageId, removeEmptyTurn = false }) {
  if (!thread || !turnId || !messageId) return thread;
  const turns = (thread.turns ?? []).flatMap((turn) => {
    if (turn.id !== turnId) return [turn];
    const items = (turn.items ?? []).filter((item) => item.id !== messageId);
    if (removeEmptyTurn && items.length === 0) return [];
    return [{ ...turn, items }];
  });
  return { ...thread, turns };
}

export function applyRuntimePayload(thread, payload) {
  if (!thread || !payload || payload.threadId !== thread.id) return thread;
  const method = payload.method;

  if (method === "turn/started" && payload.turn) {
    const receivedAt = eventTimestamp(payload);
    return updateTurn(thread, payload.turn.id, (turn) => ({
      ...turn,
      ...payload.turn,
      startedAt: turnStartedAt(payload.turn, turnStartedAt(turn, receivedAt)),
      items: payload.turn.items?.length
        ? stampTurnItems(payload.turn.items, { startedAt: turnStartedAt(payload.turn, turnStartedAt(turn, receivedAt)) })
        : turn.items ?? []
    }), payload.turn);
  }
  if (method === "turn/completed" && payload.turn) {
    const receivedAt = eventTimestamp(payload);
    return updateTurn(thread, payload.turn.id, (turn) => ({
      ...turn,
      ...payload.turn,
      startedAt: turnStartedAt(payload.turn, turnStartedAt(turn, receivedAt)),
      completedAt: payload.turn.completedAt ?? turn.completedAt ?? receivedAt,
      items: payload.turn.items?.length
        ? stampTurnItems(mergeTurnItems(turn.items, payload.turn.items), {
            startedAt: turnStartedAt(payload.turn, turnStartedAt(turn, receivedAt)),
            completedAt: payload.turn.completedAt ?? turn.completedAt ?? receivedAt
          })
        : turn.items ?? []
    }), payload.turn);
  }
  if ((method === "item/started" || method === "item/completed") && payload.item) {
    const receivedAt = eventTimestamp(payload);
    const item = {
      ...payload.item,
      ...(method === "item/started" && !payload.item.startedAt ? { startedAt: receivedAt } : {}),
      ...(method === "item/completed" && !payload.item.completedAt ? { completedAt: receivedAt } : {}),
      ...(payload.item.type === "agentMessage" && !payload.item.createdAt ? { createdAt: receivedAt } : {})
    };
    return updateTurn(thread, payload.turnId, (turn) => upsertItem(turn, item));
  }
  if (method === "item/agentMessage/delta" && payload.itemId) {
    return updateTurn(thread, payload.turnId, (turn) => {
      const existing = (turn.items ?? []).find((item) => item.id === payload.itemId);
      const item = existing?.type === "agentMessage"
        ? { ...existing, text: `${existing.text ?? ""}${payload.delta ?? ""}` }
        : { id: payload.itemId, type: "agentMessage", text: payload.delta ?? "", phase: "commentary", createdAt: eventTimestamp(payload) };
      return upsertItem(turn, item);
    });
  }
  return thread;
}

export function descendantsOf(threads, rootId) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return threads.filter((thread) => {
    let parentId = thread.parentThreadId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (parentId === rootId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentThreadId;
    }
    return false;
  });
}

function collabThreadStatus(status, tool) {
  if (status === "pendingInit" || status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "errored") return "failed";
  if (status === "interrupted" || status === "shutdown" || status === "notFound") return status;
  return tool === "closeAgent" ? "completed" : "running";
}

export function projectCollabAgents(threads, item) {
  if (item?.type !== "collabAgentToolCall" && item?.type !== "collabToolCall") return threads;
  const receiverIds = [...new Set([
    ...(item.receiverThreadIds ?? []),
    ...Object.keys(item.agentsStates ?? {})
  ])].filter((id) => id && id !== item.senderThreadId);
  if (!receiverIds.length) return threads;

  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  receiverIds.forEach((id) => {
    const existing = byId.get(id);
    const agentState = item.agentsStates?.[id];
    const preview = existing?.preview || item.prompt?.trim() || "Delegated task";
    byId.set(id, {
      id,
      ...existing,
      parentThreadId: existing?.parentThreadId ?? (item.tool === "spawnAgent" ? item.senderThreadId : null),
      preview,
      name: existing?.name ?? null,
      status: collabThreadStatus(agentState?.status, item.tool),
      startedAt: existing?.startedAt ?? item.startedAt ?? item.createdAt ?? new Date().toISOString(),
      agentStatusMessage: agentState?.message ?? existing?.agentStatusMessage ?? null,
      bridge: existing?.bridge ?? (item.bridge ? {
        kind: "pixiceBridge",
        parentThreadId: item.senderThreadId,
        model: item.model ?? null,
        effort: item.effort ?? null
      } : null),
      liveProjection: existing?.liveProjection ?? true
    });
  });
  return [...byId.values()];
}

export function parseDiff(diff) {
  if (!diff?.trim()) return [];
  const files = [];
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = { path: match?.[2] ?? line.slice(11), plus: 0, minus: 0, lines: [line] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) current.plus += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.minus += 1;
  }
  if (current) files.push(current);
  return files.map((file) => ({ ...file, rows: parseDiffRows(file.lines) }));
}

export function reviewFiles(diff, dirtyPaths = []) {
  const files = parseDiff(diff);
  const diffPaths = new Set(files.map((file) => file.path));
  for (const dirtyPath of dirtyPaths ?? []) {
    if (!dirtyPath || diffPaths.has(dirtyPath)) continue;
    files.push({ path: dirtyPath, plus: 0, minus: 0, lines: [], rows: [] });
    diffPaths.add(dirtyPath);
  }
  return files;
}

function parseDiffRows(lines) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ old: null, cur: null, type: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) {
      rows.push({ old: null, cur: null, type: "meta", text: line });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ old: null, cur: newLine, type: "add", text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ old: oldLine, cur: null, type: "del", text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ old: oldLine, cur: newLine, type: "ctx", text });
    oldLine += 1;
    newLine += 1;
  }

  return rows;
}
