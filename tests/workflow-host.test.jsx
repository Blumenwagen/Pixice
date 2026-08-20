import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowHost } from "../src/components/workflows/WorkflowHost.jsx";

const workflow = {
  id: "workflow-1",
  projectId: "project-1",
  name: "Release workflow",
  description: "Review and ship a release.",
  createdByThreadId: null,
  createdAt: "2026-08-20T06:00:00.000Z",
  updatedAt: "2026-08-20T06:00:00.000Z",
  graph: {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "trigger", type: "manualTrigger", name: "Manual trigger", description: "", position: { x: 50, y: 100 }, config: {} },
      { id: "agent", type: "loomAgent", name: "Review release", description: "", position: { x: 380, y: 100 }, config: { prompt: "Review", executionMode: "background", permissionMode: "workspace-write" } },
      { id: "output", type: "output", name: "Result", description: "", position: { x: 710, y: 100 }, config: {} }
    ],
    edges: [
      { id: "one", source: "trigger", target: "agent", sourcePort: "output", targetPort: "input" },
      { id: "two", source: "agent", target: "output", sourcePort: "output", targetPort: "input" }
    ]
  }
};

function createApi(threads = [{ id: "thread-lead", name: "Lead task", parentThreadId: null }]) {
  const listeners = new Set();
  const api = {
    projects: { list: vi.fn(async () => [{ id: "project-1", displayName: "Loom", canonicalPath: "/workspace" }]) },
    models: { list: vi.fn(async () => []) },
    threads: { list: vi.fn(async () => ({ data: threads })) },
    browser: { setViewport: vi.fn(async () => ({ native: false, activeTabId: null, tabs: [] })) },
    workflows: {
      list: vi.fn(async () => ({ data: [{ ...workflow, latestRun: null }] })),
      read: vi.fn(async () => ({ workflow, runs: [] })),
      save: vi.fn(async (payload) => ({ ...workflow, ...payload, updatedAt: "2026-08-20T06:01:00.000Z" })),
      create: vi.fn(async () => workflow),
      delete: vi.fn(async () => workflow),
      run: vi.fn(async () => ({ id: "run-1", workflowId: workflow.id, projectId: workflow.projectId, status: "queued", nodeRuns: {} })),
      cancel: vi.fn(async () => ({ id: "run-1", workflowId: workflow.id, projectId: workflow.projectId, status: "cancelled", nodeRuns: {} }))
    },
    events: {
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    }
  };
  return {
    api,
    emit: (type, payload) => listeners.forEach((listener) => listener({ type, payload, at: new Date().toISOString() }))
  };
}

function Shell({ taskNames = ["Lead task"], onTaskClick = () => {} }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <div className="loom-app" style={{ "--rail-width": "264px" }}>
      <aside className="sidebar">
        <div className="rail-group" />
        <div className="task-tree">
          {taskNames.map((name, index) => (
            <div className={`task-row ${index === 0 ? "active" : ""}`} key={name}>
              <button className="task-select" onClick={() => onTaskClick(name)}><span className="task-title">{name}</span></button>
            </div>
          ))}
        </div>
      </aside>
      <button aria-label="Open preview workspace" onClick={() => setPreviewOpen(true)}>Preview</button>
      {previewOpen && (
        <section className="browser-panel">
          <button aria-label="Close preview workspace" onClick={() => setPreviewOpen(false)}>Close</button>
        </section>
      )}
    </div>
  );
}

beforeEach(() => {
  localStorage.setItem("loom.activeProjectId", "project-1");
});

afterEach(() => {
  delete window.loom;
  localStorage.clear();
});

describe("WorkflowHost", () => {
  it("adds a dedicated Workflows navigation item and opens the library workspace", async () => {
    const { api } = createApi();
    window.loom = api;
    render(<WorkflowHost><Shell /></WorkflowHost>);

    const navigation = await screen.findByRole("button", { name: "Workflows" });
    fireEvent.click(navigation);

    await waitFor(() => expect(document.querySelector('[data-workflow-workspace="true"]')).toBeInTheDocument());
    expect(await screen.findAllByText("Release workflow")).not.toHaveLength(0);
    expect(api.workflows.list).toHaveBeenCalledWith({ projectId: "project-1" });
  });

  it("opens an agent-requested workflow inside the controlling thread Preview", async () => {
    const onTaskClick = vi.fn();
    const { api, emit } = createApi();
    window.loom = api;
    render(<WorkflowHost><Shell onTaskClick={onTaskClick} /></WorkflowHost>);
    await screen.findByRole("button", { name: "Workflows" });

    emit("WorkflowOpenRequested", {
      projectId: "project-1",
      workflowId: "workflow-1",
      workflowName: "Release workflow",
      threadId: "thread-agent",
      workspaceId: "thread-lead",
      reason: "edit"
    });

    expect(await screen.findByLabelText("Workflow preview")).toBeInTheDocument();
    expect(screen.getByText("Agent is editing this workflow")).toBeInTheDocument();
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith({ workspaceId: "thread-lead", visible: false }));
    await waitFor(() => expect(onTaskClick).toHaveBeenCalledWith("Lead task"));
  });

  it("brings a foreground workflow agent into its normal task thread", async () => {
    const onTaskClick = vi.fn();
    const { api, emit } = createApi([
      { id: "thread-lead", name: "Lead task", parentThreadId: null },
      { id: "thread-foreground", name: "Foreground agent", parentThreadId: null }
    ]);
    window.loom = api;
    render(<WorkflowHost><Shell taskNames={["Lead task", "Foreground agent"]} onTaskClick={onTaskClick} /></WorkflowHost>);
    await screen.findByRole("button", { name: "Workflows" });

    emit("WorkflowForegroundRequested", {
      projectId: "project-1",
      workflowId: "workflow-1",
      workflowName: "Release workflow",
      runId: "run-1",
      nodeId: "agent",
      threadId: "thread-foreground",
      sourceThreadId: "thread-lead"
    });

    await waitFor(() => expect(onTaskClick).toHaveBeenCalledWith("Foreground agent"));
    expect(await screen.findByLabelText("Workflow preview")).toBeInTheDocument();
    expect(screen.getByText("Agent is running this workflow")).toBeInTheDocument();
    await waitFor(() => expect(api.browser.setViewport).toHaveBeenCalledWith({ workspaceId: "thread-foreground", visible: false }));
  });
});
