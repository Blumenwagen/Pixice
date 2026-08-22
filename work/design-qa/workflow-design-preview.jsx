import React from "react";
import { createRoot } from "react-dom/client";
import { WorkflowWorkspace } from "../../src/components/workflows/WorkflowWorkspace.jsx";
import "../../src/styles.css";

const nodes = [
  { id: "brief", type: "manualTrigger", name: "Brief", description: "Capture the goal, audience, and constraints for this run.", position: { x: 40, y: 190 }, config: {} },
  { id: "scout", type: "httpRequest", name: "Scout", description: "Collect the source material the creative agents need.", position: { x: 320, y: 190 }, config: { method: "GET", url: "https://example.com" } },
  { id: "writer", type: "loomAgent", name: "Writer", description: "Turn the research into a concise first draft.", position: { x: 600, y: 80 }, config: { prompt: "Write a draft.", executionMode: "background", permissionMode: "workspace-write" } },
  { id: "designer", type: "loomAgent", name: "Designer", description: "Develop a visual direction alongside the written draft.", position: { x: 600, y: 300 }, config: { prompt: "Design the supporting visual.", executionMode: "background", permissionMode: "workspace-write" } },
  { id: "merge", type: "merge", name: "Merge", description: "Combine both creative outputs into one review package.", position: { x: 880, y: 190 }, config: {} },
  { id: "critic", type: "loomAgent", name: "Critic", description: "Check quality, risk, and alignment before human review.", position: { x: 1160, y: 190 }, config: { prompt: "Review this work.", executionMode: "background", permissionMode: "read-only" } },
  { id: "approval", type: "condition", name: "Human check", description: "Pause for a final decision before delivery.", position: { x: 1440, y: 190 }, config: { left: "{{input.approved}}", operator: "isTrue", right: "" } },
  { id: "deliver", type: "output", name: "Deliver", description: "Return the approved package to the calling task.", position: { x: 1720, y: 190 }, config: {} }
];

const edges = [
  ["brief", "scout", "output", "input"],
  ["scout", "writer", "output", "input"],
  ["scout", "designer", "output", "input"],
  ["writer", "merge", "output", "input"],
  ["designer", "merge", "output", "input"],
  ["merge", "critic", "output", "input"],
  ["critic", "approval", "output", "input"],
  ["approval", "deliver", "true", "input"]
].map(([source, target, sourcePort, targetPort], index) => ({ id: `edge-${index}`, source, target, sourcePort, targetPort }));

const workflow = {
  id: "creative-review",
  projectId: "loom-preview",
  name: "Creative review thread",
  description: "Research, create, critique, and approve one deliverable.",
  enabled: false,
  updatedAt: new Date().toISOString(),
  graph: { nodes, edges, viewport: { x: 12, y: 74, zoom: .68 } }
};

const run = {
  id: "run-27",
  workflowId: workflow.id,
  status: "running",
  output: null,
  nodeRuns: Object.fromEntries(nodes.map((node, index) => [node.id, {
    nodeId: node.id,
    status: index < 5 ? "completed" : index === 5 ? "running" : "queued"
  }]))
};

const api = {
  workflows: {
    list: async () => ({ data: [{ ...workflow, latestRun: run }] }),
    read: async () => ({ workflow, runs: [run] }),
    save: async (candidate) => ({ ...workflow, ...candidate, updatedAt: new Date().toISOString() }),
    run: async () => run,
    cancel: async () => ({ ...run, status: "cancelled" }),
    create: async () => workflow,
    delete: async () => null
  },
  events: { subscribe: () => () => {} }
};

createRoot(document.getElementById("root")).render(
  <div className="loom-app" style={{ "--rail-width": "0px" }}>
    <WorkflowWorkspace api={api} projectId="loom-preview" projectName="Loom" models={[]} />
  </div>
);

if (new URLSearchParams(window.location.search).has("inspector")) {
  window.setTimeout(() => document.querySelector('[aria-label="Workflow settings"]')?.click(), 650);
}
