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
    summary: "Highest-depth GPT option for architecture, difficult debugging, and consequential code changes.",
    strengths: ["architecture", "hard debugging", "security analysis", "complex refactors"],
    ratings: rating(5, 5, 4, 4, 3, 2)
  }
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

function gptProfile(id) {
  if (!id.includes("5.6")) return null;
  return Object.entries(GPT_56_PROFILES).find(([family]) => id.includes(family))?.[1] ?? null;
}

function claudeProfile(id) {
  return Object.entries(CLAUDE_PROFILES).find(([family]) => id.includes(family))?.[1]
    ?? CLAUDE_PROFILES.default;
}

export function bridgeModelProfile(model) {
  const id = normalizedModelId(model);
  const provider = model?.provider ?? (id.includes("claude") ? "claude" : "codex");
  const profile = provider === "claude" ? claudeProfile(id) : gptProfile(id);
  if (!profile) return { eligible: false };
  return {
    eligible: true,
    provider,
    ...profile,
    ratingScale: { minimum: 1, maximum: 5 }
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
  return candidates[0] ?? null;
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
      reason: explicitlyClaude
        ? "The task explicitly asks for Claude."
        : !gptModels.length
          ? "Claude is the only connected model family available to the bridge."
          : "This task centers on UI design or taste, where Claude generally has the stronger prior."
    };
  }

  if (gptModels.length) {
    const deepTask = includesAny(taskText, ["architecture", "security", "hard debugging", "deep reasoning", "complex refactor"]);
    const routineTask = includesAny(taskText, ["routine", "mechanical", "search", "run tests", "small edit", "quick check", "high volume"]);
    const families = deepTask ? ["sol", "terra", "luna"] : routineTask ? ["luna", "terra", "sol"] : ["terra", "luna", "sol"];
    const model = preferredModel(eligible, "codex", families);
    return {
      modelId: model.id,
      provider: "codex",
      reason: deepTask
        ? "GPT is preferred for cost efficiency; Sol best fits this unusually deep technical task."
        : routineTask
          ? "GPT is preferred for cost efficiency; Luna best fits routine or high-volume work."
          : "GPT is the normal default for cost-effective delegation; Terra provides the best general balance."
    };
  }

  const model = preferredModel(eligible, "claude", ["sonnet", "opus", "default", "haiku"]);
  return {
    modelId: model.id,
    provider: "claude",
    reason: "Claude is the only connected model family available to the bridge."
  };
}
