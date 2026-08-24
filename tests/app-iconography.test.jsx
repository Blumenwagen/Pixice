import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ICONS } from "../src/components/icons/app-iconography.jsx";
import { WORKFLOW_ICONS } from "../src/components/workflows/workflow-icons.jsx";

const menuIconSource = readFileSync("src/components/icons/menu.tsx", "utf8");

describe("Pixice product iconography", () => {
  it("keeps the primary workspace destinations visually distinct", () => {
    const destinations = [
      APP_ICONS.board,
      APP_ICONS.attention,
      APP_ICONS.review,
      APP_ICONS.preview,
      APP_ICONS.taskMap
    ];

    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("does not reuse the fast-mode glyph for auto-review", () => {
    expect(APP_ICONS.fastMode).not.toBe(APP_ICONS.autoReview);
  });

  it("uses one board glyph in navigation and workflow actions", () => {
    expect(APP_ICONS.board.displayName).toBe("List");
    expect(WORKFLOW_ICONS.board).toBe(APP_ICONS.board);
  });

  it("keeps the board glyph recognizable as a list while it animates", () => {
    expect(menuIconSource).not.toContain("rotate:");
    expect(menuIconSource).not.toMatch(/opacity:\s*custom\s*===\s*2\s*\?\s*0/);
  });

  it("separates workflow nodes that previously shared unrelated glyphs", () => {
    expect(WORKFLOW_ICONS.aggregate).not.toBe(WORKFLOW_ICONS.database);
    expect(WORKFLOW_ICONS.merge).not.toBe(WORKFLOW_ICONS.database);
    expect(WORKFLOW_ICONS.delay).not.toBe(WORKFLOW_ICONS.scheduleTrigger);
    expect(WORKFLOW_ICONS.transform).not.toBe(WORKFLOW_ICONS.useSkill);
  });
});
