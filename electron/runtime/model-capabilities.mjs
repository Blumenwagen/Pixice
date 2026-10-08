function normalizedModelId(model) {
  return String(model?.model ?? model?.id ?? model ?? "").toLowerCase();
}

function rating(coding, reasoning, ui, taste, speed, costEfficiency) {
  return { coding, reasoning, ui, taste, speed, costEfficiency };
}

const GPT_56_PROFILES = {
  luna: {
    label: "Economical workhorse",
    summary: "Near-zero-cost, very fast execution for routine edits, searches, tests, and parallel chores.",
    strengths: ["routine coding", "repository search", "test execution", "high-volume delegation"],
    ratings: rating(3, 3, 2, 2, 5, 5)
  },
  terra: {
    label: "Balanced builder",
    summary: "The default balance of implementation quality, reasoning depth, latency, and cost.",
    strengths: ["feature implementation", "debugging", "code review", "general product work"],
    ratings: rating(4, 4, 3, 3, 4, 4)
  },
  sol: {
    label: "Deep technical specialist",
    summary: "Deep technical GPT option for architecture, difficult debugging, and consequential code changes.",
    strengths: ["architecture", "hard debugging", "security analysis", "complex refactors"],
    ratings: rating(5, 5, 4, 4, 3, 2)
  }
};

const GPT_ASTRA_PROFILE = {
  label: "Advanced reasoning specialist",
  summary: "GPT-6 Astra for complex, demanding coding and reasoning tasks.",
  strengths: ["architecture", "hard debugging", "complex reasoning", "complex refactors"],
  ratings: rating(5, 5, 4, 4, 2, 1)
};

const CLAUDE_PROFILES = {
  opus: {
    label: "Taste and reasoning specialist",
    summary: "Best fit for nuanced product judgment, polished interfaces, and difficult open-ended reasoning.",
    strengths: ["UI design", "product taste", "complex reasoning", "creative direction"],
    ratings: rating(5, 5, 5, 5, 2, 1)
  },
  sonnet: {
    label: "Product-minded builder",
    summary: "Strong implementation with excellent UI judgment and a more moderate cost than Opus.",
    strengths: ["frontend implementation", "UI design", "product iteration", "code review"],
    ratings: rating(4, 4, 5, 5, 3, 2)
  },
  haiku: {
    label: "Fast Claude collaborator",
    summary: "Quick, lower-cost Claude option for focused reviews, small tasks, and lightweight UI feedback.",
    strengths: ["focused review", "small edits", "summarization", "quick UI feedback"],
    ratings: rating(3, 3, 4, 4, 5, 4)
  },
  default: {
    label: "Claude recommended",
    summary: "Lets Claude Code choose its recommended model; a strong choice when the exact family is not important.",
    strengths: ["product work", "UI design", "open-ended reasoning", "implementation"],
    ratings: rating(4, 4, 5, 5, 3, 2)
  }
};

const GENERIC_PROFILE = {
  label: "Discovered agent model",
  summary: "Advertised by the connected provider. Pixice has not assigned a curated capability rating to this model.",
  strengths: [],
  ratings: null,
  rated: false
};

function providerMetadata(model) {
  return [model, model?.metadata, model?.capabilities].filter((value) => value && typeof value === "object");
}

function hasMetadataValue(model, keys, expected) {
  return providerMetadata(model).some((source) => keys.some((key) => source[key] === expected));
}

function explicitNonAgentType(model) {
  const values = providerMetadata(model).flatMap((source) => [source.type, source.kind, source.modelType, source.model_type]);
  return values.some((value) => ["non-agent", "non_agent", "embedding", "image", "audio", "transcription", "realtime"].includes(String(value ?? "").toLowerCase()));
}

function providerExclusion(model) {
  if (hasMetadataValue(model, ["hidden", "isHidden"], true) || hasMetadataValue(model, ["visible", "isVisible"], false)) return "hidden";
  if (hasMetadataValue(model, ["eligible", "isEligible", "bridgeEligible", "agentEligible"], false)) return "ineligible";
  if (hasMetadataValue(model, ["agent", "isAgent", "supportsAgent"], false) || explicitNonAgentType(model)) return "non-agent";
  return null;
}

function gptProfile(id) {
  if (id.includes("gpt-6-astra")) return GPT_ASTRA_PROFILE;
  if (!id.includes("5.6")) return null;
  return Object.entries(GPT_56_PROFILES).find(([family]) => id.includes(family))?.[1] ?? null;
}

function claudeProfile(id) {
  return Object.entries(CLAUDE_PROFILES).find(([family]) => id.includes(family))?.[1]
    ?? null;
}

