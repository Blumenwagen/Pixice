import { describe, expect, it } from "vitest";
import { calculateUsageCost, resolveModelPricing, listPricingCatalog } from "../electron/usage/pricing.mjs";

describe("API-equivalent pricing", () => {
  it("keeps newly discovered models visibly unpriced until metadata is verified", () => {
    expect(resolveModelPricing("gpt-7-nova", "codex")).toBeNull();
    expect(resolveModelPricing("claude-oracle-7", "claude")).toBeNull();
    expect(calculateUsageCost({ provider: "codex", model: "gpt-7-nova", inputTokens: 1_000, outputTokens: 1_000 })).toBeNull();
  });

  it("prices Astra standard, fast, cached, and long-context usage", () => {
    const usage = { provider: "codex", model: "codex:gpt-6-astra", inputTokens: 10_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 1_000, outputTokens: 2_000 };
    expect(calculateUsageCost(usage).costUsd).toBeCloseTo(0.1665);
    expect(calculateUsageCost({ ...usage, serviceTier: "priority" }).costUsd).toBeCloseTo(0.333);
    expect(calculateUsageCost({ ...usage, inputTokens: 272_000 }).longContext).toBe(false);
    const long = calculateUsageCost({ ...usage, inputTokens: 300_000 });
    expect(long.longContext).toBe(true);
    expect(long.costUsd).toBeCloseTo(6.083);
    expect(calculateUsageCost({ ...usage, inputTokens: 300_000, serviceTier: "priority" }).costUsd).toBeCloseTo(12.166);
    expect(resolveModelPricing("gpt-6-astra-2026-09-05", "codex").id).toBe("gpt-6-astra");
    expect(listPricingCatalog()).toContainEqual(expect.objectContaining({
      model: "gpt-6-astra", verifiedAt: "2026-09-05",
      rates: { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 50 },
      fastRates: { input: 20, cachedInput: 2, cacheWriteInput: 25, output: 100 }
    }));
  });

  it("prices GPT-6 Sol and Luna at their advertised standard, priority, and long-context rates", () => {
    const usage = {
      provider: "codex",
      inputTokens: 10_000,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 2_000
    };

    expect(resolveModelPricing("gpt-6-sol-2026-09-22", "codex")?.id).toBe("gpt-6-sol");
    expect(resolveModelPricing("codex:gpt-6-luna", "codex")?.id).toBe("gpt-6-luna");
    expect(calculateUsageCost({ ...usage, model: "gpt-6-sol" }).costUsd).toBeCloseTo(0.0333);
    expect(calculateUsageCost({ ...usage, model: "gpt-6-luna" }).costUsd).toBeCloseTo(0.001665);

    const solPriority = calculateUsageCost({ ...usage, model: "gpt-6-sol", serviceTier: "priority" });
    expect(solPriority.serviceTier).toBe("fast");
    expect(solPriority.costUsd).toBeCloseTo(0.0666);

    const solLong = calculateUsageCost({ ...usage, model: "gpt-6-sol", inputTokens: 300_000 });
    expect(solLong.longContext).toBe(true);
    expect(solLong.costUsd).toBeCloseTo(1.2166);

    expect(listPricingCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "gpt-6-sol", verifiedAt: "2026-09-22",
        rates: { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
        fastRates: { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 }
      }),
      expect.objectContaining({
        model: "gpt-6-luna", verifiedAt: "2026-09-22",
        rates: { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
        fastRates: { input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1 }
      })
    ]));
  });

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

  it("prices current Claude releases with their 5-minute cache-write rates", () => {
    expect(resolveModelPricing("claude-haiku-4-5-20251001", "claude")?.id).toBe("claude-haiku-4-5");
    expect(resolveModelPricing("claude-fable-5-1-20260923", "claude")?.id).toBe("claude-fable-5-1");
    expect(resolveModelPricing("anthropic:claude-mythos-5-1", "claude")?.id).toBe("claude-mythos-5-1");
    expect(resolveModelPricing("claude-opus-5-5-20260923", "claude")?.id).toBe("claude-opus-5-5");

    const fable = calculateUsageCost({
      provider: "claude",
      model: "claude-fable-5-1",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false
    });
    const opus = calculateUsageCost({
      provider: "claude",
      model: "claude-opus-5-5",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false
    });

    expect(fable.costUsd).toBeCloseTo(0.07275);
    expect(opus.costUsd).toBeCloseTo(0.0292);
    expect(listPricingCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "claude-fable-5-1", verifiedAt: "2026-09-01", rates: { input: 10, cachedInput: 0.25, cacheWriteInput: 12.5, output: 50 } }),
      expect.objectContaining({ model: "claude-mythos-5-1", verifiedAt: "2026-09-01", rates: { input: 10, cachedInput: 0.25, cacheWriteInput: 12.5, output: 50 } }),
      expect.objectContaining({ model: "claude-opus-5-5", verifiedAt: "2026-09-22", rates: { input: 4, cachedInput: 0.2, cacheWriteInput: 5, output: 20 } })
    ]));
  });

  it("keeps Claude Sonnet 5 at its unchanged price for historical and current usage", () => {
    const historical = calculateUsageCost({
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false,
      recordedAt: "2026-08-19T12:00:00.000Z"
    });
    const current = calculateUsageCost({
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheWriteInputTokens: 1_000,
      outputTokens: 1_000,
      inputIncludesCached: false,
      recordedAt: "2026-09-02T12:00:00.000Z"
    });

    expect(historical.costUsd).toBeCloseTo(0.0147);
    expect(current.costUsd).toBeCloseTo(0.0147);
    expect(listPricingCatalog()).toContainEqual(expect.objectContaining({
      model: "claude-sonnet-5",
      verifiedAt: "2026-09-23",
      rates: { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 }
    }));
  });
});
