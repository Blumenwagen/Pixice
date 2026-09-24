import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FocusCoordination } from "../src/components/FocusCoordination.jsx";

const models = [
  { model: "gpt-5.6-luna", displayName: "Luna", provider: "codex" },
  { model: "claude-haiku", displayName: "Haiku", provider: "claude" },
];

function focusState(overrides = {}) {
  return {
    work: [{ id: "work-1", title: "Check release", prompt: "Check the release notes", status: "running", model: "gpt-5.6-luna", verification: { status: "passed", evidence: "pnpm test" }, decisionRevision: 3, acknowledgedDecisionRevision: 2 }],
    decisions: [], policy: { coordinatorModel: "gpt-5.6-luna", workerModel: null, reviewModel: null, permissionMode: "workspace-write", executionHost: "current" },
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

function renderCoordination(props = {}) {
  return render(<FocusCoordination api={props.api} projectId={props.projectId ?? "project-a"} models={models} open={props.open ?? true} onClose={props.onClose} />);
}

describe("FocusCoordination", () => {
  it("uses the parent-controlled panel state and close action", async () => {
    const api = createApi();
    const onClose = vi.fn();
    const { rerender } = renderCoordination({ api, open: false, onClose });

    const panel = document.getElementById("focus-activity-panel");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");

    rerender(<FocusCoordination api={api} projectId="project-a" models={models} open onClose={onClose} />);
    expect(screen.getByRole("complementary", { name: "Coordinator activity" })).toHaveAttribute("aria-hidden", "false");
    const close = screen.getByRole("button", { name: "Close activity panel" });
    expect(close.querySelector("svg")).toBeInTheDocument();
    expect(close).toHaveTextContent("");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("controls, redirects, and exposes the review state for delegated work", async () => {
    const api = createApi();
    renderCoordination({ api });
    await screen.findByText("Since you were away");
    fireEvent.click(screen.getByRole("button", { name: /Check release/ }));
    expect(screen.getByText("Decision needs acknowledgement")).toBeInTheDocument();
    expect(screen.getByText("Verification · passed: pnpm test")).toBeInTheDocument();

    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause).toHaveClass("focus-coordination-action-primary");
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveClass("focus-coordination-action-primary");
    fireEvent.click(pause);
    await waitFor(() => expect(api.focus.controlWork).toHaveBeenCalledWith({ projectId: "project-a", workId: "work-1", action: "pause" }));

    const redirect = screen.getByRole("textbox", { name: "Redirect Check release" });
    fireEvent.change(redirect, { target: { value: "Use the stable branch" } });
    fireEvent.submit(redirect.closest("form"));
    await waitFor(() => expect(api.focus.followUp).toHaveBeenCalledWith({ projectId: "project-a", workId: "work-1", prompt: "Use the stable branch" }));
  });

  it("omits the worker count control and still updates worker access", async () => {
    const api = createApi();
    renderCoordination({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Coordinator policy" }));
    expect(screen.queryByLabelText("Concurrent workers")).not.toBeInTheDocument();
    expect(screen.queryByText("Concurrent workers")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "New work access" }), { target: { value: "read-only" } });
    await waitFor(() => expect(api.focus.updatePolicy).toHaveBeenCalledWith({ projectId: "project-a", patch: { permissionMode: "read-only" } }));
  });

  it("dismisses only the supplied monotonic activity sequence", async () => {
    const api = createApi();
    renderCoordination({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.focus.markSeen).toHaveBeenCalledWith({ projectId: "project-a", sequence: 5 }));
    expect(screen.queryByText("Since you were away")).not.toBeInTheDocument();
  });

  it("keeps a redirect draft when its follow-up fails", async () => {
    const api = createApi();
    api.focus.followUp.mockRejectedValueOnce(new Error("Coordinator unavailable"));
    renderCoordination({ api });
    await screen.findByText("Since you were away");
    fireEvent.click(screen.getByRole("button", { name: /Check release/ }));
    const redirect = screen.getByRole("textbox", { name: "Redirect Check release" });
    fireEvent.change(redirect, { target: { value: "Keep this direction" } });
    fireEvent.submit(redirect.closest("form"));
    await screen.findByRole("alert");
    expect(redirect).toHaveValue("Keep this direction");
  });

  it("offers recovery for work needing attention and exposes persisted artifacts", async () => {
    const api = createApi(focusState({ work: [{ id: "recover", title: "Recover inspection", status: "needs-attention", artifacts: ["src/exporter.js"] }] }));
    renderCoordination({ api });
    await screen.findByText("Recover inspection");
    fireEvent.click(screen.getByRole("button", { name: /Recover inspection/ }));
    expect(screen.getByText("src/exporter.js")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.focus.controlWork).toHaveBeenCalledWith({ projectId: "project-a", workId: "recover", action: "resume" }));
  });

  it("shows every current item and only the three newest terminal items from the last day", async () => {
    const now = Date.now();
    const work = [
      ...["running", "review", "paused", "blocked", "needs-attention"].map((status) => ({ id: status, title: `Current ${status}`, status, updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() })),
      ...[1, 2, 3, 4].map((minutes) => ({ id: `recent-${minutes}`, title: `Recent ${minutes}`, status: minutes === 4 ? "cancelled" : "done", updatedAt: new Date(now - minutes * 60 * 1000).toISOString() })),
      { id: "old", title: "Week-old failed work", status: "failed", updatedAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const api = createApi(focusState({ work, unseenEvents: [] }));
    renderCoordination({ api });
    expect(await screen.findByText("5 active")).toBeInTheDocument();
    for (const status of ["running", "review", "paused", "blocked", "needs-attention"]) expect(screen.getByText(`Current ${status}`)).toBeInTheDocument();
    for (const minutes of [1, 2, 3]) expect(screen.getByText(`Recent ${minutes}`)).toBeInTheDocument();
    expect(screen.queryByText("Recent 4")).not.toBeInTheDocument();
    expect(screen.queryByText("Week-old failed work")).not.toBeInTheDocument();
    expect(work).toHaveLength(10);
  });

  it("ages a terminal item out without another Focus event", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-09-23T12:00:00.000Z");
      vi.setSystemTime(now);
      const api = createApi(focusState({ work: [{ id: "expiring", title: "Recent completion", status: "done", updatedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1000).toISOString() }], unseenEvents: [] }));
      renderCoordination({ api });
      await act(async () => {});
      expect(screen.getByText("Recent completion")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.queryByText("Recent completion")).not.toBeInTheDocument();
      expect(screen.getByText("No current work")).toBeInTheDocument();
      expect(screen.getByText("No active or recent work.")).toBeInTheDocument();
      expect(api.focus.state).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a slow response from the previous project", async () => {
    let resolveA;
    const api = createApi();
    api.focus.state.mockImplementation(({ projectId }) => projectId === "project-a"
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve(focusState({ work: [{ id: "work-b", title: "Project B work", status: "done", updatedAt: new Date().toISOString() }], unseenEvents: [] })));
    const { rerender } = renderCoordination({ api });
    rerender(<FocusCoordination api={api} projectId="project-b" models={models} open />);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    resolveA(focusState({ work: [{ id: "work-a", title: "Old project work", status: "running" }] }));
    await waitFor(() => expect(screen.getByText("Project B work")).toBeInTheDocument());
    expect(screen.queryByText("Old project work")).not.toBeInTheDocument();
  });
});
