import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  WorkflowGenerator,
  parseGeneratedWorkflowGraph
} from "../electron/workflows/workflow-generator.mjs";
import { resolveWorkflowGenerationModel } from "../electron/runtime/workflow-generation-models.mjs";

const generatedGraph = {
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: "trigger", type: "manualTrigger", name: "Manual trigger", description: "Start the workflow.", position: { x: 80, y: 180 }, config: {} },
    { id: "output", type: "output", name: "Workflow output", description: "Return the result.", position: { x: 380, y: 180 }, config: {} }
  ],
  edges: [{ id: "trigger-output", source: "trigger", target: "output", sourcePort: "output", targetPort: "input" }]
};

describe("workflow generation", () => {
  it("prefers Terra automatically and falls back to Claude Sonnet", () => {
    const models = [
      { id: "claude:claude-sonnet-5", model: "claude-sonnet-5", provider: "claude", displayName: "Claude Sonnet 5" },
      { id: "codex:gpt-5.6-luna", model: "gpt-5.6-luna", provider: "codex" },
      { id: "codex:gpt-5.6-terra", model: "gpt-5.6-terra", provider: "codex" }
    ];
    expect(resolveWorkflowGenerationModel("auto", models)).toMatchObject({ id: "codex:gpt-5.6-terra", effort: "medium" });
    expect(resolveWorkflowGenerationModel("auto", models.slice(0, 1))).toMatchObject({ id: "claude:claude-sonnet-5", effort: null });
    expect(resolveWorkflowGenerationModel("claude:claude-sonnet-5", models)).toMatchObject({ provider: "claude" });
  });

  it("parses and validates an executable generated graph", () => {
    expect(parseGeneratedWorkflowGraph(`\`\`\`json\n${JSON.stringify({ graph: generatedGraph })}\n\`\`\``)).toEqual(generatedGraph);
    expect(() => parseGeneratedWorkflowGraph(JSON.stringify({ graph: { ...generatedGraph, edges: [{ id: "cycle", source: "output", target: "trigger", sourcePort: "output", targetPort: "input" }] } }))).toThrow();
    expect(() => parseGeneratedWorkflowGraph(JSON.stringify({ graph: { ...generatedGraph, nodes: generatedGraph.nodes.filter((node) => node.type !== "output"), edges: [] } }))).toThrow(/Output node/);
  });

  it("adds deterministic ids when generated edges omit them", () => {
    const transform = { id: "transform", type: "transform", name: "Transform", description: "Shape the result.", position: { x: 230, y: 180 }, config: {} };
    const graph = parseGeneratedWorkflowGraph(JSON.stringify({
      graph: {
        ...generatedGraph,
        nodes: [generatedGraph.nodes[0], transform, generatedGraph.nodes[1]],
        edges: [
          { id: "edge-2", source: "trigger", target: "transform" },
          { source: "transform", target: "output", sourcePort: "output", targetPort: "input" }
        ]
      }
    }));

    expect(graph.edges.map((edge) => edge.id)).toEqual(["edge-2", "edge-2-2"]);
  });

  it("runs generation in an ephemeral read-only agent thread", async () => {
    class Runtime extends EventEmitter {
      connected = true;
      calls = [];
      async request(method, payload) {
        this.calls.push([method, payload]);
        if (method === "model/list") return { data: [{ id: "codex:gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", provider: "codex" }] };
        if (method === "thread/start") return { thread: { id: "helper-thread" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            this.emit("event", { payload: { method: "item/completed", threadId: "helper-thread", item: { type: "agentMessage", text: JSON.stringify({ graph: generatedGraph }) } } });
            this.emit("event", { payload: { method: "turn/completed", threadId: "helper-thread", turn: { id: "helper-turn", status: "completed" } } });
          });
          return { turn: { id: "helper-turn" } };
        }
        if (method === "thread/archive") return { threadId: payload.threadId };
        throw new Error(`Unexpected request: ${method}`);
      }
    }

    const runtime = new Runtime();
    const generator = new WorkflowGenerator(runtime);
    const result = await generator.generate({
      cwd: "/project",
      workflow: { id: "workflow-1", name: "Build release", description: "Build a release and return the artifact." }
    });

    expect(result.graph).toEqual(generatedGraph);
    expect(result.model).toBe("GPT-5.6 Terra");
    expect(runtime.calls.find(([method]) => method === "thread/start")[1]).toMatchObject({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      permissionMode: "read-only",
      serviceName: "pixice_workflow_generation"
    });
    expect(runtime.calls.at(-1)).toEqual(["thread/archive", { threadId: "helper-thread" }]);
  });

  it("uses Claude without reasoning effort when it is the only connected provider", async () => {
    class Runtime extends EventEmitter {
      connected = true;
      calls = [];
      async request(method, payload) {
        this.calls.push([method, payload]);
        if (method === "thread/start") return { thread: { id: "claude-helper", ephemeral: true } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            this.emit("event", { payload: { method: "item/completed", threadId: "claude-helper", item: { type: "agentMessage", text: JSON.stringify({ graph: generatedGraph }) } } });
            this.emit("event", { payload: { method: "turn/completed", threadId: "claude-helper", turn: { id: "claude-turn", status: "completed" } } });
          });
          return { turn: { id: "claude-turn" } };
        }
        if (method === "thread/archive") return { threadId: payload.threadId };
        throw new Error(`Unexpected request: ${method}`);
      }
    }

    const runtime = new Runtime();
    const generator = new WorkflowGenerator(runtime, {
      models: async () => [{ id: "claude:claude-sonnet-5", model: "claude-sonnet-5", provider: "claude", displayName: "Claude Sonnet 5" }]
    });
    await generator.generate({ cwd: "/project", workflow: { id: "workflow-claude", name: "Summarize", description: "Summarize the input." } });

    expect(runtime.calls.find(([method]) => method === "thread/start")[1]).toMatchObject({ model: "claude:claude-sonnet-5", ephemeral: true, permissionMode: "read-only", internalNoTools: true });
    expect(runtime.calls.find(([method]) => method === "turn/start")[1]).toMatchObject({ permissionMode: "read-only" });
    expect(runtime.calls.find(([method]) => method === "turn/start")[1]).not.toHaveProperty("effort");
  });
});
