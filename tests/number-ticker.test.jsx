import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberTicker } from "../src/components/NumberTicker.jsx";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete HTMLElement.prototype.animate;
});

describe("NumberTicker", () => {
  it("does not restart the blur when the entrance stagger clears", () => {
    vi.useFakeTimers();
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate
    });

    const view = render(
      <NumberTicker value={42} blur startOnView={false} duration={0.1} stagger={0.02} />
    );
    expect(animate).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(200));
    expect(animate).toHaveBeenCalledTimes(2);

    view.rerender(
      <NumberTicker value={43} blur startOnView={false} duration={0.1} stagger={0.02} />
    );
    expect(animate).toHaveBeenCalledTimes(3);
  });
});
