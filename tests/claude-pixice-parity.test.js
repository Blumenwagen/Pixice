import { describe, expect, it } from "vitest";
import { browserDynamicTools, browserToolShapes } from "../electron/browser/browser-workspace.mjs";
import { instrumentDynamicTools } from "../electron/instruments/instrument-service.mjs";
import { iosDynamicTools } from "../electron/ios/ios-tools.mjs";
import { claudePermissionSettings } from "../electron/providers/claude-provider.mjs";
import { pixiceBoardDynamicTools } from "../electron/runtime/pixice-board.mjs";
import { pixiceBridgeDynamicTools } from "../electron/runtime/pixice-bridge.mjs";
import { questionDynamicTools } from "../electron/runtime/question-tool.mjs";

describe("Claude Pixice feature parity", () => {
  it("allows every shared Pixice tool in Claude's restrictive permission mode", () => {
    const catalogs = [
      questionDynamicTools[0],
      pixiceBridgeDynamicTools[0],
      pixiceBoardDynamicTools[0],
      instrumentDynamicTools[0],
      browserDynamicTools[0],
      iosDynamicTools[0]
    ];
    const readOnlyTools = claudePermissionSettings("read-only").tools;

    for (const catalog of catalogs) {
      for (const definition of catalog.tools) {
        expect(readOnlyTools).toContain(`mcp__${catalog.name}__${definition.name}`);
      }
    }
  });

  it("keeps Claude schemas aligned with the Pixice browser catalog", () => {
    expect(Object.keys(browserToolShapes)).toEqual(browserDynamicTools[0].tools.map((tool) => tool.name));
  });
});
