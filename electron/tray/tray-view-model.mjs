const WEEK_MINUTES = 7 * 24 * 60;
const SEEN_BASELINE_KEY = "__baselineAt";
const ACCENT_COLORS = new Set(["coral", "rose", "amber", "green", "teal", "blue", "violet", "graphite"]);

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

function weeklyWindow(provider) {
  const candidates = (provider?.limits ?? []).flatMap((limit, limitIndex) =>
    (limit.windows ?? []).map((window, windowIndex) => ({ limit, window, limitIndex, windowIndex }))
  ).filter(({ window }) => Number.isFinite(Number(window?.windowDurationMins)));
  if (!candidates.length) return null;

  candidates.sort((left, right) => {
    const leftDistance = Math.abs(Number(left.window.windowDurationMins) - WEEK_MINUTES);
    const rightDistance = Math.abs(Number(right.window.windowDurationMins) - WEEK_MINUTES);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    if (left.limitIndex !== right.limitIndex) return left.limitIndex - right.limitIndex;
    return left.windowIndex - right.windowIndex;
  });

  const selected = candidates[0];
  if (Math.abs(Number(selected.window.windowDurationMins) - WEEK_MINUTES) > 24 * 60) return null;
  const remainingPercent = finitePercent(selected.window.remainingPercent);
  const usedPercent = finitePercent(selected.window.usedPercent);
  return {
    label: selected.window.label || "Weekly",
    remainingPercent: remainingPercent ?? (usedPercent === null ? null : 100 - usedPercent),
    usedPercent: usedPercent ?? (remainingPercent === null ? null : 100 - remainingPercent),
    resetsAt: Number.isFinite(Number(selected.window.resetsAt)) ? Number(selected.window.resetsAt) : null,
    reached: Boolean(selected.limit.rateLimitReachedType || selected.limit.spendControlReached)
  };
}

function normalizeProvider(provider) {
  const weekly = weeklyWindow(provider);
  return {
    id: String(provider?.provider ?? "provider"),
    label: String(provider?.label ?? provider?.provider ?? "Provider"),
    planType: provider?.planType ? String(provider.planType) : null,
    status: provider?.status === "available" && weekly ? "available" : "unavailable",
    message: weekly ? null : String(provider?.message ?? "This account did not report a weekly limit."),
    weekly
  };
}

function threadCompletionRevision(thread) {
  if (thread?.completionRevision !== undefined && thread?.completionRevision !== null) return String(thread.completionRevision);
  return null;
}

function threadCompletionWasSeen(thread, revision, seenCompletions) {
  const seenRevision = seenCompletions?.[thread.id];
  if (seenRevision !== undefined && seenRevision !== null) return String(seenRevision) === revision;
  const baseline = seenCompletions?.[SEEN_BASELINE_KEY];
  if (!Number.isFinite(baseline)) return true;
  const updatedAt = Date.parse(thread.updatedAt ?? "");
  return Number.isFinite(updatedAt) && updatedAt <= baseline;
}

function progressForThread(thread, status) {
  const plan = Array.isArray(thread.plan) ? thread.plan : [];
  const total = plan.length;
  const completed = plan.filter((step) => step?.status === "completed").length;
  if (status === "unread") return { completed: total || 1, total: total || 1, percent: 100, label: "Completed" };
  if (!total) return { completed: 0, total: 0, percent: null, label: "Working" };
  return { completed, total, percent: Math.round((completed / total) * 100), label: `${completed} of ${total} steps` };
}

export function createTrayWorkItems({ threads = [], activeTurns = [], seenCompletions = {} } = {}) {
  const activeByThread = new Map(activeTurns);
  return threads.flatMap((thread) => {
    if (!thread?.id) return [];
    const activeTurnId = activeByThread.get(thread.id) ?? null;
    if (thread.parentThreadId && !thread.bridgeThread && !activeTurnId) return [];
    const completionRevision = threadCompletionRevision(thread);
    const status = activeTurnId
      ? "active"
      : completionRevision && !threadCompletionWasSeen(thread, completionRevision, seenCompletions)
        ? "unread"
        : null;
    if (!status) return [];
    return [{
      id: String(thread.id),
      turnId: activeTurnId ? String(activeTurnId) : null,
      projectId: thread.projectId ? String(thread.projectId) : null,
      projectName: String(thread.projectName ?? "Unknown project"),
      provider: String(thread.provider ?? "codex"),
      title: String(thread.name ?? thread.preview ?? "Untitled task").trim().slice(0, 160) || "Untitled task",
      updatedAt: thread.updatedAt ?? null,
      status,
      progress: progressForThread(thread, status)
    }];
  }).sort((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
  });
}

export function createTrayViewModel({ limits, summary, activeTurns = 0, workItems = [], keepSystemAwake = false, appearance = {}, appIconDataUrl = null } = {}) {
  const stats = summary?.stats ?? {};
  return {
    activeTurns: Math.max(0, Math.round(Number(activeTurns) || 0)),
    keepSystemAwake: keepSystemAwake === true,
    appearance: {
      accentColor: ACCENT_COLORS.has(appearance?.accentColor) ? appearance.accentColor : "coral",
      reduceTransparency: appearance?.reduceTransparency === true
    },
    appIconDataUrl,
    fetchedAt: limits?.fetchedAt ?? new Date().toISOString(),
    cost: {
      currentWeekUsd: Math.max(0, Number(stats.currentWeekCostUsd) || 0),
      allTimeUsd: Math.max(0, Number(stats.allTimeCostUsd) || 0)
    },
    providers: (limits?.providers ?? []).map(normalizeProvider),
    workItems,
    unreadThreads: workItems.filter((item) => item.status === "unread").length
  };
}

export { weeklyWindow };
