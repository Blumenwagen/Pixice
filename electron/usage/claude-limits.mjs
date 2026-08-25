function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function resetEpoch(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp / 1000 : null;
}

function normalizeWindow(window, windowDurationMins, label = null) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizedPercent(window.utilization);
  const resetsAt = resetEpoch(window.resets_at);
  if (usedPercent === null && resetsAt === null) return null;
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowDurationMins,
    resetsAt,
    label
  };
}

function slug(value) {
  return String(value ?? "model").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}

export function normalizeClaudeRateLimits(response, fetchedAt = new Date()) {
  const rateLimits = response?.rate_limits;
  if (response?.rate_limits_available !== true || !rateLimits || typeof rateLimits !== "object") {
    return {
      status: "unavailable",
      provider: "claude",
      label: "Claude",
      fetchedAt: new Date(fetchedAt).toISOString(),
      planType: response?.subscription_type ?? null,
      message: "Claude plan limits are not available for this account. API key and third-party provider sessions do not expose subscription allowances."
    };
  }

  const limits = [];
  const generalWindows = [
    normalizeWindow(rateLimits.five_hour, 300),
    normalizeWindow(rateLimits.seven_day, 10_080)
  ].filter(Boolean);
  if (generalWindows.length) limits.push({ id: "claude", name: "Claude", windows: generalWindows });

  const namedWindows = [
    ["claude_oauth_apps", "OAuth apps", rateLimits.seven_day_oauth_apps],
    ["claude_opus", "Claude Opus", rateLimits.seven_day_opus],
    ["claude_sonnet", "Claude Sonnet", rateLimits.seven_day_sonnet]
  ];
  for (const [id, name, window] of namedWindows) {
    const normalized = normalizeWindow(window, 10_080);
    if (normalized) limits.push({ id, name, windows: [normalized] });
  }

  for (const [index, model] of (Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []).entries()) {
    const name = String(model?.display_name ?? "Model limit").trim() || "Model limit";
    const window = normalizeWindow(model, 10_080);
    if (window) limits.push({ id: `claude_model_${slug(name)}_${index}`, name, windows: [window] });
  }

  const extraUsage = rateLimits.extra_usage;
  if (extraUsage?.is_enabled) {
    const window = normalizeWindow(extraUsage, null, "Monthly extra usage");
    if (window) {
      const currency = typeof extraUsage.currency === "string" && extraUsage.currency.trim() ? extraUsage.currency.trim().toUpperCase() : "USD";
      const used = finiteNumber(extraUsage.used_credits);
      const limit = finiteNumber(extraUsage.monthly_limit);
      limits.push({
        id: "claude_extra_usage",
        name: "Extra usage",
        windows: [{ ...window, detail: used !== null && limit !== null ? { used, limit, currency } : null }]
      });
    }
  }

  return {
    status: "available",
    provider: "claude",
    label: "Claude",
    fetchedAt: new Date(fetchedAt).toISOString(),
    planType: response?.subscription_type ?? null,
    limits: limits.map((limit) => ({
      ...limit,
      planType: response?.subscription_type ?? null,
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      rateLimitReachedType: null
    })),
    resetCredits: { availableCount: 0, credits: [] }
  };
}

export async function readClaudeRateLimits(provider) {
  if (!provider?.connected || typeof provider.usageLimits !== "function") return null;
  try {
    const result = await provider.usageLimits();
    if (!result?.authenticated) return null;
    return normalizeClaudeRateLimits(result.usage);
  } catch (error) {
    return {
      status: "unavailable",
      provider: "claude",
      label: "Claude",
      fetchedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Claude limits could not be loaded."
    };
  }
}
