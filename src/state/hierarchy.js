export function reconstructHierarchy(threads) {
  const nodes = new Map(threads.map((thread) => [thread.id, { ...thread, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentThreadId ? nodes.get(node.parentThreadId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (node) => {
    node.children.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    node.children.forEach(sort);
    return node;
  };
  return roots.map(sort);
}

export function projectAgentActivity(current, event) {
  if (event.type !== "AgentUpdated") return current;
  const id = event.payload.threadId ?? event.payload.agentId;
  if (!id) return current;
  return { ...current, [id]: { ...current[id], ...event.payload } };
}
