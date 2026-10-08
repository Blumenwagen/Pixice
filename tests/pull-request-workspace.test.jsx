import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullRequestWorkspace } from "../src/components/PullRequestWorkspace.jsx";

const url = "https://github.com/acme/project/pull/42";
function setup({ canWrite = true, links = [], initialUrl = null, overrides = {} } = {}) {
  let eventHandler;
  const detail = { number: 42, url, title: "Ship the change", body: "Review the current implementation", state: "open", isDraft: true, author: { login: "me" }, viewer: "me", baseBranch: "main", headBranch: "codex/change", headSha: "a".repeat(40), mergeability: "clean", checks: [{ name: "test", status: "success", required: true }], comments: [{ id: "comment-1", body: "Please check the error handling", author: { login: "reviewer" }, createdAt: "2026-10-08T12:00:00Z" }], reviews: [], inlineComments: [], files: [{ path: "app.js" }], activityComplete: true };
  const workspace = { projectId: "project", threadId: "thread", branch: "codex/change", files: [{ path: "app.js", status: " M" }, { path: "notes.md", status: "??" }], ahead: 1, behind: 0, repository: { nameWithOwner: "acme/project", defaultBranchRef: { name: "main" } }, canWrite, canWatch: true, links };
  const pullRequests = {
    workspace: vi.fn(async () => workspace), list: vi.fn(async () => [detail]), read: vi.fn(async () => detail), diff: vi.fn(async () => ({ diff: "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old\n+new\n" })),
    commit: vi.fn(async () => ({ workspace })), push: vi.fn(async () => ({ workspace })), create: vi.fn(async () => ({ detail, links: [detail] })), update: vi.fn(async () => detail),
    link: vi.fn(async () => ({ detail, links: [detail] })), unlink: vi.fn(async () => ({ links: [] })), watch: vi.fn(async () => ({ active: true })), stopWatch: vi.fn(async () => ({ ok: true })), ...overrides
  };
  const api = { pullRequests, events: { subscribe: vi.fn((handler) => { eventHandler = handler; return () => {}; }) } };
  const props = { api, projectId: "project", threadId: "thread", initialUrl, onOpenUrl: vi.fn() };
  return { ...render(<PullRequestWorkspace {...props} />), api, pullRequests, detail, workspace, props, event: (value) => eventHandler(value) };
}

describe("native PR delivery Preview tab", () => {
  it("requires selected files and a message before committing, scoped to the current chat", async () => {
    const { pullRequests } = setup();
    const button = await screen.findByRole("button", { name: "Commit selected files" }); expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Select app.js")); fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Handle errors" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1 selected file" }));
    await waitFor(() => expect(pullRequests.commit).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", message: "Handle errors", paths: ["app.js"] }));
    expect(pullRequests.push).not.toHaveBeenCalled(); expect(pullRequests.create).not.toHaveBeenCalled();
  });
  it("shows the reviewable draft creation form and publishes only on its explicit action", async () => {
    const { pullRequests } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Prepare pull request" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Handle request failures" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Preserve the request state.\n\nVerified locally." } });
    expect(screen.getByLabelText("Draft pull request")).toBeChecked(); expect(pullRequests.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create draft pull request" }));
    await waitFor(() => expect(pullRequests.create).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", title: "Handle request failures", body: "Preserve the request state.\n\nVerified locally.", base: "main", draft: true }));
    expect(await screen.findByRole("heading", { name: "Ship the change" })).toBeInTheDocument();
  });
  it("keeps delivery controls disabled for read-only chats while allowing review inspection", async () => {
    setup({ canWrite: false });
    expect(await screen.findByRole("button", { name: "Push to origin" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Prepare pull request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pull requests" })); fireEvent.click(await screen.findByRole("button", { name: "#42 Ship the change" }));
    expect(await screen.findByRole("button", { name: "Mark ready for review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Checks · 1" })); expect(await screen.findByText("test")).toBeInTheDocument();
  });
  it("starts and stops a persisted watch from the linked review without sending an ordinary message", async () => {
    const link = { url, number: 42, snapshot: { title: "Ship the change", state: "open" } };
    const { pullRequests, workspace, event } = setup({ links: [link], initialUrl: url });
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    await waitFor(() => expect(pullRequests.watch).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", reference: url }));
    workspace.links = [{ ...link, watch: { active: true } }];
    await act(async () => event({ type: "PullRequestsUpdated", payload: { projectId: "project", threadId: "thread" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop watching" }));
    await waitFor(() => expect(pullRequests.stopWatch).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", url }));
  });
  it("renders remote discussion text as text and keeps diff changes in the tab", async () => {
    const { pullRequests, detail, props } = setup({ initialUrl: url });
    detail.comments[0].body = '<img src=x onerror="steal()">';
    await screen.findByRole("heading", { name: "Ship the change" });
    fireEvent.click(screen.getByRole("button", { name: "Conversation · 1" }));
    expect(await screen.findByText('<img src=x onerror="steal()">')).toBeInTheDocument(); expect(document.querySelector(".pr-remarks img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Code · 1" }));
    expect(await screen.findByLabelText("Pull request diff")).toHaveTextContent("+new"); expect(pullRequests.diff).toHaveBeenCalledWith({ projectId: "project", threadId: "thread", url });
    expect(props.onOpenUrl).not.toHaveBeenCalled();
  });
  it("does not display a previous chat's delayed review after switching scope", async () => {
    let resolveFirst;
    const pending = new Promise((resolve) => { resolveFirst = resolve; });
    const second = { number: 2, url: "https://github.com/acme/project/pull/2", title: "Current chat review", body: "", state: "open", isDraft: true, author: { login: "me" }, viewer: "me", baseBranch: "main", headBranch: "next", headSha: "b".repeat(40), mergeability: "clean", checks: [], comments: [], reviews: [], inlineComments: [], files: [], activityComplete: true };
    const { rerender, props, detail } = setup({ initialUrl: url, overrides: { read: vi.fn(({ threadId }) => threadId === "thread" ? pending : Promise.resolve(second)) } });
    await screen.findByRole("button", { name: "Pull requests" });
    rerender(<PullRequestWorkspace {...props} threadId="other-thread" initialUrl={second.url} />);
    expect(await screen.findByRole("heading", { name: "Current chat review" })).toBeInTheDocument();
    await act(async () => resolveFirst(detail));
    expect(screen.queryByRole("heading", { name: "Ship the change" })).not.toBeInTheDocument();
  });
  it("keeps large diffs readable without creating a DOM element per line", async () => {
    const diff = "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n" + "+large change\n".repeat(10_001);
    setup({ initialUrl: url, overrides: { diff: vi.fn(async () => ({ diff })) } });
    await screen.findByRole("heading", { name: "Ship the change" });
    fireEvent.click(screen.getByRole("button", { name: "Code · 1" }));
    const preview = await screen.findByLabelText("Pull request diff");
    expect(preview.textContent).toBe(diff); expect(preview.childElementCount).toBe(0);
  });
  it("preserves the current review when parent callback identities change", async () => {
    const { pullRequests, rerender, props } = setup({ initialUrl: url });
    await screen.findByRole("heading", { name: "Ship the change" });
    fireEvent.click(screen.getByRole("button", { name: "Code · 1" }));
    const preview = await screen.findByLabelText("Pull request diff");
    const reads = pullRequests.read.mock.calls.length;
    rerender(<PullRequestWorkspace {...props} onError={() => {}} />);
    await act(async () => {});
    expect(screen.getByLabelText("Pull request diff")).toBe(preview);
    expect(pullRequests.read).toHaveBeenCalledTimes(reads);
  });
});
