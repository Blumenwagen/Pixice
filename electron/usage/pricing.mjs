const MTOK = 1_000_000;

const rate = (input, cachedInput, output, cacheWriteInput = input) => ({
  input,
  cachedInput,
  cacheWriteInput,
  output
});

// USD per million text tokens. This is intentionally limited to the text models
// Pixice can run as an agent harness; image/audio generation and tool-call fees do
// not share the token usage shape recorded by the runtimes.
const PRICE_CATALOG = [
  {
    provider: "codex",
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    // https://developers.openai.com/api/docs/models/gpt-6-astra
    verifiedAt: "2026-09-05",
    rates: rate(10, 1, 50, 12.5),
    fastRates: rate(20, 2, 100, 25),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    // https://developers.openai.com/api/docs/pricing
    verifiedAt: "2026-09-22",
    rates: rate(2, 0.2, 10, 2.5),
    fastRates: rate(4, 0.4, 20, 5),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    // https://developers.openai.com/api/docs/pricing
    verifiedAt: "2026-09-22",
    rates: rate(0.1, 0.01, 0.5, 0.125),
    fastRates: rate(0.2, 0.02, 1, 0.25),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    aliases: ["gpt-5.6"],
    rates: rate(5, 0.5, 30, 6.25),
    fastRates: rate(10, 1, 60, 12.5),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    rates: rate(2, 0.2, 12, 2.5),
    fastRates: rate(4, 0.4, 24, 5),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    rates: rate(0.2, 0.02, 1.2, 0.25),
    fastRates: rate(0.4, 0.04, 2.4, 0.5),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    rates: rate(30, 30, 180),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.5",
    label: "GPT-5.5",
    rates: rate(5, 0.5, 30),
    fastRates: rate(12.5, 1.25, 75),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    rates: rate(30, 30, 180),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    provider: "codex",
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    rates: rate(0.75, 0.075, 4.5),
    fastRates: rate(1.5, 0.15, 9)
  },
  { provider: "codex", id: "gpt-5.4-nano", label: "GPT-5.4 nano", rates: rate(0.2, 0.02, 1.25) },
  {
    provider: "codex",
    id: "gpt-5.4",
    label: "GPT-5.4",
    rates: rate(2.5, 0.25, 15),
    fastRates: rate(5, 0.5, 30),
    longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  { provider: "codex", id: "gpt-5.3-codex", label: "GPT-5.3 Codex", rates: rate(1.75, 0.175, 14) },
  { provider: "codex", id: "gpt-5.2-codex", label: "GPT-5.2 Codex", rates: rate(1.75, 0.175, 14) },
  { provider: "codex", id: "gpt-5.2", label: "GPT-5.2", rates: rate(1.75, 0.175, 14), fastRates: rate(3.5, 0.35, 28) },
  { provider: "codex", id: "gpt-5.1", label: "GPT-5.1", rates: rate(1.25, 0.125, 10), fastRates: rate(2.5, 0.25, 20) },
  { provider: "codex", id: "gpt-5", label: "GPT-5", rates: rate(1.25, 0.125, 10), fastRates: rate(2.5, 0.25, 20) },
  { provider: "codex", id: "o3-pro", label: "o3-pro", rates: rate(20, 20, 80) },
  { provider: "codex", id: "o3", label: "o3", rates: rate(2, 0.5, 8) },
  { provider: "codex", id: "o4-mini", label: "o4-mini", rates: rate(1.1, 0.275, 4.4) },
  { provider: "codex", id: "gpt-4.1-mini", label: "GPT-4.1 mini", rates: rate(0.4, 0.1, 1.6) },
  { provider: "codex", id: "gpt-4.1-nano", label: "GPT-4.1 nano", rates: rate(0.1, 0.025, 0.4) },
  { provider: "codex", id: "gpt-4.1", label: "GPT-4.1", rates: rate(2, 0.5, 8) },
  { provider: "codex", id: "gpt-4o-mini", label: "GPT-4o mini", rates: rate(0.15, 0.075, 0.6) },
  { provider: "codex", id: "gpt-4o", label: "GPT-4o", rates: rate(2.5, 1.25, 10) },

  // Cache-write prices represent Anthropic's 5-minute cache duration.
  { provider: "claude", id: "claude-fable-5-1", label: "Claude Fable 5.1", verifiedAt: "2026-09-01", rates: rate(10, 0.25, 50, 12.5) },
  { provider: "claude", id: "claude-mythos-5-1", label: "Claude Mythos 5.1", verifiedAt: "2026-09-01", rates: rate(10, 0.25, 50, 12.5) },
  { provider: "claude", id: "claude-opus-5-5", label: "Claude Opus 5.5", verifiedAt: "2026-09-22", rates: rate(4, 0.2, 20, 5) },
  { provider: "claude", id: "claude-fable-5", label: "Claude Fable 5", rates: rate(10, 1, 50, 12.5) },
  { provider: "claude", id: "claude-mythos-5", label: "Claude Mythos 5", rates: rate(10, 1, 50, 12.5) },
  { provider: "claude", id: "claude-opus-5", label: "Claude Opus 5", rates: rate(5, 0.5, 25, 6.25) },
  { provider: "claude", id: "claude-opus-4-8", label: "Claude Opus 4.8", rates: rate(5, 0.5, 25, 6.25) },
  { provider: "claude", id: "claude-opus-4-7", label: "Claude Opus 4.7", rates: rate(5, 0.5, 25, 6.25) },
  { provider: "claude", id: "claude-opus-4-6", label: "Claude Opus 4.6", rates: rate(5, 0.5, 25, 6.25) },
  { provider: "claude", id: "claude-opus-4-5", label: "Claude Opus 4.5", rates: rate(5, 0.5, 25, 6.25) },
  {
    provider: "claude",
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    verifiedAt: "2026-09-23",
    rates: rate(2, 0.2, 10, 2.5)
  },
  { provider: "claude", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", rates: rate(3, 0.3, 15, 3.75) },
  { provider: "claude", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", rates: rate(3, 0.3, 15, 3.75) },
  { provider: "claude", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", rates: rate(1, 0.1, 5, 1.25) },
  { provider: "claude", id: "claude-opus-4-1", label: "Claude Opus 4.1", rates: rate(15, 1.5, 75, 18.75) },
  { provider: "claude", id: "claude-haiku-3-5", label: "Claude Haiku 3.5", rates: rate(0.8, 0.08, 4, 1) }
];

const providerPrefix = /^(?:codex|openai|claude|anthropic):/;

function normalizedModel(model) {
  return String(model ?? "").trim().toLowerCase().replace(providerPrefix, "");
}

function matchesModel(candidate, id) {
  return candidate === id || candidate.startsWith(`${id}-20`);
}

export function resolveModelPricing(model, provider) {
  const candidate = normalizedModel(model);
  const candidates = PRICE_CATALOG
    .filter((entry) => !provider || entry.provider === provider)
    .sort((left, right) => right.id.length - left.id.length);
  return candidates.find((entry) =>
    matchesModel(candidate, entry.id)
    || (entry.aliases ?? []).some((alias) => matchesModel(candidate, alias))
  ) ?? null;
}

function ratesAt(entry, recordedAt) {
  const timestamp = new Date(recordedAt ?? Date.now()).getTime();
  const historical = entry.historicalRates?.find((candidate) => timestamp < Date.parse(candidate.before));
  return historical?.rates ?? entry.rates;
}

export function calculateUsageCost({
  provider,
  model,
  serviceTier,
  inputTokens = 0,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
  outputTokens = 0,
  inputIncludesCached = provider === "codex",
  recordedAt = new Date().toISOString()
}) {
  const pricing = resolveModelPricing(model, provider);
  if (!pricing) return null;
  const standardRates = ratesAt(pricing, recordedAt);
  const fast = serviceTier === "priority" || serviceTier === "fast";
  const selectedRates = fast && pricing.fastRates ? pricing.fastRates : standardRates;
  const cached = Math.max(0, Number(cachedInputTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteInputTokens) || 0);
  const rawInput = Math.max(0, Number(inputTokens) || 0);
  const uncached = inputIncludesCached ? Math.max(0, rawInput - cached - cacheWrite) : rawInput;
  const output = Math.max(0, Number(outputTokens) || 0);
  const pricedInput = uncached + cached + cacheWrite;
  const longContext = pricing.longContext && pricedInput > pricing.longContext.threshold;
  const inputMultiplier = longContext ? pricing.longContext.inputMultiplier : 1;
  const outputMultiplier = longContext ? pricing.longContext.outputMultiplier : 1;
  const breakdown = {
    input: (uncached * selectedRates.input * inputMultiplier) / MTOK,
    cachedInput: (cached * selectedRates.cachedInput * inputMultiplier) / MTOK,
    cacheWriteInput: (cacheWrite * selectedRates.cacheWriteInput * inputMultiplier) / MTOK,
    output: (output * selectedRates.output * outputMultiplier) / MTOK
  };
  return {
    costUsd: breakdown.input + breakdown.cachedInput + breakdown.cacheWriteInput + breakdown.output,
    breakdown,
    pricingModel: pricing.id,
    pricingLabel: pricing.label,
    serviceTier: fast && pricing.fastRates ? "fast" : "standard",
    longContext: Boolean(longContext)
  };
}

export function listPricingCatalog(recordedAt = new Date().toISOString()) {
  return PRICE_CATALOG.map((entry) => ({
    provider: entry.provider,
    model: entry.id,
    label: entry.label,
    verifiedAt: entry.verifiedAt ?? PRICING_VERIFIED_AT,
    rates: ratesAt(entry, recordedAt),
    fastRates: entry.fastRates ?? null
  }));
}

export const PRICING_VERIFIED_AT = "2026-08-19";
