import { describe, expect, it } from "vitest";
import {
  parseWorkflowCron,
  workflowCronMatches,
  workflowIntervalMilliseconds,
  workflowNextCronDate,
  workflowNextScheduleDate
} from "../electron/workflows/workflow-cron.mjs";

describe("workflow cron schedules", () => {
  it("parses ranges, names, lists, steps, and weekday seven", () => {
    const cron = parseWorkflowCron("*/15 9-17 * JAN,MAR MON-FRI");
    expect([...cron.minute.values]).toEqual([0, 15, 30, 45]);
    expect(cron.hour.values.has(17)).toBe(true);
    expect([...cron.month.values]).toEqual([1, 3]);
    expect([...cron.weekday.values]).toEqual([1, 2, 3, 4, 5]);
    expect(workflowCronMatches("0 12 * * 7", new Date(2026, 7, 23, 12, 0))).toBe(true);
  });

  it("uses standard day-of-month or weekday semantics and finds the next minute", () => {
    const expression = "0 9 1 * MON";
    expect(workflowCronMatches(expression, new Date(2026, 5, 1, 9, 0))).toBe(true);
    expect(workflowCronMatches(expression, new Date(2026, 5, 8, 9, 0))).toBe(true);
    expect(workflowCronMatches(expression, new Date(2026, 5, 9, 9, 0))).toBe(false);

    const next = workflowNextCronDate("*/10 * * * *", new Date(2026, 7, 20, 12, 1, 30));
    expect(next).toEqual(new Date(2026, 7, 20, 12, 10, 0));
  });

  it("computes interval schedules and rejects malformed cron expressions", () => {
    expect(workflowIntervalMilliseconds({ every: 2, unit: "hours" })).toBe(7_200_000);
    expect(workflowNextScheduleDate({ mode: "interval", every: 30, unit: "seconds" }, new Date(1000))).toEqual(new Date(31_000));
    expect(() => parseWorkflowCron("* * *")).toThrow(/exactly five fields/i);
    expect(() => parseWorkflowCron("61 * * * *")).toThrow(/minute value is invalid/i);
  });
});
