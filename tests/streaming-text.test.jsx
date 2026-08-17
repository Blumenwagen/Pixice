import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingText } from "../src/components/StreamingText.jsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("StreamingText", () => {
  it("types appended response chunks without restarting from the beginning", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<StreamingText text="Hello" />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();

    rerender(<StreamingText text="Hello world" />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it("finishes even very long responses in well under a second", () => {
    vi.useFakeTimers();
    const longResponse = "A polished response with markdown. ".repeat(250);
    const { container } = render(<StreamingText text={longResponse} />);

    act(() => vi.advanceTimersByTime(640));

    expect(container.textContent).toBe(longResponse);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it("shows the complete response immediately with reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true });
    render(<StreamingText text="Complete response" />);

    expect(screen.getByText("Complete response")).toBeInTheDocument();
  });
});
