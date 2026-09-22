import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FocusCoordination } from "../src/components/FocusCoordination.jsx";

const models = [
  { model: "gpt-5.6-luna", displayName: "Luna", provider: "codex" },
  { model: "claude-haiku", displayName: "Haiku", provider: "claude" },
];

function focusState(overrides = {}) {
  return {
    work: [{ id: "work-1", title: "Check release", prompt: "Check the release notes", status: "running", model: "gpt-5.6-luna", verification: { status: "passed", evidence: "pnpm test" }, decisionRevision: 3, acknowledgedDecisionRevision: 2 }],
    decisions: [], policy: { coordinatorModel: "gpt-5.6-luna", workerModel: null, reviewModel: null, maxWorkers: 2, permissionMode: "workspace-write", executionHost: "current" },
    seenSequence: 2, latestSequence: 5, unseenEvents: [{ sequence: 5, summary: "Release check started" }],
    ...overrides,
  };
}

function createApi(state = focusState()) {
  const listeners = new Set();
  return {
    focus: {
      state: vi.fn(async () => state),
      controlWork: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
      updatePolicy: vi.fn(async ({ patch }) => ({ ...state.policy, ...patch })),
      markSeen: vi.fn(async () => ({})),
    },
    events: { subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }) },
    emit: (payload) => listeners.forEach((listener) => listener({ type: "FocusUpdated", payload })),
  };
}

describe("FocusCoordination", () => {
  it("controls, redirects, and exposes the review state for delegated work", async () => {
    const api = createApi();
    render(<FocusCoordination api={api} projectId="project-a" models={models} />);
    await screen.findByText("Since you were away");
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("button", { name: /Check release/ }));
    expect(screen.getByText("Decision needs acknowledgement")).toBeInTheDocument();
    expect(screen.getByText("Verification · passed: pnpm test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.focus.controlWork).toHaveBeenCalledWith({ projectId: "project-a", workId: "work-1", action: "pause" }));

    const redirect = screen.getByRole("textbox", { name: "Redirect Check release" });
    fireEvent.change(redirect, { target: { value: "Use the stable branch" } });
    fireEvent.submit(redirect.closest("form"));
    await waitFor(() => expect(api.focus.followUp).toHaveBeenCalledWith({ projectId: "project-a", workId: "work-1", prompt: "Use the stable branch" }));
  });

  it("dismisses only the supplied monotonic activity sequence", async () => {
    const api = createApi();
    render(<FocusCoordination api={api} projectId="project-a" models={models} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.focus.markSeen).toHaveBeenCalledWith({ projectId: "project-a", sequence: 5 }));
    expect(screen.queryByText("Since you were away")).not.toBeInTheDocument();
  });

  it("keeps a redirect draft when its follow-up fails", async () => {
    const api = createApi();
    api.focus.followUp.mockRejectedValueOnce(new Error("Coordinator unavailable"));
    render(<FocusCoordination api={api} projectId="project-a" models={models} />);
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("button", { name: /Check release/ }));
    const redirect = screen.getByRole("textbox", { name: "Redirect Check release" });
    fireEvent.change(redirect, { target: { value: "Keep this direction" } });
    fireEvent.submit(redirect.closest("form"));
    await screen.findByRole("alert");
    expect(redirect).toHaveValue("Keep this direction");
  });

  it("offers recovery for work needing attention and exposes persisted artifacts", async () => {
    const api = createApi(focusState({ work: [{ id: "recover", title: "Recover inspection", status: "needs-attention", artifacts: ["src/exporter.js"] }] }));
    render(<FocusCoordination api={api} projectId="project-a" models={models} />);
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }));
    fireEvent.click(screen.getByRole("button", { name: /Recover inspection/ }));
    expect(screen.getByText("src/exporter.js")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.focus.controlWork).toHaveBeenCalledWith({ projectId: "project-a", workId: "recover", action: "resume" }));
  });

  it("ignores a slow response from the previous project", async () => {
    let resolveA;
    const api = createApi();
    api.focus.state.mockImplementation(({ projectId }) => projectId === "project-a"
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve(focusState({ work: [{ id: "work-b", title: "Project B work", status: "done" }], unseenEvents: [] })));
    const { rerender } = render(<FocusCoordination api={api} projectId="project-a" models={models} />);
    rerender(<FocusCoordination api={api} projectId="project-b" models={models} />);
    expect(await screen.findByRole("button", { name: "Activity" })).toHaveTextContent("Up to date");
    resolveA(focusState({ work: [{ id: "work-a", title: "Old project work", status: "running" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    await waitFor(() => expect(screen.getByText("Project B work")).toBeInTheDocument());
    expect(screen.queryByText("Old project work")).not.toBeInTheDocument();
  });
});
