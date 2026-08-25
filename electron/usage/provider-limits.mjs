import { readCodexRateLimits } from "./codex-limits.mjs";
import { readClaudeRateLimits } from "./claude-limits.mjs";

async function readSignedInCodexLimits(provider) {
  if (!provider?.connected || typeof provider.account !== "function") return null;
  try {
    const account = await provider.account();
    if (!account?.account) return null;
    const result = await readCodexRateLimits(provider);
    return { ...result, provider: "codex", label: "Codex" };
  } catch {
    return null;
  }
}

export async function readProviderRateLimits({ codexProvider, claudeProvider }) {
  const providers = (await Promise.all([
    readSignedInCodexLimits(codexProvider),
    readClaudeRateLimits(claudeProvider)
  ])).filter(Boolean);
  return {
    status: providers.length ? "available" : "unavailable",
    fetchedAt: new Date().toISOString(),
    providers,
    ...(providers.length ? {} : { message: "Sign in to Codex or Claude in Providers to see live limits." })
  };
}
