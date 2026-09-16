import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MorphText } from "../src/components/MorphText.jsx";

describe("MorphText", () => {
  it("keeps a stable text element while its value changes", () => {
    const { rerender } = render(<MorphText value="Checking for updates" />);
    const element = screen.getByText("Checking for updates");

    rerender(<MorphText value="42% downloaded" />);

    expect(screen.getByText("42% downloaded")).toBe(element);
  });

  it("renders numeric values without losing zero", () => {
    render(<MorphText value={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
