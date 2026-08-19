import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { promptPreviewItems } from "../src/App.jsx";
import { PromptPreviewRail } from "../src/components/PromptPreviewRail.jsx";

const items = [
  { id: "one", anchorId: "prompt-one", label: "First request", description: "First response summary." },
  { id: "two", anchorId: "prompt-two", label: "Second request", description: "Second response summary." },
  { id: "three", anchorId: "prompt-three", label: "Third request", description: "Still working." },
];

describe("PromptPreviewRail", () => {
  it("marks the active prompt and exposes a preview on hover", async () => {
    render(<PromptPreviewRail items={items} activeId="two" />);

    const rail = screen.getByRole("navigation", { name: "Prompts in this thread" });
    const first = screen.getByRole("button", { name: /Jump to prompt 1/ });
    const second = screen.getByRole("button", { name: /Jump to prompt 2/ });
    expect(rail).toBeInTheDocument();
    expect(second).toHaveAttribute("aria-current", "location");
    expect(document.querySelector('[data-prompt-preview-rail="true"]')).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByText("Second response summary.")).not.toBeInTheDocument();

    fireEvent.pointerEnter(first, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByText("First response summary.")).toBeInTheDocument());
    expect(document.querySelector('[data-prompt-preview-rail="true"]')).toHaveAttribute("data-expanded", "true");
  });

  it("selects immediately with a mouse and uses the first touch as a preview", () => {
    const onItemSelect = vi.fn();
    render(<PromptPreviewRail items={items} activeId="two" onItemSelect={onItemSelect} />);
    const first = screen.getByRole("button", { name: /Jump to prompt 1/ });

    fireEvent.pointerDown(first, { pointerType: "touch" });
    fireEvent.click(first);
    expect(onItemSelect).not.toHaveBeenCalled();

    fireEvent.pointerDown(first, { pointerType: "touch" });
    fireEvent.click(first);
    expect(onItemSelect).toHaveBeenCalledWith(items[0]);

    const third = screen.getByRole("button", { name: /Jump to prompt 3/ });
    fireEvent.pointerDown(third, { pointerType: "mouse" });
    fireEvent.click(third);
    expect(onItemSelect).toHaveBeenLastCalledWith(items[2]);
  });

  it("dismisses a hover preview when the pointer moves beyond the rail", async () => {
    render(<PromptPreviewRail items={items} activeId="two" />);
    const root = document.querySelector('[data-prompt-preview-rail="true"]');
    root.querySelector("nav").getBoundingClientRect = () => ({
      top: 100,
      right: 134,
      bottom: 180,
      left: 100,
      width: 34,
      height: 80,
      x: 100,
      y: 100,
      toJSON: () => {},
    });

    fireEvent.pointerEnter(screen.getByRole("button", { name: /Jump to prompt 1/ }), { pointerType: "mouse" });
    await screen.findByText("First response summary.");

    fireEvent.pointerMove(window, { pointerType: "mouse", clientX: 220, clientY: 140 });
    await waitFor(() => expect(screen.queryByText("First response summary.")).not.toBeInTheDocument());
  });

  it("stays out of the way until a thread has multiple prompts", () => {
    const { container } = render(<PromptPreviewRail items={[items[0]]} activeId="one" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("promptPreviewItems", () => {
  it("builds prompt targets and compact response previews from turns", () => {
    const result = promptPreviewItems({
      turns: [{
        id: "turn / 1",
        status: "completed",
        items: [
          { id: "prompt / 1", type: "userMessage", content: [{ type: "text", text: "## Refine the rail" }] },
          { id: "answer-1", type: "agentMessage", text: "Done. [Open the file](src/App.jsx)." },
        ],
      }],
    });

    expect(result).toEqual([expect.objectContaining({
      id: "prompt / 1",
      anchorId: "prompt-prompt%20%2F%201",
      label: "Refine the rail",
      description: "Done. Open the file.",
    })]);
  });
});
