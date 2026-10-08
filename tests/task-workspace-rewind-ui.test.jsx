import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskWorkspacePicker } from "../src/components/TaskWorkspace.jsx";
import { RewindPromptAction } from "../src/components/RewindPrompt.jsx";

afterEach(cleanup);

describe("task workspace selection", () => {
  it("offers a real ref/branch contract and disables worktrees without Git", () => {
    const change = vi.fn();
    const { rerender } = render(<TaskWorkspacePicker value={{ mode: "project" }} onChange={change} repository={{ kind: "folder" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Task execution workspace" }));
    expect(screen.getByRole("button", { name: /New worktree/ })).toBeDisabled();
    rerender(<TaskWorkspacePicker value={{ mode: "worktree", startingState: { type: "ref", ref: "main" } }} onChange={change} repository={{ kind: "git", baseCommit: "abc" }} />);
    fireEvent.change(screen.getByLabelText("Git reference"), { target: { value: "origin/main" } });
    expect(change).toHaveBeenLastCalledWith({ mode: "worktree", startingState: { type: "ref", ref: "origin/main" } });
    fireEvent.change(screen.getByLabelText("New branch"), { target: { value: "codex/task" } });
    expect(change).toHaveBeenLastCalledWith({ mode: "worktree", startingState: { type: "ref", ref: "main" }, branch: "codex/task" });
  });
});

describe("edit from here", () => {
  const details = { checkpointId: "checkpoint", input: [{ type: "text", text: "Original" }], conversationRevision: "conversation", workspaceRevision: "workspace", removedTurns: 2,
    restoreAllowed: true, fileCount: 1, files: [{ root: "/checkout", path: "file.txt", plus: 4, minus: 2 }] };

  it("previews files and passes exactly the reviewed revision on confirmation", async () => {
    const rewind = vi.fn(async () => ({ input: details.input }));
    const restored = vi.fn();
    render(<RewindPromptAction checkpointId="checkpoint" preview={async () => details} rewind={rewind} onRewound={restored} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit from here" }));
    expect(rewind).not.toHaveBeenCalled();
    await screen.findByText("file.txt");
    fireEvent.click(screen.getByRole("button", { name: "Revert files too" }));
    await waitFor(() => expect(restored).toHaveBeenCalledWith({ input: details.input }));
    expect(rewind).toHaveBeenCalledWith({ checkpointId: "checkpoint", conversationRevision: "conversation", workspaceRevision: "workspace", restoreFiles: true });
  });

  it("makes shared-workspace restoration unavailable while retaining conversation rewind", async () => {
    const rewind = vi.fn(async () => ({ input: details.input }));
    render(<RewindPromptAction checkpointId="checkpoint" preview={async () => ({ ...details, restoreAllowed: false, restoreReason: "Another agent shares this worktree." })} rewind={rewind} onRewound={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit from here" }));
    await screen.findByText("Another agent shares this worktree.");
    expect(screen.getByRole("button", { name: "Revert files too" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revert and keep changes" }));
    await waitFor(() => expect(rewind).toHaveBeenCalledWith(expect.objectContaining({ restoreFiles: false })));
  });

  it("requires explicit selected-file confirmation and reloads the token after restore", async () => {
    const preview = vi.fn().mockResolvedValueOnce(details).mockResolvedValueOnce({ ...details, workspaceRevision: "updated", files: [], fileCount: 0 });
    const restoreFile = vi.fn(async () => ({}));
    render(<RewindPromptAction checkpointId="checkpoint" preview={preview} rewind={vi.fn()} restoreFile={restoreFile} onRewound={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit from here" }));
    const section = await screen.findByRole("region", { name: "Rewind conversation preview" });
    await within(section).findByText("file.txt");
    fireEvent.click(screen.getByRole("button", { name: "Restore file.txt" }));
    expect(restoreFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore selected file" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(restoreFile).toHaveBeenCalledWith({ checkpointId: "checkpoint", file: { root: "/checkout", path: "file.txt" }, workspaceRevision: "workspace" });
  });
});
