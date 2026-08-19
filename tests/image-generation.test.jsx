import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageGeneration, imageGenerationSource } from "../src/components/ImageGeneration.jsx";

describe("ImageGeneration", () => {
  it("shows the animated generation preview with prompt and resolution", () => {
    render(<ImageGeneration prompt="a calm mountain lake at dawn" resolution="1536 × 1024" />);

    expect(screen.getByRole("img", { name: "Generating image" })).toBeInTheDocument();
    expect(screen.getByText("1536 × 1024")).toBeInTheDocument();
    expect(screen.getByText("“a calm mountain lake at dawn”")).toBeInTheDocument();
  });

  it("renders completed base64 output as an image", () => {
    const result = "a".repeat(132);
    render(<ImageGeneration result={result} revisedPrompt="a revised lake prompt" status="completed" />);

    expect(screen.getByRole("img", { name: "a revised lake prompt" })).toHaveAttribute("src", `data:image/png;base64,${result}`);
    expect(screen.getByRole("link", { name: "Open generated image" })).toHaveAttribute("href", `data:image/png;base64,${result}`);
    expect(screen.getByText("Generated image")).toBeInTheDocument();
  });

  it("surfaces structured generation failures", () => {
    render(<ImageGeneration status="failed" failure={{ type: "usageLimitExceeded", limitId: "images" }} />);

    expect(screen.getByRole("img", { name: "Image generation limit reached" })).toBeInTheDocument();
    expect(screen.getByText("Image generation limit reached")).toBeInTheDocument();
  });

  it("accepts JSON-wrapped URLs and saved file paths", () => {
    expect(imageGenerationSource('{"image_url":"https://example.com/generated.png"}')).toBe("https://example.com/generated.png");
    expect(imageGenerationSource("", "/tmp/generated image.png")).toBe("file:///tmp/generated%20image.png");
  });
});
