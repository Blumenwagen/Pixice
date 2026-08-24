const ACTIVE_THREAD_STATUSES = new Set(["active", "running", "inprogress", "attention"]);

function activityStatus(thread) {
  const status = thread?.status;
  if (typeof status === "string") return status.toLowerCase();
  if (status?.type === "active" && status.activeFlags?.length) return "attention";
  return String(status?.type ?? "idle").toLowerCase();
}

export function reconcileThreadActivity(thread, activeTurnId) {
  if (!thread || activeTurnId || !ACTIVE_THREAD_STATUSES.has(activityStatus(thread))) return thread;
  return { ...thread, status: { type: "idle", activeFlags: [] } };
}
