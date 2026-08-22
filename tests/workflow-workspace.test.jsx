import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowWorkspace } from "../src/components/workflows/WorkflowWorkspace.jsx";

const workflow = {
  id: "workflow-1",
  projectId: "project-1",
  name: "Release workflow",
  description: "Review and ship a release.",
  enabled: false,
  createdAt: "2026-08-20T06:00:00.000Z",
  updatedAt: "2026-08-20T06:00:00.000Z",
  graph: {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "trigger", type: "manualTrigger", name: "Manual trigger", description: "", position: { x: 50, y: 100 }, config: {} },
      { id: "output", type: "output", name: "Result", description: "", position: { x: 420, y: 100 }, config: {} }
    ],
    edges: [{ id: "edge", source: "trigger", target: "output", sourcePort: "output", targetPort: "input" }]
  }
};

function createApi() {
  const listeners = new Set();
  const api = {
    workflows: {
      list: vi.fn(async () => ({ data: [{ ...workflow, latestRun: null }] })),
      read: vi.fn(async () => ({ workflow, runs: [] })),
      save: vi.fn(async (payload) => {
        const saved = { ...workflow, ...payload, id: workflow.id, updatedAt: "2026-08-20T06:01:00.000Z" };
        listeners.forEach((listener) => listener({
          type: "WorkflowUpdated",
          payload: { projectId: workflow.projectId, action: "updated", workflow: saved }
        }));
        return saved;
      }),
      create: vi.fn(async () => workflow),
      delete: vi.fn(async () => workflow),
      run: vi.fn(),
      cancel: vi.fn()
    },
    events: {
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    }
  };
  return api;
}

describe("WorkflowWorkspace", () => {
  it("uses a settings-style workflow sidebar with a back action", async () => {
    const api = createApi();
    const onBack = vi.fn();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Loom" onBack={onBack} />);

    expect(await screen.findByRole("complementary", { name: "Workflow navigation" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Select workflow")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps the editor mounted when an autosave emits WorkflowUpdated", async () => {
    const api = createApi();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Loom" />);

    await screen.findByRole("button", { name: "Workflow settings" });
    expect(api.workflows.list).toHaveBeenCalledTimes(1);
    expect(api.workflows.read).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Workflow settings" }));
    fireEvent.change(screen.getByDisplayValue("Release workflow"), { target: { value: "Release workflow 2" } });

    await waitFor(() => expect(api.workflows.save).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(api.workflows.list).toHaveBeenCalledTimes(1);
    expect(api.workflows.read).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue("Release workflow 2")).toBeInTheDocument();
    expect(screen.queryByText(/changed by another agent/i)).not.toBeInTheDocument();
  });
});
