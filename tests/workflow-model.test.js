import { describe, expect, it } from "vitest";
import {
  createDefaultWorkflow,
  validateWorkflowGraph,
  workflowExecutionLayers,
  workflowInputsForNode
} from "../electron/workflows/workflow-model.mjs";

describe("workflow model", () => {
  it("creates an executable background Loom Agent workflow", () => {
    const workflow = createDefaultWorkflow({ projectId: "project-1", name: "Ship release" });
    expect(workflow.name).toBe("Ship release");
    expect(workflow.graph.nodes.map((node) => node.type)).toEqual(["manualTrigger", "loomAgent", "output"]);
    expect(workflow.graph.nodes.find((node) => node.type === "loomAgent")?.config.executionMode).toBe("background");
    expect(workflowExecutionLayers(workflow)).toHaveLength(3);
  });

  it("normalizes older agent nodes and rejects invalid execution modes", () => {
    const graph = {
      nodes: [
        { id: "start", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
        { id: "agent", type: "loomAgent", name: "Agent", description: "", position: { x: 1, y: 1 }, config: { prompt: "Work" } }
      ],
      edges: [{ id: "edge", source: "start", target: "agent", sourcePort: "output", targetPort: "input" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    };
    expect(validateWorkflowGraph(graph).nodes[1].config).toMatchObject({
      executionMode: "background",
      permissionMode: "workspace-write"
    });
    expect(() => validateWorkflowGraph({
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "agent" ? { ...node, config: { executionMode: "detached" } } : node)
    })).toThrow(/execution mode/i);
  });

  it("rejects broken references and cyclic graphs", () => {
    expect(() => validateWorkflowGraph({
      nodes: [{ id: "a", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} }],
      edges: [{ id: "edge", source: "a", target: "missing", sourcePort: "output", targetPort: "input" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/missing target/i);

    expect(() => workflowExecutionLayers({
      graph: {
        nodes: [
          { id: "a", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
          { id: "b", type: "output", name: "Done", description: "", position: { x: 1, y: 1 }, config: {} }
        ],
        edges: [
          { id: "ab", source: "a", target: "b", sourcePort: "output", targetPort: "input" },
          { id: "ba", source: "b", target: "a", sourcePort: "output", targetPort: "input" }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    })).toThrow(/cycle/i);
  });

  it("collects upstream values in connection order", () => {
    const workflow = createDefaultWorkflow({ projectId: "project-1" });
    const agent = workflow.graph.nodes.find((node) => node.type === "loomAgent");
    const trigger = workflow.graph.nodes.find((node) => node.type === "manualTrigger");
    const outputs = new Map([[trigger.id, { ticket: 42 }]]);
    expect(workflowInputsForNode(workflow, agent.id, outputs)).toEqual([
      expect.objectContaining({ sourceNodeId: trigger.id, value: { ticket: 42 } })
    ]);
  });
});
