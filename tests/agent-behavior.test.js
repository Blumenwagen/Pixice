import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentBehaviorCatalog, composeAgentInstructions, resolveAgentBehaviors } from "../electron/runtime/agent-behavior.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseInstructionsPath = path.join(root, "resources/runtime/loom-developer-instructions.md");
const behaviorsDirectory = path.join(root, "resources/runtime/agent-behaviors");

describe("agent behavior packs", () => {
  it("exposes UI metadata without local resource paths", () => {
    const catalog = agentBehaviorCatalog();
    expect(catalog.map((behavior) => behavior.id)).toEqual([
      "structuredPlanning",
      "parallelDelegation",
      "verification",
      "unslop"
    ]);
    expect(catalog.every((behavior) => !("filename" in behavior))).toBe(true);
  });

  it("uses safe defaults and honors persisted overrides", () => {
    expect(resolveAgentBehaviors({ parallelDelegation: true, verification: false })).toEqual({
      structuredPlanning: true,
      parallelDelegation: true,
      verification: false,
      unslop: false
    });
  });

  it("composes only enabled Markdown packs after Loom's base guidance", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: true, verification: false }
    });

    expect(instructions).toContain("# Loom runtime guidance");
    expect(instructions).toContain("# Parallel delegation");
    expect(instructions).not.toContain("# Structured planning");
    expect(instructions).not.toContain("# Verification before handoff");
  });

  it("prioritizes Loom-native visualizations over generic visualization skills", () => {
    const instructions = composeAgentInstructions({
      baseInstructionsPath,
      behaviorsDirectory,
      settings: { structuredPlanning: false, parallelDelegation: false, verification: false }
    });

    expect(instructions).toContain("requests such as `visualize`");
    expect(instructions).toContain("Do not invoke an installed visualization Skill");
    expect(instructions).toContain("Treat `Loom visualization`, `in-chat visualization`, `inline visualization`, and `native visualization` as explicit format requirements");
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
});
