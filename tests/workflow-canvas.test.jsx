import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultWorkflow } from "../electron/workflows/workflow-model.mjs";
import { WorkflowCanvas } from "../src/components/workflows/WorkflowCanvas.jsx";

describe("WorkflowCanvas", () => {
  it("lets users promote a Loom Agent node from background to foreground", () => {
    const workflow = createDefaultWorkflow({ projectId: "project-1", name: "Release review" });
    const agent = workflow.graph.nodes.find((node) => node.type === "loomAgent");
    const onChange = vi.fn();

    render(
      <WorkflowCanvas
        workflow={workflow}
        models={[]}
        onChange={onChange}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("Background")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("group", { name: "Loom Agent: Loom Agent" }));
    fireEvent.click(screen.getByRole("radio", { name: /Foreground/i }));

    const next = onChange.mock.calls.at(-1)[0];
    expect(next.graph.nodes.find((node) => node.id === agent.id).config.executionMode).toBe("foreground");
  });

  it("shows live execution modes and node run state on the canvas", () => {
    const workflow = createDefaultWorkflow({ projectId: "project-1" });
    const agent = workflow.graph.nodes.find((node) => node.type === "loomAgent");
    const foreground = {
      ...workflow,
      graph: {
        ...workflow.graph,
        nodes: workflow.graph.nodes.map((node) => node.id === agent.id
          ? { ...node, config: { ...node.config, executionMode: "foreground" } }
          : node)
      }
    };

    render(
      <WorkflowCanvas
        workflow={foreground}
        models={[]}
        run={{
          id: "run-1",
          status: "running",
          nodeRuns: { [agent.id]: { nodeId: agent.id, status: "running", executionMode: "foreground" } }
        }}
        onChange={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("Foreground thread")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});
