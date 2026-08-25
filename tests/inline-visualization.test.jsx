import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "../src/App.jsx";
import { InlineVisualization, parseVisualizationSpec, visualizationChartMaximum } from "../src/components/InlineVisualization.jsx";

const source = JSON.stringify({
  version: 1,
  title: "Demand planner",
  description: "Adjust the inputs to compare the modeled outcome.",
  controls: [
    { id: "investment", type: "range", label: "Investment", min: 0, max: 100, step: 10, value: 10 },
    { id: "scenario", type: "segmented", label: "Scenario", value: "balanced", options: [{ label: "Balanced", value: "balanced" }, { label: "Growth", value: "growth" }] },
    { id: "enabled", type: "toggle", label: "Include partners", value: false }
  ],
  metrics: [
    { label: "Reach", value: { base: 100, add: { investment: 2 }, multiply: { scenario: { balanced: 1, growth: 1.5 } } } },
    { label: "Confidence", value: { base: 70, by: { enabled: { true: 85, false: 70 } } }, format: "percent" }
  ],
  chart: {
    type: "area",
    title: "Projected demand",
    xKey: "month",
    xLabel: "Month",
    yLabel: "Indexed demand",
    data: [{ month: "Jan", forecast: { base: 80, add: { investment: 1 } } }, { month: "Feb", forecast: { base: 100, add: { investment: 1.5 } } }],
    series: [{ key: "forecast", label: "Forecast", color: "blue" }]
  },
  segments: [{ label: "Search", value: { base: 20, add: { investment: 1 } }, color: "blue" }, { label: "Social", value: 50, color: "purple" }]
});

describe("provider-neutral inline visualizations", () => {
  it("validates the native JSON contract and rejects executable or malformed blocks", () => {
    expect(parseVisualizationSpec(source)?.title).toBe("Demand planner");
    expect(parseVisualizationSpec(source, "javascript")).toBeNull();
    expect(parseVisualizationSpec("<script>alert(1)</script>")).toBeNull();
    expect(parseVisualizationSpec(JSON.stringify({ version: 1, title: "Empty" }))).toBeNull();
  });

  it("updates metrics from range, segmented, and toggle controls", () => {
    const spec = parseVisualizationSpec(source);
    render(<InlineVisualization spec={spec} />);

    const reach = screen.getByText("Reach").closest("article");
    const confidence = screen.getByText("Confidence").closest("article");
    expect(within(reach).getByText("120")).toBeInTheDocument();
    expect(within(confidence).getByText("70%")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider"), { target: { value: "20" } });
    expect(within(reach).getByText("140")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Growth" }));
    expect(within(reach).getByText("210")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Include partners" }));
    expect(within(confidence).getByText("85%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Demand planner: Projected demand" })).toBeInTheDocument();
  });

  it("renders a visualization fence inline instead of exposing its JSON", () => {
    render(<MarkdownMessage text={`Here is the model.\n\n\`\`\`pixice-visualization\n${source}\n\`\`\``} />);
    expect(screen.getByText("Here is the model.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Demand planner" })).toBeInTheDocument();
    expect(document.querySelector("code[data-language='pixice-visualization']")).not.toBeInTheDocument();
  });

  it("keeps a stable chart scale across the full range of reactive controls", () => {
    const spec = parseVisualizationSpec(source);
    expect(visualizationChartMaximum(spec)).toBe(250);
  });
});
