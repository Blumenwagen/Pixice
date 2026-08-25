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

function isLuna(model) {
  return model?.provider === "codex" && normalizedModel(model).includes("gpt-5.6-luna");
}

function isHaiku(model) {
  return model?.provider === "claude" && normalizedModel(model).includes("haiku");
}

export function threadNamingModels(models = []) {
  return models.filter((model) => isLuna(model) || isHaiku(model));
}

export function resolveThreadNamingModel(selection = THREAD_NAMING_AUTO, models = []) {
  if (selection === THREAD_NAMING_OFF) return null;
  const eligible = threadNamingModels(models);
  let selected = null;
  if (!selection || selection === THREAD_NAMING_AUTO) {
    selected = eligible.find(isLuna) ?? eligible.find(isHaiku) ?? null;
  } else {
    selected = eligible.find((model) => qualifiedModelId(model) === selection) ?? null;
  }
  if (!selected) return null;
  return {
    id: qualifiedModelId(selected),
    model: selected.model ?? selected.id,
    provider: selected.provider,
    displayName: selected.displayName ?? selected.model ?? selected.id,
    effort: selected.provider === "codex" ? "low" : null
  };
}
