import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DitherAreaChart, DitherBarChart, resampleChartValues } from "../src/components/dither-kit/DitherChart.jsx";

const data = [
  { label: "Mon", cost: 1 },
  { label: "Tue", cost: 2 }
];
const series = [{ key: "cost", label: "Cost", color: "blue" }];
const originalUserAgent = navigator.userAgent;

function drawingContext() {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: ""
  };
}

describe.each([
  ["area", DitherAreaChart],
  ["bar", DitherBarChart]
])("Dither %s chart", (_type, Chart) => {
  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("repaints updates without restarting the reveal animation", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Pixice chart test" });
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context);
    const requestAnimationFrame = vi.fn((callback) => {
      callback(performance.now() + 1000);
      return 1;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const view = render(<Chart data={data} series={series} ariaLabel="Usage chart" />);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(screen.getByRole("img", { name: "Usage chart" }).querySelector(".dither-chart-plot"), { clientX: 20 });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Tue", { selector: ".dither-chart-tooltip strong" })).toBeInTheDocument();

    context.fillRect.mockClear();
    view.rerender(<Chart data={data.map((row) => ({ ...row, cost: row.cost * 2 }))} series={series.map((item) => ({ ...item }))} ariaLabel="Usage chart" />);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(context.fillRect).toHaveBeenCalled();
  });

  it("ignores referential-only data changes", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Pixice chart test" });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => drawingContext());
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const view = render(<Chart data={data} series={series} ariaLabel="Usage chart" />);
    expect(getContext).toHaveBeenCalledTimes(2);
    view.rerender(<Chart data={data.map((row) => ({ ...row }))} series={series.map((item) => ({ ...item }))} ariaLabel="Usage chart" />);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledTimes(2);
  });

  it("changes canvas geometry against a fixed reactive scale", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Pixice chart test" });
    const context = drawingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context);
    const requestAnimationFrame = vi.fn((callback) => {
      callback(performance.now() + 1000);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const view = render(<Chart data={data} series={series} maxValue={4} ariaLabel="Usage chart" />);
    const initialPaintCount = context.fillRect.mock.calls.length;
    context.fillRect.mockClear();

    view.rerender(<Chart data={data.map((row) => ({ ...row, cost: row.cost * 2 }))} series={series} maxValue={4} ariaLabel="Usage chart" />);

    expect(context.fillRect.mock.calls.length).toBeGreaterThan(initialPaintCount);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});

describe("Dither area chart interpolation", () => {
  it("slopes down to an explicit zero instead of holding the previous value", () => {
    expect(resampleChartValues([150, 0, 100], 9)).toEqual([
      150, 112.5, 75, 37.5, 0, 25, 50, 75, 100
    ]);
  });
});
