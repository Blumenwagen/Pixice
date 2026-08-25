import { describe, expect, it, vi } from "vitest";
import { readProviderRateLimits } from "../electron/usage/provider-limits.mjs";

describe("provider rate limits", () => {
  it("returns only providers with authenticated accounts", async () => {
    const codexProvider = {
      connected: true,
      account: vi.fn().mockResolvedValue({ account: null }),
      request: vi.fn()
    };
    const claudeProvider = {
      connected: true,
      usageLimits: vi.fn().mockResolvedValue({
        authenticated: true,
        usage: {
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 25, resets_at: "2026-08-25T12:00:00.000Z" } }
        }
      })
    };

    const result = await readProviderRateLimits({ codexProvider, claudeProvider });

    expect(result.status).toBe("available");
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({ provider: "claude", planType: "pro" });
    expect(codexProvider.request).not.toHaveBeenCalled();
  });

  it("returns a sign-in state when neither provider has an account", async () => {
    const result = await readProviderRateLimits({
      codexProvider: { connected: true, account: vi.fn().mockResolvedValue({ account: null }) },
      claudeProvider: { connected: true, usageLimits: vi.fn().mockResolvedValue({ authenticated: false }) }
    });
    expect(result).toMatchObject({ status: "unavailable", providers: [] });
  });
});
