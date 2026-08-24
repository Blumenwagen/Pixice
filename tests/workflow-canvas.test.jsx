import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultWorkflow } from "../electron/workflows/workflow-model.mjs";
import { WorkflowCanvas } from "../src/components/workflows/WorkflowCanvas.jsx";

const workflowWorkspaceCss = readFileSync("src/components/workflows/WorkflowWorkspace.module.css", "utf8");
const workflowNodesCss = readFileSync("src/components/workflows/WorkflowNodes.module.css", "utf8");

describe("WorkflowCanvas", () => {
  it("floats canvas controls instead of reserving toolbar and timeline rows", () => {
    expect(workflowWorkspaceCss).toContain(".editor { grid-template-rows: minmax(0, 1fr); }");
    expect(workflowWorkspaceCss).toMatch(/\.canvasToolbar\s*\{[^}]*position: absolute;[^}]*background: transparent;/s);
    expect(workflowWorkspaceCss).toMatch(/\.runTimeline\s*\{[^}]*position: absolute;[^}]*width: fit-content;/s);
  });

  it("keeps the add-node list scrollable within the popup height", () => {
    expect(workflowNodesCss).toMatch(/\.nodePicker\s*\{[^}]*max-height:[^;]+;[^}]*display: flex;[^}]*flex-direction: column;/s);
    expect(workflowNodesCss).toMatch(/\.nodePickerBody\s*\{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/s);
  });

  it("lets users promote a Pixice Agent node from background to foreground", () => {
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
    fireEvent.click(screen.getByRole("group", { name: "Pixice Agent: Pixice Agent" }));
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

  it("offers useful action, data, flow, Skill, and Pixice nodes from a searchable picker", () => {
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
    expect(screen.getByText("Git").closest("button")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use Skill/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pixice Board/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search actions, data, flow…"), { target: { value: "skill" } });
    expect(screen.getByRole("button", { name: /Use Skill/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /HTTP Request/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Use Skill/i }));

    const next = onChange.mock.calls.at(-1)[0];
    expect(next.graph.nodes.at(-1)).toMatchObject({
      type: "useSkill",
      name: "Use Skill",
      config: expect.objectContaining({ source: "installed", maxBytes: 500000 })
    });
  });

  it("connects Use Skill only to an Agent Skill port", () => {
    const workflow = {
      ...createDefaultWorkflow({ projectId: "project-1" }),
      graph: {
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: "skill", type: "useSkill", name: "Release Rules", description: "", position: { x: 40, y: 180 }, config: { source: "markdown", path: "docs/release.md" } },
          { id: "agent", type: "loomAgent", name: "Release Agent", description: "", position: { x: 420, y: 140 }, config: {} }
        ],
        edges: []
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

    fireEvent.click(screen.getByRole("button", { name: "Connect from Release Rules · Skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect into Release Agent · Input" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Use Skill nodes connect only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect into Release Agent · Skill" }));
    const next = onChange.mock.calls.at(-1)[0];
    expect(next.graph.edges).toEqual([
      expect.objectContaining({ source: "skill", target: "agent", sourcePort: "skill", targetPort: "skill" })
    ]);
  });

  it("discovers installed Skills and configures project Markdown attachments", async () => {
    let workflow = {
      ...createDefaultWorkflow({ projectId: "project-1" }),
      graph: {
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: "skill", type: "useSkill", name: "Use Skill", description: "", position: { x: 40, y: 120 }, config: { source: "installed", skillRef: "", skillName: "", path: "", maxBytes: 500000 } }
        ],
        edges: []
      }
    };
    const api = {
      extensions: {
        list: vi.fn(async () => ({
          skills: [{
            cwd: "/workspace",
            skills: [{ id: "release-review", name: "Release Review", description: "Verify release readiness", path: "/skills/release-review" }]
          }],
          errors: []
        }))
      }
    };
    const onChange = vi.fn();
    const renderCanvas = () => (
      <WorkflowCanvas
        workflow={workflow}
        api={api}
        models={[]}
        onChange={onChange}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const view = render(renderCanvas());

    fireEvent.click(screen.getByRole("group", { name: "Use Skill: Use Skill" }));
    await waitFor(() => expect(api.extensions.list).toHaveBeenCalledWith({ projectId: "project-1" }));
    const installed = await screen.findByLabelText("Installed Skill");
    fireEvent.change(installed, { target: { value: "/skills/release-review" } });
    workflow = onChange.mock.calls.at(-1)[0];
    expect(workflow.graph.nodes[0].config).toMatchObject({ skillRef: "/skills/release-review", skillName: "Release Review" });
    view.rerender(renderCanvas());

    fireEvent.change(screen.getByLabelText("Instruction source"), { target: { value: "markdown" } });
    workflow = onChange.mock.calls.at(-1)[0];
    expect(workflow.graph.nodes[0].config).toMatchObject({ source: "markdown", skillRef: "", path: "" });
    view.rerender(renderCanvas());
    expect(screen.getByLabelText("Skill Markdown path")).toBeInTheDocument();
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
