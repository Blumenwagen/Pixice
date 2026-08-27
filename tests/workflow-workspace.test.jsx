import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowPreview, WorkflowWorkspace } from "../src/components/workflows/WorkflowWorkspace.jsx";

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
      generate: vi.fn(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
        return {
          graph: {
            ...workflow.graph,
            nodes: workflow.graph.nodes.map((node) => node.id === "output" ? { ...node, name: "Generated result" } : node)
          },
          model: "GPT-5.6 Terra",
          generatedAt: "2026-08-20T06:02:00.000Z"
        };
      }),
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
  it("opens a tabbed workflow from list data when the bridge has no read method", async () => {
    const api = createApi();
    delete api.workflows.read;
    api.workflows.list.mockResolvedValueOnce({ data: [{ ...workflow, graph: undefined }] });

    render(<WorkflowPreview api={api} projectId="project-1" workflowId="workflow-1" workflowName="Release workflow" tabbed />);

    expect(await screen.findByRole("button", { name: "Workflow settings" })).toBeInTheDocument();
    expect(api.workflows.list).toHaveBeenCalled();
    expect(screen.queryByText(/workflow unavailable/i)).not.toBeInTheDocument();
  });

  it("uses a settings-style workflow sidebar with a back action", async () => {
    const api = createApi();
    const onBack = vi.fn();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Pixice" onBack={onBack} />);

    expect(await screen.findByRole("complementary", { name: "Workflow navigation" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Select workflow")).not.toBeInTheDocument();
    const deleteButton = await screen.findByRole("button", { name: "Delete workflow" });
    expect(screen.queryByRole("button", { name: "Refresh workflows" })).not.toBeInTheDocument();
    expect(deleteButton.parentElement).toBe(screen.getByRole("button", { name: "Tidy" }).parentElement);
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps the editor mounted when an autosave emits WorkflowUpdated", async () => {
    const api = createApi();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Pixice" />);

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

  it("generates the current workflow from its description with visible progress", async () => {
    const api = createApi();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Pixice" />);

    fireEvent.click(await screen.findByRole("button", { name: "Workflow settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate workflow from description" }));

    expect(await screen.findByText("Agent is building this workflow")).toBeInTheDocument();
    await waitFor(() => expect(api.workflows.generate).toHaveBeenCalledWith({ projectId: "project-1", workflowId: "workflow-1" }));
    await waitFor(() => expect(api.workflows.save).toHaveBeenLastCalledWith(expect.objectContaining({
      graph: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ name: "Generated result" })]) })
    })), { timeout: 1500 });
    expect(await screen.findByText("Workflow ready")).toBeInTheDocument();
  });

  it("keeps the current canvas when generation fails", async () => {
    const api = createApi();
    api.workflows.generate.mockRejectedValueOnce(new Error("The workflow agent is unavailable"));
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Pixice" />);

    fireEvent.click(await screen.findByRole("button", { name: "Workflow settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate workflow from description" }));

    expect((await screen.findAllByText("The workflow agent is unavailable")).length).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: "Output: Result" })).toBeInTheDocument();
  });

  it("offers Plan Work as a native node with review-only proposal controls", async () => {
    const api = createApi();
    render(<WorkflowWorkspace api={api} projectId="project-1" projectName="Pixice" />);

    fireEvent.click(await screen.findByRole("button", { name: "Add node" }));
    fireEvent.click(screen.getByRole("button", { name: /Plan Work/ }));

    expect(await screen.findByText("Plan input")).toBeInTheDocument();
    expect(screen.getByText("Create review proposal")).toBeInTheDocument();
    await waitFor(() => expect(api.workflows.save).toHaveBeenCalledWith(expect.objectContaining({
      graph: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ type: "planWork" })]) })
    })), { timeout: 1500 });
  });
});
