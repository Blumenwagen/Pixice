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
