import { describe, expect, it } from "vitest";
import { claudePermissionSettings } from "../electron/providers/claude-provider.mjs";
import { loomBridgeDynamicTools, loomBridgeToolShapes } from "../electron/runtime/loom-bridge.mjs";
import { loomWorkflowTools } from "../electron/workflows/loom-workflows.mjs";

describe("Claude workflow tools", () => {
  it("registers every workflow operation in the shared Pixice bridge catalog", () => {
    const bridgeNames = loomBridgeDynamicTools[0].tools.map((tool) => tool.name);
    for (const workflowTool of loomWorkflowTools) {
      expect(bridgeNames).toContain(workflowTool.name);
      expect(loomBridgeToolShapes[workflowTool.name]).toBeDefined();
    }
  });

  it("allows workflow MCP calls even when the Claude thread is read only", () => {
    const allowed = claudePermissionSettings("read-only").tools;
    for (const workflowTool of loomWorkflowTools) {
      expect(allowed).toContain(`mcp__loom_bridge__${workflowTool.name}`);
    }
  });
});
