import { describe, expect, it } from "vitest";
import { placeCanvasWorkflow, canvasWorkflowGraph, flattenCanvasWorkflows } from "../src/components/canvas/canvas-workflows.js";
import { createCanvas, createCanvasItem } from "../src/components/canvas/canvas-store.js";
import { createWorkflowNode, createWorkflowEdge } from "../src/components/workflows/workflow-utils.js";

function workflow() {
  const trigger = createWorkflowNode("manualTrigger", { x: 20, y: 30 });
  const agent = createWorkflowNode("pixiceAgent", { x: 330, y: 30 });
  return { id: "workflow", name: "A routine", graph: { nodes: [trigger, agent], edges: [createWorkflowEdge(trigger.id, agent.id, "output", "input")], viewport: { x: 0, y: 0, zoom: 1 } } };
}

describe("Workflows on the shared canvas", () => {
  it("keeps native configuration and edge identities when editing and saving shared nodes", () => {
    const source = workflow();
    const placed = placeCanvasWorkflow(source, { x: 100, y: 200 }, {}, "owner");
    const document = { nodes: [placed.label, ...placed.nodes], edges: placed.edges };
    document.nodes[2].position.x += 75;
    document.nodes[2].data.node.config.prompt = "Use the adjacent brief";
    document.edges.push({ id: "context", source: placed.nodes[0].id, target: "note", data: { kind: "context" } });
    const graph = canvasWorkflowGraph(document, "owner");
    expect(graph.nodes[1].position).toEqual({ x: 405, y: 30 });
    expect(graph.nodes[1].config.prompt).toBe("Use the adjacent brief");
    expect(graph.edges).toEqual(source.graph.edges);
    const replaced = placeCanvasWorkflow({ ...source, graph }, placed.label.position, {}, "owner");
    expect(replaced.edges[0].id).toBe(placed.edges[0].id);
  });

  it("imports the same workflow twice without collisions", () => {
    const source = workflow();
    const first = placeCanvasWorkflow(source, { x: 0, y: 0 });
    const second = placeCanvasWorkflow(source, { x: 700, y: 0 });
    const ids = [...first.nodes, ...second.nodes].map(node => node.id);
    expect(new Set(ids).size).toBe(4);
    const document = { nodes: [first.label, ...first.nodes, second.label, ...second.nodes], edges: [...first.edges, ...second.edges] };
    expect(canvasWorkflowGraph(document, first.label.id).nodes).toEqual(source.graph.nodes);
    expect(canvasWorkflowGraph(document, second.label.id).nodes).toEqual(source.graph.nodes);
  });

  it("migrates prior embedded workflow cards once while preserving their context connections", () => {
    const document = createCanvas();
    const card = createCanvasItem("workflow", { x: 40, y: 80 }, { workflow: workflow() });
    const note = createCanvasItem("text", { x: 0, y: 0 }, { content: "Brief" });
    document.nodes = [card, note];
    document.edges = [{ id: "context", source: card.id, target: note.id }];
    const migrated = flattenCanvasWorkflows(document);
    expect(migrated.nodes).toHaveLength(4);
    expect(migrated.nodes.find(node => node.id === card.id).data.flattened).toBe(true);
    expect(migrated.edges[0]).toEqual(document.edges[0]);
    expect(flattenCanvasWorkflows(migrated)).toBe(migrated);
    expect(canvasWorkflowGraph(migrated, card.id).nodes).toEqual(card.data.workflow.graph.nodes);
  });
});
