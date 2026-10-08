import { projectRendererThread } from "./renderer-thread-projection.mjs";

const pendingReads = new WeakMap();

// Share only in-flight reads. Completed snapshots must not retain a second
// copy of the conversation or hide subsequent live updates.
export function readRendererThread(runtime, threadId, { cursor = null, limit = 12 } = {}) {
  let pending = pendingReads.get(runtime);
  if (!pending) pendingReads.set(runtime, pending = new Map());
  const key = JSON.stringify([threadId, cursor, limit]);
  if (pending.has(key)) return pending.get(key);
  const request = readPage(runtime, threadId, cursor, limit).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}

async function readPage(runtime, threadId, cursor, limit) {
  if (runtime.providerForThread(threadId) !== "codex") {
    const response = await runtime.request("thread/read", { threadId, includeTurns: true });
    return { ...response, thread: projectRendererThread(response.thread) };
  }
  try {
    const response = await runtime.request("thread/read", { threadId, includeTurns: false });
    const page = await runtime.request("thread/turns/list", {
      threadId, cursor, limit, sortDirection: "desc", itemsView: "full"
    });
    return {
      ...response,
      thread: projectRendererThread({
        ...response.thread,
        turns: [...page.data].reverse(),
        history: { paginated: true, nextCursor: page.nextCursor ?? null }
      })
    };
  } catch (error) {
    // Older CLIs and other providers retain their established read behavior.
    // A timeout or disconnected provider must not trigger a huge fallback read.
    if (!/method not found|unknown method|unsupported method/i.test(error.message)) throw error;
    const response = await runtime.request("thread/read", { threadId, includeTurns: true });
    return { ...response, thread: projectRendererThread(response.thread) };
  }
}