export function bridgeModelProfile(model) {
  const id = normalizedModelId(model);
  const provider = model?.provider ?? (id.includes("claude") ? "claude" : "codex");
  const exclusionReason = providerExclusion(model);
  if (!id || exclusionReason) return { eligible: false, ...(exclusionReason ? { exclusionReason } : {}) };
  const profile = provider === "claude" ? claudeProfile(id) : gptProfile(id);
  const selectedProfile = profile ?? GENERIC_PROFILE;
  return {
    eligible: true,
    provider,
    ...selectedProfile,
    ...(profile ? { rated: true, ratingScale: { minimum: 1, maximum: 5 } } : {})
  };
}

export function annotateBridgeModel(model) {
  return { ...model, bridge: bridgeModelProfile(model) };
}

export function bridgeEligibleModels(models = []) {
  return models.map(annotateBridgeModel).filter((model) => model.bridge.eligible);
}

function includesAny(value, patterns) {
  return patterns.some((pattern) => value.includes(pattern));
}

function preferredModel(models, provider, families) {
  const candidates = models.filter((model) => model.provider === provider);
  for (const family of families) {
    const match = candidates.find((model) => normalizedModelId(model).includes(family));
    if (match) return match;
  }
  return candidates.find((model) => model.isDefault) ?? candidates[0] ?? null;
}

export function advertisedReasoningEfforts(model) {
  const values = model?.supportedReasoningEfforts ?? model?.reasoningEfforts ?? [];
  return [...new Set(values.map((entry) => entry?.reasoningEffort ?? entry?.effort ?? entry).filter((value) => typeof value === "string" && value))];
}

export function selectAdvertisedReasoningEffort(model, { preferLow = false } = {}) {
  const efforts = advertisedReasoningEfforts(model);
  if (preferLow && efforts.includes("low")) return "low";
  const providerDefault = model?.defaultReasoningEffort ?? model?.defaultEffort ?? null;
  if (providerDefault && (!efforts.length || efforts.includes(providerDefault))) return providerDefault;
  return efforts[0] ?? null;
}

function recommendationReason(model, fallback) {
  if (model.bridge?.rated === false) {
    return model.isDefault
      ? "The provider marks this connected model as its default. Pixice has no curated capability rating for it yet."
      : "This model is advertised by the connected provider. Pixice has no curated capability rating for it yet.";
  }
  return fallback;
}

export function recommendBridgeModel(models = [], task = "") {
  const eligible = bridgeEligibleModels(models);
  const taskText = String(task ?? "").toLowerCase();
  const gptModels = eligible.filter((model) => model.provider === "codex");
  const claudeModels = eligible.filter((model) => model.provider === "claude");
  if (!eligible.length) return null;

  const explicitlyClaude = includesAny(taskText, ["claude", "anthropic", "sonnet", "opus", "haiku"]);
  const uiOrTasteTask = includesAny(taskText, [
    "ui design", "user interface", "visual design", "product design", "design system",
    "layout", "typography", "color palette", "aesthetic", "taste", "interface polish",
    "polish the ui", "mockup"
  ]);
  if (claudeModels.length && (explicitlyClaude || !gptModels.length || uiOrTasteTask)) {
    const model = preferredModel(eligible, "claude", ["sonnet", "opus", "default", "haiku"]);
    return {
      modelId: model.id,
      provider: "claude",
      reason: recommendationReason(model, explicitlyClaude
        ? "The task explicitly asks for Claude."
        : !gptModels.length
          ? "Claude is the only connected model family available to the bridge."
          : "This task centers on UI design or taste, where Claude generally has the stronger prior.")
    };
  }

  if (gptModels.length) {
    const deepTask = includesAny(taskText, ["architecture", "security", "hard debugging", "deep reasoning", "complex refactor"]);
    const routineTask = includesAny(taskText, ["routine", "mechanical", "search", "run tests", "small edit", "quick check", "high volume"]);
    const families = deepTask ? ["astra", "sol", "terra", "luna"] : routineTask ? ["luna", "terra", "sol", "astra"] : ["terra", "luna", "sol", "astra"];
    const model = preferredModel(eligible, "codex", families);
    return {
      modelId: model.id,
      provider: "codex",
      reason: recommendationReason(model, normalizedModelId(model).includes("gpt-6-astra")
        ? "GPT-6 Astra is the connected GPT choice for complex, demanding work."
        : deepTask
          ? "GPT is preferred for cost efficiency; Sol best fits this unusually deep technical task."
          : routineTask
            ? "GPT is preferred for cost efficiency; Luna best fits routine or high-volume work."
            : "GPT is the normal default for cost-effective delegation; Terra provides the best general balance.")
    };
  }

  const model = preferredModel(eligible, "claude", ["sonnet", "opus", "default", "haiku"])
    ?? eligible.find((candidate) => candidate.isDefault)
    ?? eligible[0];
  return {
    modelId: model.id,
    provider: model.provider,
    reason: recommendationReason(model, `${model.provider} is the only connected model provider available to the bridge.`)
  };
}
