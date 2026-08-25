import path from "node:path";
import { readFileSync } from "node:fs";

export const AGENT_BEHAVIORS = Object.freeze([
  Object.freeze({
    id: "structuredPlanning",
    label: "Structured planning",
    description: "Plan multi-step work, keep progress current, and close out every step.",
    category: "core",
    filename: "structured-planning.md",
    defaultEnabled: true
  }),
  Object.freeze({
    id: "parallelDelegation",
    label: "Parallel delegation",
    description: "Use focused helper agents when independent work can run in parallel.",
    category: "core",
    filename: "parallel-delegation.md",
    defaultEnabled: false
  }),
  Object.freeze({
    id: "verification",
    label: "Verification before handoff",
    description: "Run proportionate checks and report what was actually verified.",
    category: "core",
    filename: "verification.md",
    defaultEnabled: true
  }),
  Object.freeze({
    id: "unslop",
    label: "Unslop writing",
    description: "Cut AI writing tells and use a plainer, more human voice.",
    category: "core",
    filename: "unslop.md",
    defaultEnabled: false
  }),
  Object.freeze({
    id: "workflowAutomation",
    label: "Workflow-first automation",
    description: "Proactively use Pixice workflows for repeatable, scheduled, or reusable processes.",
    category: "pixice-native",
    filename: "workflow-first-automation.md",
    defaultEnabled: false
  }),
  Object.freeze({
    id: "boardStewardship",
    label: "Board stewardship",
    description: "Proactively inspect the board, attach tracked work, and capture durable follow-ups.",
    category: "pixice-native",
    filename: "board-stewardship.md",
    defaultEnabled: false
  }),
  Object.freeze({
    id: "threadOrchestration",
    label: "Thread orchestration",
    description: "Spawn focused Pixice threads for substantial parallel work, second opinions, and cross-model review.",
    category: "pixice-native",
    filename: "thread-orchestration.md",
    defaultEnabled: false
  }),
  Object.freeze({
    id: "tools",
    label: "Tools",
    description: "Extend Pixice with project-specific controls and views without building a separate app.",
    category: "pixice-native",
    filename: "tools.md",
    defaultEnabled: false
  })
]);

export const AGENT_BEHAVIOR_IDS = AGENT_BEHAVIORS.map((behavior) => behavior.id);

export function agentBehaviorCatalog() {
  return AGENT_BEHAVIORS.map(({ filename: _filename, ...behavior }) => behavior);
}

export function resolveAgentBehaviors(settings = {}) {
  return Object.fromEntries(AGENT_BEHAVIORS.map((behavior) => [
    behavior.id,
    typeof settings?.[behavior.id] === "boolean" ? settings[behavior.id] : behavior.defaultEnabled
  ]));
}

export function composeAgentInstructions({ baseInstructionsPath, behaviorsDirectory, settings = {} }) {
  const sections = [readFileSync(baseInstructionsPath, "utf8").trim()];
  const resolved = resolveAgentBehaviors(settings);
  for (const behavior of AGENT_BEHAVIORS) {
    if (!resolved[behavior.id]) continue;
    sections.push(readFileSync(path.join(behaviorsDirectory, behavior.filename), "utf8").trim());
  }
  return sections.filter(Boolean).join("\n\n");
}
