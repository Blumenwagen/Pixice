import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasWorkspace } from "../src/components/canvas/CanvasWorkspace.jsx";
import { createCanvas, createCanvasItem } from "../src/components/canvas/canvas-store.js";

vi.mock("../src/components/canvas/CanvasResources.jsx", () => ({ CanvasWorkflow: () => null, CanvasTool: () => null, CanvasBoardTask: () => null, CanvasResourcePicker: () => null }));

function memoryStore(documents) {
  const records = new Map(documents.map(document => [document.id, structuredClone(document)]));
  return { list: vi.fn(async () => [...records.values()].map(record => structuredClone(record))), save: vi.fn(async document => records.set(document.id, structuredClone(document))), remove: vi.fn(async id => records.delete(id)), records };
}

describe("Canvas workspace durability", () => {
  it("saves the edited canvas before switching without leaking content into another canvas", async () => {
    const first = createCanvas("First"); const second = createCanvas("Second");
    first.nodes.push(createCanvasItem("text", { x: 0, y: 0 }, { content: "Original" }));
    second.nodes.push(createCanvasItem("text", { x: 0, y: 0 }, { content: "Other canvas" }));
    const store = memoryStore([first, second]);
    const { unmount } = render(<CanvasWorkspace store={store} active onBack={vi.fn()} />);
    await screen.findByDisplayValue("Original");
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "Saved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle canvases" }));
    fireEvent.click(screen.getByRole("button", { name: "Second 1 item" }));
    expect(screen.getByLabelText("Note text")).toHaveValue("Other canvas");
    await waitFor(() => expect(store.records.get(first.id).nodes[0].data.content).toBe("Saved edit"));
    expect(store.records.get(second.id).nodes[0].data.content).toBe("Other canvas");
    unmount();
    render(<CanvasWorkspace store={store} active onBack={vi.fn()} />);
    await screen.findByLabelText("Canvas name");
    fireEvent.click(screen.getByRole("button", { name: "Toggle canvases" }));
    await screen.findByRole("button", { name: "First 1 item" });
    fireEvent.click(screen.getByRole("button", { name: "First 1 item" }));
    expect(screen.getByLabelText("Note text")).toHaveValue("Saved edit");
  });

  it("preserves unsaved edits and retries a failed save", async () => {
    const document = createCanvas("Recovery");
    document.nodes.push(createCanvasItem("text", { x: 0, y: 0 }, { content: "Original" }));
    const store = memoryStore([document]);
    store.save.mockRejectedValueOnce(new Error("Storage full"));
    render(<CanvasWorkspace store={store} active onBack={vi.fn()} />);
    await screen.findByDisplayValue("Original");
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "Still here" } });
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Note text")).toHaveValue("Still here");
    expect(screen.getByRole("alert")).toHaveTextContent("Storage full");
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(store.records.get(document.id).nodes[0].data.content).toBe("Still here");
  });
});
