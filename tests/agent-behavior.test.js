import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentBehaviorCatalog, composeAgentInstructions, resolveAgentBehaviors } from "../electron/runtime/agent-behavior.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseInstructionsPath = path.join(root, "resources/runtime/pixice-developer-instructions.md");
const behaviorsDirectory = path.join(root, "resources/runtime/agent-behaviors");

describe("agent behavior packs", () => {
  it("exposes UI metadata without local resource paths", () => {
    const catalog = agentBehaviorCatalog();
    expect(catalog.map((behavior) => behavior.id)).toEqual([
      "structuredPlanning",
      "parallelDelegation",
      "verification",
      "unslop",
      "workflowAutomation",
      "boardStewardship",
      "threadOrchestration",
      "tools"
    ]);
    expect(catalog.every((behavior) => !("filename" in behavior))).toBe(true);
    expect(catalog.filter((behavior) => behavior.category === "pixice-native")).toHaveLength(4);
  });

  it("uses safe defaults and honors persisted overrides", () => {
    expect(resolveAgentBehaviors({ parallelDelegation: true, verification: false })).toEqual({
      structuredPlanning: true,
      parallelDelegation: true,
      verification: false,
      unslop: false,
      workflowAutomation: false,
      boardStewardship: false,
      threadOrchestration: false,
      tools: false
    });
  });

  it("composes only enabled Markdown packs after Pixice's base guidance", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: true, verification: false }
    });

    expect(instructions).toContain("# Pixice runtime guidance");
    expect(instructions).toContain("# Parallel delegation");
    expect(instructions).not.toContain("# Structured planning");
    expect(instructions).not.toContain("# Verification before handoff");
  });

  it("uses provider-neutral base guidance and names each native project instruction file", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: false, verification: false }
    });

    expect(instructions).toContain("active provider runtime's normal agent behavior");
    expect(instructions).toContain("Codex uses `AGENTS.md`; Claude uses `CLAUDE.md`");
    expect(instructions).not.toContain("control surface for Codex work");
  });

  it("prioritizes Pixice-native visualizations over generic visualization skills", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: false, verification: false }
    });

    expect(instructions).toContain("requests such as `visualize`");
    expect(instructions).toContain("Do not invoke an installed visualization Skill");
    expect(instructions).toContain("Treat `Pixice visualization`, `in-chat visualization`, `inline visualization`, and `native visualization` as explicit format requirements");
    expect(instructions).toContain("takes precedence over Skills or other instructions that would create an HTML file");
  });

  it("asks agents to choose useful native visualizations without an explicit user request", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: false, verification: false }
    });

    expect(instructions).toContain("even when the user does not ask for one");
    expect(instructions).toContain("Add one proactively when it materially reduces the work needed to understand");
    expect(instructions).toContain("three or more values that need comparison");
    expect(instructions).toContain("Never add a chart as decoration");
  });

  it("loads the Unslop writing guidance only when enabled", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: false, verification: false, unslop: true }
    });

    expect(instructions).toContain("# Unslop");
    expect(instructions).toContain("Edit text to remove AI patterns and add human voice.");
  });

  it("loads Pixice-native guidance independently", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: {
        structuredPlanning: false,
        parallelDelegation: false,
        verification: false,
        workflowAutomation: true,
        boardStewardship: false,
        threadOrchestration: true,
        tools: true
      }
    });

    expect(instructions).toContain("# Workflow-first automation");
    expect(instructions).toContain("# Thread orchestration");
    expect(instructions).toContain("# Tools");
    expect(instructions).toContain("Do not wait for the user to mention workflows.");
    expect(instructions).toContain("Do not merely describe the option.");
    expect(instructions).toContain("Pixice Tools let an agent add project-specific controls and views to Pixice without forking Pixice");
    expect(instructions).toContain("Consider creating one when the user asks for project-specific controls");
    expect(instructions).toContain("Do not substitute a Tool when the user asked to change the product's actual UI or project code.");
    expect(instructions).toContain("Use `sendAgentEvent` only when the next step needs agent judgment.");
    expect(instructions).not.toContain("# Board stewardship");
  });

  it("loads proactive board guidance when board stewardship is enabled", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: {
        structuredPlanning: false,
        parallelDelegation: false,
        verification: false,
        boardStewardship: true
      }
    });

    expect(instructions).toContain("# Board stewardship");
    expect(instructions).toContain("Do not wait for the user to mention the board.");
    expect(instructions).toContain("inspect it at the start of a substantial task");
    expect(instructions).toContain("capture a newly discovered follow-up when it is clearly outside the current scope");
    expect(instructions).toContain("Do not mirror an agent's plan or temporary implementation checklist onto the board.");
  });
});
