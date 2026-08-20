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

  it("offers useful action, data, flow, and Loom nodes from a searchable picker", () => {
    const workflow = createDefaultWorkflow({ projectId: "project-1" });
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

    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(screen.getByRole("dialog", { name: "Add workflow node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /HTTP Request/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transform/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Condition/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Project File/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Git /i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Loom Board/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search actions, data, flow…"), { target: { value: "http" } });
    expect(screen.getByRole("button", { name: /HTTP Request/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Loom Board/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /HTTP Request/i }));

    const next = onChange.mock.calls.at(-1)[0];
    expect(next.graph.nodes.at(-1)).toMatchObject({
      type: "httpRequest",
      name: "HTTP Request",
      config: expect.objectContaining({ method: "GET", responseType: "auto" })
    });
  });

  it("renders branch-specific ports and condition settings", () => {
    const workflow = {
      ...createDefaultWorkflow({ projectId: "project-1" }),
      graph: {
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: "trigger", type: "manualTrigger", name: "Start", description: "", position: { x: 40, y: 120 }, config: {} },
          { id: "condition", type: "condition", name: "Ready?", description: "", position: { x: 380, y: 120 }, config: { left: "{{input.ready}}", operator: "isTrue", right: "" } }
        ],
        edges: [{ id: "edge", source: "trigger", target: "condition", sourcePort: "output", targetPort: "input" }]
      }
    };
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

    expect(screen.getByRole("button", { name: "Connect from Ready? · True" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect from Ready? · False" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("group", { name: "Condition: Ready?" }));
    expect(screen.getByLabelText("Left value")).toHaveValue("{{input.ready}}");
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "equals" } });

    const next = onChange.mock.calls.at(-1)[0];
    expect(next.graph.nodes.find((node) => node.id === "condition").config.operator).toBe("equals");
  });
});
