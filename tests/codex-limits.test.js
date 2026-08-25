import { describe, expect, it, vi } from "vitest";
import { normalizeCodexRateLimits, readCodexRateLimits } from "../electron/usage/codex-limits.mjs";

const response = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_788_153_371 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    planType: "prolite"
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_788_153_371 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "prolite"
    },
    codex_spark: {
      limitId: "codex_spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_788_000_000 },
      secondary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_788_200_000 },
      planType: "prolite"
    }
  },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [{ id: "reset-1", status: "available", title: "Full reset", expiresAt: 1_789_000_000 }]
  }
};

describe("Codex rate limits", () => {
  it("normalizes limit windows and computes the remaining percentage", () => {
    const result = normalizeCodexRateLimits(response, "2026-08-25T10:00:00.000Z");

    expect(result).toMatchObject({
      status: "available",
      fetchedAt: "2026-08-25T10:00:00.000Z",
      planType: "prolite",
      resetCredits: { availableCount: 1 }
    });
    expect(result.limits[0]).toMatchObject({
      id: "codex",
      windows: [{ usedPercent: 34, remainingPercent: 66, windowDurationMins: 10_080 }]
    });
    expect(result.limits[1]).toMatchObject({
      name: "GPT-5.3-Codex-Spark",
      windows: [
        { usedPercent: 12, remainingPercent: 88, windowDurationMins: 300 },
        { usedPercent: 47, remainingPercent: 53, windowDurationMins: 10_080 }
      ]
    });
  });

  it("reads the canonical app-server method and degrades when Codex is offline", async () => {
    const runtime = { connected: true, request: vi.fn().mockResolvedValue(response) };
    await expect(readCodexRateLimits(runtime)).resolves.toMatchObject({ status: "available", planType: "prolite" });
    expect(runtime.request).toHaveBeenCalledWith("account/rateLimits/read", {});
    await expect(readCodexRateLimits({ connected: false })).resolves.toMatchObject({ status: "unavailable" });
  });
});
