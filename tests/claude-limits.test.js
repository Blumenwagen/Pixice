import { describe, expect, it, vi } from "vitest";
import { normalizeClaudeRateLimits, readClaudeRateLimits } from "../electron/usage/claude-limits.mjs";

const response = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 21, resets_at: "2026-08-25T12:00:00.000Z" },
    seven_day: { utilization: 43, resets_at: "2026-08-30T12:00:00.000Z" },
    seven_day_opus: { utilization: 70, resets_at: "2026-08-30T12:00:00.000Z" },
    model_scoped: [{ display_name: "Fable", utilization: 18, resets_at: "2026-08-30T12:00:00.000Z" }],
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 32, utilization: 32, currency: "usd" }
  }
};

describe("Claude rate limits", () => {
  it("normalizes subscription windows, model limits, and extra usage", () => {
    const result = normalizeClaudeRateLimits(response, "2026-08-25T10:00:00.000Z");

    expect(result).toMatchObject({
      status: "available",
      provider: "claude",
      planType: "max",
      fetchedAt: "2026-08-25T10:00:00.000Z"
    });
    expect(result.limits[0]).toMatchObject({
      id: "claude",
      windows: [
        { usedPercent: 21, remainingPercent: 79, windowDurationMins: 300, resetsAt: 1_787_659_200 },
        { usedPercent: 43, remainingPercent: 57, windowDurationMins: 10_080 }
      ]
    });
    expect(result.limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude_opus", name: "Claude Opus" }),
      expect.objectContaining({ name: "Fable" }),
      expect.objectContaining({ id: "claude_extra_usage", windows: [expect.objectContaining({ detail: { used: 32, limit: 100, currency: "USD" } })] })
    ]));
  });

  it("reports when a session does not expose plan limits", () => {
    expect(normalizeClaudeRateLimits({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toMatchObject({
      status: "unavailable",
      provider: "claude"
    });
  });

  it("omits signed-out Claude and degrades if the experimental SDK call fails", async () => {
    await expect(readClaudeRateLimits({ connected: true, usageLimits: vi.fn().mockResolvedValue({ authenticated: false }) })).resolves.toBeNull();
    await expect(readClaudeRateLimits({ connected: true, usageLimits: vi.fn().mockRejectedValue(new Error("Usage command changed")) })).resolves.toMatchObject({
      status: "unavailable",
      message: "Usage command changed"
    });
  });
});
