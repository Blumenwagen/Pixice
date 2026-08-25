import { describe, expect, it } from "vitest";
import { claudePermissionSettings } from "../electron/providers/claude-provider.mjs";
import { pixiceBridgeDynamicTools, pixiceBridgeToolShapes } from "../electron/runtime/pixice-bridge.mjs";
import { pixiceWorkflowTools } from "../electron/workflows/pixice-workflows.mjs";

describe("Claude workflow tools", () => {
  it("registers every workflow operation in the shared Pixice bridge catalog", () => {
    const bridgeNames = pixiceBridgeDynamicTools[0].tools.map((tool) => tool.name);
    for (const workflowTool of pixiceWorkflowTools) {
      expect(bridgeNames).toContain(workflowTool.name);
      expect(pixiceBridgeToolShapes[workflowTool.name]).toBeDefined();
    }
  });

  it("allows workflow MCP calls even when the Claude thread is read only", () => {
    const allowed = claudePermissionSettings("read-only").tools;
    for (const workflowTool of pixiceWorkflowTools) {
      expect(allowed).toContain(`mcp__pixice_bridge__${workflowTool.name}`);
    }
  });
});
