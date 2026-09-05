import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerPicker, renderCapturedChanges, preserveReceiptEvidence } from "../src/App.jsx";
import { ModelReplay, TaskReceipt } from "../src/components/TaskResults.jsx";

const receipt = { projectId: "p", threadId: "t", groupId: "t", revision: "revision", title: "Authentication", projectName: "Example",
  model: "codex:gpt-6-astra", status: "completed", outcome: "pending", summary: "Session expiry is fixed.", prompt: "Fix session expiry.", promptCount: 2,
  usage: { costUsd: 1.5, tokens: 10_000, events: 3, unpricedEvents: 1 }, durationMs: 63_000, replayAvailable: true,
  checks: [{ id: "check", command: "pnpm test", status: "failed", output: "one failing check" }],
  changes: { files: [{ root: "/example", path: "auth.ts", plus: 3, minus: 1 }], fileCount: 1, patch: "+ fixed" } };

describe("task result controls", () => {
  it("shows tokens beside cost without acceptance controls and keeps evidence errors actionable", async () => {
    const onLoadEvidence = vi.fn().mockRejectedValue(new Error("Could not load captured changes."));
    render(<TaskReceipt receipt={{ ...receipt, outcome: "accepted" }} onLoadEvidence={onLoadEvidence} />);
    expect(screen.getByText("$1.50 + unpriced")).toBeInTheDocument();
    expect(screen.getByText("10,000 tokens").parentElement).toBe(screen.getByText("$1.50 + unpriced").parentElement);
    expect(screen.queryByRole("button", { name: /accept|abandon/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load captured changes.");
  });

  it("opens running replays", () => {
    const open = vi.fn();
    render(<TaskReceipt receipt={{ ...receipt, status: "running" }} onOpen={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Open running task" }));
    expect(open).toHaveBeenCalled();
  });

  it("keeps a running receipt collapsed until its details are requested", () => {
    render(<TaskReceipt compact receipt={{ ...receipt, status: "running", remainingReplayTurns: 2 }} />);

    expect(screen.getByRole("button", { name: "Show working details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("10,000 tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("Working on the original prompt…")).not.toBeInTheDocument();
    expect(screen.queryByText("2 more original prompts queued.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show working details" }));

    expect(screen.getByRole("button", { name: "Hide working details" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("10,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Working on the original prompt…")).toBeInTheDocument();
    expect(screen.getByText("2 more original prompts queued.")).toBeInTheDocument();
  });

  it("sends model-specific effort and speed, and resets fast mode when switching providers", async () => {
    const onReplay = vi.fn().mockResolvedValue({});
    const models = [{ id: "codex:gpt-6-astra", model: "gpt-6-astra", displayName: "Astra", defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }], serviceTiers: [{ id: "priority" }] },
    { id: "claude:sonnet", model: "sonnet", displayName: "Sonnet" }];
    render(<ModelReplay Picker={ComposerPicker} source={receipt} comparisons={[receipt]} models={models} onReplay={onReplay} />);
    fireEvent.click(screen.getByRole("button", { name: /Replay model:/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    fireEvent.click(screen.getByRole("option", { name: /Astra/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reasoning:/ }));
    fireEvent.click(screen.getByRole("option", { name: "Ultra" }));
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Run replay" }));
    await waitFor(() => expect(onReplay).toHaveBeenCalledWith(receipt, { model: "codex:gpt-6-astra", effort: "ultra", serviceTier: "priority" }));
    fireEvent.click(screen.getByRole("button", { name: /Replay model:/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));
    expect(screen.queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run replay" }));
    await waitFor(() => expect(onReplay).toHaveBeenLastCalledWith(receipt, { model: "claude:sonnet", serviceTier: null }));
  });

  it("explains missing replay snapshots and does not allow a run", () => {
    render(<ModelReplay Picker={ComposerPicker} source={{ ...receipt, replayAvailable: false, replayUnavailableReason: "No starting snapshot was recorded." }} comparisons={[]} models={[]} />);
    expect(screen.getByText("No starting snapshot was recorded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run replay" })).toBeDisabled();
  });

  it("keeps same-named files from different repositories separate", () => {
    const patch = (content) => `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+${content}\n`;
    render(<div>{renderCapturedChanges({ files: [{ root: "/one", path: "package.json", plus: 1, minus: 1 }, { root: "/two", path: "package.json", plus: 1, minus: 1 }], repositoryPatches: [{ root: "/one", patch: patch("first repository") }, { root: "/two", patch: patch("second repository") }] })}</div>);
    expect(screen.getByText("first repository")).toBeInTheDocument();
    expect(screen.getByText("second repository")).toBeInTheDocument();
  });

  it("retains expanded evidence on list refresh but drops it for a new result", () => {
    const incoming = { ...receipt, outcome: "accepted", changes: { ...receipt.changes, patch: undefined } };
    expect(preserveReceiptEvidence([incoming], [receipt])[0]).toMatchObject({ outcome: "accepted", changes: { patch: "+ fixed" } });
    expect(preserveReceiptEvidence([{ ...incoming, revision: "new-turn" }], [receipt])[0].changes.patch).toBeUndefined();
  });

});
