import { describe, expect, it } from "vitest";
import {
  workflowEvaluateCondition,
  workflowExpressionContext,
  workflowParseJsonTemplate,
  workflowRenderTemplate,
  workflowResolveExpression
} from "../electron/workflows/workflow-values.mjs";

describe("workflow values", () => {
  const context = workflowExpressionContext({
    inputs: [{ value: { issue: { id: 42, labels: ["bug", "urgent"] } } }],
    runInput: { environment: "staging" },
    nodeOutputs: { "agent-1": { summary: "Investigated", score: 9 } },
    now: "2026-08-20T08:00:00.000Z"
  });

  it("resolves typed paths, helpers, and fallbacks", () => {
    expect(workflowResolveExpression("input.issue.id", context)).toBe(42);
    expect(workflowResolveExpression("nodes.agent-1.score", context)).toBe(9);
    expect(workflowResolveExpression("length(input.issue.labels)", context)).toBe(2);
    expect(workflowResolveExpression("input.missing ?? run.environment", context)).toBe("staging");
    expect(workflowResolveExpression("now", context)).toBe("2026-08-20T08:00:00.000Z");
  });

  it("preserves types for exact expressions and interpolates mixed strings", () => {
    expect(workflowRenderTemplate("{{input.issue}}", context)).toEqual({ id: 42, labels: ["bug", "urgent"] });
    expect(workflowRenderTemplate("Issue {{input.issue.id}} in {{run.environment}}", context)).toBe("Issue 42 in staging");
    expect(workflowParseJsonTemplate('{"id":"{{input.issue.id}}","summary":"{{nodes.agent-1.summary}}"}', context)).toEqual({
      id: 42,
      summary: "Investigated"
    });
  });

  it("evaluates data-aware condition operators", () => {
    expect(workflowEvaluateCondition(9, "greaterThan", 5)).toBe(true);
    expect(workflowEvaluateCondition(["bug", "urgent"], "contains", "urgent")).toBe(true);
    expect(workflowEvaluateCondition({ ready: true }, "contains", "ready")).toBe(true);
    expect(workflowEvaluateCondition("release-2026", "matches", "^release-")).toBe(true);
    expect(workflowEvaluateCondition([], "isEmpty")).toBe(true);
    expect(workflowEvaluateCondition(false, "isFalse")).toBe(true);
  });
});
