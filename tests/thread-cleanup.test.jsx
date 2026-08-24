import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadCleanupPopover } from "../src/components/sidebar/ThreadCleanupPopover.jsx";
import { getCleanupCandidates, THREAD_CLEANUP_AGE_DAYS } from "../src/components/sidebar/thread-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function thread(id, daysOld, status = { type: "idle" }) {
  return {
    id,
    name: `Thread ${id}`,
    preview: `Notes from ${id}`,
    status,
    updatedAt: NOW - daysOld * DAY_MS
  };
}

describe("thread cleanup", () => {
  it("only proposes old inactive threads that are neither open nor board-linked", () => {
    const candidates = getCleanupCandidates({
      tasks: [
        thread("old", 75),
        thread("recent", 8),
        thread("open", 90),
        thread("board", 120),
        thread("running", 140, { type: "active" })
      ],
      selectedThreadId: "open",
      protectedThreadIds: ["board"],
      now: NOW
    });

    expect(THREAD_CLEANUP_AGE_DAYS).toBe(30);
    expect(candidates).toEqual([
      expect.objectContaining({ id: "old", title: "Thread old", daysInactive: 75, detail: "Idle · Last used 2 months ago" })
    ]);
  });

  it("uses the selected cleanup age", () => {
    const tasks = [thread("eight-days", 8), thread("six-days", 6)];
    expect(getCleanupCandidates({ tasks, ageDays: 30, now: NOW })).toHaveLength(0);
    expect(getCleanupCandidates({ tasks, ageDays: 7, now: NOW }).map((candidate) => candidate.id)).toEqual(["eight-days"]);
    expect(getCleanupCandidates({ tasks, ageDays: 5, now: NOW }).map((candidate) => candidate.id)).toEqual(["eight-days", "six-days"]);
  });

  it("shows a compact review and supports individual or bulk cleanup", async () => {
    const onDeleteThread = vi.fn().mockResolvedValue(true);
    const onCleanupAll = vi.fn().mockResolvedValue(2);
    render(
      <ThreadCleanupPopover
        tasks={[thread("older", 100), thread("old", 45)]}
        selectedThreadId={null}
        protectedThreadIds={[]}
        onDeleteThread={onDeleteThread}
        onCleanupAll={onCleanupAll}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Review 2 old threads" }));
    expect(screen.getByRole("dialog", { name: "Thread cleanup" })).toBeInTheDocument();
    expect(screen.getByText("2 chats match the cleanup rule. Open, running, and board-linked work stays out of this list.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Thread old from cleanup" }));
    await waitFor(() => expect(onDeleteThread).toHaveBeenCalledWith("old", { skipConfirm: true }));

    fireEvent.click(screen.getByRole("button", { name: "Clean up all" }));
    await waitFor(() => expect(onCleanupAll).toHaveBeenCalledWith(["older", "old"]));
  });
});
