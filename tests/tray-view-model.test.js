import { describe, expect, it } from "vitest";
import { createTrayViewModel, createTrayWorkItems, weeklyWindow } from "../electron/tray/tray-view-model.mjs";

describe("tray view model", () => {
  it("selects the weekly window instead of the short provider window", () => {
    const provider = {
      limits: [{
        id: "codex",
        windows: [
          { windowDurationMins: 300, remainingPercent: 80 },
          { windowDurationMins: 10_080, remainingPercent: 42, resetsAt: 2_000_000_000 }
        ]
      }]
    };
    expect(weeklyWindow(provider)).toMatchObject({ remainingPercent: 42, usedPercent: 58, resetsAt: 2_000_000_000 });
  });

  it("keeps both signed-in providers and usage totals", () => {
    const model = createTrayViewModel({
      limits: {
        fetchedAt: "2026-08-29T12:00:00.000Z",
        providers: [
          { provider: "codex", label: "Codex", status: "available", planType: "pro", limits: [{ id: "codex", windows: [{ windowDurationMins: 10_080, usedPercent: 25 }] }] },
          { provider: "claude", label: "Claude", status: "available", planType: "max", limits: [{ id: "claude", windows: [{ windowDurationMins: 10_080, usedPercent: 60 }] }] }
        ]
      },
      summary: { stats: { currentWeekCostUsd: 12.345, allTimeCostUsd: 98.76 } },
      activeTurns: 2,
      keepSystemAwake: true,
      appearance: { accentColor: "teal", reduceTransparency: true }
    });
    expect(model.providers).toHaveLength(2);
    expect(model.providers.map((provider) => provider.weekly.remainingPercent)).toEqual([75, 40]);
    expect(model.cost).toEqual({ currentWeekUsd: 12.345, allTimeUsd: 98.76 });
    expect(model).toMatchObject({
      activeTurns: 2,
      keepSystemAwake: true,
      appearance: { accentColor: "teal", reduceTransparency: true }
    });
  });

  it("falls back to Pixice's default appearance for unsupported tray values", () => {
    const model = createTrayViewModel({ appearance: { accentColor: "neon", reduceTransparency: "yes" } });
    expect(model.appearance).toEqual({ accentColor: "coral", reduceTransparency: false });
  });

  it("reports a connected provider whose account does not expose weekly limits", () => {
    const model = createTrayViewModel({ limits: { providers: [{ provider: "claude", label: "Claude", status: "unavailable", message: "Plan limits unavailable." }] } });
    expect(model.providers[0]).toMatchObject({ id: "claude", status: "unavailable", message: "Plan limits unavailable.", weekly: null });
  });

  it("lists every active thread before newly completed unread work", () => {
    const items = createTrayWorkItems({
      threads: [
        { id: "active-lead", name: "Lead task", projectName: "Pixice", updatedAt: "2026-08-29T12:00:00.000Z", plan: [{ status: "completed" }, { status: "in_progress" }] },
        { id: "active-child", name: "Child task", parentThreadId: "active-lead", projectName: "Pixice", updatedAt: "2026-08-29T12:01:00.000Z" },
        { id: "unread", name: "Finished task", completionRevision: "turn:done", projectName: "Pixice", updatedAt: "2026-08-29T12:02:00.000Z" },
        { id: "seen", name: "Seen task", completionRevision: "turn:seen", projectName: "Pixice", updatedAt: "2026-08-29T12:03:00.000Z" }
      ],
      activeTurns: [["active-lead", "turn-1"], ["active-child", "turn-2"]],
      seenCompletions: { __baselineAt: Date.parse("2026-08-29T11:00:00.000Z"), seen: "turn:seen" }
    });
    expect(items.map((item) => [item.id, item.status])).toEqual([
      ["active-child", "active"],
      ["active-lead", "active"],
      ["unread", "unread"]
    ]);
    expect(items.find((item) => item.id === "active-lead")?.progress).toMatchObject({ completed: 1, total: 2, percent: 50 });
    expect(items.find((item) => item.id === "unread")?.progress).toMatchObject({ percent: 100, label: "Completed" });
  });

  it("does not treat historical completions as unread before the seen baseline exists", () => {
    const items = createTrayWorkItems({
      threads: [{ id: "historical", completionRevision: "turn:old", updatedAt: "2026-01-01T00:00:00.000Z" }],
      seenCompletions: {}
    });
    expect(items).toEqual([]);
  });
});
