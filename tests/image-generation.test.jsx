import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImageGeneration, imageGenerationSource } from "../src/components/ImageGeneration.jsx";

describe("ImageGeneration", () => {
  it("shows the animated generation preview with prompt and resolution", () => {
    render(<ImageGeneration prompt="a calm mountain lake at dawn" resolution="1536 × 1024" />);

    expect(screen.getByRole("img", { name: "Generating image" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Generating image" })).toHaveStyle({ aspectRatio: "1536 / 1024" });
    expect(screen.getByText("1536 × 1024")).toBeInTheDocument();
    expect(screen.getByText("“a calm mountain lake at dawn”")).toBeInTheDocument();
  });

  it("renders completed base64 output as an image", () => {
    const result = "a".repeat(132);
    render(<ImageGeneration result={result} revisedPrompt="a revised lake prompt" status="completed" />);

    expect(screen.getByRole("img", { name: "a revised lake prompt" })).toHaveAttribute("src", `data:image/png;base64,${result}`);
    expect(screen.getByRole("button", { name: "Inspect a revised lake prompt" })).toBeInTheDocument();
    expect(screen.getByText("Generated image")).toBeInTheDocument();
  });

  it("opens generated pictures in the inspector and submits revision comments", async () => {
    const onRequestRevision = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <ImageGeneration
        result="data:image/png;base64,AA=="
        revisedPrompt="a revised lake prompt"
        status="completed"
        onRequestRevision={onRequestRevision}
      />
    );

    await user.click(screen.getByRole("button", { name: "Inspect a revised lake prompt" }));
    const inspector = screen.getByRole("dialog", { name: "Generated picture inspector" });
    expect(inspector).toBeInTheDocument();
    expect(within(inspector).getByRole("img", { name: "a revised lake prompt" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Picture revision comments" }), "Warm the sky and move the cabin left");
    await user.click(screen.getByRole("button", { name: "Generate revision" }));

    await waitFor(() => expect(onRequestRevision).toHaveBeenCalledWith({
      comment: "Warm the sky and move the cabin left",
      source: "data:image/png;base64,AA==",
      prompt: "a revised lake prompt"
    }));
    expect(screen.queryByRole("dialog", { name: "Generated picture inspector" })).not.toBeInTheDocument();
  });

  it("closes the picture inspector with Escape", async () => {
    render(<ImageGeneration result="data:image/png;base64,AA==" status="completed" />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect Generated image" }));
    expect(screen.getByRole("dialog", { name: "Generated picture inspector" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Generated picture inspector" })).not.toBeInTheDocument();
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
