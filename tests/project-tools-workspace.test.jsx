import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectToolsWorkspace } from "../src/components/instruments/ProjectToolsWorkspace.jsx";

const tool = {
  id: "tool-1",
  lifecycle: "pinned",
  documentVersion: 2,
  metadata: { name: "Release tool" },
  grants: ["workflow.run"],
  requestedCapabilities: ["board.move", "workflow.run"],
  usageCount: 4,
  lastOpenedAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:00:00.000Z",
  lastError: null,
  document: {
    title: "Release launcher",
    description: "Run a release with explicit inputs.",
    parameters: {
      environment: { label: "Environment", description: "Deployment target", type: "select", required: true, options: [{ label: "Staging", value: "staging" }, { label: "Production", value: "production" }] },
      dryRun: { label: "Dry run", description: "Do not publish", type: "boolean", required: false, default: true }
    }
  }
};

describe("Project tools workspace", () => {
  it("launches with parameters and manages names, grants, and revisions", async () => {
    const onLaunch = vi.fn().mockResolvedValue({});
    const onRename = vi.fn().mockResolvedValue({});
    const onGrants = vi.fn().mockResolvedValue({});
    const onRestore = vi.fn().mockResolvedValue({});
    const onRevisions = vi.fn().mockResolvedValue([
      { id: "tool-1:2", version: 2, createdAt: "2026-08-23T08:00:00.000Z" },
      { id: "tool-1:1", version: 1, createdAt: "2026-08-22T08:00:00.000Z" }
    ]);
    render(<ProjectToolsWorkspace
      project={{ displayName: "Pixice" }}
      threadId="thread-1"
      tools={[tool]}
      loading={false}
      onReload={vi.fn()}
      onLaunch={onLaunch}
      onRename={onRename}
      onGrants={onGrants}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onRevisions={onRevisions}
      onReceipts={vi.fn().mockResolvedValue([{ requestId: "request-1", status: "sent", capability: "workflow.run", effectSummary: "Run workflow Release.", createdAt: "2026-08-23T08:00:00.000Z" }])}
      onRestore={onRestore}
    />);

    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Environment/ }), { target: { value: "production" } });
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledWith("tool-1", { environment: "production", dryRun: true }));

    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Production release" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("tool-1", "Production release"));

    fireEvent.click(screen.getByRole("checkbox", { name: /board.move/ }));
    await waitFor(() => expect(onGrants).toHaveBeenCalledWith("tool-1", ["workflow.run", "board.move"]));
    await screen.findByText("Version 1");
    expect(screen.getByText("Run workflow Release.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("tool-1", 1));
  });

  it("requires a controlling task before launch or management", () => {
    render(<ProjectToolsWorkspace
      project={{ displayName: "Pixice" }}
      threadId={null}
      tools={[tool]}
      loading={false}
      onReload={vi.fn()}
      onLaunch={vi.fn()}
      onRename={vi.fn()}
      onGrants={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onRevisions={vi.fn().mockResolvedValue([])}
      onReceipts={vi.fn().mockResolvedValue([])}
      onRestore={vi.fn()}
    />);
    expect(screen.getByText(/Select or create a task/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
  });
});
