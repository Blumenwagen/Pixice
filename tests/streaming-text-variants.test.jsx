import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingTextVariant } from "../src/components/StreamingTextVariants.jsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("streaming comparison treatments", () => {
  it.each(["fade", "focus", "crisp", "dissolve", "cascade"])("keeps existing %s words mounted when chunks arrive", (variant) => {
    const { container, rerender } = render(<StreamingTextVariant text="The first wo" variant={variant} active />);
    const words = [...container.querySelectorAll("span")];
    rerender(<StreamingTextVariant text="The first word arrives" variant={variant} active />);
    expect(container.textContent).toBe("The first word arrives");
    words.forEach((word, index) => expect(container.querySelectorAll("span")[index]).toBe(word));
  });

  it("smooths burst delivery, preserves graphemes, and drains its final buffer", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const text = "👩🏽‍💻 ".repeat(30);
    const { container, rerender } = render(<StreamingTextVariant text={text} variant="fluid" active />);
    act(() => vi.advanceTimersByTime(80));
    const partial = container.textContent;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(text.length);
    expect(partial.replaceAll("👩🏽‍💻", "").trim()).toBe("");
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe(text);
    rerender(<StreamingTextVariant text={text} variant="fluid" active={false} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.firstChild).toHaveAttribute("data-settled", "true");
  });

  it("preserves the typed prefix during pause and resumes without restarting", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const text = "A response that keeps arriving while its display is paused.";
    const { container, rerender } = render(<StreamingTextVariant text={text} variant="fluid" active />);
    act(() => vi.advanceTimersByTime(64));
    const prefix = container.textContent;
    rerender(<StreamingTextVariant text={text} variant="fluid" active paused />);
    act(() => vi.advanceTimersByTime(500));
    expect(container.textContent).toBe(prefix);
    rerender(<StreamingTextVariant text={text} variant="fluid" active />);
    act(() => vi.advanceTimersByTime(800));
    expect(container.textContent).toBe(text);
  });

  it("shows arriving text immediately without a caret when motion is reduced", () => {
    const { container, rerender } = render(<StreamingTextVariant text="First chunk" variant="fluid" active reducedMotion />);
    expect(container.textContent).toBe("First chunk");
    rerender(<StreamingTextVariant text="First chunk and second" variant="fluid" active reducedMotion />);
    expect(container.textContent).toBe("First chunk and second");
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
