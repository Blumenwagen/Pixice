import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReasoningOrb } from "../src/components/ReasoningOrb.jsx";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ReasoningOrb", () => {
  it("renders the supplied nine-cell lattice on one canvas", () => {
    const { container } = render(<ReasoningOrb />);
    const stage = container.querySelector('[data-current-variant]');
    expect(stage).toHaveAttribute("data-current-variant", "S1");
    expect(stage).toHaveAttribute("data-dot-count", "9");
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector('[data-reasoning-orb]')).toHaveAttribute("data-frame-rate", "24");
  });

  it("renders the supplied G1 globe as five rings of eight projected dots", () => {
    const { container } = render(<ReasoningOrb variant="G1" />);
    const globe = container.querySelector('[data-current-variant]');
    expect(globe).toHaveAttribute("data-current-variant", "G1");
    expect(globe).toHaveAttribute("data-dot-count", "40");
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("morphs to a different randomized choreography while active", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<ReasoningOrb />);

    act(() => vi.advanceTimersByTime(1801));

    const stage = container.querySelector('[data-current-variant]');
    expect(stage).toHaveAttribute("data-current-variant", "S2");
    expect(stage).toHaveAttribute("data-previous-variant", "S1");

    act(() => vi.advanceTimersByTime(520));
    expect(stage).not.toHaveAttribute("data-previous-variant");
  });

  it("includes G1 in the randomized morph pool", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { container } = render(<ReasoningOrb />);

    act(() => vi.advanceTimersByTime(3400));

    expect(container.querySelector('[data-current-variant]')).toHaveAttribute("data-current-variant", "G1");
    expect(container.querySelector('[data-current-variant]')).toHaveAttribute("data-dot-count", "40");
  });

  it("stays on a static lattice when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { container } = render(<ReasoningOrb />);

    act(() => vi.advanceTimersByTime(10000));

    expect(container.querySelector('[data-current-variant]')).toHaveAttribute("data-current-variant", "S1");
    expect(container.querySelector('[data-current-variant]')).not.toHaveAttribute("data-previous-variant");
  });
});
