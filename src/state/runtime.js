export function threadStatus(thread) {
  const status = thread?.status;
  if (typeof status === "string") return status;
  if (!status?.type) return "idle";
  if (status.type === "active" && status.activeFlags?.length) return "attention";
  return status.type === "active" ? "running" : status.type;
}

export function threadTitle(thread) {
  return thread?.name?.trim() || thread?.preview?.trim() || "Untitled task";
}

export function flattenItems(thread) {
  return (thread?.turns ?? []).flatMap((turn) =>
    (turn.items ?? []).map((item) => ({ ...item, turnId: turn.id, turnStatus: turn.status }))
  );
}

function upsertItem(turn, item) {
  const items = [...(turn.items ?? [])];
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) items.push(item);
  else items[index] = { ...items[index], ...item };
  return { ...turn, items };
}

function updateTurn(thread, turnId, updater, fallback) {
  const turns = [...(thread.turns ?? [])];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index === -1) turns.push(updater(fallback ?? { id: turnId, items: [], status: "inProgress" }));
  else turns[index] = updater(turns[index]);
  return { ...thread, turns };
}

export function applyRuntimePayload(thread, payload) {
  if (!thread || !payload || payload.threadId !== thread.id) return thread;
  const method = payload.method;

  if (method === "turn/started" && payload.turn) {
    return updateTurn(thread, payload.turn.id, () => payload.turn, payload.turn);
  }
  if (method === "turn/completed" && payload.turn) {
    return updateTurn(thread, payload.turn.id, () => payload.turn, payload.turn);
  }
  if ((method === "item/started" || method === "item/completed") && payload.item) {
    return updateTurn(thread, payload.turnId, (turn) => upsertItem(turn, payload.item));
  }
  if (method === "item/agentMessage/delta" && payload.itemId) {
    return updateTurn(thread, payload.turnId, (turn) => {
      const existing = (turn.items ?? []).find((item) => item.id === payload.itemId);
      const item = existing?.type === "agentMessage"
        ? { ...existing, text: `${existing.text ?? ""}${payload.delta ?? ""}` }
        : { id: payload.itemId, type: "agentMessage", text: payload.delta ?? "", phase: "commentary" };
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
  return files;
}
