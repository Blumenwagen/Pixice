import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningOrb } from "../src/components/ReasoningOrb.jsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ReasoningOrb", () => {
  it("renders the supplied nine-cell lattice", () => {
    const { container } = render(<ReasoningOrb />);
    expect(container.querySelectorAll('[data-slot="current"] span')).toHaveLength(10);
    expect(container.querySelector('[data-slot="current"]')).toHaveAttribute("data-variant", "S1");
  });

  it("renders the supplied G1 globe as five rings of eight projected dots", () => {
    const { container } = render(<ReasoningOrb variant="G1" />);
    const globe = container.querySelector('[data-slot="current"]');
    const dots = globe.querySelectorAll('[style*="--g0x"]');

    expect(globe).toHaveAttribute("data-variant", "G1");
    expect(dots).toHaveLength(40);
    expect(dots[0].style.getPropertyValue("--g0x")).toMatch(/px$/);
    expect(dots[0].style.getPropertyValue("--g7o")).toMatch(/^0\.\d{3}$/);
  });

  it("morphs to a different randomized choreography while active", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = render(<ReasoningOrb />);

    act(() => vi.advanceTimersByTime(1801));

    expect(container.querySelector('[data-slot="current"]')).toHaveAttribute("data-variant", "S2");
    expect(container.querySelector('[data-slot="previous"]')).toHaveAttribute("data-variant", "S1");

    act(() => vi.advanceTimersByTime(520));
    expect(container.querySelector('[data-slot="previous"]')).not.toBeInTheDocument();
  });

  it("includes G1 in the randomized morph pool", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { container } = render(<ReasoningOrb />);

    act(() => vi.advanceTimersByTime(3400));

    expect(container.querySelector('[data-slot="current"]')).toHaveAttribute("data-variant", "G1");
    expect(container.querySelectorAll('[data-slot="current"] [style*="--g0x"]')).toHaveLength(40);
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

    expect(container.querySelector('[data-slot="current"]')).toHaveAttribute("data-variant", "S1");
    expect(container.querySelector('[data-slot="previous"]')).not.toBeInTheDocument();
  });
});
