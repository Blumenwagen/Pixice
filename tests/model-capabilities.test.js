import { describe, expect, it } from "vitest";
import { bridgeEligibleModels, bridgeModelProfile, recommendBridgeModel } from "../electron/runtime/model-capabilities.mjs";

describe("Pixice bridge model capabilities", () => {
  it("allows only the Luna, Terra, and Sol members of the GPT 5.6 family", () => {
    const models = bridgeEligibleModels([
      { model: "gpt-5.6-luna", provider: "codex" },
      { model: "gpt-5.6-terra", provider: "codex" },
      { model: "gpt-5.6-sol", provider: "codex" },
      { model: "gpt-5.6", provider: "codex" },
      { model: "gpt-5.5", provider: "codex" }
    ]);

    expect(models.map((model) => model.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(models[0].bridge.ratings.costEfficiency).toBe(5);
    expect(models[2].bridge.ratings.reasoning).toBe(5);
  });

  it("supports Astra and prefers it for demanding work with a Sol fallback", () => {
    const astra = { id: "codex:gpt-6-astra", model: "gpt-6-astra", provider: "codex" };
    const sol = { id: "codex:gpt-5.6-sol", model: "gpt-5.6-sol", provider: "codex" };
    const terra = { id: "codex:gpt-5.6-terra", model: "gpt-5.6-terra", provider: "codex" };
    expect(bridgeModelProfile(astra)).toMatchObject({ eligible: true, ratings: { reasoning: 5 } });
    expect(bridgeModelProfile("codex:gpt-6-astra").eligible).toBe(true);
    expect(bridgeModelProfile("gpt-6-astra-2026-09-01").eligible).toBe(true);
    expect(bridgeModelProfile("gpt-6-astra-unknown").eligible).toBe(false);
    expect(recommendBridgeModel([terra, sol, astra], "Review the architecture").modelId).toBe(astra.id);
    expect(recommendBridgeModel([terra, sol], "Review the architecture").modelId).toBe(sol.id);
    expect(recommendBridgeModel([terra, astra], "Implement an endpoint").modelId).toBe(terra.id);
    expect(recommendBridgeModel([astra], "Implement an endpoint")).toMatchObject({ modelId: astra.id, reason: expect.stringContaining("Astra") });
  });

  it("keeps every Claude model and makes taste and UI strengths explicit", () => {
    expect(bridgeModelProfile({ model: "claude-opus-4-1", provider: "claude" })).toMatchObject({
      eligible: true,
      ratings: { ui: 5, taste: 5 }
    });
    expect(bridgeModelProfile({ model: "future-claude-model", provider: "claude" }).eligible).toBe(true);
  });

  it("prefers GPT by default and reserves Claude preference for explicit, UI, taste, or availability cases", () => {
    const models = [
      { id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", provider: "codex" },
      { id: "codex:gpt-5.6-terra", model: "gpt-5.6-terra", provider: "codex" },
      { id: "codex:gpt-5.6-sol", model: "gpt-5.6-sol", provider: "codex" },
      { id: "claude:claude-sonnet-4-6", model: "claude-sonnet-4-6", provider: "claude" }
    ];

    expect(recommendBridgeModel(models, "Implement the API endpoint")).toMatchObject({
      modelId: "codex:gpt-5.6-terra",
      provider: "codex"
    });
    expect(recommendBridgeModel(models, "Review the UI design and typography").provider).toBe("claude");
    expect(recommendBridgeModel(models, "Ask Claude to review this algorithm").provider).toBe("claude");
    expect(recommendBridgeModel(models.slice(0, 3), "Review the UI design").provider).toBe("codex");
    expect(recommendBridgeModel(models.slice(3), "Implement the API endpoint").provider).toBe("claude");
  });
});
