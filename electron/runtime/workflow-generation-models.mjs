import { bridgeEligibleModels, recommendBridgeModel, selectAdvertisedReasoningEffort } from "./model-capabilities.mjs";

export const WORKFLOW_GENERATION_AUTO = "auto";

function qualifiedModelId(model) {
  const id = String(model?.model ?? model?.id ?? "");
  if (!id) return "";
  return id.includes(":") || !model?.provider ? id : `${model.provider}:${id}`;
}

export function workflowGenerationModels(models = []) {
  return bridgeEligibleModels(models).filter((model) => ["codex", "claude"].includes(model?.provider) && qualifiedModelId(model));
}

export function resolveWorkflowGenerationModel(selection = WORKFLOW_GENERATION_AUTO, models = []) {
  const available = workflowGenerationModels(models);
  let selected = null;
  if (!selection || selection === WORKFLOW_GENERATION_AUTO) {
    const recommendation = recommendBridgeModel(available, "Design a Pixice workflow graph from a description");
    selected = available.find((model) => qualifiedModelId(model) === recommendation?.modelId)
      ?? available.find((model) => model.isDefault)
      ?? available[0]
      ?? null;
  } else {
    selected = available.find((model) => qualifiedModelId(model) === selection) ?? null;
  }
  if (!selected) return null;
  return {
    id: qualifiedModelId(selected),
    model: selected.model ?? selected.id,
    provider: selected.provider,
    displayName: selected.displayName ?? selected.model ?? selected.id,
    effort: selectAdvertisedReasoningEffort(selected)
  };
}
