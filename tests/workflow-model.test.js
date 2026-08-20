import { describe, expect, it } from "vitest";
import {
  createDefaultWorkflow,
  validateWorkflowGraph,
  workflowExecutionLayers,
  workflowInputsForNode
} from "../electron/workflows/workflow-model.mjs";
import { workflowNodeResult } from "../electron/workflows/workflow-node-executors.mjs";

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

  it("allows multiple Use Skill nodes only on a Loom Agent Skill input", () => {
    const nodes = [
      { id: "start", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
      { id: "skill-one", type: "useSkill", name: "Release Skill", description: "", position: { x: 0, y: 2 }, config: { source: "installed", skillRef: "release", skillName: "Release" } },
      { id: "skill-two", type: "useSkill", name: "Project Guide", description: "", position: { x: 0, y: 4 }, config: { source: "markdown", path: "docs/guide.md" } },
      { id: "agent", type: "loomAgent", name: "Agent", description: "", position: { x: 2, y: 2 }, config: {} },
      { id: "transform", type: "transform", name: "Transform", description: "", position: { x: 4, y: 2 }, config: {} }
    ];
    const valid = validateWorkflowGraph({
      nodes,
      edges: [
        { id: "data", source: "start", target: "agent", sourcePort: "output", targetPort: "input" },
        { id: "skill-one-edge", source: "skill-one", target: "agent", sourcePort: "skill", targetPort: "skill" },
        { id: "skill-two-edge", source: "skill-two", target: "agent", sourcePort: "skill", targetPort: "skill" }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    expect(valid.nodes.find((node) => node.id === "skill-one")?.config).toMatchObject({
      source: "installed",
      skillRef: "release",
      maxBytes: 500_000
    });
    expect(valid.edges.filter((edge) => edge.targetPort === "skill")).toHaveLength(2);

    expect(() => validateWorkflowGraph({
      nodes,
      edges: [{ id: "wrong-agent-port", source: "skill-one", target: "agent", sourcePort: "skill", targetPort: "input" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/directly to Loom Agent · Skill/i);

    expect(() => validateWorkflowGraph({
      nodes,
      edges: [{ id: "wrong-source", source: "start", target: "agent", sourcePort: "output", targetPort: "skill" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/directly to Loom Agent · Skill/i);

    expect(() => validateWorkflowGraph({
      nodes,
      edges: [{ id: "wrong-target", source: "skill-one", target: "transform", sourcePort: "skill", targetPort: "input" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/directly to Loom Agent · Skill/i);
  });

  it("rejects broken references, invalid ports, and cyclic graphs", () => {
    expect(() => validateWorkflowGraph({
      nodes: [{ id: "a", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} }],
      edges: [{ id: "edge", source: "a", target: "missing", sourcePort: "output", targetPort: "input" }],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/missing target/i);

    expect(() => validateWorkflowGraph({
      nodes: [
        { id: "start", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
        { id: "condition", type: "condition", name: "Condition", description: "", position: { x: 1, y: 1 }, config: {} },
        { id: "output", type: "output", name: "Output", description: "", position: { x: 2, y: 2 }, config: {} }
      ],
      edges: [
        { id: "one", source: "start", target: "condition", sourcePort: "output", targetPort: "input" },
        { id: "two", source: "condition", target: "output", sourcePort: "maybe", targetPort: "input" }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    })).toThrow(/missing output port/i);

    expect(() => workflowExecutionLayers({
      graph: {
        nodes: [
          { id: "start", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
          { id: "a", type: "transform", name: "A", description: "", position: { x: 1, y: 1 }, config: {} },
          { id: "b", type: "transform", name: "B", description: "", position: { x: 2, y: 2 }, config: {} }
        ],
        edges: [
          { id: "start-a", source: "start", target: "a", sourcePort: "output", targetPort: "input" },
          { id: "a-b", source: "a", target: "b", sourcePort: "output", targetPort: "input" },
          { id: "b-a", source: "b", target: "a", sourcePort: "output", targetPort: "input" }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    })).toThrow(/cycle/i);
  });

  it("collects only values emitted through active output ports", () => {
    const workflow = {
      graph: {
        nodes: [
          { id: "start", type: "manualTrigger", name: "Start", description: "", position: { x: 0, y: 0 }, config: {} },
          { id: "condition", type: "condition", name: "Condition", description: "", position: { x: 1, y: 1 }, config: {} },
          { id: "true-target", type: "transform", name: "True", description: "", position: { x: 2, y: 0 }, config: {} },
          { id: "false-target", type: "transform", name: "False", description: "", position: { x: 2, y: 2 }, config: {} }
        ],
        edges: [
          { id: "start-condition", source: "start", target: "condition", sourcePort: "output", targetPort: "input" },
          { id: "true", source: "condition", target: "true-target", sourcePort: "true", targetPort: "input" },
          { id: "false", source: "condition", target: "false-target", sourcePort: "false", targetPort: "input" }
        ],
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    };
    const outputs = new Map([
      ["condition", workflowNodeResult({ matched: true }, { true: { ticket: 42 } })]
    ]);
    expect(workflowInputsForNode(workflow, "true-target", outputs)).toEqual([
      expect.objectContaining({ sourceNodeId: "condition", sourcePort: "true", value: { ticket: 42 } })
    ]);
    expect(workflowInputsForNode(workflow, "false-target", outputs)).toEqual([]);
  });
});
