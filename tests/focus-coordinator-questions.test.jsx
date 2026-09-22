import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusCoordinatorQuestions } from "../src/components/FocusCoordinatorQuestions.jsx";

const request = {
  id: "request-1",
  requestGeneration: 3,
  params: {
    isBlocking: false,
    focusCoordinatorQuestion: true,
    coordinatorReason: "Two workers need the same product decision.",
    coordinatorRecommendation: "Keep the current session shape.",
    workerCount: 2,
    questions: [
      { id: "approach", header: "Session shape", question: "Which migration approach should we use?", options: [{ label: "Preserve shape", description: "Migrate without changing callers.", recommended: true }, { label: "Redesign", description: "Change the session contract." }] },
      { id: "detail", header: "Constraint", question: "What should the workers preserve?", options: [] },
    ]
  }
};

afterEach(() => localStorage.clear());

describe("FocusCoordinatorQuestions", () => {
  it("answers multiple inline coordinator questions through the generic callback and retains a receipt", async () => {
    const onResolve = vi.fn(async () => true);
    render(<FocusCoordinatorQuestions projectId="project-a" requests={[request]} onResolve={onResolve} storage={localStorage} />);
    expect(screen.getByRole("heading", { name: "Which migration approach should we use?" })).toBeInTheDocument();
    expect(screen.getByText("Two workers need the same product decision.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Preserve shape/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer for What should the workers preserve?" }), { target: { value: "Existing refresh semantics" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(request, { action: "answer", answers: { approach: "Preserve shape", detail: "Existing refresh semantics" } }));
    expect(await screen.findByText("Coordinator question answered")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
  });

  it("keeps drafts and shows an inline error when resolving is rejected", async () => {
    const onResolve = vi.fn(async () => false);
    render(<FocusCoordinatorQuestions projectId="project-a" requests={[request]} onResolve={onResolve} storage={localStorage} />);
    fireEvent.click(screen.getByRole("radio", { name: /Preserve shape/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer for What should the workers preserve?" }), { target: { value: "Keep cookies" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not accepted");
    expect(screen.getByRole("textbox", { name: "Answer for What should the workers preserve?" })).toHaveValue("Keep cookies");
  });

  it("keeps a custom answer field open and submits its typed value", async () => {
    const onResolve = vi.fn(async () => true);
    const single = { ...request, params: { ...request.params, questions: [request.params.questions[0]] } };
    render(<FocusCoordinatorQuestions projectId="project-a" requests={[single]} onResolve={onResolve} storage={localStorage} />);
    fireEvent.click(screen.getByRole("button", { name: "Type a different answer" }));
    const input = screen.getByRole("textbox", { name: "Answer for Which migration approach should we use?" });
    fireEvent.change(input, { target: { value: "Stage it behind a flag" } });
    expect(input).toHaveValue("Stage it behind a flag");
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(single, { action: "answer", answers: { approach: "Stage it behind a flag" } }));
  });

  it("persists non-secret drafts per project and generation without storing secret answers", async () => {
    const secretRequest = { ...request, requestGeneration: 4, params: { ...request.params, questions: [{ id: "secret", header: "Credential", question: "Enter the one-time value", isSecret: true, options: [] }] } };
    const view = render(<FocusCoordinatorQuestions projectId="project-a" requests={[request, secretRequest]} onResolve={vi.fn()} storage={localStorage} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer for What should the workers preserve?" }), { target: { value: "Persist this" } });
    fireEvent.change(screen.getByLabelText("Answer for Enter the one-time value"), { target: { value: "do-not-store" } });
    await waitFor(() => expect(localStorage.getItem("pixice.focusCoordinatorQuestionDrafts.project-a")).toContain("Persist this"));
    expect(localStorage.getItem("pixice.focusCoordinatorQuestionDrafts.project-a")).not.toContain("do-not-store");
    view.rerender(<FocusCoordinatorQuestions projectId="project-b" requests={[request]} onResolve={vi.fn()} storage={localStorage} />);
    view.rerender(<FocusCoordinatorQuestions projectId="project-a" requests={[request, secretRequest]} onResolve={vi.fn()} storage={localStorage} />);
    expect(await screen.findByRole("textbox", { name: "Answer for What should the workers preserve?" })).toHaveValue("Persist this");
  });

  it("redacts a secret answer from the local receipt", async () => {
    const secretRequest = { ...request, requestGeneration: 4, params: { ...request.params, questions: [{ id: "secret", header: "Credential", question: "Enter the one-time value", isSecret: true, options: [] }] } };
    render(<FocusCoordinatorQuestions projectId="project-a" requests={[secretRequest]} onResolve={vi.fn(async () => true)} storage={localStorage} />);
    fireEvent.change(screen.getByLabelText("Answer for Enter the one-time value"), { target: { value: "do-not-display" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByText("Answer redacted")).toBeInTheDocument();
    expect(screen.queryByText("do-not-display")).not.toBeInTheDocument();
  });

  it("loads only user-escalated durable answer receipts from Focus state", async () => {
    const api = { focus: { state: vi.fn(async () => ({ events: [
      { kind: "question-answered", focusCoordinatorQuestion: true, source: "user", wasVisible: true, request: { id: request.id, generation: request.requestGeneration, questions: request.params.questions }, answers: { approach: ["Preserve shape"], detail: ["Existing refresh semantics"] } },
      { kind: "question-answered", focusCoordinatorQuestion: true, source: "coordinator", request: { id: request.id, generation: request.requestGeneration, questions: request.params.questions }, answers: { approach: ["Ignore"], detail: ["Ignore"] } },
      { kind: "question-answered", focusCoordinatorQuestion: true, source: "coordinator", userEscalated: true, request: { id: "answered-in-chat", generation: 8, questions: [{ id: "scope", question: "Where should this launch?" }] }, answers: { scope: ["Beta users, as requested in chat"] } },
    ] })) } };
    render(<FocusCoordinatorQuestions projectId="project-a" requests={[]} onResolve={vi.fn()} api={api} storage={localStorage} />);
    expect(await screen.findByText("Existing refresh semantics")).toBeInTheDocument();
    expect(screen.getByText("Existing refresh semantics")).toBeInTheDocument();
    expect(screen.getByText("Beta users, as requested in chat")).toBeInTheDocument();
    expect(screen.queryByText("Ignore")).not.toBeInTheDocument();
  });
});
