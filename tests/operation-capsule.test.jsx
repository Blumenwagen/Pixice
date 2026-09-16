import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationCapsuleStack } from "../src/components/OperationCapsule.jsx";
import { publishOperation } from "../src/state/operation-events.js";

describe("OperationCapsuleStack", () => {
  it("shows determinate progress and updates the status in place", () => {
    const operation = {
      id: "pixice-update",
      kind: "update",
      tone: "working",
      status: "12% downloaded",
      title: "Downloading Pixice 1.2.0",
      detail: "Downloading the update.",
      progress: 12,
      dismissible: false
    };
    const { rerender } = render(<OperationCapsuleStack operations={[operation]} />);
    const progress = screen.getByRole("progressbar", { name: "Downloading Pixice 1.2.0 progress" });
    expect(progress).toHaveAttribute("aria-valuenow", "12");

    rerender(<OperationCapsuleStack operations={[{ ...operation, status: "64% downloaded", progress: 64 }]} />);

    expect(screen.getByText("Downloading Pixice 1.2.0 · 64% downloaded")).toBeInTheDocument();
    expect(progress).toHaveAttribute("aria-valuenow", "64");
  });

  it("accepts transient Workflow operations and runs their action", () => {
    const onAction = vi.fn();
    render(<OperationCapsuleStack />);

    act(() => publishOperation({
      id: "workflow-created:one",
      kind: "workflow",
      tone: "success",
      status: "Workflow created",
      title: "Release notes",
      detail: "A thread added a new Workflow to this project.",
      progress: 100,
      actionLabel: "Open",
      onAction
    }));

    expect(screen.getByText("Workflow created · Release notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
