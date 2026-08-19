import { describe, expect, it } from "vitest";
import { calculateUsageCost, resolveModelPricing } from "../electron/usage/pricing.mjs";

describe("API-equivalent pricing", () => {
  it("separates uncached, cached, cache-write, and output tokens", () => {
    const priced = calculateUsageCost({
      provider: "codex",
      model: "gpt-5.6",
      inputTokens: 10_000,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 2_000,
      inputIncludesCached: true,
      recordedAt: "2026-08-19T12:00:00.000Z"
    });

    expect(priced.pricingModel).toBe("gpt-5.6-sol");
    expect(priced.breakdown).toMatchObject({ input: 0.025, cachedInput: 0.002, cacheWriteInput: 0.00625, output: 0.06 });
    expect(priced.costUsd).toBeCloseTo(0.09325);
  });

  it("uses fast and long-context prices when those tiers apply", () => {
    const fast = calculateUsageCost({
      provider: "codex",
      model: "gpt-5.6-sol",
      serviceTier: "priority",
      inputTokens: 10_000,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 2_000,
      inputIncludesCached: true
    });
    const long = calculateUsageCost({
      provider: "codex",
      model: "gpt-5.6-sol",
      inputTokens: 300_000,
      outputTokens: 10_000,
      inputIncludesCached: true
    });

    expect(fast.serviceTier).toBe("fast");
    expect(fast.costUsd).toBeCloseTo(0.1865);
    expect(long.longContext).toBe(true);
    expect(long.costUsd).toBeCloseTo(3.45);
  });

  it("honors dated Claude pricing and snapshot model ids", () => {
    expect(resolveModelPricing("claude-haiku-4-5-20251001", "claude")?.id).toBe("claude-haiku-4-5");
    const introductory = calculateUsageCost({
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false,
      recordedAt: "2026-08-19T12:00:00.000Z"
    });
    const standard = calculateUsageCost({
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false,
      recordedAt: "2026-09-02T12:00:00.000Z"
    });

    expect(introductory.costUsd).toBeCloseTo(0.0147);
    expect(standard.costUsd).toBeCloseTo(0.02205);
  });
});
