function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizedPercent(window.usedPercent);
  const windowDurationMins = finiteNumber(window.windowDurationMins);
  const resetsAt = finiteNumber(window.resetsAt);
  if (usedPercent === null && windowDurationMins === null && resetsAt === null) return null;
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowDurationMins,
    resetsAt
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  return {
    hasCredits: Boolean(credits.hasCredits),
    unlimited: Boolean(credits.unlimited),
    balance: credits.balance == null ? null : String(credits.balance)
  };
}

function normalizeLimit(limit, fallbackId) {
  if (!limit || typeof limit !== "object") return null;
  const id = String(limit.limitId ?? fallbackId ?? "").trim();
  if (!id) return null;
  const windows = [normalizeWindow(limit.primary), normalizeWindow(limit.secondary)].filter(Boolean);
  return {
    id,
    name: typeof limit.limitName === "string" && limit.limitName.trim() ? limit.limitName.trim() : null,
    planType: typeof limit.planType === "string" && limit.planType.trim() ? limit.planType.trim() : null,
    windows,
    credits: normalizeCredits(limit.credits),
    individualLimit: finiteNumber(limit.individualLimit),
    spendControlReached: limit.spendControlReached === true,
    rateLimitReachedType: typeof limit.rateLimitReachedType === "string" ? limit.rateLimitReachedType : null
  };
}

export function normalizeCodexRateLimits(response, fetchedAt = new Date()) {
  const byId = response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object"
    ? response.rateLimitsByLimitId
    : {};
  const limits = Object.entries(byId)
    .map(([id, limit]) => normalizeLimit(limit, id))
    .filter(Boolean);
  const primary = normalizeLimit(response?.rateLimits, "codex");
  if (primary && !limits.some((limit) => limit.id === primary.id)) limits.unshift(primary);
  limits.sort((left, right) => {
    if (left.id === primary?.id) return -1;
    if (right.id === primary?.id) return 1;
    return (left.name ?? left.id).localeCompare(right.name ?? right.id);
  });

  const resetCredits = response?.rateLimitResetCredits;
  const availableResetCredits = Math.max(0, Math.floor(finiteNumber(resetCredits?.availableCount) ?? 0));
  return {
    status: "available",
    fetchedAt: new Date(fetchedAt).toISOString(),
    planType: primary?.planType ?? limits.find((limit) => limit.planType)?.planType ?? null,
    limits,
    resetCredits: {
      availableCount: availableResetCredits,
      credits: Array.isArray(resetCredits?.credits)
        ? resetCredits.credits.filter((credit) => credit?.status === "available").map((credit) => ({
          id: String(credit.id ?? ""),
          title: typeof credit.title === "string" ? credit.title : null,
          description: typeof credit.description === "string" ? credit.description : null,
          expiresAt: finiteNumber(credit.expiresAt)
        }))
        : []
    }
  };
}

export async function readCodexRateLimits(runtime) {
  if (!runtime?.connected) {
    return { status: "unavailable", fetchedAt: new Date().toISOString(), message: "Codex is not connected." };
  }
  try {
    const response = await runtime.request("account/rateLimits/read", {});
    return normalizeCodexRateLimits(response);
  } catch (error) {
    return {
      status: "unavailable",
      fetchedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Codex limits could not be loaded."
    };
  }
}
