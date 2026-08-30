import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../src/components/RendererErrorBoundary.jsx";

function BrokenView() {
  throw new Error("Broken task payload");
}

describe("RendererErrorBoundary", () => {
  it("keeps an actionable recovery surface mounted after a view exception", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RendererErrorBoundary><BrokenView /></RendererErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("Pixice hit a display error");
    expect(screen.getByText("Broken task payload")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload interface" })).toBeInTheDocument();
  });
});
