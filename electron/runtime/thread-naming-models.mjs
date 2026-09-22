import { bridgeEligibleModels, selectAdvertisedReasoningEffort } from "./model-capabilities.mjs";

export const THREAD_NAMING_AUTO = "auto";
export const THREAD_NAMING_OFF = "off";

function normalizedModel(model) {
  return String(model?.model ?? model?.id ?? model ?? "").toLowerCase();
}

function qualifiedModelId(model) {
  const id = String(model?.model ?? model?.id ?? "");
  if (!id) return "";
  return id.includes(":") || !model?.provider ? id : `${model.provider}:${id}`;
}

function numericSignal(model, key) {
  const value = model?.bridge?.ratings?.[key] ?? model?.[key] ?? model?.metadata?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function namingSuitability(model) {
  const id = normalizedModel(model);
  const familySignal = ["luna", "haiku", "mini", "nano", "flash", "fast", "lite", "small"]
    .some((family) => id.includes(family)) ? 4 : 0;
  return numericSignal(model, "speed")
    + numericSignal(model, "costEfficiency")
    + familySignal
    + (model.isDefault ? 0.5 : 0);
}

export function threadNamingModels(models = []) {
  return bridgeEligibleModels(models)
    .map((model, index) => ({ model, index, score: namingSuitability(model) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ model }) => model);
}

export function resolveThreadNamingModel(selection = THREAD_NAMING_AUTO, models = []) {
  if (selection === THREAD_NAMING_OFF) return null;
  const eligible = threadNamingModels(models);
  let selected = null;
  if (!selection || selection === THREAD_NAMING_AUTO) {
    selected = eligible[0] ?? null;
  } else {
    selected = eligible.find((model) => qualifiedModelId(model) === selection) ?? null;
  }
  if (!selected) return null;
  return {
    id: qualifiedModelId(selected),
    model: selected.model ?? selected.id,
    provider: selected.provider,
    displayName: selected.displayName ?? selected.model ?? selected.id,
    effort: selectAdvertisedReasoningEffort(selected, { preferLow: true })
  };
}
